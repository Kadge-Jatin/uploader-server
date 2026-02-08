/**
 * Token service with:
 * - /create-payment-link (creates Razorpay payment links)
 * - /razorpay-webhook (verifies webhook and issues tokens)
 * - /claim-return (redirect buyer after payment to PUBLIC_SETUP_URL#token=)
 *
 * Required env vars:
 * - REDIS_URL
 * - ADMIN_SECRET
 * - PUBLIC_SETUP_URL
 * - RAZORPAY_KEY_ID
 * - RAZORPAY_KEY_SECRET
 * - RAZORPAY_WEBHOOK_SECRET
 * - CLAIM_RETURN_BASE (optional, defaults to https://valentines-token-service.onrender.com)
 * - PURCHASE_TTL_SECONDS (optional, default 7200)
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // keep raw body for webhook signature verification
}));
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// config from env
const REDIS_URL = process.env.REDIS_URL || '';
if (!REDIS_URL) console.warn('WARNING: REDIS_URL not set');
const redis = new Redis(REDIS_URL);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';
const PUBLIC_SETUP_URL = process.env.PUBLIC_SETUP_URL || 'https://Kadge-Jatin.github.io/Valentines-Gifts_3/setup.html';

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || ''; // API Key Secret (Basic auth)
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || ''; // webhook signing secret

const CLAIM_RETURN_BASE = process.env.CLAIM_RETURN_BASE || `https://${process.env.RENDER_EXTERNAL_URL || 'valentines-token-service.onrender.com'}`;
const PURCHASE_TTL = parseInt(process.env.PURCHASE_TTL_SECONDS || 'value 7200', 10);

const purchaseKey = (token) => `purchase:${token}`;
const paymentKey = (paymentId) => `payment:${paymentId}`;

// issue a purchase token and store it in Redis with TTL
async function issuePurchaseToken(meta = {}) {
  const token = uuidv4();
  const key = purchaseKey(token);
  const stored = Object.assign({ createdAt: Date.now() }, meta);
  await redis.set(key, JSON.stringify(stored), 'EX', PURCHASE_TTL);

  if (meta.paymentId) {
    try {
      await redis.set(paymentKey(meta.paymentId), token, 'EX', PURCHASE_TTL);
    } catch (e) {
      console.warn('failed to set payment->token mapping', e);
    }
  }
  return token;
}

// verify a purchase token (return stored meta or null)
async function verifyPurchaseToken(token) {
  if (!token) return null;
  const raw = await redis.get(purchaseKey(token));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Admin: create token manually
app.post('/admin/issue-token', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const paymentId = req.body.paymentId || `manual_${Date.now()}`;
  const token = await issuePurchaseToken({ paymentId });
  const claimUrl = `${PUBLIC_SETUP_URL}#token=${encodeURIComponent(token)}`;
  return res.json({ success: true, token, claimUrl, expiresInSec: PURCHASE_TTL });
});

// Verify endpoint used by uploader-server before accepting uploads
app.get('/verify-purchase', async (req, res) => {
  const token = req.query.token || (req.headers['authorization'] && String(req.headers['authorization']).startsWith('Bearer ') ? String(req.headers['authorization']).slice(7) : null);
  if (!token) return res.status(400).json({ error: 'missing_token' });
  const meta = await verifyPurchaseToken(token);
  if (!meta) return res.status(404).json({ error: 'invalid_or_expired' });
  return res.json({ valid: true, meta });
});

// Create Razorpay payment link (called by frontend)
app.post('/create-payment-link', async (req, res) => {
  try {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'razorpay keys not configured' });
    }
    const amountRs = Number(req.body.amount || 1);
    const amountPaise = Math.max(1, Math.round(amountRs * 100));

    const payload = {
      amount: amountPaise,
      currency: 'INR',
      accept_partial: false,
      description: 'Valentines gift',
      reference_id: `ref_${Date.now()}`,
      callback_url: `${CLAIM_RETURN_BASE}/claim-return`,
      callback_method: 'get'
    };

    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const r = await axios.post('https://api.razorpay.com/v1/payment_links', payload, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    return res.json(r.data);
  } catch (err) {
    console.error('create-payment-link error', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'failed to create payment link', detail: err?.response?.data || err.message });
  }
});

// Razorpay webhook: verify signature (if webhook secret set) and issue purchase token
app.post('/razorpay-webhook', async (req, res) => {
  try {
    const sig = req.headers['x-razorpay-signature'] || '';
    const body = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body || {});

    // Use webhook-specific secret to verify signature (do not use API secret)
    if (RAZORPAY_WEBHOOK_SECRET) {
      const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
      if (sig !== expected) {
        console.warn('razorpay signature mismatch');
        return res.status(400).send('invalid signature');
      }
    } else {
      console.warn('RAZORPAY_WEBHOOK_SECRET not set — skipping webhook signature verification');
    }

    // extract payment id if present in webhook payload
    let paymentId = `razorpay_${Date.now()}`;
    try {
      if (req.body && req.body.payload) {
        const p = req.body.payload;
        if (p.payment && p.payment.entity && p.payment.entity.id) paymentId = p.payment.entity.id;
        else if (p.payment_link && p.payment_link.entity && p.payment_link.entity.id) paymentId = p.payment_link.entity.id;
      }
    } catch (e) { /* ignore */ }

    const purchaseToken = await issuePurchaseToken({ paymentId, event: req.body.event || null });
    const claimUrl = `${PUBLIC_SETUP_URL}#token=${encodeURIComponent(purchaseToken)}`;
    console.log('Issued purchase token:', purchaseToken, 'claimUrl:', claimUrl);
    return res.json({ ok: true, claimUrl });
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).send('server error');
  }
});

// Claim-return route for Razorpay redirect after payment
app.get('/claim-return', async (req, res) => {
  try {
    // Accept multiple possible query param names Razorpay may use in redirects:
    // - payment_id, paymentId, payment, razorpay_payment_id
    // - payment link ids: razorpay_payment_link_id, razorpay_payment_link_reference_id
    const paymentId =
      req.query.payment_id ||
      req.query.paymentId ||
      req.query.payment ||
      req.query.razorpay_payment_id ||
      req.query.razorpay_paymentId ||
      req.query.razorpay_payment_link_id ||
      req.query.razorpay_payment_link_reference_id ||
      null;

    if (!paymentId) {
      // helpful debug message including the full query for troubleshooting
      console.warn('claim-return missing payment_id - query:', req.query);
      return res.status(400).send('missing payment_id');
    }

    // If a token already exists for this payment, reuse it
    let token = await redis.get(paymentKey(paymentId));
    if (!token) {
      token = await issuePurchaseToken({ paymentId });
    } else {
      // extend TTLs so buyer has time to use the token after redirect
      try {
        await redis.expire(purchaseKey(token), PURCHASE_TTL);
        await redis.expire(paymentKey(paymentId), PURCHASE_TTL);
      } catch (e) {
        console.warn('failed to extend TTLs', e);
      }
    }

    const claimUrl = `${PUBLIC_SETUP_URL}#token=${encodeURIComponent(token)}`;
    return res.redirect(claimUrl);
  } catch (err) {
    console.error('claim-return error', err);
    return res.status(500).send('server error');
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Token service listening on ${port}`));

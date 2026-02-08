/**
 * Token service (strict expiry + setup verification support)
 *
 * Behaviour changes implemented:
 * - PURCHASE_TTL is parsed safely and logged.
 * - issuePurchaseToken sets the payment->token mapping using NX so a mapping is only created once.
 * - Webhook will reuse existing mapping if present; otherwise it creates a new token and mapping.
 * - /claim-return will NOT create a new token when mapping is missing; it returns 410 Gone.
 * - /claim-return no longer extends TTL on redirect (strict expiry).
 *
 * Required env vars:
 * - REDIS_URL
 * - ADMIN_SECRET
 * - PUBLIC_SETUP_URL
 * - RAZORPAY_KEY_ID
 * - RAZORPAY_KEY_SECRET
 * - RAZORPAY_WEBHOOK_SECRET
 * - CLAIM_RETURN_BASE (optional)
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

// safe PURCHASE_TTL parsing with fallback to 7200 seconds (2 hours)
const _envTtl = Number(process.env.PURCHASE_TTL_SECONDS);
const PURCHASE_TTL = Number.isFinite(_envTtl) && _envTtl > 0 ? Math.floor(_envTtl) : 7200;
console.log('PURCHASE_TTL set to', PURCHASE_TTL);

const purchaseKey = (token) => `purchase:${token}`;
const paymentKey = (paymentId) => `payment:${paymentId}`;

/**
 * issuePurchaseToken(meta)
 * - Creates a new token and stores purchase:<token> with TTL
 * - If meta.paymentId is provided, attempts to set payment:<paymentId> -> token using NX (won't overwrite)
 * - Returns an object: { token, createdMapping } where createdMapping is true if the payment mapping was created by this call
 */
async function issuePurchaseToken(meta = {}) {
  const token = uuidv4();
  const key = purchaseKey(token);
  const stored = Object.assign({ createdAt: Date.now() }, meta);

  // store token data with expiry
  await redis.set(key, JSON.stringify(stored), 'EX', PURCHASE_TTL);
  console.log('issued token', token, 'ttl', PURCHASE_TTL);

  let createdMapping = false;
  if (meta.paymentId) {
    try {
      // set payment->token only if not already present (NX)
      // ioredis set(key, value, 'EX', seconds, 'NX') returns 'OK' if set, null otherwise
      const setResult = await redis.set(paymentKey(meta.paymentId), token, 'EX', PURCHASE_TTL, 'NX');
      createdMapping = setResult === 'OK';
      console.log('payment mapping for', meta.paymentId, createdMapping ? 'created' : 'already existed');
    } catch (e) {
      console.warn('failed to set payment->token mapping', e);
    }
  }

  return { token, createdMapping };
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

  // create token and attempt to map (mapping will be created only if absent)
  const { token } = await issuePurchaseToken({ paymentId });
  const claimUrl = `${PUBLIC_SETUP_URL}#token=${encodeURIComponent(token)}`;
  return res.json({ success: true, token, claimUrl, expiresInSec: PURCHASE_TTL });
});

// Verify endpoint used by setup page or uploader-server before accepting uploads
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

// Razorpay webhook: verify signature and issue purchase token only if mapping absent
app.post('/razorpay-webhook', async (req, res) => {
  try {
    const sig = req.headers['x-razorpay-signature'] || '';
    const body = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body || {});

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

    // If mapping already exists, reuse that token
    const existing = await redis.get(paymentKey(paymentId));
    if (existing) {
      console.log('webhook: mapping exists for', paymentId, 'reusing token', existing);
      const claimUrl = `${PUBLIC_SETUP_URL}#token=${encodeURIComponent(existing)}`;
      return res.json({ ok: true, claimUrl, reused: true });
    }

    // create token and mapping (mapping will be set using NX from issuePurchaseToken)
    const { token } = await issuePurchaseToken({ paymentId, event: req.body.event || null });
    const claimUrl = `${PUBLIC_SETUP_URL}#token=${encodeURIComponent(token)}`;
    console.log('webhook: created token', token, 'for payment', paymentId);
    return res.json({ ok: true, claimUrl, created: true });
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).send('server error');
  }
});

// Claim-return route for Razorpay redirect after payment
// STRICT: Do NOT create a new token if mapping missing. Only reuse existing mapping.
// This ensures that once the mapping's TTL expires, the setup link is no longer usable.
app.get('/claim-return', async (req, res) => {
  try {
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
      console.warn('claim-return missing payment_id - query:', req.query);
      return res.status(400).send('missing payment_id');
    }

    // Strict behavior: only reuse existing token, do NOT create a new one here
    const token = await redis.get(paymentKey(paymentId));
    if (!token) {
      console.warn('claim-return: mapping missing or expired for', paymentId);
      return res.status(410).send('Link expired or not found for this payment.');
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

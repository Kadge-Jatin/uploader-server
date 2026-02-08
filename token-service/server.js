/**
 * Minimal token-service: issue & verify short-lived purchase tokens in Redis.
 *
 * Env vars required:
 * - REDIS_URL
 * - ADMIN_SECRET
 * - PUBLIC_SETUP_URL  (e.g. https://Kadge-Jatin.github.io/Valentines-Gifts_3/setup.html)
 * - PURCHASE_TTL_SECONDS (optional, default 7200)
 * - RAZORPAY_KEY_SECRET (optional; set when you configure Razorpay webhook)
 *
 * This version adds a /claim-return route so Razorpay can redirect the buyer
 * after payment. The route will:
 *  - accept a payment id query param (payment_id / paymentId / payment)
 *  - reuse an already-created token for that payment if present
 *  - otherwise issue a new token and store a payment -> token mapping
 *  - redirect the buyer to PUBLIC_SETUP_URL#token=<token>
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// config
const REDIS_URL = process.env.REDIS_URL || '';
if (!REDIS_URL) console.warn('WARNING: REDIS_URL not set');
const redis = new Redis(REDIS_URL);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';
const PUBLIC_SETUP_URL = process.env.PUBLIC_SETUP_URL || 'https://Kadge-Jatin.github.io/Valentines-Gifts_3/setup.html';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const PURCHASE_TTL = parseInt(process.env.PURCHASE_TTL_SECONDS || '7200', 10);

const purchaseKey = (token) => `purchase:${token}`;
const paymentKey = (paymentId) => `payment:${paymentId}`;

// issue a purchase token and store it in Redis with TTL
// also store a mapping from paymentId -> token when paymentId is provided
async function issuePurchaseToken(meta = {}) {
  const token = uuidv4();
  const key = purchaseKey(token);
  const stored = Object.assign({ createdAt: Date.now() }, meta);
  await redis.set(key, JSON.stringify(stored), 'EX', PURCHASE_TTL);

  // if meta.paymentId exists, store a reverse mapping so we can reuse tokens on redirect
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

// Admin helper: create a purchase token manually for testing
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

// Razorpay webhook: verify signature (if RAZORPAY_KEY_SECRET set) and issue purchase token
app.post('/razorpay-webhook', async (req, res) => {
  try {
    const sig = req.headers['x-razorpay-signature'] || '';
    const body = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body || {});

    if (RAZORPAY_KEY_SECRET) {
      const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(body).digest('hex');
      if (sig !== expected) {
        console.warn('razorpay signature mismatch');
        return res.status(400).send('invalid signature');
      }
    }

    // extract payment id if present
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
// Example: Razorpay can be configured to redirect to:
//   https://valentines-token-service.onrender.com/claim-return
// Razorpay typically appends payment_id or other query params; this route accepts common names.
app.get('/claim-return', async (req, res) => {
  try {
    const paymentId = req.query.payment_id || req.query.paymentId || req.query.paymentid || req.query.payment;
    if (!paymentId) return res.status(400).send('missing payment_id');

    // If a token already exists for this payment, reuse it
    let token = await redis.get(paymentKey(paymentId));
    if (!token) {
      // No existing token: issue a new one and set mapping
      token = await issuePurchaseToken({ paymentId });
      // issuePurchaseToken already sets the payment->token mapping
    } else {
      // token is stored as a plain string
      // extend TTL for the token and mapping so buyer has time to use it
      try {
        await redis.expire(purchaseKey(token), PURCHASE_TTL);
        await redis.expire(paymentKey(paymentId), PURCHASE_TTL);
      } catch (e) {
        console.warn('failed to extend TTLs', e);
      }
    }

    const claimUrl = `${PUBLIC_SETUP_URL}#token=${encodeURIComponent(token)}`;
    // Redirect the buyer to the client setup page with the token in the fragment
    return res.redirect(claimUrl);
  } catch (err) {
    console.error('claim-return error', err);
    return res.status(500).send('server error');
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// serve landing.html at root so GET / works
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Token service listening on ${port}`));

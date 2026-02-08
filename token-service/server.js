/**
 * Minimal token-service: issue & verify short-lived purchase tokens in Redis.
 *
 * Env vars required:
 * - REDIS_URL
 * - ADMIN_SECRET
 * - PUBLIC_SETUP_URL  (e.g. https://Kadge-Jatin.github.io/Valentines-Gifts_3/setup.html)
 * - PURCHASE_TTL_SECONDS (optional, default 7200)
 * - RAZORPAY_KEY_SECRET (optional; set when you configure Razorpay webhook)
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

const purchaseKey = (t) => `purchase:${t}`;

// issue a purchase token and store it in Redis with TTL
async function issuePurchaseToken(meta = {}) {
  const token = uuidv4();
  const key = purchaseKey(token);
  await redis.set(key, JSON.stringify(Object.assign({ createdAt: Date.now() }, meta)), 'EX', PURCHASE_TTL);
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
  const token = req.query.token || req.headers['authorization'] && String(req.headers['authorization']).startsWith('Bearer ') ? String(req.headers['authorization']).slice(7) : null;
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

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Token service listening on ${port}`));

// serve landing.html at root so GET / works
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

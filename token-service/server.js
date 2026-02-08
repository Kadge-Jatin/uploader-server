/**
 * Minimal token server for Valentines flow
 * - Serves token-service/public as static (landing page)
 * - /admin/issue-token  -> create a purchase token (protected by ADMIN_SECRET)
 * - /razorpay-webhook    -> receive payment webhook, verify signature, issue purchase token
 * - /generate            -> create/update view token (requires Authorization: Bearer <purchaseToken>)
 * - /validate-view       -> return view payload for given view token
 *
 * Env vars required:
 * - REDIS_URL (Upstash redis URI)
 * - ADMIN_SECRET (simple secret for /admin endpoints)
 * - PUBLIC_SETUP_URL (e.g. https://Kadge-Jatin.github.io/Valentines-Gifts_3/setup.html)
 * - PUBLIC_VIEW_BASE (e.g. https://Kadge-Jatin.github.io/Valentines-Gifts_3/view.html)
 * Optional:
 * - RAZORPAY_KEY_SECRET (if you set webhook secret in Razorpay)
 * - PURCHASE_TTL_SECONDS (default 7200)
 * - VIEW_TTL_SECONDS (default 2592000)
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();

// preserve raw body for webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Config from env
const REDIS_URL = process.env.REDIS_URL || '';
const redis = new Redis(REDIS_URL);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';
const PUBLIC_SETUP_URL = process.env.PUBLIC_SETUP_URL || 'https://Kadge-Jatin.github.io/Valentines-Gifts_3/setup.html';
const PUBLIC_VIEW_BASE = process.env.PUBLIC_VIEW_BASE || 'https://Kadge-Jatin.github.io/Valentines-Gifts_3/view.html';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

const PURCHASE_TTL = parseInt(process.env.PURCHASE_TTL_SECONDS || '7200', 10); // 2 hours
const VIEW_TTL = parseInt(process.env.VIEW_TTL_SECONDS || (30 * 24 * 3600).toString(), 10); // 30 days

// Helpers
const purchaseKey = (t) => `purchase:${t}`;
const viewKey = (t) => `view:${t}`;

async function issuePurchaseToken(meta = {}) {
  const token = uuidv4();
  const key = purchaseKey(token);
  await redis.set(key, JSON.stringify(Object.assign({ createdAt: Date.now() }, meta)), 'EX', PURCHASE_TTL);
  return token;
}

async function verifyPurchaseToken(token) {
  if (!token) return null;
  const raw = await redis.get(purchaseKey(token));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function createViewToken(setupPayload, orderMeta = {}) {
  const token = uuidv4();
  await redis.set(viewKey(token), JSON.stringify({ setupPayload, orderMeta, createdAt: Date.now() }), 'EX', VIEW_TTL);
  return token;
}

async function updateViewToken(token, setupPayload) {
  const k = viewKey(token);
  const exists = await redis.exists(k);
  if (!exists) return null;
  await redis.set(k, JSON.stringify({ setupPayload, updatedAt: Date.now() }), 'EX', VIEW_TTL);
  return token;
}

// Admin helper to create a purchase token manually (for testing)
app.post('/admin/issue-token', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const paymentId = req.body.paymentId || `manual_${Date.now()}`;
  const token = await issuePurchaseToken({ paymentId });
  const claimUrl = `${PUBLIC_SETUP_URL}#token=${encodeURIComponent(token)}`;
  return res.json({ success: true, token, claimUrl, expiresInSec: PURCHASE_TTL });
});

// Razorpay webhook endpoint (server-to-server)
// Verifies signature if RAZORPAY_KEY_SECRET is set
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

    // Extract a payment id if present
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

// POST /generate: create or update view token
// Authorization: Bearer <purchaseToken> OR { purchaseToken } in body
app.post('/generate', async (req, res) => {
  try {
    const auth = (req.headers.authorization || '');
    const purchaseToken = auth.startsWith('Bearer ') ? auth.slice(7) : (req.body.purchaseToken || null);
    if (!purchaseToken) return res.status(401).json({ error: 'missing_purchase_token' });

    const meta = await verifyPurchaseToken(purchaseToken);
    if (!meta) return res.status(403).json({ error: 'invalid_or_expired_purchase_token' });

    const setupPayload = req.body.setup || {};
    const existingViewToken = req.body.viewToken || null;

    let viewToken;
    if (existingViewToken) {
      const updated = await updateViewToken(existingViewToken, setupPayload);
      if (updated) viewToken = existingViewToken;
    }
    if (!viewToken) viewToken = await createViewToken(setupPayload, meta);

    const viewUrl = `${PUBLIC_VIEW_BASE}?token=${encodeURIComponent(viewToken)}`;
    return res.json({ success: true, viewToken, viewUrl, purchaseTokenExpiresIn: PURCHASE_TTL });
  } catch (err) {
    console.error('generate error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /validate-view?token=...
app.get('/validate-view', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'missing_view_token' });
    const raw = await redis.get(viewKey(token));
    if (!raw) return res.status(410).json({ error: 'view_token_not_found' });
    const payload = JSON.parse(raw);
    return res.json({ success: true, payload });
  } catch (err) {
    console.error('validate-view error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Simple health
app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Token service listening on ${port}`));

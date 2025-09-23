// server/index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// ---------- Config ----------
const ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 3001);

const rawKey = (process.env.TELNYX_API_KEY || '').trim();
const telnyx = rawKey ? require('telnyx')(rawKey) : null;

const SMS_MODE = (process.env.SMS_MODE || 'live').toLowerCase(); // 'test' | 'dry' | 'live'
const SMS_ALLOWLIST = (process.env.SMS_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean); // e.g. ["+15124351152"]
const SMS_PREFIX = process.env.SMS_PREFIX || '';

const MSG_PROFILE_ID = (process.env.TELNYX_MESSAGING_PROFILE_ID || '').trim();
const FROM_NUMBER   = (process.env.TELNYX_FROM_NUMBER || '').trim();

// CORS: "*" for dev, or comma-separated list of allowed origins
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ---------- Helpers ----------
function toE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  // US simple rules:
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // If the user already gave +<country><number>
  if (s.startsWith('+')) return s;
  return `+${digits}`;
}

function corsMiddleware() {
  if (CORS_ORIGINS.length === 1 && CORS_ORIGINS[0] === '*') {
    return cors(); // allow all (dev)
  }
  return cors({
    origin(origin, cb) {
      if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS blocked for origin: ${origin}`));
    },
  });
}

// ---------- App ----------
const app = express();
app.use(corsMiddleware());
app.use(express.json());

// Log config on boot (no secrets)
console.log('CONFIG ↴');
console.log({
  env: ENV,
  port: PORT,
  sms: { mode: SMS_MODE, allowlist: SMS_ALLOWLIST, prefix: SMS_PREFIX ? '[SET]' : '' },
  telnyx: { hasKey: Boolean(rawKey), profileSet: Boolean(MSG_PROFILE_ID), fromSet: Boolean(FROM_NUMBER) },
  cors: { origins: CORS_ORIGINS },
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, mode: SMS_MODE, env: ENV });
});

// Send SMS
app.post('/send-sms', async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'Missing "to" or "text"' });

    // Normalize destination on the server (Step 1 complete)
    const toNorm = toE164(to);
    if (!toNorm || !toNorm.startsWith('+') || toNorm.length < 8) {
      return res.status(400).json({ error: 'Invalid "to" number' });
    }

    // Build outbound payload
    const payload = {
      to: toNorm,
      text: (SMS_PREFIX ? `${SMS_PREFIX} ` : '') + String(text),
    };
    if (MSG_PROFILE_ID) payload.messaging_profile_id = MSG_PROFILE_ID;
    if (FROM_NUMBER)    payload.from = FROM_NUMBER;

    // Test/Dry modes — no charges
    if (SMS_MODE !== 'live') {
      console.log('[TEST MODE] Would send ->', payload);
      return res.json({ ok: true, id: `TEST-${Date.now()}` });
    }

    // Live mode guardrails
    if (SMS_ALLOWLIST.length && !SMS_ALLOWLIST.includes(toNorm)) {
      return res.status(403).json({ error: 'Destination not allowed in live mode' });
    }
    if (!rawKey || !telnyx) {
      return res.status(500).json({ error: 'Server missing TELNYX_API_KEY' });
    }

    console.log('Sending payload ->', payload);
    const resp = await telnyx.messages.create(payload);

    return res.json({
      ok: true,
      id: resp?.data?.data?.id || resp?.data?.id || resp?.id || 'unknown',
    });
  } catch (err) {
    const details = err?.response?.data || err?.data || err?.message || err;
    console.error('Telnyx send error ->', details);
    return res.status(500).json({ error: 'send failed', details });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Sign-in cookie.
//
// Firebase Hosting passes exactly one cookie through to the server, and it must
// be named "__session". So the whole session lives in that one cookie, signed
// with HMAC-SHA256: anyone can see it's a session, nobody can change or forge it.
//
// req.session works like cookie-session's: set req.session.userId to sign in,
// set req.session = null to sign out.

const crypto = require('crypto');
const onHeaders = require('on-headers');

const COOKIE = '__session';
const b64 = buf => Buffer.from(buf).toString('base64url');
// `purpose` is mixed into the signature, so a token made for one use (an
// upload) can never be accepted as another (a sign-in), and vice versa.
const hmac = (secret, purpose, value) => crypto.createHmac('sha256', secret).update(`${purpose}\n${value}`).digest();

function sign(secret, payload, purpose = 'session') {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(hmac(secret, purpose, body))}`;
}
function verify(secret, token, purpose = 'session') {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const given = Buffer.from(sig, 'base64url');
  const want = hmac(secret, purpose, body);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, value) : value);
}

// getSecret: () => Promise<string>. maxAgeMs: how long a sign-in lasts.
function sessionMiddleware({ getSecret, maxAgeMs, secure }) {
  return (req, res, next) => {
    Promise.resolve().then(getSecret).then(secret => {
      const payload = verify(secret, readCookie(req.headers.cookie, COOKIE));
      let current = payload && payload.exp > Date.now() && payload.d && typeof payload.d === 'object' ? payload.d : {};
      const original = JSON.stringify(current);
      Object.defineProperty(req, 'session', {
        configurable: true, enumerable: true,
        get: () => current,
        set: v => { current = v; }
      });
      onHeaders(res, () => {
        const nowJson = current ? JSON.stringify(current) : null;
        if (nowJson === original) return;
        const attrs = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
        if (!current || !Object.keys(current).length) {
          appendSetCookie(res, `${COOKIE}=; Max-Age=0; ${attrs}`);
        } else {
          const token = sign(secret, { d: current, exp: Date.now() + maxAgeMs });
          appendSetCookie(res, `${COOKIE}=${encodeURIComponent(token)}; Max-Age=${Math.floor(maxAgeMs / 1000)}; ${attrs}`);
        }
      });
      next();
    }, next);
  };
}

module.exports = { sessionMiddleware, sign, verify, COOKIE };

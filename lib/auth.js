// JWT auth, mirroring ShowPilot's pattern.
// Defensive: requireAuth null-checks req.cookies so a misordered middleware
// stack returns clean 401 JSON instead of crashing into Express's HTML 500.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// API tokens (v0.4.0): random, prefixed so they're recognisable in logs and
// secret scanners; only their SHA-256 hash is stored.
function hashApiToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function generateApiToken() {
  return 'shp_' + crypto.randomBytes(32).toString('base64url');
}

function makeAuth(config) {
  function issue(payload) {
    return jwt.sign(payload, config.jwtSecret, {
      expiresIn: `${config.sessionDurationHours}h`,
    });
  }
  function verify(token) {
    try { return jwt.verify(token, config.jwtSecret); }
    catch (e) { return null; }
  }
  function setCookie(res, token) {
    res.cookie(config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // set true behind HTTPS — your reverse proxy should handle TLS
      maxAge: config.sessionDurationHours * 3600 * 1000,
    });
  }
  function clearCookie(res) {
    res.clearCookie(config.sessionCookieName);
  }
  function requireAuth(req, res, next) {
    const token = req.cookies && req.cookies[config.sessionCookieName];
    if (!token) return res.status(401).json({ error: 'auth required' });
    const claims = verify(token);
    if (!claims) return res.status(401).json({ error: 'invalid session' });
    req.user = claims;
    next();
  }
  // Upload auth (v0.4.0): a signed-in browser session OR an API token sent as
  // "Authorization: Bearer shp_...". Used ONLY on the release upload and its
  // deploy-status poll; every other route stays session-only, so a token can
  // never manage repos, environments, users or other tokens.
  function requireUploadAuth(req, res, next) {
    const cookieToken = req.cookies && req.cookies[config.sessionCookieName];
    const claims = cookieToken ? verify(cookieToken) : null;
    if (claims) {
      req.user = claims;
      req.releasedBy = `user: ${claims.username || claims.uid}`;
      return next();
    }
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(\S+)$/i);
    if (!m) return res.status(401).json({ error: 'auth required' });
    const db = require('./db');
    const row = db.getActiveApiTokenByHash(hashApiToken(m[1]));
    if (!row) return res.status(401).json({ error: 'invalid or revoked API token' });
    db.touchApiToken(row.id);
    req.apiToken = {
      id: row.id,
      name: row.name,
      allowedRepos: row.allowed_repos ? row.allowed_repos.split(',').map((s) => s.trim()).filter(Boolean) : [],
    };
    req.releasedBy = `api token: ${row.name}`;
    next();
  }
  return { issue, verify, setCookie, clearCookie, requireAuth, requireUploadAuth };
}

module.exports = { makeAuth, hashApiToken, generateApiToken };

// JWT auth, mirroring ShowPilot's pattern.
// Defensive: requireAuth null-checks req.cookies so a misordered middleware
// stack returns clean 401 JSON instead of crashing into Express's HTML 500.

const jwt = require('jsonwebtoken');

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
  return { issue, verify, setCookie, clearCookie, requireAuth };
}

module.exports = { makeAuth };

// Auth routes. First-boot detection: if the users table is empty, the
// /auth/setup endpoint accepts a username + password to create the admin.
// After that, /auth/setup returns 409 and only /auth/login works.

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../lib/db');

const BCRYPT_ROUNDS = 12;

function build(auth) {
  const r = express.Router();

  r.get('/state', (req, res) => {
    res.json({ firstBoot: db.userCount() === 0 });
  });

  r.post('/setup', async (req, res) => {
    if (db.userCount() > 0) return res.status(409).json({ error: 'setup already complete' });
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || username.length < 2) return res.status(400).json({ error: 'username required (>= 2 chars)' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'password must be >= 8 chars' });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    db.createUser({ username, passwordHash: hash, mustChangePassword: 0 });
    const user = db.getUserByUsername(username);
    const token = auth.issue({ uid: user.id, username: user.username });
    auth.setCookie(res, token);
    res.json({ ok: true });
  });

  r.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password required' });
    }
    const user = db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = auth.issue({ uid: user.id, username: user.username });
    auth.setCookie(res, token);
    res.json({ ok: true, mustChangePassword: !!user.must_change_password });
  });

  r.post('/logout', (req, res) => {
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  r.post('/change-password', auth.requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'new password must be >= 8 chars' });
    }
    const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
    if (!user) return res.status(401).json({ error: 'user not found' });
    const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'current password incorrect' });
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    db.updateUserPassword(user.id, hash);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { build };

// API token management (v0.4.0). Browser session ONLY (requireAuth): an API
// token can never list, create or revoke tokens. The token value is returned
// once, at creation; only its SHA-256 hash is stored.

const express = require('express');
const db = require('../lib/db');
const { hashApiToken, generateApiToken } = require('../lib/auth');

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

function build(auth) {
  const r = express.Router();

  r.get('/tokens', auth.requireAuth, (req, res) => {
    res.json({ tokens: db.listApiTokens() });
  });

  r.post('/tokens', auth.requireAuth, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name || name.length > 80) return res.status(400).json({ error: 'name is required (max 80 characters)' });
    let repos = (req.body && req.body.allowed_repos) || [];
    if (!Array.isArray(repos)) return res.status(400).json({ error: 'allowed_repos must be a list of repo slugs' });
    repos = [...new Set(repos.map((s) => String(s).trim()).filter(Boolean))];
    const bad = repos.filter((s) => !VALID_SLUG.test(s));
    if (bad.length) return res.status(400).json({ error: `invalid repo slug(s): ${bad.join(', ')}` });
    const token = generateApiToken();
    const info = db.createApiToken({
      name,
      tokenHash: hashApiToken(token),
      tokenPrefix: token.slice(0, 8),
      allowedRepos: repos.join(','),
    });
    res.json({ ok: true, id: info.lastInsertRowid, name, allowed_repos: repos, token });
  });

  r.delete('/tokens/:id', auth.requireAuth, (req, res) => {
    const info = db.revokeApiToken(parseInt(req.params.id, 10));
    if (!info.changes) return res.status(404).json({ error: 'not found or already revoked' });
    res.json({ ok: true });
  });

  return r;
}

module.exports = { build };

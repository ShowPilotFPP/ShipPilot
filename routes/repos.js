// Repo management endpoints.
//
// GET    /repos                — list all
// POST   /repos                — add { slug, remote, branch? } → returns publicKey
// GET    /repos/:slug/key      — fetch public key (so the user can re-copy)
// POST   /repos/:slug/test     — run ssh -T against the alias
// DELETE /repos/:slug          — remove

const express = require('express');
const repos = require('../lib/repos');

function build(auth, config) {
  const r = express.Router();

  r.get('/repos', auth.requireAuth, async (req, res) => {
    const rows = await repos.listRepos();
    // Don't leak file paths to the UI — the user doesn't care where keys live.
    const view = rows.map((row) => ({
      slug: row.slug,
      remote: row.remote_original,
      branch: row.branch,
      managed: !!row.managed,
      created_at: row.created_at,
    }));
    res.json({ repos: view });
  });

  r.post('/repos', auth.requireAuth, async (req, res) => {
    try {
      const { slug, remote, branch } = req.body || {};
      const result = await repos.addRepo({ slug, remote, branch }, config);
      res.json({
        ok: true,
        repo: {
          slug: result.repo.slug,
          remote: result.repo.remote_original,
          branch: result.repo.branch,
          managed: !!result.repo.managed,
        },
        publicKey: result.publicKey,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.get('/repos/:slug/key', auth.requireAuth, async (req, res) => {
    try {
      const pub = await repos.getPublicKey(req.params.slug);
      res.json({ ok: true, publicKey: pub });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/repos/:slug/test', auth.requireAuth, async (req, res) => {
    try {
      const result = await repos.testConnection(req.params.slug);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete('/repos/:slug', auth.requireAuth, async (req, res) => {
    try {
      await repos.deleteRepo(req.params.slug, config);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return r;
}

module.exports = { build };

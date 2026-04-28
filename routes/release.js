// Release routes. POST /release with a multipart "tarball" field runs the
// pipeline synchronously and returns the result. GET /releases lists
// history. GET /releases/:id/log returns the full captured log.

const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const db = require('../lib/db');
const { performRelease } = require('../lib/release');

function build(auth, config) {
  const r = express.Router();

  // Use disk storage so we don't blow memory on large tarballs.
  const upload = multer({
    dest: path.join(os.tmpdir(), 'shippilot-uploads'),
    limits: { fileSize: config.maxUploadBytes },
  });

  r.post('/release', auth.requireAuth, upload.single('tarball'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'tarball field required' });
    const tarballPath = req.file.path;
    let result;
    try {
      result = await performRelease(tarballPath, config);
    } catch (e) {
      // performRelease shouldn't throw, but belt-and-braces.
      result = { ok: false, manifest: null, log: e.stack || e.message, error: e.message };
    } finally {
      fs.unlink(tarballPath).catch(() => {});
    }

    db.recordRelease({
      repo: result.manifest ? result.manifest.repo : 'unknown',
      version: result.manifest ? result.manifest.version : 'unknown',
      tag: result.manifest && result.manifest.tag ? result.manifest.tag : null,
      commit_message: result.manifest ? result.manifest.commit_message : '(no manifest)',
      commit_sha: result.commitSha || null,
      status: result.ok ? 'success' : 'failed',
      error_message: result.error || null,
      log: result.log,
    });

    if (result.ok) res.json({ ok: true, manifest: result.manifest, commitSha: result.commitSha, log: result.log });
    else res.status(400).json({ ok: false, error: result.error, log: result.log });
  });

  r.get('/releases', auth.requireAuth, (req, res) => {
    res.json({ releases: db.listReleases(100) });
  });

  r.get('/releases/:id/log', auth.requireAuth, (req, res) => {
    const row = db.getReleaseLog(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ error: 'not found' });
    res.type('text/plain').send(row.log || '');
  });

  return r;
}

module.exports = { build };

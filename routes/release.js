// Release routes. POST /release with a multipart "tarball" field runs the
// pipeline synchronously and returns the result. GET /releases lists
// history. GET /releases/:id/log returns the full captured log.
// GET /releases/:id/deploys polls deploy status for async auto-deploys.

const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const db = require('../lib/db');
const { performRelease } = require('../lib/release');
const deploy = require('../lib/deploy');

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

    const releaseRow = db.recordRelease({
      repo: result.manifest ? result.manifest.repo : 'unknown',
      version: result.manifest ? result.manifest.version : 'unknown',
      tag: result.manifest && result.manifest.tag ? result.manifest.tag : null,
      commit_message: result.manifest ? result.manifest.commit_message : '(no manifest)',
      commit_sha: result.commitSha || null,
      status: result.ok ? 'success' : 'failed',
      error_message: result.error || null,
      log: result.log,
    });
    const releaseId = releaseRow.lastInsertRowid;

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, log: result.log });
    }

    // Check whether this repo has any auto-deploy environments. If none,
    // respond immediately with deploys: [] — no polling needed.
    const autoDeployEnvs = db.listEnvironmentsByRepo(result.manifest.repo, true);

    if (!autoDeployEnvs.length) {
      return res.json({
        ok: true,
        manifest: result.manifest,
        commitSha: result.commitSha,
        log: result.log,
        releaseId,
        deploys: [],
      });
    }

    // There are auto-deploy environments. Respond immediately with
    // deploys: 'pending' and fire them in the background. The UI polls
    // GET /releases/:id/deploys until all settle.
    //
    // We use setImmediate so the response is flushed before the SSH
    // work starts. This prevents Cloudflare's ~100s upstream timeout
    // from killing the connection mid-deploy.
    res.json({
      ok: true,
      manifest: result.manifest,
      commitSha: result.commitSha,
      log: result.log,
      releaseId,
      deploys: 'pending',
    });

    setImmediate(async () => {
      try {
        await deploy.autoDeployForRelease({
          repoSlug: result.manifest.repo,
          version: result.manifest.version,
          tag: result.manifest.tag,
          releaseId,
          config,
        });
      } catch (e) {
        console.error(`[release] background auto-deploy error for release ${releaseId}: ${e.message}`);
      }
    });
  });

  r.get('/releases', auth.requireAuth, (req, res) => {
    res.json({ releases: db.listReleases(100) });
  });

  r.get('/releases/:id/log', auth.requireAuth, (req, res) => {
    const row = db.getReleaseLog(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ error: 'not found' });
    res.type('text/plain').send(row.log || '');
  });

  // Polling endpoint for async auto-deploy results. Returns the deploy
  // rows for the release. The UI polls until all rows have a non-running
  // status (i.e. finished_at is set).
  r.get('/releases/:id/deploys', auth.requireAuth, (req, res) => {
    const releaseId = parseInt(req.params.id, 10);
    const deploys = db.listDeploysForRelease(releaseId);
    const allSettled = deploys.length > 0 && deploys.every(d => d.finished_at !== null);
    res.json({ deploys, allSettled });
  });

  return r;
}

module.exports = { build };

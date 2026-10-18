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
const selfUpdate = require('../lib/self-update');

function build(auth, config) {
  const r = express.Router();

  // Use disk storage so we don't blow memory on large tarballs.
  const upload = multer({
    dest: path.join(os.tmpdir(), 'shippilot-uploads'),
    limits: { fileSize: config.maxUploadBytes },
  });

  // Session OR API token (v0.4.0). Auth runs before multer, so an
  // unauthenticated upload is rejected without being written to disk.
  r.post('/release', auth.requireUploadAuth, upload.single('tarball'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'tarball field required' });
    const tarballPath = req.file.path;
    let result;
    selfUpdate.noteReleaseStart();
    try {
      result = await performRelease(tarballPath, config, {
        allowedRepos: req.apiToken ? req.apiToken.allowedRepos : null,
        releasedBy: req.releasedBy,
      });
    } catch (e) {
      // performRelease shouldn't throw, but belt-and-braces.
      result = { ok: false, manifest: null, log: e.stack || e.message, error: e.message };
    } finally {
      selfUpdate.noteReleaseEnd();
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
      released_by: req.releasedBy || null,
    });
    const releaseId = releaseRow.lastInsertRowid;

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, log: result.log });
    }

    // v0.5.0: a release of ShipPilot itself updates the running ShipPilot
    // (when automatic updates are on). It waits for any deploys below.
    const selfUpdating = selfUpdate.maybeAutoUpdate(result.manifest.repo, req.releasedBy);

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
        selfUpdate: selfUpdating ? 'starting' : null,
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
      selfUpdate: selfUpdating ? 'starting' : null,
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
  // Also open to API tokens (v0.4.0) so an automated uploader can report the
  // deploy outcome; a token limited to certain repos only sees their releases.
  r.get('/releases/:id/deploys', auth.requireUploadAuth, (req, res) => {
    const releaseId = parseInt(req.params.id, 10);
    if (req.apiToken && req.apiToken.allowedRepos.length) {
      const rel = db.getReleaseRepo(releaseId);
      if (!rel || !req.apiToken.allowedRepos.includes(rel.repo)) return res.status(404).json({ error: 'not found' });
    }
    const deploys = db.listDeploysForRelease(releaseId);
    const allSettled = deploys.length > 0 && deploys.every(d => d.finished_at !== null);
    res.json({ deploys, allSettled });
  });

  return r;
}

module.exports = { build };

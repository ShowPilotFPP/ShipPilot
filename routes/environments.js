// Environment management endpoints.
//
// GET    /environments                       — list all
// POST   /environments                       — add { slug, name, host, ssh_user, ssh_port,
//                                                    repo_slug, deploy_path, deploy_script,
//                                                    log_command?, version_check_command?,
//                                                    auto_deploy?, seed_actions? }
//                                              → returns publicKey
// GET    /environments/:slug                 — fetch one (with actions, last deploy, version)
// PATCH  /environments/:slug                 — update fields
// DELETE /environments/:slug                 — remove
// GET    /environments/:slug/key             — re-fetch public key
// POST   /environments/:slug/test            — SSH connection test
// POST   /environments/:slug/refresh-version — re-probe version
// POST   /environments/:slug/deploy          — manual deploy (run deploy_script)
// POST   /environments/:slug/logs            — run log_command, return output
// POST   /environments/:slug/actions         — add action { label, command, requires_confirmation? }
// DELETE /environments/:slug/actions/:id     — remove action
// POST   /environments/:slug/actions/:id/run — run action
// GET    /deploys                            — list recent deploys (all envs)
// GET    /deploys/:id/log                    — full deploy log

const express = require('express');
const envs = require('../lib/environments');
const deploy = require('../lib/deploy');
const db = require('../lib/db');

// View shape — never leak the key file path or any internals to the UI.
function envView(env) {
  if (!env) return null;
  return {
    slug: env.slug,
    name: env.name,
    host: env.host,
    ssh_user: env.ssh_user,
    ssh_port: env.ssh_port,
    repo_slug: env.repo_slug,
    deploy_path: env.deploy_path,
    deploy_script: env.deploy_script,
    log_command: env.log_command,
    version_check_command: env.version_check_command,
    auto_deploy: !!env.auto_deploy,
    host_key_verified: !!env.host_key_verified,
    managed: !!env.managed,
    created_at: env.created_at,
  };
}

function build(auth, config) {
  const r = express.Router();

  r.get('/environments', auth.requireAuth, async (req, res) => {
    const list = await envs.listEnvironments();
    // Annotate each env with its actions and last deploy summary so the UI
    // can render the full card without per-env follow-up requests.
    const view = list.map((env) => {
      const actions = db.listEnvActions(env.id).map((a) => ({
        id: a.id,
        label: a.label,
        command: a.command,
        requires_confirmation: !!a.requires_confirmation,
        sort_order: a.sort_order,
      }));
      const recent = db.listDeploys(env.id, 1)[0] || null;
      return {
        ...envView(env),
        actions,
        last_deploy: recent ? {
          id: recent.id,
          trigger: recent.trigger,
          action_label: recent.action_label,
          status: recent.status,
          started_at: recent.started_at,
          finished_at: recent.finished_at,
          error_message: recent.error_message,
        } : null,
      };
    });
    res.json({ environments: view });
  });

  r.post('/environments', auth.requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await envs.addEnvironment(body, config, {
        seedActions: Array.isArray(body.seed_actions) ? body.seed_actions : [],
      });
      res.json({
        ok: true,
        environment: envView(result.env),
        publicKey: result.publicKey,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.get('/environments/:slug', auth.requireAuth, async (req, res) => {
    const env = db.getEnvironmentBySlug(req.params.slug);
    if (!env) return res.status(404).json({ error: 'not found' });
    const actions = db.listEnvActions(env.id).map((a) => ({
      id: a.id,
      label: a.label,
      command: a.command,
      requires_confirmation: !!a.requires_confirmation,
      sort_order: a.sort_order,
    }));
    const deploys = db.listDeploys(env.id, 20);
    res.json({ environment: envView(env), actions, deploys });
  });

  r.patch('/environments/:slug', auth.requireAuth, async (req, res) => {
    try {
      const env = await envs.updateEnvironment(req.params.slug, req.body || {});
      res.json({ ok: true, environment: envView(env) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete('/environments/:slug', auth.requireAuth, async (req, res) => {
    try {
      await envs.deleteEnvironment(req.params.slug);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.get('/environments/:slug/key', auth.requireAuth, async (req, res) => {
    try {
      const pub = await envs.getPublicKey(req.params.slug);
      res.json({ ok: true, publicKey: pub });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/environments/:slug/test', auth.requireAuth, async (req, res) => {
    try {
      const result = await envs.testConnection(req.params.slug, config);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/environments/:slug/refresh-version', auth.requireAuth, async (req, res) => {
    try {
      const result = await envs.probeVersion(req.params.slug, config);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/environments/:slug/deploy', auth.requireAuth, async (req, res) => {
    try {
      const env = db.getEnvironmentBySlug(req.params.slug);
      if (!env) return res.status(404).json({ error: 'not found' });
      const result = await deploy.manualDeploy({ envSlug: req.params.slug, config });
      res.json({ ok: result.status === 'success', deploy: result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/environments/:slug/logs', auth.requireAuth, async (req, res) => {
    try {
      const result = await deploy.tailLogs({ envSlug: req.params.slug, config });
      res.type('text/plain').send(
        (result.stdout || '') +
        (result.stderr ? `\n--- stderr ---\n${result.stderr}` : '')
      );
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/environments/:slug/actions', auth.requireAuth, async (req, res) => {
    try {
      const env = db.getEnvironmentBySlug(req.params.slug);
      if (!env) return res.status(404).json({ error: 'not found' });
      const body = req.body || {};
      if (!body.label || typeof body.label !== 'string') {
        return res.status(400).json({ error: 'label is required' });
      }
      if (!body.command || typeof body.command !== 'string') {
        return res.status(400).json({ error: 'command is required' });
      }
      if (body.label.length > 64) {
        return res.status(400).json({ error: 'label too long (max 64)' });
      }
      if (body.command.length > 4000) {
        return res.status(400).json({ error: 'command too long (max 4000)' });
      }
      const id = db.createEnvAction({
        env_id: env.id,
        label: body.label,
        command: body.command,
        requires_confirmation: body.requires_confirmation ? 1 : 0,
        sort_order: body.sort_order || 0,
      });
      res.json({ ok: true, action: { id, ...body } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete('/environments/:slug/actions/:id', auth.requireAuth, async (req, res) => {
    try {
      const env = db.getEnvironmentBySlug(req.params.slug);
      if (!env) return res.status(404).json({ error: 'not found' });
      const action = db.getEnvAction(parseInt(req.params.id, 10));
      if (!action || action.env_id !== env.id) return res.status(404).json({ error: 'action not found' });
      db.deleteEnvActionById(action.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post('/environments/:slug/actions/:id/run', auth.requireAuth, async (req, res) => {
    try {
      const result = await deploy.runAction({
        envSlug: req.params.slug,
        actionId: parseInt(req.params.id, 10),
        config,
      });
      res.json({ ok: result.status === 'success', deploy: result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.get('/deploys', auth.requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json({ deploys: db.listDeploys(null, limit) });
  });

  r.get('/deploys/:id/log', auth.requireAuth, async (req, res) => {
    const row = db.getDeployLog(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ error: 'not found' });
    res.type('text/plain').send(row.log || '');
  });

  return r;
}

module.exports = { build };

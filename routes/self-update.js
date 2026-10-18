// ShipPilot updating itself (v0.5.0); see lib/self-update.js.
// GET /health is open (the update helper and monitoring use it: version and
// process start time only). Everything else needs a signed-in browser
// session; API tokens can't trigger or configure updates.

const express = require('express');
const selfUpdate = require('../lib/self-update');

function build(auth) {
  const r = express.Router();

  r.get('/health', (req, res) => {
    res.json({ ok: true, version: selfUpdate.VERSION, startedAt: new Date(selfUpdate.STARTED_AT).toISOString() });
  });

  r.get('/self-update', auth.requireAuth, async (req, res) => {
    res.json(await selfUpdate.info());
  });

  r.post('/self-update/check', auth.requireAuth, async (req, res) => {
    await selfUpdate.check();
    res.json(await selfUpdate.info());
  });

  r.post('/self-update/run', auth.requireAuth, async (req, res) => {
    try {
      await selfUpdate.start({ reason: 'manual', by: `user: ${req.user.username || req.user.uid}` });
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.put('/self-update/settings', auth.requireAuth, async (req, res) => {
    if (!req.body || typeof req.body.auto !== 'boolean') return res.status(400).json({ error: 'auto (true/false) is required' });
    selfUpdate.setAuto(req.body.auto);
    res.json(await selfUpdate.info());
  });

  return r;
}

module.exports = { build };

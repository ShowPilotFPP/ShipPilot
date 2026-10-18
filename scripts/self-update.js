// ShipPilot self-update helper (v0.5.0). Started by lib/self-update.js in its
// own process (setsid under PM2, a transient systemd unit under systemd) so
// it survives ShipPilot's restart. Uses only Node built-ins: node_modules may
// be half-replaced while it runs.
//
//   node scripts/self-update.js <base64 JSON args>
//
// Steps: fast-forward the clone to origin/<branch>, npm install, restart,
// wait for the new version on /api/health. If it doesn't come up: reset to
// the previous commit, npm install, restart, wait again. Every step is
// written to data/self-update.json (shown on the page) and appended to
// data/self-update.log.

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const a = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
process.env.PATH = `${a.nodeDir}:${process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`;

const startedAt = new Date().toISOString();
const log = [];
let status = { state: 'running', reason: a.reason, by: a.by, from: a.from, to: null, startedAt, pid: process.pid, message: 'Updating…', log };

function save() {
  const tmp = a.statusFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...status, log: log.slice(-200), updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, a.statusFile);
}
function say(line) {
  const l = `[${new Date().toISOString()}] ${line}`;
  log.push(l);
  try { fs.appendFileSync(a.logFile, l + '\n'); } catch {}
  save();
}
function finish(state, message, extra = {}) {
  status = { ...status, ...extra, state, message, finishedAt: new Date().toISOString() };
  say(message);
  process.exit(state === 'success' || state === 'current' ? 0 : 1);
}

function run(cmd, args, timeoutMs = 10 * 60 * 1000) {
  const r = spawnSync(cmd, args, { cwd: a.appDir, encoding: 'utf8', timeout: timeoutMs, env: process.env });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, code: r.status, out: r.error ? `${r.error.message}\n${out}` : out };
}
function git(...args) { return run('git', args, 2 * 60 * 1000); }
function tail(s, n = 15) { return String(s).split('\n').slice(-n).join('\n'); }

function packageVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(a.appDir, 'package.json'), 'utf8')).version; } catch { return null; }
}

function npmInstall() {
  say('npm install --omit=dev');
  const r = run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
  if (!r.ok) say(`npm install failed (exit ${r.code}):\n${tail(r.out)}`);
  return r.ok;
}

function restart() {
  const s = a.supervisor;
  let r;
  if (s.kind === 'pm2') {
    say(`Restarting (pm2 restart ${s.name})`);
    r = run('pm2', ['restart', s.name], 60 * 1000);
  } else {
    say(`Restarting (systemctl restart ${s.unit})`);
    r = run('systemctl', ['restart', s.unit], 60 * 1000);
  }
  if (!r.ok) say(`Restart command failed (exit ${r.code}):\n${tail(r.out)}`);
  return r.ok;
}

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: a.host, port: a.port, path: p, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Up when /api/health answers from a process started after `since` (and, if
// given, with the expected version). A version from before v0.5.0 has no
// /api/health: then any answer from /api/auth/state after the restart counts.
async function waitHealthy(since, expectVersion, timeoutMs = 90 * 1000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await get('/api/health');
    if (h && h.status === 200) {
      try {
        const j = JSON.parse(h.body);
        if (Date.parse(j.startedAt) >= since - 1000 && (!expectVersion || j.version === expectVersion)) return j.version;
      } catch {}
      continue;
    }
    if (h && h.status === 404 && !expectVersion) {
      const s = await get('/api/auth/state');
      if (s && s.status === 200) return '(older version)';
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(path.dirname(a.statusFile), { recursive: true });
  say(`Self-update started (${a.reason}${a.by ? `, ${a.by}` : ''}); running v${a.from}`);

  const prev = git('rev-parse', 'HEAD');
  if (!prev.ok) return finish('failed', `Not a git clone? ${tail(prev.out, 3)}`);
  const prevSha = prev.out.trim();

  const f = git('fetch', 'origin', a.branch);
  if (!f.ok) return finish('failed', `git fetch failed; nothing changed.\n${tail(f.out, 5)}`);
  const m = git('merge', '--ff-only', `origin/${a.branch}`);
  if (!m.ok) return finish('failed', `Can't fast-forward to origin/${a.branch} (local commits?); nothing changed.\n${tail(m.out, 5)}`);
  const newSha = git('rev-parse', 'HEAD').out.trim();
  if (newSha === prevSha) return finish('current', `Already up to date (v${a.from}).`, { to: a.from });

  const to = packageVersion();
  status.to = to;
  say(`Pulled ${prevSha.slice(0, 12)} -> ${newSha.slice(0, 12)} (v${to})`);

  if (!npmInstall()) {
    git('reset', '--hard', prevSha);
    npmInstall();
    return finish('failed', `npm install failed for v${to}; went back to v${a.from} (ShipPilot was not restarted).`);
  }

  const t1 = Date.now();
  restart();
  const up = await waitHealthy(t1, to);
  if (up) return finish('success', `Updated v${a.from} -> v${to}.`);

  say(`v${to} did not come up within 90 s; rolling back to v${a.from}.`);
  git('reset', '--hard', prevSha);
  npmInstall();
  const t2 = Date.now();
  restart();
  const back = await waitHealthy(t2, null);
  if (back) return finish('rolled-back', `v${to} didn't start; rolled back to v${a.from}. See the log and PM2/systemd logs.`, { to: a.from });
  return finish('rollback-failed', `v${to} didn't start and v${a.from} didn't come back either. Fix by hand on the ShipPilot machine (git log, pm2 logs / journalctl).`);
}

main().catch((e) => finish('failed', `Updater error: ${e.stack || e.message}`));

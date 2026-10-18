// ShipPilot updating itself (v0.5.0).
//
// ShipPilot runs from a git clone of its own repo. When it ships a release of
// that repo (or the maintainer presses "Update now"), it starts
// scripts/self-update.js OUTSIDE its own process: that helper pulls,
// runs npm install, restarts ShipPilot through its supervisor (PM2 or
// systemd), waits until the new version answers /api/health, and if it
// doesn't, puts the previous commit back and restarts again. The helper
// has to live outside: restarting kills the process that asked for it.
//
// Status goes to data/self-update.json, which this module reads back so the
// page can show what happened even though the process that started the
// update is gone.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { git } = require('./git');
const db = require('./db');

const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const STATUS_FILE = path.join(DATA_DIR, 'self-update.json');
const LOG_FILE = path.join(DATA_DIR, 'self-update.log');
const HELPER = path.join(APP_DIR, 'scripts', 'self-update.js');
const STARTED_AT = Date.now();
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

let app = { isGit: false, branch: null, origin: null, ownerRepo: null };
let lastCheck = null;
let config = null;
let releasesInFlight = 0;
let pendingStart = null;

// "owner/repo" (lowercase) from any GitHub remote form, including the
// git@github-<alias>:Owner/Repo.git form ShipPilot's SSH config uses.
function ownerRepo(url) {
  if (!url) return null;
  const m = String(url).trim().replace(/\/+$/, '').replace(/\.git$/, '').match(/[:/]([^/:]+)\/([^/:]+)$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// How ShipPilot is kept running, and so how it can be restarted.
function supervisor() {
  if (process.env.pm_id !== undefined && process.env.name) return { kind: 'pm2', name: process.env.name };
  if (process.env.INVOCATION_ID) {
    try {
      const cg = fs.readFileSync('/proc/self/cgroup', 'utf8');
      const m = cg.match(/\/([^/\n]+\.service)\s*$/m);
      if (m) return { kind: 'systemd', unit: m[1] };
    } catch {}
  }
  return null;
}

async function init(cfg) {
  config = cfg;
  if (!fs.existsSync(path.join(APP_DIR, '.git'))) return;
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], APP_DIR)).stdout.trim();
  const origin = (await git(['remote', 'get-url', 'origin'], APP_DIR)).stdout.trim();
  app = { isGit: true, branch: branch && branch !== 'HEAD' ? branch : null, origin: origin || null, ownerRepo: ownerRepo(origin) };
}

function autoEnabled() {
  return db.getSetting('selfUpdate.auto', '1') === '1';
}
function setAuto(on) {
  db.setSetting('selfUpdate.auto', on ? '1' : '0');
}

// Why updating can't work here, or null when it can.
function unsupportedReason() {
  if (!app.isGit) return 'ShipPilot is not running from a git clone, so it can\'t pull its own updates.';
  if (!app.branch) return 'ShipPilot\'s clone is not on a branch (detached HEAD).';
  if (!app.ownerRepo) return 'ShipPilot\'s clone has no GitHub "origin" remote.';
  if (!supervisor()) return 'ShipPilot isn\'t running under PM2 or systemd, so it can\'t restart itself.';
  return null;
}

// Is this ShipPilot repo slug the code this process runs from?
function isSelfRepo(slug) {
  if (!app.ownerRepo) return false;
  const row = db.getRepoBySlug(slug);
  if (!row) return false;
  const same = ownerRepo(row.remote_original) === app.ownerRepo || ownerRepo(row.remote_aliased) === app.ownerRepo;
  return same && row.branch === app.branch;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readStatus() {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return null; }
  // A helper that died mid-update (machine rebooted, killed) leaves "running".
  if (st && (st.state === 'starting' || st.state === 'running') && !pidAlive(st.pid)) {
    const age = Date.now() - Date.parse(st.updatedAt || st.startedAt || 0);
    if (age > 2 * 60 * 1000) { st.state = 'failed'; st.message = 'The update stopped without finishing (helper process gone).'; }
  }
  return st;
}

function writeStatus(st) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, STATUS_FILE);
}

function busy() {
  if (pendingStart) return true;
  const st = readStatus();
  return !!(st && (st.state === 'starting' || st.state === 'running'));
}

async function info() {
  const sup = supervisor();
  return {
    version: VERSION,
    startedAt: new Date(STARTED_AT).toISOString(),
    branch: app.branch,
    repo: app.ownerRepo,
    supervisor: sup ? (sup.kind === 'pm2' ? `PM2 (${sup.name})` : `systemd (${sup.unit})`) : null,
    supported: !unsupportedReason(),
    reason: unsupportedReason(),
    auto: autoEnabled(),
    waiting: pendingStart ? pendingStart.waitingFor : null,
    status: readStatus(),
    check: lastCheck,
  };
}

// Look at GitHub: how many commits is the running clone behind, and which
// version is there?
async function check() {
  const reason = unsupportedReason();
  if (reason && !app.isGit) return (lastCheck = { checkedAt: new Date().toISOString(), error: reason });
  const f = await git(['fetch', '--quiet', 'origin', app.branch], APP_DIR);
  if (f.code !== 0) return (lastCheck = { checkedAt: new Date().toISOString(), error: `git fetch failed: ${(f.stderr || f.stdout).trim().slice(0, 300)}` });
  const behind = parseInt((await git(['rev-list', '--count', `HEAD..origin/${app.branch}`], APP_DIR)).stdout.trim(), 10) || 0;
  let remoteVersion = null;
  const show = await git(['show', `origin/${app.branch}:package.json`], APP_DIR);
  try { remoteVersion = JSON.parse(show.stdout).version; } catch {}
  lastCheck = { checkedAt: new Date().toISOString(), behind, remoteVersion };
  return lastCheck;
}

function noteReleaseStart() { releasesInFlight++; }
function noteReleaseEnd() { releasesInFlight = Math.max(0, releasesInFlight - 1); }

// Start an update. Waits (up to 15 minutes) for releases and deploys that
// are still running, because the restart would cut them off.
async function start({ reason, by }) {
  const why = unsupportedReason();
  if (why) throw Object.assign(new Error(why), { status: 409 });
  if (busy()) throw Object.assign(new Error('An update is already running.'), { status: 409 });
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'], APP_DIR);
  if (dirty.stdout.trim()) {
    throw Object.assign(new Error('ShipPilot\'s own folder has local changes to tracked files; update it by hand (git status).'), { status: 409 });
  }

  pendingStart = { waitingFor: null };
  writeStatus({ state: 'starting', reason, by: by || null, from: VERSION, startedAt: new Date().toISOString(), pid: process.pid, message: 'Waiting for running releases and deploys to finish…', log: [] });
  (async () => {
    try {
      const until = Date.now() + 15 * 60 * 1000;
      for (;;) {
        const deploys = db.countRunningDeploys();
        if (!releasesInFlight && !deploys) break;
        pendingStart.waitingFor = releasesInFlight ? 'a release' : 'a deploy';
        if (Date.now() > until) throw new Error(`Gave up waiting for ${pendingStart.waitingFor} to finish.`);
        await new Promise((r) => setTimeout(r, 3000));
      }
      launchHelper({ reason, by });
    } catch (e) {
      writeStatus({ state: 'failed', reason, by: by || null, from: VERSION, startedAt: new Date().toISOString(), message: e.message, log: [] });
    } finally {
      pendingStart = null;
    }
  })();
}

function launchHelper({ reason, by }) {
  const sup = supervisor();
  const host = !config.host || config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const args = Buffer.from(JSON.stringify({
    appDir: APP_DIR,
    branch: app.branch,
    statusFile: STATUS_FILE,
    logFile: LOG_FILE,
    host,
    port: config.port,
    supervisor: sup,
    from: VERSION,
    reason,
    by: by || null,
    nodeDir: path.dirname(process.execPath),
  })).toString('base64');

  let cmd, cmdArgs;
  if (sup.kind === 'systemd') {
    // A transient unit: `systemctl restart` stops everything in ShipPilot's
    // own unit, which would include a plain child process.
    cmd = 'systemd-run';
    cmdArgs = ['--unit', `shippilot-self-update-${Date.now()}`, '--collect', '--quiet', process.execPath, HELPER, args];
  } else {
    // setsid --fork: the helper is re-parented away from ShipPilot, so PM2's
    // restart (which kills the process tree) leaves it running.
    cmd = 'setsid';
    cmdArgs = ['--fork', process.execPath, HELPER, args];
  }
  const child = spawn(cmd, cmdArgs, { cwd: APP_DIR, detached: true, stdio: 'ignore', env: process.env });
  child.on('error', (e) => {
    writeStatus({ state: 'failed', reason, by: by || null, from: VERSION, startedAt: new Date().toISOString(), message: `Could not start the update helper (${cmd}): ${e.message}`, log: [] });
  });
  child.unref();
}

// After a successful release: update ourselves if it was our own repo and
// automatic updates are on. Returns true when an update was queued.
function maybeAutoUpdate(repoSlug, by) {
  if (!autoEnabled() || unsupportedReason() || !isSelfRepo(repoSlug) || busy()) return false;
  // A moment's delay so the release response reaches the browser first.
  setTimeout(() => {
    start({ reason: 'release', by }).catch((e) => console.error(`[self-update] ${e.message}`));
  }, 2000);
  return true;
}

module.exports = {
  init, info, check, start, maybeAutoUpdate, setAuto, autoEnabled, isSelfRepo,
  noteReleaseStart, noteReleaseEnd, VERSION, STARTED_AT,
  // exported for tests
  ownerRepo,
};

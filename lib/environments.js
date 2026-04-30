// Environment lifecycle management.
//
// Environments are deploy targets — hosts ShipPilot SSHes into to apply
// updates after a release. Mirrors lib/repos.js patterns: per-env Ed25519
// keypair, slug-based addressing, validation regexes mean to be paranoid
// about anything that ends up in a path or hostname.
//
// Add: validate inputs → generate keypair under data/env-ssh-keys/<slug> →
// insert DB row. Custom actions (if any) are added separately via the UI,
// but the caller can pass a `seedActions` array on add to drop in defaults
// for a freshly-created env.
//
// Delete: remove DB row (cascade deletes env_actions and deploys), delete
// the key files (if managed).
//
// Test: opens an SSH connection and runs `echo ok`. On first successful
// connect we set host_key_verified=1 so subsequent deploys don't accept
// new host keys silently — anyone who can MITM after that point makes
// the deploy fail loudly.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { run } = require('./git');
const db = require('./db');
const ssh = require('./ssh');

// Slugs need to be filesystem-safe (used as a path component for the key
// file) and DNS-ish. Same rule as repos.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// Hostname or IPv4. Conservative: letters/digits/hyphens/dots, 1–253 chars.
// Doesn't validate IPv6 — if someone needs that, they can extend later.
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

// SSH usernames: alphanumerics, dot, underscore, hyphen. No leading hyphen.
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;

// Absolute Unix path. Loose-but-safe: no shell metacharacters, no whitespace
// at the boundaries. Subset of "valid path" but everything ShipPilot needs
// fits inside it.
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,255}$/;

function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error('Slug must be 2–32 characters: lowercase letters, digits, hyphens (must start with a letter or digit).');
  }
}
function validateHost(host) {
  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    throw new Error('Host must be a valid hostname or IP address.');
  }
}
function validateUser(user) {
  if (typeof user !== 'string' || !USER_RE.test(user)) {
    throw new Error('SSH user must be a valid Unix username.');
  }
}
function validatePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('SSH port must be an integer between 1 and 65535.');
  }
  return n;
}
function validateDeployPath(p) {
  if (typeof p !== 'string' || !PATH_RE.test(p)) {
    throw new Error('Deploy path must be an absolute Unix path (e.g. /opt/showpilot).');
  }
}
function validateDeployScript(s) {
  if (typeof s !== 'string' || !s.trim()) {
    throw new Error('Deploy script is required.');
  }
  if (s.length > 16000) {
    throw new Error('Deploy script is too long (max 16000 characters).');
  }
}

function keyPathFor(config, slug) {
  return path.join(config.envSshKeysDir, slug);
}

async function listEnvironments() {
  return db.listEnvironments();
}

async function addEnvironment(input, config, { seedActions = [] } = {}) {
  const slug = input.slug;
  const repoSlug = input.repo_slug || input.repoSlug;
  validateSlug(slug);
  validateHost(input.host);
  validateUser(input.ssh_user || input.sshUser);
  const port = validatePort(input.ssh_port || input.sshPort || 22);
  validateDeployPath(input.deploy_path || input.deployPath);
  validateDeployScript(input.deploy_script || input.deployScript);

  if (!repoSlug || !db.getRepoBySlug(repoSlug)) {
    throw new Error(`Unknown repo "${repoSlug}". Add the repo first.`);
  }
  if (db.getEnvironmentBySlug(slug)) {
    throw new Error(`An environment named "${slug}" already exists`);
  }

  // Generate keypair before touching the DB. If keygen fails, no DB row.
  await fsp.mkdir(config.envSshKeysDir, { recursive: true, mode: 0o700 });
  const keyPath = keyPathFor(config, slug);

  // Don't clobber an existing key file with the same path — that would
  // break any other env using it. Should never happen because slug is
  // unique, but defense in depth.
  if (fs.existsSync(keyPath)) {
    throw new Error(`Key file already exists at ${keyPath} — refusing to overwrite. Remove it manually if it's truly orphaned.`);
  }

  const keygen = await run('ssh-keygen', [
    '-t', 'ed25519',
    '-f', keyPath,
    '-N', '',
    '-C', `shippilot-env:${slug}`,
  ]);
  if (keygen.code !== 0) {
    throw new Error(`ssh-keygen failed: ${keygen.stderr || keygen.stdout}`);
  }
  await fsp.chmod(keyPath, 0o600);

  let id;
  try {
    id = db.createEnvironment({
      slug,
      name: input.name || slug,
      host: input.host,
      ssh_user: input.ssh_user || input.sshUser,
      ssh_port: port,
      key_path: keyPath,
      managed: 1,
      repo_slug: repoSlug,
      deploy_path: input.deploy_path || input.deployPath,
      deploy_script: input.deploy_script || input.deployScript,
      log_command: input.log_command || input.logCommand || null,
      version_check_command: input.version_check_command || input.versionCheckCommand || null,
      auto_deploy: input.auto_deploy === undefined ? 1 : (input.auto_deploy ? 1 : 0),
      host_key_verified: 0,
    });
    for (const action of seedActions) {
      db.createEnvAction({
        env_id: id,
        label: action.label,
        command: action.command,
        requires_confirmation: action.requires_confirmation ? 1 : 0,
        sort_order: action.sort_order || 0,
      });
    }
  } catch (e) {
    // Rollback: delete the key files we just created (DB row never landed)
    try { await fsp.unlink(keyPath); } catch {}
    try { await fsp.unlink(keyPath + '.pub'); } catch {}
    if (id) try { db.deleteEnvironmentById(id); } catch {}
    throw e;
  }

  const publicKey = (await fsp.readFile(keyPath + '.pub', 'utf8')).trim();
  return { env: db.getEnvironmentBySlug(slug), publicKey };
}

async function updateEnvironment(slug, fields) {
  const env = db.getEnvironmentBySlug(slug);
  if (!env) throw new Error('Unknown environment');

  // Validate any fields the caller is updating (skip ones they didn't send).
  if ('host' in fields) validateHost(fields.host);
  if ('ssh_user' in fields) validateUser(fields.ssh_user);
  if ('ssh_port' in fields) fields.ssh_port = validatePort(fields.ssh_port);
  if ('deploy_path' in fields) validateDeployPath(fields.deploy_path);
  if ('deploy_script' in fields) validateDeployScript(fields.deploy_script);
  if ('repo_slug' in fields) {
    if (!fields.repo_slug || !db.getRepoBySlug(fields.repo_slug)) {
      throw new Error(`Unknown repo "${fields.repo_slug}".`);
    }
  }
  if ('auto_deploy' in fields) fields.auto_deploy = fields.auto_deploy ? 1 : 0;

  // host_key_verified gets reset to 0 if any connection-defining field
  // changes, because the trust we established was for the OLD endpoint.
  // Forces the user to re-test before the next deploy.
  if ('host' in fields || 'ssh_port' in fields) {
    fields.host_key_verified = 0;
  }

  db.updateEnvironment(env.id, fields);
  return db.getEnvironmentBySlug(slug);
}

async function getPublicKey(slug) {
  const env = db.getEnvironmentBySlug(slug);
  if (!env) throw new Error('Unknown environment');
  if (!env.key_path) throw new Error('This environment has no managed key');
  const pub = await fsp.readFile(env.key_path + '.pub', 'utf8');
  return pub.trim();
}

// Open a connection and run `echo shippilot-ok`. On first success, mark
// host_key_verified so future deploys reject changed host keys.
async function testConnection(slug, config) {
  const env = db.getEnvironmentBySlug(slug);
  if (!env) throw new Error('Unknown environment');

  try {
    const result = await ssh.execOne(env, 'echo shippilot-ok', config);
    if (result.code === 0 && result.stdout.trim() === 'shippilot-ok') {
      if (!env.host_key_verified) {
        db.updateEnvironment(env.id, { host_key_verified: 1 });
      }
      return { ok: true, message: 'Connected and ran echo successfully.' };
    }
    return {
      ok: false,
      message: `Connection succeeded but echo returned unexpected output. stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// Run version_check_command if set, return the trimmed stdout.
async function probeVersion(slug, config) {
  const env = db.getEnvironmentBySlug(slug);
  if (!env) throw new Error('Unknown environment');
  if (!env.version_check_command) return { ok: false, version: null, message: 'No version_check_command configured' };
  try {
    const result = await ssh.execOne(env, env.version_check_command, config);
    if (result.code !== 0) {
      return { ok: false, version: null, message: result.stderr.trim() || `exit ${result.code}` };
    }
    return { ok: true, version: result.stdout.trim() || null };
  } catch (e) {
    return { ok: false, version: null, message: e.message };
  }
}

async function deleteEnvironment(slug) {
  const env = db.getEnvironmentBySlug(slug);
  if (!env) throw new Error('Unknown environment');

  // DB delete cascades env_actions and deploys via FK.
  db.deleteEnvironmentById(env.id);

  if (env.managed && env.key_path) {
    try { await fsp.unlink(env.key_path); } catch {}
    try { await fsp.unlink(env.key_path + '.pub'); } catch {}
  }
  return { ok: true };
}

module.exports = {
  listEnvironments,
  addEnvironment,
  updateEnvironment,
  deleteEnvironment,
  testConnection,
  probeVersion,
  getPublicKey,
  // exports for tests
  validateSlug, validateHost, validateUser, validatePort,
  validateDeployPath, validateDeployScript,
};

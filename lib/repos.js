// Repo lifecycle management.
//
// Adds: validate inputs, generate keypair under data/ssh-keys/<slug>,
// rewrite SSH config managed block, insert DB row.
//
// Deletes: remove DB row, rewrite SSH config without that block, delete
// key files and the cached clone. Each cleanup step is best-effort —
// the DB removal is the authoritative truth, leftover files are cosmetic.
//
// Test connection: ssh -T git@github-<slug>, parse the output for the
// "Hi <Owner>/<Repo>!" line which means GitHub recognized the deploy key.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { run } = require('./git');
const sshConfig = require('./ssh-config');
const db = require('./db');

// Strict slug rule: lowercase letters, digits, hyphens; must start with
// a letter or digit; 2-32 chars. Used as a path component AND a hostname
// alias, so it has to be filesystem- and SSH-safe.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
// SSH URL: git@github.com:Owner/Repo.git — strict to avoid arbitrary
// commands or scheme switching. The Owner and Repo each match GitHub's
// own naming rules (alphanumerics, hyphen, underscore, dot, no leading
// hyphen).
const REMOTE_RE = /^git@github\.com:[A-Za-z0-9_.][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}\.git$/;
// Branch names: git's actual rules are byzantine; this is a safe subset.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error('Slug must be 2–32 characters: lowercase letters, digits, hyphens (must start with a letter or digit).');
  }
}
function validateRemote(remote) {
  if (typeof remote !== 'string' || !REMOTE_RE.test(remote)) {
    throw new Error('Remote must be a GitHub SSH URL like git@github.com:Owner/Repo.git');
  }
}
function validateBranch(branch) {
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) {
    throw new Error('Branch name contains invalid characters');
  }
}

// Convert the user's plain GitHub URL into the alias-bearing form ShipPilot
// uses internally for pushes. e.g. git@github.com:X/Y.git → git@github-<slug>:X/Y.git
function aliasedRemote(slug, remote) {
  return remote.replace(/^git@github\.com:/, `git@github-${slug}:`);
}

// Where this repo's keypair lives. Keys live under data/ so they're
// included in ShipPilot's own backup/replication story rather than being
// scattered around ~/.ssh.
function keyPathFor(config, slug) {
  return path.join(config.sshKeysDir, slug);
}

// Refresh the SSH config managed block from the DB. Call this whenever
// the repo set changes (add, delete).
function syncSshConfig() {
  const repos = db.listRepos();
  const entries = repos.map((r) => ({ slug: r.slug, keyPath: r.key_path }));
  sshConfig.writeManagedBlock(entries);
}

async function listRepos() {
  return db.listRepos();
}

async function addRepo({ slug, remote, branch = 'main' }, config) {
  validateSlug(slug);
  validateRemote(remote);
  validateBranch(branch);
  if (db.getRepoBySlug(slug)) {
    throw new Error(`A repo named "${slug}" already exists`);
  }

  await fsp.mkdir(config.sshKeysDir, { recursive: true, mode: 0o700 });
  const keyPath = keyPathFor(config, slug);

  // Generate the keypair. -N "" = no passphrase. -f sets the output path.
  // -C is a human-readable comment that GitHub will display on the deploy key.
  const keygen = await run('ssh-keygen', [
    '-t', 'ed25519',
    '-f', keyPath,
    '-N', '',
    '-C', `shippilot:${slug}`,
  ]);
  if (keygen.code !== 0) {
    throw new Error(`ssh-keygen failed: ${keygen.stderr || keygen.stdout}`);
  }
  // Private key 0600
  await fsp.chmod(keyPath, 0o600);

  // Insert into DB before rewriting SSH config. If the SSH write fails,
  // we'll roll the DB row back so we don't end up with an orphan.
  const aliased = aliasedRemote(slug, remote);
  let id;
  try {
    id = db.createRepo({
      slug,
      remote_original: remote,
      remote_aliased: aliased,
      branch,
      key_path: keyPath,
      managed: 1,
    });
    syncSshConfig();
  } catch (e) {
    // Cleanup: remove the keys and DB row we just created
    if (id) try { db.deleteRepoById(id); } catch {}
    try { await fsp.unlink(keyPath); } catch {}
    try { await fsp.unlink(keyPath + '.pub'); } catch {}
    throw e;
  }

  const publicKey = await fsp.readFile(keyPath + '.pub', 'utf8');
  return { repo: db.getRepoBySlug(slug), publicKey: publicKey.trim() };
}

// Re-fetch the public key for an existing repo. Handy if the user closed
// the modal before copying it.
async function getPublicKey(slug) {
  const repo = db.getRepoBySlug(slug);
  if (!repo) throw new Error('Unknown repo');
  if (!repo.key_path) throw new Error('This repo has no managed key (it was migrated from manual config)');
  const pub = await fsp.readFile(repo.key_path + '.pub', 'utf8');
  return pub.trim();
}

// Run `ssh -T git@github-<slug>` and check whether GitHub recognized the
// deploy key. GitHub's response includes "Hi <Owner>/<Repo>!" if the key
// matches a deploy key on that repo, or "Hi <user>!" if it's a user key,
// or "Permission denied" if it's not registered at all.
async function testConnection(slug) {
  const repo = db.getRepoBySlug(slug);
  if (!repo) throw new Error('Unknown repo');
  // -o BatchMode=yes prevents any prompt (host key, password) — fail fast
  // -o StrictHostKeyChecking=accept-new auto-accepts new host keys
  const r = await run('ssh', [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `git@github-${slug}`,
  ]);
  // Note: ssh -T to GitHub always exits 1 (because GitHub closes the
  // connection — no shell). What matters is the stderr message.
  const out = (r.stdout + r.stderr).trim();
  // Success indicators
  if (/^Hi [^!]+!/.test(out) && /successfully authenticated/i.test(out)) {
    return { ok: true, message: out.split('\n')[0] };
  }
  if (/Permission denied/i.test(out)) {
    return { ok: false, message: 'Permission denied — make sure you added the public key as a deploy key on the GitHub repo with write access.' };
  }
  // Anything else: pass through the raw output for diagnostics
  return { ok: false, message: out || 'No response from GitHub' };
}

async function deleteRepo(slug, config) {
  const repo = db.getRepoBySlug(slug);
  if (!repo) throw new Error('Unknown repo');

  // 1. Remove from DB (authoritative)
  db.deleteRepoById(repo.id);

  // 2. Rewrite SSH config without this repo's block
  try { syncSshConfig(); }
  catch (e) { console.warn(`[repos] SSH config sync after delete failed: ${e.message}`); }

  // 3. Delete the key files (only if managed — never touch keys we didn't generate)
  if (repo.managed && repo.key_path) {
    try { await fsp.unlink(repo.key_path); } catch {}
    try { await fsp.unlink(repo.key_path + '.pub'); } catch {}
  }

  // 4. Delete the cached clone if it exists
  const cloneDir = path.join(config.reposDir, repo.slug);
  try { await fsp.rm(cloneDir, { recursive: true, force: true }); } catch {}

  return { ok: true };
}

// Migrate repos defined in config.js into the DB on first run. Called from
// server startup. Skips entries already in the DB. Migrated entries are
// recorded as `managed=0` because we didn't generate their keys — we don't
// know which key file SSH will use for them, only that the existing manual
// SSH config handles it. We store the alias-form remote since that's what
// the existing config.js entries already use post-manual-setup.
function migrateFromConfig(config) {
  if (!config.repos || typeof config.repos !== 'object') return;
  let migrated = 0;
  for (const [slug, info] of Object.entries(config.repos)) {
    if (!info || typeof info.remote !== 'string') continue;
    if (db.getRepoBySlug(slug)) continue;
    // We can't easily recover the original remote (the user-pasted GitHub URL)
    // because by the time it's in config.js, the alias form is already in
    // place. Store the alias form as both — it's still pushable as-is.
    db.createRepo({
      slug,
      remote_original: info.remote,
      remote_aliased: info.remote,
      branch: info.branch || 'main',
      key_path: null, // we don't manage this key — user set it up by hand
      managed: 0,
    });
    migrated += 1;
  }
  if (migrated > 0) {
    console.log(`[repos] Migrated ${migrated} repo${migrated === 1 ? '' : 's'} from config.js`);
    // Don't sync SSH config — manual entries are already in place; we'd
    // overwrite them with broken paths. Managed-block sync only matters
    // once managed repos exist.
  }
}

// Look up the remote/branch for the release pipeline. Falls back to
// config.repos for backwards compat if the slug isn't in the DB.
function getRepoForPipeline(slug, config) {
  const row = db.getRepoBySlug(slug);
  if (row) return { remote: row.remote_aliased, branch: row.branch };
  if (config.repos && config.repos[slug]) return config.repos[slug];
  return null;
}

module.exports = {
  listRepos,
  addRepo,
  deleteRepo,
  testConnection,
  getPublicKey,
  migrateFromConfig,
  getRepoForPipeline,
  // Exported for tests
  validateSlug, validateRemote, validateBranch, aliasedRemote,
};

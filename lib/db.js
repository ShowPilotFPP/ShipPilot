// SQLite schema and helpers. Two tables: users (admin only, single row in
// practice) and releases (audit log of every shipped tarball).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      repo TEXT NOT NULL,
      version TEXT NOT NULL,
      tag TEXT,
      commit_message TEXT NOT NULL,
      commit_sha TEXT,
      status TEXT NOT NULL,           -- 'success' | 'failed'
      error_message TEXT,
      log TEXT                         -- full stdout/stderr capture
    );

    CREATE INDEX IF NOT EXISTS idx_releases_created ON releases(created_at DESC);

    -- Repos managed by ShipPilot. Source of truth for which repos can be
    -- shipped to. config.repos is a deprecated seed source — entries get
    -- migrated into this table on first boot of v0.2+.
    --
    -- managed=1 means ShipPilot generated the SSH key and owns the
    -- ~/.ssh/config block for this repo. managed=0 means it was migrated
    -- from manual setup; we leave its key alone on delete.
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      remote_original TEXT NOT NULL,   -- what the user typed (or migrated)
      remote_aliased TEXT NOT NULL,    -- the git@github-<slug>:... form
      branch TEXT NOT NULL DEFAULT 'main',
      key_path TEXT,                   -- absolute path to private key, NULL for unmanaged
      managed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Environments are deploy targets. After a successful release, ShipPilot
    -- looks up every environment whose repo_slug matches the released repo
    -- and (if auto_deploy=1) SSHes in to run its deploy_script. One LXC can
    -- host multiple environments — the demo box has both a "showpilot" env
    -- (the running app) and a "showpilot-demo" env (the bundle scripts).
    --
    -- managed=1 means ShipPilot generated the SSH key. On delete we remove
    -- the key file and our marker block from ~/.ssh/config; managed=0 keys
    -- are left alone (none currently, but mirrors the repos table pattern
    -- for future-proofing).
    --
    -- deploy_script is a free-form shell script that runs over SSH on the
    -- target after a release. It receives RELEASE_TAG, RELEASE_VERSION, and
    -- RELEASE_REPO env vars so the script can pin to the exact version that
    -- was just shipped.
    CREATE TABLE IF NOT EXISTS environments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      ssh_user TEXT NOT NULL,
      ssh_port INTEGER NOT NULL DEFAULT 22,
      key_path TEXT,
      managed INTEGER NOT NULL DEFAULT 1,
      repo_slug TEXT NOT NULL,
      deploy_path TEXT NOT NULL,
      deploy_script TEXT NOT NULL,
      log_command TEXT,
      version_check_command TEXT,
      auto_deploy INTEGER NOT NULL DEFAULT 1,
      host_key_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_environments_repo ON environments(repo_slug);

    -- Custom action buttons per environment. Built-in actions (Tail Logs,
    -- Test SSH, Refresh Version) are not stored here — they're hardcoded
    -- in the UI driven by columns on environments. Custom actions are the
    -- env-specific things like "Force Reset Now" or "Snapshot Seed".
    CREATE TABLE IF NOT EXISTS env_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      command TEXT NOT NULL,
      requires_confirmation INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (env_id) REFERENCES environments(id) ON DELETE CASCADE
    );

    -- Audit log of every deploy attempt and action invocation. trigger
    -- distinguishes auto-deploys (post-release), manual deploys (user
    -- clicked "Deploy now"), and custom action clicks.
    CREATE TABLE IF NOT EXISTS deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env_id INTEGER NOT NULL,
      release_id INTEGER,
      trigger TEXT NOT NULL,
      action_label TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      log TEXT,
      FOREIGN KEY (env_id) REFERENCES environments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_deploys_env ON deploys(env_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deploys_release ON deploys(release_id);
  `);

  return db;
}

function get() {
  if (!db) throw new Error('DB not initialised — call init() first');
  return db;
}

// User helpers
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function createUser({ username, passwordHash, mustChangePassword = 0 }) {
  return db.prepare(
    'INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, ?)'
  ).run(username, passwordHash, mustChangePassword);
}
function updateUserPassword(id, passwordHash) {
  return db.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?'
  ).run(passwordHash, id);
}
function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// Release helpers
function recordRelease(row) {
  return db.prepare(`
    INSERT INTO releases (repo, version, tag, commit_message, commit_sha, status, error_message, log)
    VALUES (@repo, @version, @tag, @commit_message, @commit_sha, @status, @error_message, @log)
  `).run(row);
}
function listReleases(limit = 50) {
  return db.prepare(
    'SELECT id, created_at, repo, version, tag, commit_message, commit_sha, status, error_message FROM releases ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}
function getReleaseLog(id) {
  return db.prepare('SELECT log FROM releases WHERE id = ?').get(id);
}

// Repo helpers
function listRepos() {
  return db.prepare(
    'SELECT id, slug, remote_original, remote_aliased, branch, key_path, managed, created_at FROM repos ORDER BY slug'
  ).all();
}
function getRepoBySlug(slug) {
  return db.prepare('SELECT * FROM repos WHERE slug = ?').get(slug);
}
function createRepo(row) {
  const r = db.prepare(`
    INSERT INTO repos (slug, remote_original, remote_aliased, branch, key_path, managed)
    VALUES (@slug, @remote_original, @remote_aliased, @branch, @key_path, @managed)
  `).run(row);
  return r.lastInsertRowid;
}
function deleteRepoById(id) {
  return db.prepare('DELETE FROM repos WHERE id = ?').run(id);
}
function repoCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM repos').get().n;
}

// Environment helpers
function listEnvironments() {
  return db.prepare(`
    SELECT id, slug, name, host, ssh_user, ssh_port, key_path, managed,
           repo_slug, deploy_path, deploy_script, log_command,
           version_check_command, auto_deploy, host_key_verified, created_at
    FROM environments
    ORDER BY name
  `).all();
}
function getEnvironmentBySlug(slug) {
  return db.prepare('SELECT * FROM environments WHERE slug = ?').get(slug);
}
function getEnvironmentById(id) {
  return db.prepare('SELECT * FROM environments WHERE id = ?').get(id);
}
function listEnvironmentsByRepo(repoSlug, autoDeployOnly = false) {
  if (autoDeployOnly) {
    return db.prepare(
      'SELECT * FROM environments WHERE repo_slug = ? AND auto_deploy = 1 ORDER BY name'
    ).all(repoSlug);
  }
  return db.prepare('SELECT * FROM environments WHERE repo_slug = ? ORDER BY name').all(repoSlug);
}
function createEnvironment(row) {
  const r = db.prepare(`
    INSERT INTO environments (
      slug, name, host, ssh_user, ssh_port, key_path, managed,
      repo_slug, deploy_path, deploy_script, log_command,
      version_check_command, auto_deploy, host_key_verified
    ) VALUES (
      @slug, @name, @host, @ssh_user, @ssh_port, @key_path, @managed,
      @repo_slug, @deploy_path, @deploy_script, @log_command,
      @version_check_command, @auto_deploy, @host_key_verified
    )
  `).run(row);
  return r.lastInsertRowid;
}
function updateEnvironment(id, fields) {
  // Whitelist updatable columns to keep this tight.
  const allowed = [
    'name', 'host', 'ssh_user', 'ssh_port', 'repo_slug', 'deploy_path',
    'deploy_script', 'log_command', 'version_check_command',
    'auto_deploy', 'host_key_verified',
  ];
  const sets = [];
  const params = { id };
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) {
      sets.push(`${k} = @${k}`);
      params[k] = fields[k];
    }
  }
  if (!sets.length) return { changes: 0 };
  return db.prepare(`UPDATE environments SET ${sets.join(', ')} WHERE id = @id`).run(params);
}
function deleteEnvironmentById(id) {
  return db.prepare('DELETE FROM environments WHERE id = ?').run(id);
}

// Env action helpers
function listEnvActions(envId) {
  return db.prepare(
    'SELECT id, env_id, label, command, requires_confirmation, sort_order FROM env_actions WHERE env_id = ? ORDER BY sort_order, id'
  ).all(envId);
}
function getEnvAction(id) {
  return db.prepare('SELECT * FROM env_actions WHERE id = ?').get(id);
}
function createEnvAction(row) {
  const r = db.prepare(`
    INSERT INTO env_actions (env_id, label, command, requires_confirmation, sort_order)
    VALUES (@env_id, @label, @command, @requires_confirmation, @sort_order)
  `).run(row);
  return r.lastInsertRowid;
}
function deleteEnvActionById(id) {
  return db.prepare('DELETE FROM env_actions WHERE id = ?').run(id);
}

// Deploy helpers
function startDeploy(row) {
  const r = db.prepare(`
    INSERT INTO deploys (env_id, release_id, trigger, action_label, status, log)
    VALUES (@env_id, @release_id, @trigger, @action_label, 'running', '')
  `).run(row);
  return r.lastInsertRowid;
}
function finishDeploy(id, { status, errorMessage, log }) {
  return db.prepare(`
    UPDATE deploys
    SET finished_at = CURRENT_TIMESTAMP, status = ?, error_message = ?, log = ?
    WHERE id = ?
  `).run(status, errorMessage || null, log || '', id);
}
function listDeploys(envId, limit = 50) {
  if (envId) {
    return db.prepare(`
      SELECT id, env_id, release_id, trigger, action_label, started_at, finished_at,
             status, error_message
      FROM deploys
      WHERE env_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(envId, limit);
  }
  return db.prepare(`
    SELECT id, env_id, release_id, trigger, action_label, started_at, finished_at,
           status, error_message
    FROM deploys
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit);
}
function getDeployLog(id) {
  return db.prepare('SELECT log FROM deploys WHERE id = ?').get(id);
}
function listDeploysForRelease(releaseId) {
  return db.prepare(
    'SELECT id, env_id, status, error_message, started_at, finished_at FROM deploys WHERE release_id = ? ORDER BY started_at'
  ).all(releaseId);
}

module.exports = {
  init, get,
  getUserByUsername, createUser, updateUserPassword, userCount,
  recordRelease, listReleases, getReleaseLog,
  listRepos, getRepoBySlug, createRepo, deleteRepoById, repoCount,
  listEnvironments, getEnvironmentBySlug, getEnvironmentById,
  listEnvironmentsByRepo, createEnvironment, updateEnvironment, deleteEnvironmentById,
  listEnvActions, getEnvAction, createEnvAction, deleteEnvActionById,
  startDeploy, finishDeploy, listDeploys, getDeployLog, listDeploysForRelease,
};

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

module.exports = {
  init, get,
  getUserByUsername, createUser, updateUserPassword, userCount,
  recordRelease, listReleases, getReleaseLog,
  listRepos, getRepoBySlug, createRepo, deleteRepoById, repoCount,
};

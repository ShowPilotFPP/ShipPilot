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

module.exports = {
  init, get,
  getUserByUsername, createUser, updateUserPassword, userCount,
  recordRelease, listReleases, getReleaseLog,
};

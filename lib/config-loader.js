// Loads config.js and applies env-var overrides + auto-generated secrets.
// Mirrors ShowPilot's config-loader pattern so behavior is familiar.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function load() {
  const configPath = path.resolve(__dirname, '..', 'config.js');
  if (!fs.existsSync(configPath)) {
    console.error('config.js not found. Copy config.example.js to config.js and edit.');
    process.exit(1);
  }

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const cfg = require(configPath);

  // Resolve secrets: env > config.js > auto-generated (persisted)
  const secretsPath = path.resolve(__dirname, '..', 'data', 'secrets.json');
  let persisted = {};
  if (fs.existsSync(secretsPath)) {
    try { persisted = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch (e) { persisted = {}; }
  }

  const envJwt = process.env.SHIPPILOT_JWT_SECRET;
  let jwtSecret = envJwt || cfg.jwtSecret || persisted.jwtSecret;
  if (!jwtSecret) {
    jwtSecret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify({ ...persisted, jwtSecret }, null, 2));
    console.log('Generated new jwtSecret and saved to data/secrets.json');
  }
  cfg.jwtSecret = jwtSecret;

  // Resolve relative paths to absolute so callers don't need to care about cwd
  const root = path.resolve(__dirname, '..');
  if (!path.isAbsolute(cfg.dbPath)) cfg.dbPath = path.resolve(root, cfg.dbPath);
  if (!path.isAbsolute(cfg.reposDir)) cfg.reposDir = path.resolve(root, cfg.reposDir);
  // Default sshKeysDir lives next to the DB so backups capture it together.
  if (!cfg.sshKeysDir) cfg.sshKeysDir = path.resolve(root, 'data/ssh-keys');
  else if (!path.isAbsolute(cfg.sshKeysDir)) cfg.sshKeysDir = path.resolve(root, cfg.sshKeysDir);

  return cfg;
}

module.exports = { load };

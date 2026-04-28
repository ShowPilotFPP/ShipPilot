// ShipPilot — entry point.
//
// Mount order invariant (same lesson learned from ShowPilot v0.25.5):
// cookieParser MUST run before any router that calls requireAuth, because
// requireAuth reads req.cookies. Keep the order below intact.

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { load } = require('./lib/config-loader');
const db = require('./lib/db');
const reposLib = require('./lib/repos');
const { makeAuth } = require('./lib/auth');
const authRoutes = require('./routes/auth');
const releaseRoutes = require('./routes/release');
const reposRoutes = require('./routes/repos');

const config = load();
db.init(config.dbPath);
const auth = makeAuth(config);

// One-time migration: copy any repos defined in config.js into the DB so
// the UI can manage them. Existing DB rows are preserved (the migration
// skips slugs that are already present).
reposLib.migrateFromConfig(config);

const app = express();

if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);

// Order: cookieParser before any auth-protected route.
app.use(cookieParser());

// Release routes use multer for the upload (multipart parsing), so they
// don't need express.json. Mount them BEFORE the global json parser so
// they aren't subject to its body-size limit (separate lesson from
// ShowPilot v0.25.4 — global limits clobber endpoint-specific needs).
app.use('/api', releaseRoutes.build(auth, config));

// Global JSON parser for everything else.
app.use(express.json({ limit: '1mb' }));

// Auth routes use JSON bodies, so they go after express.json.
app.use('/api/auth', authRoutes.build(auth));

// Repo management routes also use JSON.
app.use('/api', reposRoutes.build(auth, config));

// Static UI
app.use('/', express.static(path.join(__dirname, 'public')));

// Generic JSON 404 for unknown /api routes (anything else falls through to static).
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

const server = app.listen(config.port, config.host, () => {
  console.log(`ShipPilot listening on http://${config.host}:${config.port}`);
});

function shutdown() {
  console.log('Shutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

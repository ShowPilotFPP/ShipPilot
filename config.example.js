// ============================================================
// ShipPilot — Configuration
// ============================================================

module.exports = {
  // Server
  port: 3200,
  host: '0.0.0.0',

  // Trust proxy — same semantics as ShowPilot. If you put NPM (or any
  // reverse proxy) in front of this, set to 1. If exposed directly, false.
  trustProxy: 1,

  // Database
  dbPath: './data/shippilot.db',

  // Where the managed clones live. The tool will git-clone here on first
  // boot if these paths don't exist.
  reposDir: './data/repos',

  // Repos this tool manages. The `repo` field in a tarball's .release.json
  // must match one of these keys.
  repos: {
    showpilot: {
      remote: 'git@github.com:ShowPilotFPP/ShowPilot.git',
      branch: 'main',
    },
    'showpilot-plugin': {
      remote: 'git@github.com:ShowPilotFPP/ShowPilot-plugin.git',
      branch: 'main',
    },
  },

  // Git identity for commits made by this tool.
  gitAuthor: {
    name: 'ShipPilot',
    email: 'shippilot@lightsondrake.org',
  },

  // ============================================================
  // Auth secret — auto-generated on first start
  // ============================================================
  // Set to null to auto-generate and persist to data/secrets.json.
  // Override with SHIPPILOT_JWT_SECRET env var if needed.
  jwtSecret: null,
  sessionCookieName: 'shippilot_session',
  sessionDurationHours: 24 * 30, // 30 days

  // Max upload size for tarballs (bytes). 100 MB matches ShowPilot's
  // backup endpoints, plenty of headroom for any realistic release.
  maxUploadBytes: 100 * 1024 * 1024,

  // Logging
  logLevel: 'info',
};

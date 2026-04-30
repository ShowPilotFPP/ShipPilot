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

  // Where SSH keys for managed repos live. ShipPilot generates a unique
  // Ed25519 keypair under this directory whenever you add a repo through
  // the UI. Default: ./data/ssh-keys
  // sshKeysDir: './data/ssh-keys',

  // Where SSH keys for managed environments live. Separate from sshKeysDir
  // so a compromised env key doesn't give GitHub access (and vice versa).
  // Default: ./data/env-ssh-keys
  // envSshKeysDir: './data/env-ssh-keys',

  // Where pinned remote host keys live (one file per env). On first
  // successful Test SSH, the host's key is captured here and from then on
  // any change to the host key fails the deploy loudly.
  // Default: ./data/env-known-hosts
  // envKnownHostsDir: './data/env-known-hosts',

  // ============================================================
  // DEPRECATED — repos are now managed via the UI and stored in the DB
  // ============================================================
  // The `repos` block below is kept for backwards compatibility and as a
  // first-boot seed. On startup, any entries here that aren't already in
  // the DB will be imported. After import, you should manage repos
  // through the web UI (Add/Delete/Test buttons) — that path generates
  // keys for you and writes the SSH config block automatically.
  //
  // For new installs, you can leave this empty: {} — the UI handles
  // everything.
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

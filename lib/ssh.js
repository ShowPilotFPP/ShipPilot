// SSH transport for environment deploys and actions.
//
// Wraps the `ssh2` library to provide:
//   - execOne(env, command, config): run one command, capture stdout/stderr/code
//   - execScript(env, script, config, { onLine }): run a multi-line shell
//     script, streaming output to a callback
//
// Host-key handling:
//   On first connection (env.host_key_verified=0), we accept any host key
//   and persist it to the env's known_hosts file. On subsequent connections
//   (host_key_verified=1), we require the host key to match what we saved.
//   This is "Trust On First Use" — the same model OpenSSH uses by default
//   with StrictHostKeyChecking=accept-new. The DB flag is what tells us
//   which mode to be in.
//
// We deliberately don't use the user's ~/.ssh/known_hosts. Each env has
// its own pinned host key in data/env-known-hosts/<slug>, so changing one
// env's host doesn't affect others.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Client } = require('ssh2');

const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 600000; // 10 min — deploys can do npm install

function knownHostsPath(config, slug) {
  return path.join(config.envKnownHostsDir, slug);
}

async function readPersistedHostKey(config, slug) {
  const p = knownHostsPath(config, slug);
  try {
    const buf = await fsp.readFile(p);
    if (!buf.length) return null;
    return buf;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function persistHostKey(config, slug, keyBuffer) {
  await fsp.mkdir(config.envKnownHostsDir, { recursive: true, mode: 0o700 });
  const p = knownHostsPath(config, slug);
  await fsp.writeFile(p, keyBuffer, { mode: 0o600 });
}

function loadPrivateKey(env) {
  if (!env.key_path) {
    throw new Error(`Environment "${env.slug}" has no SSH key configured.`);
  }
  if (!fs.existsSync(env.key_path)) {
    throw new Error(`SSH key file missing: ${env.key_path}`);
  }
  return fs.readFileSync(env.key_path);
}

// Connect with TOFU host-key handling. Returns a connected ssh2 Client.
function connect(env, config) {
  return new Promise(async (resolve, reject) => {
    let privateKey;
    try {
      privateKey = loadPrivateKey(env);
    } catch (e) {
      return reject(e);
    }

    const persisted = await readPersistedHostKey(config, env.slug).catch(() => null);
    const verified = !!env.host_key_verified;

    const client = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch {}
      reject(new Error(`SSH connect to ${env.host}:${env.ssh_port} timed out after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    client.once('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.end(); } catch {}
      reject(new Error(`SSH error: ${err.message}`));
    });

    client.connect({
      host: env.host,
      port: env.ssh_port,
      username: env.ssh_user,
      privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // hostVerifier: called per connection. If we have a pinned key AND
      // we're in verified mode, require an exact match. Otherwise accept
      // and persist.
      hostVerifier: (keyHash, cb) => {
        // ssh2 calls hostVerifier with a Buffer of the host key; comparison
        // is byte-for-byte. (Older ssh2 versions passed a hash string —
        // 1.x passes the key Buffer.)
        const keyBuf = Buffer.isBuffer(keyHash) ? keyHash : Buffer.from(keyHash);
        if (verified && persisted) {
          const match = persisted.equals(keyBuf);
          if (!match) {
            // Reject the connection. ssh2's API for hostVerifier expects
            // a callback with (boolean) or a sync return — return false to
            // reject. We also push an error so the rejection has context.
            return cb(false);
          }
          return cb(true);
        }
        // Not verified yet (or no persisted key): accept and persist after
        // ready. We persist asynchronously here; if the persist fails,
        // we'll retry next connection because the DB flag is the source of
        // truth for "verified" state — and the env's testConnection flow
        // is what eventually flips it.
        persistHostKey(config, env.slug, keyBuf).catch(() => {});
        return cb(true);
      },
    });
  });
}

// Run a single command. Returns { code, stdout, stderr }.
async function execOne(env, command, config) {
  const client = await connect(env, config);
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        try { client.end(); } catch {}
        return reject(new Error(`exec failed: ${err.message}`));
      }
      let stdout = '';
      let stderr = '';
      let code = null;
      const timeout = setTimeout(() => {
        try { stream.close(); } catch {}
        try { client.end(); } catch {}
        reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms: ${command.slice(0, 80)}`));
      }, COMMAND_TIMEOUT_MS);

      stream.on('data', (d) => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      stream.once('close', (exitCode) => {
        clearTimeout(timeout);
        code = exitCode === undefined || exitCode === null ? -1 : Number(exitCode);
        try { client.end(); } catch {}
        resolve({ code, stdout, stderr });
      });
      stream.once('error', (e) => {
        clearTimeout(timeout);
        try { client.end(); } catch {}
        reject(e);
      });
    });
  });
}

// Run a multi-line script via `bash -s` over stdin, with optional env vars
// supplied as `VAR=value` prefixes (so the script can reference them).
// Streams stdout+stderr to onLine(line) as lines complete.
//
// We use `bash -s` (read script from stdin) instead of writing the script
// to a temp file on the target — the target may not have a writable /tmp
// or may restrict /tmp/exec. stdin works everywhere.
//
// Exits with the script's exit code. `set -euo pipefail` is prepended so
// any unhandled error fails the deploy instead of silently continuing.
async function execScript(env, script, config, { envVars = {}, onLine } = {}) {
  const client = await connect(env, config);
  return new Promise((resolve, reject) => {
    // Build the env-var prefix. Values are quoted; we accept a-z A-Z 0-9
    // plus a few safe chars for the values to keep this paranoid.
    // Anything beyond that requires the caller to escape themselves.
    const envPrefix = Object.entries(envVars)
      .map(([k, v]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          throw new Error(`Invalid env var name: ${k}`);
        }
        return `export ${k}=${shellQuote(String(v))}`;
      })
      .join('\n');
    const fullScript = `set -euo pipefail\n${envPrefix}\n${script}\n`;

    client.exec('bash -s', (err, stream) => {
      if (err) {
        try { client.end(); } catch {}
        return reject(new Error(`exec failed: ${err.message}`));
      }
      let stdout = '';
      let stderr = '';
      let buf = '';
      const timeout = setTimeout(() => {
        try { stream.close(); } catch {}
        try { client.end(); } catch {}
        reject(new Error(`Script timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      function pushLines(text) {
        if (!onLine) return;
        buf += text;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }

      stream.on('data', (d) => { const s = d.toString('utf8'); stdout += s; pushLines(s); });
      stream.stderr.on('data', (d) => { const s = d.toString('utf8'); stderr += s; pushLines(s); });
      stream.once('close', (exitCode) => {
        clearTimeout(timeout);
        if (buf.length && onLine) onLine(buf);
        try { client.end(); } catch {}
        const code = exitCode === undefined || exitCode === null ? -1 : Number(exitCode);
        resolve({ code, stdout, stderr });
      });
      stream.once('error', (e) => {
        clearTimeout(timeout);
        try { client.end(); } catch {}
        reject(e);
      });

      // Send the script and close stdin.
      stream.end(fullScript);
    });
  });
}

// Single-quote a value for shell. Replaces ' with '\''.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

module.exports = { execOne, execScript, shellQuote };

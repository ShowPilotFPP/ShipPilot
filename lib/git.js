// Thin wrapper around `git` so the release pipeline reads top-to-bottom
// instead of being a chain of nested callbacks. Every call returns
// { code, stdout, stderr } and never throws on non-zero exit — the
// pipeline decides what's fatal.

const { spawn } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, env: { ...process.env, ...(opts.env || {}) } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

function git(args, cwd, env = {}) {
  return run('git', args, { cwd, env });
}

module.exports = { run, git };

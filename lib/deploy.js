// Deploy pipeline.
//
// Runs an environment's deploy_script over SSH, captures all output to the
// deploys table, and returns success/failure. Used in three contexts:
//
//   1. Auto-deploy after a successful release. lib/release.js calls
//      autoDeployForRelease() after the push. Every env where
//      repo_slug=<released repo> AND auto_deploy=1 gets the script run.
//      Failures are recorded but don't fail the release itself — the
//      release is already on GitHub at that point.
//
//   2. Manual deploy from the UI ("Deploy now" button on an env card).
//      Runs the same deploy_script with no release context.
//
//   3. Custom action invocation. Runs the action's command (single-line)
//      via execOne, recorded as a deploy row with trigger='action' and
//      action_label set.
//
// Per-env serialization: a Map of env_id → in-flight Promise prevents two
// deploys to the same env from racing. The second caller waits for the
// first to finish, then runs. Different envs run in parallel.

const db = require('./db');
const ssh = require('./ssh');

// Map env_id → Promise that settles when the in-flight deploy ends.
// Both success and failure resolve the outer promise (we use it only as
// a "wait until prior is done" gate; awaiters chain `.catch(()=>{})` to
// ignore the prior's outcome). This means we never produce an unhandled
// rejection from the lock itself.
const envLocks = new Map();

async function withEnvLock(envId, fn) {
  const prior = envLocks.get(envId);
  if (prior) await prior.catch(() => {});

  // Run the work; capture its outcome as a single resolved value so the
  // lock promise can never reject. Caller of withEnvLock sees the original
  // result/throw via the direct await chain; followers see only "done".
  const work = (async () => {
    try { return { ok: true, value: await fn() }; }
    catch (e) { return { ok: false, error: e }; }
  })();

  envLocks.set(envId, work);
  let outcome;
  try {
    outcome = await work;
  } finally {
    if (envLocks.get(envId) === work) envLocks.delete(envId);
  }
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

// Internal: run a deploy or action and record it. Returns the deploy row id.
async function _runOnEnv({ env, releaseId, trigger, actionLabel, script, envVars, config }) {
  const deployId = db.startDeploy({
    env_id: env.id,
    release_id: releaseId || null,
    trigger,
    action_label: actionLabel || null,
  });

  const lines = [];
  const log = (msg) => {
    const stamped = `[${new Date().toISOString()}] ${msg}`;
    lines.push(stamped);
  };

  log(`Deploy starting on ${env.name} (${env.host})`);
  if (releaseId) log(`Release id: ${releaseId}`);
  if (envVars && Object.keys(envVars).length) {
    log(`Env vars: ${Object.keys(envVars).join(', ')}`);
  }

  let status = 'success';
  let errorMessage = null;
  try {
    const result = await ssh.execScript(env, script, config, {
      envVars: envVars || {},
      onLine: (line) => lines.push(line),
    });
    if (result.code !== 0) {
      status = 'failed';
      errorMessage = `Script exited with code ${result.code}`;
      log(`FAILED: exit ${result.code}`);
    } else {
      log('Deploy completed successfully');
    }
  } catch (e) {
    status = 'failed';
    errorMessage = e.message;
    log(`ERROR: ${e.message}`);
  }

  db.finishDeploy(deployId, {
    status,
    errorMessage,
    log: lines.join('\n'),
  });

  return { deployId, status, errorMessage };
}

// Entry point used by lib/release.js after a successful release.
// Looks up auto-deploy environments for the repo, runs each in parallel
// (serialized per-env via the lock map), returns an array of results.
async function autoDeployForRelease({ repoSlug, version, tag, releaseId, config }) {
  const envs = db.listEnvironmentsByRepo(repoSlug, true);
  if (!envs.length) return [];

  const envVars = {
    RELEASE_REPO: repoSlug,
    RELEASE_VERSION: version,
    RELEASE_TAG: tag || `v${version}`,
  };

  const results = await Promise.all(envs.map((env) =>
    withEnvLock(env.id, () => _runOnEnv({
      env,
      releaseId,
      trigger: 'auto',
      script: env.deploy_script,
      envVars,
      config,
    }))
  ));

  return results.map((r, i) => ({
    env_id: envs[i].id,
    env_slug: envs[i].slug,
    env_name: envs[i].name,
    deploy_id: r.deployId,
    status: r.status,
    error_message: r.errorMessage,
  }));
}

// Manual deploy. Like auto-deploy but for a single env, with no release id.
// The script gets MANUAL=1 in env vars instead of release info, in case the
// script wants to behave differently.
async function manualDeploy({ envSlug, config }) {
  const env = db.getEnvironmentBySlug(envSlug);
  if (!env) throw new Error('Unknown environment');
  return withEnvLock(env.id, () => _runOnEnv({
    env,
    trigger: 'manual',
    script: env.deploy_script,
    envVars: { MANUAL: '1' },
    config,
  }));
}

// Run a custom action. Action's command is a single shell line, run via
// execOne (no script wrapping). Recorded with trigger='action' and the
// action's label so the deploy log lists it distinguishably.
async function runAction({ envSlug, actionId, config }) {
  const env = db.getEnvironmentBySlug(envSlug);
  if (!env) throw new Error('Unknown environment');
  const action = db.getEnvAction(actionId);
  if (!action || action.env_id !== env.id) throw new Error('Unknown action');

  return withEnvLock(env.id, async () => {
    const deployId = db.startDeploy({
      env_id: env.id,
      release_id: null,
      trigger: 'action',
      action_label: action.label,
    });

    const lines = [];
    const log = (msg) => lines.push(`[${new Date().toISOString()}] ${msg}`);
    log(`Action "${action.label}" on ${env.name}`);
    log(`Command: ${action.command}`);

    let status = 'success';
    let errorMessage = null;
    try {
      const result = await ssh.execOne(env, action.command, config);
      if (result.stdout) lines.push(result.stdout.replace(/\n$/, ''));
      if (result.stderr) lines.push(result.stderr.replace(/\n$/, ''));
      if (result.code !== 0) {
        status = 'failed';
        errorMessage = `Command exited with code ${result.code}`;
      }
    } catch (e) {
      status = 'failed';
      errorMessage = e.message;
      log(`ERROR: ${e.message}`);
    }

    db.finishDeploy(deployId, { status, errorMessage, log: lines.join('\n') });
    return { deployId, status, errorMessage };
  });
}

// Run the env's log_command and return the captured output. Used by the
// "Tail Logs" button. NOT recorded in deploys (it's read-only and noisy).
async function tailLogs({ envSlug, config }) {
  const env = db.getEnvironmentBySlug(envSlug);
  if (!env) throw new Error('Unknown environment');
  if (!env.log_command) throw new Error('No log_command configured for this environment');
  const result = await ssh.execOne(env, env.log_command, config);
  return result;
}

module.exports = { autoDeployForRelease, manualDeploy, runAction, tailLogs };

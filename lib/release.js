// The release pipeline.
//
// Given a path to a tarball and the loaded config, this module:
//   1. Extracts the tarball to a staging dir
//   2. Reads & validates .release.json
//   3. Runs preflight checks (version match, tag uniqueness, syntax check)
//   4. Snapshots HEAD of the target clone (for rollback)
//   5. Wipes the working tree of the clone (preserving .git), copies the
//      staged tree in, removes .release.json
//   6. git add -A, commit, tag, push, push --tags
//   7. On any failure after step 5, rolls back: reset --hard to the
//      snapshot, delete the local tag if created
//
// Every step appends to a `log` array so the UI can display what happened.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const tar = require('tar');
const { git, run } = require('./git');

const VALID_REPO_KEY = /^[a-z0-9][a-z0-9-]*$/;
const VALID_VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const VALID_TAG = /^[\w./+-]+$/;

function makeLogger() {
  const entries = [];
  return {
    log(msg) { const line = `[${new Date().toISOString()}] ${msg}`; entries.push(line); console.log(line); },
    text() { return entries.join('\n'); },
  };
}

async function extractTarball(tarballPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  // strip 1 component because the tarballs are made with `tar czf foo.tar.gz showpilot/`
  // so everything is under a top-level dir.
  await tar.x({ file: tarballPath, cwd: destDir, strip: 1 });
}

function readManifest(stagingDir) {
  const manifestPath = path.join(stagingDir, '.release.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Tarball is missing .release.json at its root');
  }
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); }
  catch (e) { throw new Error(`Could not read .release.json: ${e.message}`); }

  let m;
  try { m = JSON.parse(raw); }
  catch (e) { throw new Error(`.release.json is not valid JSON: ${e.message}`); }

  if (typeof m.repo !== 'string' || !VALID_REPO_KEY.test(m.repo)) {
    throw new Error('.release.json: "repo" must be a lowercase slug (letters, digits, hyphens)');
  }
  if (typeof m.version !== 'string' || !VALID_VERSION.test(m.version)) {
    throw new Error('.release.json: "version" must look like 1.2.3 (semver)');
  }
  if (typeof m.commit_message !== 'string' || !m.commit_message.trim()) {
    throw new Error('.release.json: "commit_message" is required and must be non-empty');
  }
  if (m.tag !== undefined && m.tag !== null) {
    if (typeof m.tag !== 'string' || !VALID_TAG.test(m.tag)) {
      throw new Error('.release.json: "tag" must be a valid git tag name or omitted');
    }
  }
  return m;
}

function readPackageJsonVersion(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null; // not every repo has package.json (the plugin is PHP/Python)
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || null;
  } catch (e) {
    throw new Error(`Could not parse package.json in tarball: ${e.message}`);
  }
}

// Walk extracted tree and run `node --check` on every .js file. Skips
// node_modules, data, .git, and `vendor` dirs (third-party drop-ins). Also
// skips any *.min.js file — minified bundles can use top-level constructs
// that node --check (which wraps in a function) flags as invalid even when
// they're valid scripts. We only care about checking OUR code anyway.
async function syntaxCheckJs(rootDir, logger) {
  const skipDirs = new Set(['node_modules', 'data', '.git', 'vendor']);
  const failures = [];
  let checked = 0;
  let skipped = 0;

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.js')) {
        if (e.name.endsWith('.min.js')) { skipped += 1; continue; }
        const full = path.join(dir, e.name);
        const r = await run('node', ['--check', full]);
        checked += 1;
        if (r.code !== 0) failures.push({ file: path.relative(rootDir, full), stderr: r.stderr.trim() });
      }
    }
  }
  await walk(rootDir);
  const skipNote = skipped > 0 ? ` (${skipped} minified file${skipped === 1 ? '' : 's'} skipped)` : '';
  logger.log(`Syntax-checked ${checked} .js file${checked === 1 ? '' : 's'}${skipNote}`);
  if (failures.length) {
    const lines = failures.map((f) => `  ${f.file}: ${f.stderr.split('\n')[0]}`).join('\n');
    throw new Error(`Syntax check failed:\n${lines}`);
  }
}

// Replace clone's working tree with the staging tree's contents, preserving
// the clone's .git directory. We do this by deleting everything except .git
// and then copying the staging tree in.
async function replaceWorkingTree(cloneDir, stagingDir, logger) {
  const entries = await fsp.readdir(cloneDir);
  for (const name of entries) {
    if (name === '.git') continue;
    await fsp.rm(path.join(cloneDir, name), { recursive: true, force: true });
  }
  // Copy staging contents (not the staging dir itself) into clone.
  const staged = await fsp.readdir(stagingDir);
  for (const name of staged) {
    if (name === '.release.json') continue; // never commit the manifest
    await fsp.cp(path.join(stagingDir, name), path.join(cloneDir, name), { recursive: true });
  }
  logger.log('Working tree replaced with tarball contents');
}

async function ensureCloneExists(repoConfig, cloneDir, logger) {
  if (fs.existsSync(path.join(cloneDir, '.git'))) return;
  logger.log(`Cloning ${repoConfig.remote} → ${cloneDir}`);
  await fsp.mkdir(path.dirname(cloneDir), { recursive: true });
  const r = await run('git', ['clone', '--branch', repoConfig.branch, repoConfig.remote, cloneDir]);
  if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr || r.stdout}`);
}

async function fetchAndReset(cloneDir, branch, logger) {
  let r = await git(['fetch', 'origin', branch], cloneDir);
  if (r.code !== 0) throw new Error(`git fetch failed: ${r.stderr || r.stdout}`);
  r = await git(['checkout', branch], cloneDir);
  if (r.code !== 0) throw new Error(`git checkout ${branch} failed: ${r.stderr || r.stdout}`);
  r = await git(['reset', '--hard', `origin/${branch}`], cloneDir);
  if (r.code !== 0) throw new Error(`git reset failed: ${r.stderr || r.stdout}`);
  // Clean any untracked debris from a previous failed run.
  r = await git(['clean', '-fdx'], cloneDir);
  if (r.code !== 0) throw new Error(`git clean failed: ${r.stderr || r.stdout}`);
  logger.log(`Clone synced to origin/${branch}`);
}

async function getHeadSha(cloneDir) {
  const r = await git(['rev-parse', 'HEAD'], cloneDir);
  if (r.code !== 0) throw new Error(`git rev-parse failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function tagExists(cloneDir, tag) {
  // After fetchAndReset we have all remote tags. Check both local and remote.
  const r = await git(['tag', '-l', tag], cloneDir);
  if (r.code !== 0) return false;
  return r.stdout.trim() === tag;
}

async function deleteLocalTag(cloneDir, tag) {
  await git(['tag', '-d', tag], cloneDir);
}

async function rollback(cloneDir, snapshotSha, createdTag, logger) {
  logger.log('Rolling back local changes…');
  if (createdTag) {
    await deleteLocalTag(cloneDir, createdTag);
    logger.log(`Deleted local tag ${createdTag}`);
  }
  const r = await git(['reset', '--hard', snapshotSha], cloneDir);
  if (r.code === 0) logger.log(`Reset clone to ${snapshotSha}`);
  else logger.log(`WARNING: rollback reset failed: ${r.stderr}`);
  await git(['clean', '-fdx'], cloneDir);
}

// Parse "owner/repo" from a git remote URL.
// Handles:
//   git@github.com:Owner/Repo.git          — standard SSH
//   https://github.com/Owner/Repo.git      — HTTPS
//   git@github-<slug>:Owner/Repo.git       — ShipPilot SSH alias form
// For legacy repos migrated from config.repos, remote_original may be the
// alias form (git@github-showpilot:...) since config.js already had the
// alias by the time migration ran. All forms embed owner/repo after the colon.
function parseGithubOwnerRepo(remote) {
  if (!remote) return null;
  // Covers all three forms — the key insight is owner/repo always follows
  // the colon (SSH) or the last github.com/ (HTTPS).
  const sshMatch = remote.match(/^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = remote.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  return null;
}

// Create a GitHub Release via the REST API after a successful tag push.
// Requires a GitHub PAT with repo scope (config.githubToken).
// Skips silently if no token is configured — never breaks the pipeline.
function createGithubRelease({ ownerRepo, tag, name, body, token }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      tag_name: tag,
      name: name || tag,
      body: body || '',
      draft: false,
      prerelease: false,
      make_latest: 'true', // always promote to latest
    });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${ownerRepo}/releases`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'ShipPilot',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 201) {
          resolve({ ok: true });
        } else {
          let msg = `GitHub API returned ${res.statusCode}`;
          try { msg += `: ${JSON.parse(data).message}`; } catch { /* raw body */ }
          resolve({ ok: false, error: msg });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'GitHub API timed out' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// Main entry point. Returns { ok, manifest, commitSha, log, error? }.
async function performRelease(tarballPath, config) {
  const logger = makeLogger();
  const stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shippilot-stage-'));
  let manifest;
  let cloneDir;
  let snapshotSha;
  let createdTag = null;

  try {
    logger.log(`Extracting tarball: ${path.basename(tarballPath)}`);
    await extractTarball(tarballPath, stagingDir);

    manifest = readManifest(stagingDir);
    logger.log(`Manifest: repo=${manifest.repo} version=${manifest.version} tag=${manifest.tag || '(none)'}`);

    const reposLib = require('./repos');
    const repoCfg = reposLib.getRepoForPipeline(manifest.repo, config);
    if (!repoCfg) {
      const dbSlugs = require('./db').listRepos().map((r) => r.slug);
      const cfgSlugs = config.repos ? Object.keys(config.repos) : [];
      const all = [...new Set([...dbSlugs, ...cfgSlugs])].sort();
      throw new Error(`Unknown repo "${manifest.repo}". Configured repos: ${all.join(', ')}`);
    }

    // Preflight: package.json version must match manifest version (when package.json exists)
    const pkgVersion = readPackageJsonVersion(stagingDir);
    if (pkgVersion !== null && pkgVersion !== manifest.version) {
      throw new Error(`Version mismatch: manifest says ${manifest.version} but package.json says ${pkgVersion}`);
    }
    if (pkgVersion === null) logger.log('No package.json in tarball — skipping version cross-check');
    else logger.log(`Version cross-check OK (${pkgVersion})`);

    // Preflight: syntax check all .js files
    await syntaxCheckJs(stagingDir, logger);

    // Prepare clone
    cloneDir = path.join(config.reposDir, manifest.repo);
    await ensureCloneExists(repoCfg, cloneDir, logger);
    await fetchAndReset(cloneDir, repoCfg.branch, logger);

    // Preflight: tag must not already exist (on either side, since we just fetched)
    if (manifest.tag && await tagExists(cloneDir, manifest.tag)) {
      throw new Error(`Tag ${manifest.tag} already exists in ${manifest.repo}. Bump version or remove the existing tag.`);
    }

    // Snapshot HEAD before we start mutating
    snapshotSha = await getHeadSha(cloneDir);
    logger.log(`Snapshot HEAD: ${snapshotSha}`);

    // Apply tarball
    await replaceWorkingTree(cloneDir, stagingDir, logger);

    // Configure git author for this repo (local config, doesn't pollute global)
    await git(['config', 'user.name', config.gitAuthor.name], cloneDir);
    await git(['config', 'user.email', config.gitAuthor.email], cloneDir);

    // Stage and commit
    let r = await git(['add', '-A'], cloneDir);
    if (r.code !== 0) throw new Error(`git add failed: ${r.stderr || r.stdout}`);

    // If nothing changed, that's an error — the tarball was identical to HEAD.
    r = await git(['diff', '--cached', '--quiet'], cloneDir);
    if (r.code === 0) throw new Error('Tarball produced no changes vs current HEAD. Did you forget to bump or include changes?');

    r = await git(['commit', '-m', manifest.commit_message], cloneDir);
    if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr || r.stdout}`);
    const commitSha = (await getHeadSha(cloneDir));
    logger.log(`Committed ${commitSha.slice(0, 12)}`);

    // Tag if requested
    if (manifest.tag) {
      r = await git(['tag', manifest.tag], cloneDir);
      if (r.code !== 0) throw new Error(`git tag failed: ${r.stderr || r.stdout}`);
      createdTag = manifest.tag;
      logger.log(`Created tag ${manifest.tag}`);
    }

    // Push branch
    r = await git(['push', 'origin', repoCfg.branch], cloneDir);
    if (r.code !== 0) throw new Error(`git push failed: ${r.stderr || r.stdout}`);
    logger.log(`Pushed ${repoCfg.branch}`);

    // Push tag (only the one we just made, not all tags — safer)
    if (manifest.tag) {
      r = await git(['push', 'origin', manifest.tag], cloneDir);
      if (r.code !== 0) throw new Error(`git push tag failed: ${r.stderr || r.stdout}`);
      logger.log(`Pushed tag ${manifest.tag}`);
    }

    // Create GitHub Release if a token is configured. This promotes the tag
    // to a proper Release object so ShowPilot's updater can find it without
    // relying on GitHub's manually-set "latest" marker.
    if (manifest.tag && config.githubToken) {
      const dbRow = require('./db').getRepoBySlug(manifest.repo);
      const ownerRepo = parseGithubOwnerRepo(dbRow && dbRow.remote_original);
      if (ownerRepo) {
        logger.log(`Creating GitHub Release for ${ownerRepo}@${manifest.tag}…`);
        const ghResult = await createGithubRelease({
          ownerRepo,
          tag: manifest.tag,
          name: manifest.tag,
          body: manifest.commit_message || '',
          token: config.githubToken,
        });
        if (ghResult.ok) {
          logger.log(`GitHub Release created (${manifest.tag} marked as latest)`);
        } else {
          // Non-fatal — the tag is already pushed, release creation failing
          // is recoverable manually. Log but don't roll back.
          logger.log(`WARNING: GitHub Release creation failed: ${ghResult.error}`);
        }
      } else {
        logger.log(`WARNING: Could not parse owner/repo from remote — skipping GitHub Release`);
      }
    } else if (manifest.tag && !config.githubToken) {
      logger.log('No githubToken configured — skipping GitHub Release creation');
    }

    return { ok: true, manifest, commitSha, log: logger.text() };
  } catch (err) {
    logger.log(`ERROR: ${err.message}`);
    if (cloneDir && snapshotSha) {
      try { await rollback(cloneDir, snapshotSha, createdTag, logger); }
      catch (rbErr) { logger.log(`Rollback error: ${rbErr.message}`); }
    }
    return { ok: false, manifest: manifest || null, log: logger.text(), error: err.message };
  } finally {
    // Always clean up the staging dir.
    fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { performRelease };

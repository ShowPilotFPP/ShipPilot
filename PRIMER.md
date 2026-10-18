# ShipPilot Project Primer

This document gives you (Claude, in a future conversation) the context you need to help the maintainer work on ShipPilot effectively. Read this first before any other project files.

---

## What ShipPilot is

ShipPilot is a tarball-driven release tool. The maintainer doesn't write code; they work with Claude, who packages updates as tarballs. ShipPilot is the web UI the maintainer uses to take a tarball and turn it into a real GitHub commit, tag, and push — so the release flow is "drop a `.tar.gz` in a browser" instead of "shell into a dev box, extract, git add, commit, tag, push, push tag."

It's a sibling to ShowPilot, not part of it. ShowPilot is the light-show software; ShipPilot is the tool that ships ShowPilot (and ShowPilot-plugin, and ShipPilot itself, and any other repos the maintainer adds).

**The key idea:** every tarball Claude packages contains a `.release.json` file at its root. ShipPilot reads that manifest, figures out which repo to push to, validates a few preflight checks, applies the tarball over a managed git clone, commits, tags, pushes. On any failure it rolls back so the clone is always either fully shipped or fully untouched.

---

## Architecture

**Stack:**
- Node.js / Express server (`server.js` is the entry point)
- SQLite via `better-sqlite3` (data lives at `data/shippilot.db`)
- Vanilla JS frontend (no React, no build step) — the entire UI is `public/index.html`
- JWT-based auth in httpOnly cookies, bcrypt for passwords
- Single-user practical model (one admin), but the schema permits more

**Key directories:**
```
/opt/shippilot/                  (prod LXC)
├── server.js                    — entry point, route mount order matters (see below)
├── package.json                 — version source of truth
├── config.js                    — host-specific config (port, dbPath, sshKeysDir, deprecated repos block)
├── config.example.js            — template for fresh installs
├── PRIMER.md                    — this file, shipped with the repo
├── lib/
│   ├── config-loader.js         — loads config.js, applies env overrides, persists secrets
│   ├── db.js                    — SQLite schema + helpers (users, releases, repos, environments, deploys)
│   ├── auth.js                  — JWT issue/verify, requireAuth middleware
│   ├── git.js                   — thin promise wrapper around the git CLI
│   ├── ssh-config.js            — marker-based ~/.ssh/config rewriter (security-sensitive)
│   ├── ssh.js                   — SSH transport: execOne / execScript over ssh2, TOFU host-key pinning
│   ├── repos.js                 — repo lifecycle: add/list/delete/test, key generation
│   ├── release.js               — the release pipeline (tarball → push or rollback)
│   └── deploy.js                — SSH deploy runner: auto-deploy after release, manual deploy, actions
├── routes/
│   ├── auth.js                  — login, logout, first-boot setup, change-password
│   ├── release.js               — POST /release (multipart upload), release history
│   ├── repos.js                 — repo CRUD, key fetch, test connection
│   └── envs.js                  — environment CRUD, deploy, actions, log tail, version check
├── public/
│   └── index.html               — entire UI in one file
└── data/
    ├── shippilot.db             — SQLite DB
    ├── secrets.json             — auto-generated jwtSecret, persisted between restarts
    ├── ssh-keys/                — managed Ed25519 keys, one per repo (mode 0600)
    ├── env-known-hosts/         — per-environment pinned SSH host keys (TOFU, one file per env slug)
    └── repos/                   — git clones managed by ShipPilot, one per repo
        ├── showpilot/
        ├── showpilot-plugin/
        └── shippilot/
```

---

## Deployment topology

**ShipPilot LXC (Proxmox)**
- Host: a Proxmox LXC on the LAN (`<shippilot-host>` below)
- Path: `/opt/shippilot/`
- Process manager: **PM2** (process name: `shippilot`)
- Runtime: Node 22, Ubuntu 24.04
- Public URL: `https://<your-domain>/push` (via Nginx Proxy Manager + custom location with rewrite)
- Restart: `pm2 restart shippilot`
- Logs: `pm2 logs shippilot`

**Reverse proxy quirk worth knowing:**
NPM forwards `<your-domain>/push/*` to `http://<shippilot-host>:3200/*` with a rewrite rule:
```
rewrite ^/push/?(.*)$ /$1 break;
```
ShipPilot's UI handles this transparently because it derives `API_BASE` from `window.location.pathname` at runtime. So API calls from the page work whether it's served at `/`, `/push`, or any other prefix. Don't hard-code `/api/...` in the UI — always use `API_BASE + '/...'`.

**SSH keys:**
ShipPilot has its own SSH identity per managed repo. Keys generated via the UI live in `data/ssh-keys/<slug>`. Older manually-set-up repos (showpilot, showpilot-plugin, shippilot) have keys in `/root/.ssh/` (id_ed25519, id_plugin, id_showpilot) and are flagged `managed=0` in the DB — ShipPilot leaves their key files and SSH config blocks alone.

**SSH config is shared:**
`~/.ssh/config` has both manually-added entries (for the three legacy repos) and a managed block:
```
Host github-showpilot
    ...
Host github-plugin
    ...
Host github-shippilot
    ...

# === BEGIN SHIPPILOT-MANAGED ===
Host github-<slug>
    HostName github.com
    User git
    IdentityFile /opt/shippilot/data/ssh-keys/<slug>
    IdentitiesOnly yes
# === END SHIPPILOT-MANAGED ===
```
ShipPilot ONLY rewrites the managed block. The marker-based logic in `lib/ssh-config.js` is paranoid — it refuses to write if BEGIN exists without END.

### CI/CD
- GitHub: `github.com/ShowPilotFPP/ShipPilot` (public as of v0.3.4)
- No GitHub Actions of its own. Releases are manual via tarball-into-itself. `docs/` holds the example ship workflow and the self-hosted runner setup used by the ShowPilot repos.

---

## Deployment workflow

### Releasing a new ShipPilot version

ShipPilot can ship its own updates via its own UI. The flow:

1. Claude packages a tarball at `/mnt/user-data/outputs/shippilot-vX.Y.Z.tar.gz`
2. The maintainer downloads it and drops it into the ShipPilot UI (`<your-domain>/push`)
3. The pipeline commits to GitHub, pushes the tag
4. **The maintainer then has to manually pull and restart on the LXC**, because the running ShipPilot pushed the new code to GitHub but is still running the old version:
   ```bash
   ssh root@<shippilot-host>
   cd /opt/shippilot && git pull origin main
   npm install      # in case dependencies changed
   pm2 restart shippilot
   ```

**Bootstrap problem:** if a ShipPilot release ships a bug bad enough to crash on startup, the running ShipPilot pushed it before crashing — but you can't use ShipPilot to fix it. Fall back to the manual flow: scp tarball, extract, restart. The release pipeline's rollback only protects against git-side failures, not application crashes after the new code is running.

### Standard tarball packaging

All ShipPilot tarballs use this exclude set:
```bash
tar --exclude='shippilot/.git' \
    --exclude='shippilot/node_modules' \
    --exclude='shippilot/config.js' \
    --exclude='shippilot/data' \
    --exclude='shippilot/*.tar.gz' \
    -czf /mnt/user-data/outputs/shippilot-vX.Y.Z.tar.gz shippilot/
```

**Critical: always exclude `.git`.** If `.git/` is included in the tarball, ShipPilot's `replaceWorkingTree` overwrites the managed clone's `.git/config` with the dev machine's, which has an HTTPS origin URL. Every subsequent push fails with `fatal: could not read Username for 'https://github.com'`. Discovered 2026-05-01.

The tarball MUST contain `.release.json` at the root:
```json
{
  "repo": "shippilot",
  "version": "0.X.Y",
  "commit_message": "vX.Y.Z — description",
  "tag": "vX.Y.Z"
}
```

The `repo` field is the slug — must match a `repo` row in ShipPilot's DB. For ShipPilot itself, that's `shippilot`.

### Sanity-check syntax before packaging

```bash
cd /home/claude/shippilot && for f in server.js routes/*.js lib/*.js; do node --check "$f" 2>&1 | head -3; done; echo OK
```

For inline JS in `public/index.html`:
```bash
python3 -c "
import re
html = open('/home/claude/shippilot/public/index.html').read()
blocks = re.findall(r'<script(?![^>]*src=)[^>]*>(.*?)</script>', html, re.DOTALL)
for i, b in enumerate(blocks): open(f'/tmp/sp_{i}.js', 'w').write(b)
"
for f in /tmp/sp_*.js; do node --check "$f" 2>&1 | head -3; done
```

### Version bumping

Bump in BOTH places before packaging:
- `package.json` — `"version": "X.Y.Z"`
- `public/index.html` — `<div class="version">vX.Y.Z</div>` near the top

---

## Environments and auto-deploy

ShipPilot v0.3.x added a full deploy system. Each repo can have one or more **environments** — a remote host + SSH credentials + deploy script. After a successful release, every environment with `auto_deploy=1` for that repo gets its deploy script run automatically via SSH.

**Key concepts:**
- Environments are managed in the ShipPilot UI (Environments section)
- Each env has: name, host, SSH user/port, key path, repo slug, deploy path, deploy script, optional log command, optional version check command
- `auto_deploy=1` means the script runs automatically after every successful release of that repo
- Auto-deploys run **asynchronously** (v0.3.5+) — the release response is sent immediately after the git push, then deploys fire in the background. The UI polls `GET /releases/:id/deploys` every 5s until all envs settle, showing a "Deploying…" spinner.
- Deploy history is in the `deploys` table, viewable per-env

**Why async matters:** ShipPilot is served via Cloudflare, which has a ~100s upstream timeout. SSH deploys (git pull + npm install + pm2 restart) can exceed that. Before v0.3.5, this caused Cloudflare to return an HTML 524 error page before ShipPilot could respond — the release had succeeded but the UI showed an error.

**How `lib/deploy.js` works:**
- `autoDeployForRelease({ repoSlug, ... })` — looks up all auto-deploy envs for the repo, runs them in parallel (serialized per-env via an in-memory lock map to prevent races)
- `manualDeploy({ envSlug, ... })` — runs the deploy script for a single env on demand
- `runAction({ envSlug, actionId, ... })` — runs a custom one-line action command
- `tailLogs({ envSlug, ... })` — runs the env's `log_command` and returns output (not recorded)
- All deploys are recorded in `deploys` table with full log capture

**`lib/ssh.js` transport:**
- Wraps the `ssh2` library
- `execOne(env, command, config)` — runs a single command, returns `{ code, stdout, stderr }`
- `execScript(env, script, config, { onLine })` — runs a multi-line bash script via `bash -s` (stdin), streams output line by line
- **TOFU host-key pinning:** first connection accepts any host key and persists it to `data/env-known-hosts/<slug>`. Subsequent connections require exact match. The DB `host_key_verified` flag controls which mode. Run "Test SSH" in the UI to pin a new env's host key.
- Connect timeout: 15s. Command/script timeout: 10 minutes.

---

## Architectural decisions worth knowing

**Mount order in `server.js` matters (twice):**
1. `cookieParser()` MUST come before any router that calls `requireAuth`. Same lesson as ShowPilot v0.25.5 — `requireAuth` reads `req.cookies` and crashes the request handler if cookieParser hasn't run.
2. The release router MUST mount BEFORE the global `express.json()` parser, because uploads use multer (multipart) and we don't want the global JSON body limit to interfere. ShowPilot learned this the same way (v0.25.4).

Don't reorder these without thinking.

**`API_BASE` derivation in the UI** lets ShipPilot run at any path prefix (`/`, `/push`, `/anything`) without code changes. Implemented in `public/index.html`. Don't introduce hard-coded `/api/...` paths.

**Repos live in the DB, not config.js (since v0.2.0).**
The old `config.repos` block is deprecated but still works as a one-time seed. On startup, `lib/repos.js#migrateFromConfig` imports any config.js entries that aren't already in the DB. Migrated entries are flagged `managed=0` because ShipPilot didn't generate their keys and shouldn't manage their SSH config blocks. Three legacy repos exist on the production LXC: `showpilot`, `showpilot-plugin`, `shippilot` — all `managed=0`.

**Release pipeline rollback** (`lib/release.js`):
1. Snapshot HEAD before any mutation
2. Wipe working tree (preserving `.git`), apply tarball
3. `git add -A`, commit, tag, push branch, push tag
4. ON ANY FAILURE: `git reset --hard <snapshot>`, delete local tag if created, `git clean -fdx`

This means a failed ship leaves the clone identical to its pre-ship state. Tested with: bad tarball, tag collision, push rejected (pre-receive hook), identical-to-HEAD tarball.

**GitHub Release creation** (`lib/release.js` → `createGithubRelease`):
After a successful tag push, ShipPilot calls the GitHub REST API to create a formal Release object. Requires `config.githubToken` (a PAT with repo scope). Non-fatal if it fails — the tag is already pushed. This is what powers ShowPilot's in-app updater (`/api/updates/check` hits the GitHub Releases API to find the latest version). If `githubToken` is not configured, the step is skipped with a log note.

**`parseGithubOwnerRepo`** handles three SSH remote URL forms:
- `git@github.com:Owner/Repo.git` (standard)
- `git@github-showpilot:Owner/Repo.git` (legacy SSH alias form used by migrated repos)
- `https://github.com/Owner/Repo.git` (HTTPS)

**Syntax check skips vendor blobs.** `node --check` chokes on minified files (it wraps in a function and minified bundles use top-level constructs that fail in that wrapper). The pre-flight skips `vendor/` directories and any `*.min.js`. Don't try to "fix" this by checking everything — the bug isn't in the code, it's in node --check's wrapping.

**The DB filename was once `showpilot.db` due to a copy-paste typo from ShowPilot's config.** Fixed in v0.2.0's example config (`shippilot.db`). If working on an old install, look in `data/` for both names — this has happened before.

**SSH config rewrite is marker-based** (`lib/ssh-config.js`). The module ONLY touches content between `# === BEGIN SHIPPILOT-MANAGED ===` and `# === END SHIPPILOT-MANAGED ===`. Anything outside is preserved verbatim. On a malformed file (BEGIN without END), it refuses to write. Don't change this behavior without thinking very carefully.

**Repo input validation regexes are strict on purpose:**
- Slug: `^[a-z0-9][a-z0-9-]{1,31}$` — used as both a path component and a hostname alias
- Remote: must match `git@github.com:Owner/Repo.git` exactly — no scheme switching, no shell metacharacters
- Branch: a safe subset of git's actual rules

---

## Working style — what the maintainer expects

Same as the ShowPilot primer:

- **Direct and minimal.** Surgical edits, not architectural rewrites. If you find yourself proposing a refactor, stop and ask. The maintainer pushes back hard on over-engineering.
- **Don't fabricate.** If you don't know what something does, look at the code or ask. Don't make up file paths, function names, or behavior.
- **Show your work in code, not in chat.** When you find a bug, paste the reasoning concisely, then make the fix. Don't write three paragraphs of "let me think about this" before each edit.
- **Test what you can.** If a fix involves a regex, a state machine, anything testable in isolation, write a quick `/tmp/test.js` and run it before claiming the fix works. The repos lib was tested this way before shipping; do the same for new logic.
- **One feature per version bump.** Each tarball should be a coherent change. If you're touching three unrelated things, that's three releases.
- **Comments explain WHY, not WHAT.** The code already says what. Comments are for the rationale that isn't obvious from reading — middleware ordering invariants, edge cases, why a particular regex shape was chosen.

The maintainer doesn't write code. They run commands you give them. So:
- Give them scripts they can paste, not "edit this file at line 47"
- Bake version bumps into your edits (don't make them hunt for spots to update)
- Always include the standard sanity-check syntax command before packaging

---

## Recent state (as of v0.4.1, October 2026)

| Version | Change |
|---------|--------|
| 0.1.0 | Initial release: tarball pipeline, auth, history table |
| 0.1.1 | Skip `vendor/` dirs and `*.min.js` in syntax check (ShowPilot has minified jspdf vendor blobs) |
| 0.1.2 | Light/dark theme toggle, persisted to localStorage |
| 0.1.3 | Derive API base from page URL — fixes UI behind reverse-proxy path prefixes |
| 0.2.0 | Manage repos from the UI: add/test/delete with auto-generated SSH keys; deprecate config.repos block |
| 0.3.x | Environments + deploy system: SSH deploy runner (`lib/ssh.js`, `lib/deploy.js`), per-env TOFU host-key pinning, auto-deploy after release, manual deploy, custom action buttons, log tail, version check. GitHub Release creation after tag push (`config.githubToken`). |
| 0.3.4 | Safe JSON parsing in `doShip`. `resp.json()` was called unconditionally — if NPM dropped the connection mid-response (e.g. during a ShowPilot auto-deploy that restarted a proxied service), the parse threw "not valid JSON" even though the release had already succeeded on GitHub. Now checks content-type first, falls back to text. A 2xx non-JSON response shows "Shipped — check release history to confirm" instead of crashing. Also: PRIMER.md added to repo. |
| 0.3.5 | Async auto-deploy. `POST /release` now responds immediately after the git push, then fires SSH deploys in the background via `setImmediate`. The UI polls `GET /releases/:id/deploys` every 5s, showing a "Deploying…" spinner until all envs settle. Fixes Cloudflare 524 errors when deploy scripts take longer than ~100s. `listDeploysForRelease` query updated to include env name/slug via JOIN. |
| 0.4.0 | **API tokens for automated uploads** (see "API tokens and automated releases"): `POST /release` accepts a browser session OR `Authorization: Bearer shp_…`; tokens are managed in a new UI card (session-only routes `GET/POST/DELETE /api/tokens`), stored as SHA-256 hashes, shown once, optionally limited to repo slugs, revocable, with last-used time. Tokens can only upload releases and poll `GET /releases/:id/deploys` (limited tokens: their repos only). New `releases.released_by` column (auto-migrated) shown in history as "by user: …" / "by api token: …". `fetchAndReset` now fetches all tags (`--tags --force`) so the tag-collision preflight also sees tags created on GitHub. Example workflow in `docs/github-actions-release.example.yml`. Primer and repo sanitized (no personal names, domains or internal addresses; the config example, UI placeholder and tests use example values). Tested against a running copy upgraded from v0.3.5's database with a local bare repo as origin: history kept and migrated; session and token uploads succeed; a limited token is refused for another repo (nothing tagged); no auth / wrong token → 401 with no temp file written; tokens get 401 on tokens/repos/history/logs; deploy status 200 for own repo, 404 otherwise; a tag already on GitHub (on another branch) is caught at preflight; a commit merged on GitHub first is released on top of cleanly; revocation is immediate; only hashes stored. |
| 0.4.1 | Docs only: **self-hosted build runner** (`docs/self-hosted-runner/`: `setup-runner.sh` + README; see "Self-hosted build runner"); the example workflow targets that runner with the `SPP_RUNNER=github` fallback. No server code changes. |

---

## API tokens and automated releases (v0.4.0)

`POST /api/release` accepts either a signed-in browser session or an API token (`Authorization: Bearer shp_…`). This lets an automated uploader, such as a GitHub Actions workflow, ship through the normal pipeline without a browser.

- **Scope:** a token can ONLY upload releases and poll `GET /api/releases/:id/deploys`. Every other route (repos, environments, users, history, logs, tokens) stays browser-session-only (`requireAuth`), so a leaked token cannot change configuration or mint more tokens. `requireUploadAuth` in `lib/auth.js` is used on exactly those two routes. Auth runs before multer, so unauthenticated uploads are never written to disk.
- **Repo limits:** a token may be limited to repo slugs (`allowed_repos`); `performRelease` refuses any other manifest repo before touching a clone, and deploy-status polling only shows those repos' releases.
- **Storage:** tokens look like `shp_` + 43 base64url characters; only the SHA-256 hash and an 8-character prefix (for recognition in the UI) are stored. The value is shown once, at creation. Revoked tokens stay listed (greyed) for the audit trail.
- **Audit:** every release records `released_by` ("user: <name>" or "api token: <name>"), shown under the message in Recent releases and logged in the release log.
- **Mixed flows are safe:** before applying a tarball, the clone is synced to `origin/<branch>` (fetch, reset --hard, clean) and all tags are fetched, so commits merged on GitHub directly (e.g. a PR) are simply built upon, and a tag that already exists on GitHub is caught at preflight. A tarball identical to the current branch is refused ("no changes"), so automation must ship a branch other than the target (see the example workflow).
- **Example workflow:** `docs/github-actions-release.example.yml` (manual `workflow_dispatch` on a chosen branch → packages with `git archive` + `.release.json` from `package.json` → uploads with the token → fails the job if ShipPilot refuses). Secrets: `SHIPPILOT_URL`, `SHIPPILOT_TOKEN`, `SHIPPILOT_REPO`.
- **Example workflow runner (v0.4.1):** the example's job uses `runs-on: ${{ vars.SPP_RUNNER == 'github' && 'ubuntu-latest' || fromJSON('["self-hosted","linux","arm64","showpilot"]') }}` like the ShowPilot repos; set the repo variable `SPP_RUNNER` to `github` to use GitHub-hosted runners.
- **Exposure note:** a token is as powerful as a release upload, which includes auto-deploys. Limit tokens to the repos that need them, store them only as CI secrets, and revoke any token that may have leaked.

---

## Self-hosted build runner (v0.4.1)

The ShowPilot repos' build, test, Docker and ship jobs run on one self-hosted GitHub Actions runner (labels `self-hosted, linux, arm64, showpilot`). Kept here because it serves every repo ShipPilot ships. Files: `docs/self-hosted-runner/setup-runner.sh`, `docs/self-hosted-runner/README.md`.

- **Reference machine:** an Ubuntu 24.04 machine in OrbStack on an Apple Silicon Mac (arm64, so ShowPilot Player SD images build natively). Any Ubuntu box works; on x86_64 the arm64 parts are emulated.
- **`setup-runner.sh`** (run as a normal sudo user inside the machine; re-runnable): apt tools (git, curl, jq, python3, zip, xz, sfdisk, e2fsprogs, mpv/php-cgi/ffmpeg for Player tests), GitHub CLI, Node 22, Docker; a weekly cron prune (`/etc/cron.weekly/showpilot-runner-cleanup`: Docker images/cache older than a week, `/var/tmp/spp-image`); a **loop-device self-test** (ext4 image mounted through `losetup`) because the SD image build needs it — if it fails, use a full VM (UTM). Then one runner per repo (default ShowPilot, ShowPilot-Lite, ShowPilot-plugin, ShowPilot-Player) in `~/actions-runners/<repo>`, label `showpilot`, installed as a systemd service. Registration tokens come from `gh api .../actions/runners/registration-token` (it runs `gh auth login` if needed and **logs out again** so jobs can't read an owner login), or are typed in. Re-runs drop the local registration and use `--replace`. `--status` lists the services.
- **Fallback:** repo variable `SPP_RUNNER` = `github` → GitHub-hosted runners for that repo. Unset and machine offline → jobs queue up to 24 h.
- **Kept on GitHub-hosted runners on purpose:** the Claude workflows (driven by public issue/PR text; on a shared machine a prompt-injected run could read the other runners' registration files) and Player tests for pull requests from forks.
- **Disk:** ~4-5 GB tools/runners; SD image build ~6-8 GB peak (cleaned up); Docker cache pruned weekly.

---

## Open items / tech debt

- **No backup/restore for ShipPilot itself.** If the LXC dies, the SSH keys, DB, and history are lost. Backup of `data/` would suffice — that's where everything lives.
- **No rate limit on login.** A determined attacker could brute-force the password. Practical mitigation right now is the IP allowlist option in NPM, not yet configured.
- **No HTTPS direct on ShipPilot.** Relies on NPM in front. Cookies are not flagged Secure for this reason — leaving the LXC as plain HTTP. If ShipPilot is ever exposed directly, the cookie flag and TLS need to come together.
- **DB filename typo** (`showpilot.db` instead of `shippilot.db`) might exist on the production LXC depending on history. Don't rename without coordinating — losing the history table is a bad day.
- **The bootstrap problem** (a ShipPilot release that crashes on startup leaves you unable to use ShipPilot to ship the fix). No clean solution; documented above.

---

## Wider context (lightly)

- ShipPilot exists to make shipping ShowPilot (a synchronized light-show platform) and its sibling repos easier. ShowPilot has a viewer side (audience-facing, no auth) and an admin side (password-protected); ShipPilot is admin-only by definition.
- It runs in one LXC among several on Proxmox. The maintainer is iterative and tests risky changes before production; ShowPilot has a Docker test container for that, but for ShipPilot the LXC IS production (no separate test environment).

---

## Starting a new conversation in this project

When a conversation about ShipPilot starts, you have:
- This primer (you're reading it — it ships with the repo at `PRIMER.md`)
- Possibly past conversation history, if earlier chats were moved into the project

What you should do:

1. **Read this primer.** Ask what to work on.
2. **Clone the repo.** It's public: `git clone https://github.com/ShowPilotFPP/ShipPilot.git /home/claude/shippilot`
3. **Check the version in `package.json`** to confirm what release you're starting from.
4. **For continuity on a specific issue,** search the conversation history, if past chats were moved into the project.

Don't reinvent decisions documented above. If you think a documented decision is wrong, raise it explicitly rather than quietly changing course.

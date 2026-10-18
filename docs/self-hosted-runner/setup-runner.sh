#!/bin/bash
# Set up the self-hosted GitHub Actions build runner for the ShowPilot repos.
# Run inside an Ubuntu 24.04 machine (an OrbStack machine on an Apple Silicon
# Mac, a VM, or any Linux box) as a normal user with sudo:
#
#   bash setup-runner.sh                      # tools + one runner per default repo
#   bash setup-runner.sh ShowPilot-Player     # tools + runners for the repos named
#   bash setup-runner.sh --status             # show the runner services
#
# Registration tokens come from the GitHub CLI (`gh auth login` as the repo
# owner, done for you if needed; logged out again at the end) or are asked for
# one repo at a time (repo Settings -> Actions -> Runners -> New self-hosted runner).
# Re-running is safe: tools are skipped when present, runners re-registered.
set -euo pipefail

OWNER="${OWNER:-ShowPilotFPP}"
DEFAULT_REPOS=(ShowPilot ShowPilot-Lite ShowPilot-plugin ShowPilot-Player)
LABELS="showpilot"            # plus the automatic self-hosted, Linux, ARM64/X64
BASE="${RUNNER_BASE:-$HOME/actions-runners}"

say() { echo; echo "== $*"; }
die() { echo "setup-runner: $*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "run this inside the Linux machine (e.g. after 'orb -m showpilot-runner'), not on macOS"
[ "$(id -u)" != 0 ] || die "run as a normal user with sudo, not root (the runner refuses to run as root)"
command -v sudo >/dev/null || die "sudo is required"
case "$(uname -m)" in aarch64) RARCH=arm64 ;; x86_64) RARCH=x64 ;; *) die "unsupported CPU $(uname -m)" ;; esac

if [ "${1:-}" = "--status" ]; then
	systemctl list-units --all 'actions.runner.*' --no-pager
	exit 0
fi
REPOS=("$@"); [ ${#REPOS[@]} -gt 0 ] || REPOS=("${DEFAULT_REPOS[@]}")

say "Packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -q
# Workflow tools (git, curl, jq, python3, zip), SD image build (xz, sfdisk,
# e2fsprogs), ShowPilot Player tests (mpv, php-cgi, ffmpeg).
sudo apt-get install -y -q --no-install-recommends \
	git curl ca-certificates jq python3 zip unzip xz-utils fdisk e2fsprogs util-linux \
	build-essential mpv php-cgi php-cli ffmpeg

if ! command -v gh >/dev/null; then
	say "GitHub CLI"
	sudo install -d -m 755 /etc/apt/keyrings
	curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
	sudo chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		| sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
	sudo apt-get update -q && sudo apt-get install -y -q gh
fi

if ! node -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" 2>/dev/null; then
	say "Node.js 22"
	curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
	sudo apt-get install -y -q nodejs
fi

if ! command -v docker >/dev/null; then
	say "Docker"
	curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"

say "Weekly cleanup (Docker cache, old runner work folders)"
sudo tee /etc/cron.weekly/showpilot-runner-cleanup >/dev/null <<'EOF'
#!/bin/sh
# Keep the build machine's disk in check: unused Docker images/cache older than a week.
docker system prune -af --filter until=168h >/dev/null 2>&1
docker builder prune -af --filter until=168h >/dev/null 2>&1
rm -rf /var/tmp/spp-image
exit 0
EOF
sudo chmod 755 /etc/cron.weekly/showpilot-runner-cleanup

say "Self-test: loop device + ext4 mount + chroot (the SD image build needs these)"
T="$(mktemp -d)"
truncate -s 64M "$T/t.img"
mkfs.ext4 -q -F "$T/t.img"
L="$(sudo losetup -f --show "$T/t.img")"
mkdir -p "$T/m"
if sudo mount "$L" "$T/m"; then
	sudo umount "$T/m"; sudo losetup -d "$L"; rm -rf "$T"
	echo "OK"
else
	sudo losetup -d "$L"; rm -rf "$T"
	die "this machine can't mount loop devices; SD image builds won't work here (use a full VM, e.g. UTM, instead)"
fi

say "Runner software"
VER="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')"
[ -n "$VER" ] && [ "$VER" != null ] || die "could not look up the latest runner version"
PKG="$BASE/.cache/actions-runner-linux-${RARCH}-${VER}.tar.gz"
mkdir -p "$BASE/.cache"
[ -f "$PKG" ] || curl -fL -o "$PKG" "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-${RARCH}-${VER}.tar.gz"
find "$BASE/.cache" -name 'actions-runner-*.tar.gz' ! -name "$(basename "$PKG")" -delete
echo "actions/runner ${VER} (${RARCH})"

USED_GH_LOGIN=""
if ! gh auth status >/dev/null 2>&1; then
	echo
	echo "Log in to GitHub as the owner of ${OWNER} (used only to fetch registration tokens)."
	if gh auth login --hostname github.com --git-protocol https --web; then USED_GH_LOGIN=1; fi
fi

token_for() {
	local t=""
	if gh auth status >/dev/null 2>&1; then
		t="$(gh api -X POST "repos/${OWNER}/$1/actions/runners/registration-token" --jq .token 2>/dev/null || true)"
	fi
	if [ -z "$t" ]; then
		read -r -p "Registration token for ${OWNER}/$1 (Settings -> Actions -> Runners -> New self-hosted runner): " t </dev/tty
	fi
	echo "$t"
}

for REPO in "${REPOS[@]}"; do
	say "Runner for ${OWNER}/${REPO}"
	DIR="$BASE/$REPO"
	if [ -f "$DIR/.runner" ]; then
		# Re-run: drop the old service and local registration; --replace below
		# takes over the runner of the same name on GitHub.
		(cd "$DIR" && { sudo ./svc.sh stop >/dev/null 2>&1; sudo ./svc.sh uninstall >/dev/null 2>&1; true; })
		rm -f "$DIR/.runner" "$DIR/.credentials" "$DIR/.credentials_rsaparams" "$DIR/.service"
	fi
	mkdir -p "$DIR"
	tar -xzf "$PKG" -C "$DIR"
	# Its "Unable to locate package libicuNN" lines are normal (it tries each
	# version until one exists); only show its output if it actually fails.
	if ! OUT="$(sudo "$DIR/bin/installdependencies.sh" 2>&1)"; then echo "$OUT"; die "runner dependency install failed"; fi
	TOKEN="$(token_for "$REPO")"
	[ -n "$TOKEN" ] || die "no registration token for $REPO"
	(cd "$DIR" && ./config.sh --unattended --replace \
		--url "https://github.com/${OWNER}/${REPO}" --token "$TOKEN" \
		--name "$(hostname -s)-${REPO}" --labels "$LABELS" --work _work)
	(cd "$DIR" && sudo ./svc.sh install "$USER" >/dev/null && sudo ./svc.sh start >/dev/null)
	echo "Running as service actions.runner.${OWNER}-${REPO}.*"
done

if [ -n "$USED_GH_LOGIN" ]; then
	# Jobs run as this user; don't leave an owner-level GitHub login where they can read it.
	gh auth logout --hostname github.com >/dev/null 2>&1 || true
	echo; echo "Logged out of the GitHub CLI again."
fi

say "Done"
echo "Runners: ${REPOS[*]}  (labels: self-hosted, Linux, ${RARCH^^}, ${LABELS})"
echo "Check: bash $0 --status   |   GitHub: each repo -> Settings -> Actions -> Runners (Idle = ready)."
echo "Your own shell needs a new login before plain 'docker' works without sudo; the runner services already have it."

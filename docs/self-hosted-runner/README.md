# Self-hosted build runner

All ShowPilot build, test, Docker and ship jobs run on one self-hosted GitHub
Actions runner instead of GitHub's machines. The reference setup is an Apple
Silicon Mac running an Ubuntu machine in OrbStack: the Mac is arm64 like a
Raspberry Pi, so the ShowPilot Player SD card image builds natively.

| Workflow | Repo | Runs on |
|---|---|---|
| Ship via ShipPilot | ShowPilot, ShowPilot-Lite, ShowPilot-plugin, ShowPilot-Player | self-hosted |
| Build and publish Docker image (amd64 + arm64 + merge) | ShowPilot | self-hosted (amd64 emulated) |
| Tests | ShowPilot-Player | self-hosted; **pull requests from forks stay on GitHub** |
| Build SD card image (manual) | ShowPilot-Player | self-hosted |
| Claude (issues/PRs) | ShowPilot, ShowPilot-Lite, ShowPilot-plugin | **GitHub-hosted, on purpose** (see Security) |

Jobs target the labels `self-hosted, linux, arm64, showpilot`. Setting the repo
variable **`SPP_RUNNER` = `github`** (Settings -> Secrets and variables ->
Actions -> Variables) sends that repo's jobs back to GitHub-hosted runners, for
when the build machine is off or broken. While the machine is off and the
variable isn't set, jobs wait in the queue (up to 24 hours) and start when it
comes back.

## Disk and memory

- Tools, Docker and the runners: about 4-5 GB.
- An SD image build: about 6-8 GB while running (the Raspberry Pi OS download,
  ~0.5 GB, is kept between builds in `/var/cache/spp-image`; the rest is
  deleted when the build ends).
- Docker build cache grows with ShowPilot image builds; a weekly job
  (`/etc/cron.weekly/showpilot-runner-cleanup`) prunes anything older than a week.
- OrbStack's disk grows and shrinks with use, so space comes back to macOS.
- 4 GB of memory for the machine is enough; 8 GB if Docker builds feel slow.

## Set up (Mac + OrbStack)

1. Install OrbStack (`brew install orbstack`, or from orbstack.dev) and open it
   once. In OrbStack settings, turn on **Start at login**.
2. Keep the Mac awake: System Settings -> Energy -> **Prevent automatic sleeping
   when the display is off**.
3. In Terminal, create the Ubuntu machine and open a shell in it:
   ```bash
   orb create ubuntu:noble showpilot-runner
   orb -m showpilot-runner
   ```
4. Save `setup-runner.sh` (this folder) to the Mac's Downloads folder. OrbStack
   machines see the Mac's files at the same paths, so inside the machine run:
   ```bash
   bash /Users/<your-mac-user>/Downloads/setup-runner.sh
   ```
   Or download it straight into the machine:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/ShowPilotFPP/ShipPilot/main/docs/self-hosted-runner/setup-runner.sh
   bash setup-runner.sh
   ```
   It installs the tools, checks that loop devices work (needed for SD
   images), and registers one runner per repo as a service. When asked, log
   in to GitHub in the browser with the code it shows; it logs out again at
   the end.
5. Check each repo -> Settings -> Actions -> Runners: the runner shows **Idle**.

Re-run `bash setup-runner.sh` to update the runner software or re-register;
`bash setup-runner.sh ShowPilot-Player` does just one repo; `--status` lists
the services.

If the loop-device self-test fails, OrbStack can't mount disk images on that
Mac: use a full Ubuntu Server (arm64) VM in UTM instead and run the same script there.

Any other Linux machine works too (a Proxmox VM, a Pi 5): same script. On an
x86_64 machine the SD image chroot and the arm64 Docker image are emulated
with QEMU (slower).

## Security

- A self-hosted runner runs whatever the job runs, on your network. Only
  trusted code reaches it: ship jobs (owner-approved `claude/*` branches),
  Docker builds (tags and the beta branch), the SD image (manual) and
  pushed commits. Fork pull requests run their tests on GitHub's machines.
- Set each repo -> Settings -> Actions -> General -> **Require approval for all
  external contributors** for fork pull request workflows.
- The Claude workflows stay on GitHub-hosted runners: they act on public issue
  and PR text, and on a shared machine a prompt-injected run could read the
  other runners' registration files. A throwaway GitHub VM has nothing to steal.
- Jobs run as the runner's user with passwordless sudo (the image build needs
  root), so treat the machine as a build box: no personal files or other
  credentials on it.

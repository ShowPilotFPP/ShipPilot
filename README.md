# ShipPilot

Tarball-driven release tool for ShowPilot and ShowPilot-plugin. Drops a
tarball, applies it to a managed git clone, commits, tags, and pushes — so
shipping a release stops being a sequence of manual git commands.

## What's in a tarball

ShipPilot reads `.release.json` from the tarball root:

```json
{
  "repo": "showpilot",
  "version": "0.25.6",
  "commit_message": "0.25.6 — fix something",
  "tag": "v0.25.6"
}
```

Fields:
- `repo` — must match a key in `config.js` `repos`
- `version` — semver. Cross-checked against `package.json` if present.
- `commit_message` — used as-is for the commit
- `tag` — optional; omit for an untagged commit

## Install (Ubuntu 24.04 LXC)

```bash
sudo apt-get update && sudo apt-get install -y nodejs npm git build-essential python3
sudo npm install -g pm2

cd /opt
sudo git clone https://github.com/ShowPilotFPP/ShipPilot.git shippilot
cd shippilot
sudo npm install
sudo cp config.example.js config.js
# edit config.js — at minimum verify port and repo remotes
```

Set up SSH keys for git so the tool can push without prompting:

```bash
sudo -u root ssh-keygen -t ed25519 -C "shippilot@<host>" -f /root/.ssh/id_ed25519 -N ""
cat /root/.ssh/id_ed25519.pub
# add as a deploy key (with write access) on each managed repo on GitHub
ssh -T git@github.com   # accept the host key once
```

Start it:

```bash
pm2 start server.js --name shippilot
pm2 save
pm2 startup   # follow the printed instructions to enable on boot
```

First load of the UI shows a setup form. Create the admin user, then ship.

## Operating notes

- The clones live under `data/repos/<repo>`. They're managed by ShipPilot —
  don't edit them by hand.
- Every release is logged in `data/shippilot.db`. The UI's "Log" button
  shows the captured stdout/stderr from any past release.
- On any failure after the working tree has been replaced, ShipPilot resets
  the clone hard back to the pre-release HEAD and deletes any local tag it
  created. So the clone is always either fully shipped or fully untouched.
- `package.json` version mismatch with the manifest is a hard fail. So is a
  tag that already exists. Bump or fix and try again.

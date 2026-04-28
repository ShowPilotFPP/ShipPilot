// SSH config management with markers.
//
// ShipPilot needs to write `Host github-<slug>` blocks to ~/.ssh/config so
// SSH knows which key to use for which alias. But that file may have other
// content the user set up manually (e.g. the three repos we wired by hand
// originally), and we MUST NOT touch any of it.
//
// Strategy: carve out a managed block delimited by sentinel comments. Read
// the whole file, replace just the managed section, write back. Anything
// outside the markers is preserved verbatim.
//
// On first install (markers absent), we append a new managed block at the
// end of the file.

const fs = require('fs');
const path = require('path');
const os = require('os');

const BEGIN = '# === BEGIN SHIPPILOT-MANAGED ===';
const END = '# === END SHIPPILOT-MANAGED ===';

function defaultConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

// Build the managed block content from a list of repo entries.
// Each entry: { slug: 'foo', keyPath: '/root/.ssh/shippilot-keys/foo' }
function renderManagedBlock(entries) {
  if (!entries.length) {
    // Even with no entries, leave the markers so we know we own the section
    return `${BEGIN}\n# (no repos managed by ShipPilot)\n${END}\n`;
  }
  const blocks = entries.map((e) => (
    `Host github-${e.slug}\n` +
    `    HostName github.com\n` +
    `    User git\n` +
    `    IdentityFile ${e.keyPath}\n` +
    `    IdentitiesOnly yes\n`
  ));
  return `${BEGIN}\n` + blocks.join('\n') + `${END}\n`;
}

// Read the file, find the managed block (if any), and split into
// before/after. The block itself is discarded; we'll regenerate it.
function splitFile(text) {
  const beginIdx = text.indexOf(BEGIN);
  if (beginIdx < 0) return { before: text, after: '', hadBlock: false };
  // Find END after BEGIN
  const endIdx = text.indexOf(END, beginIdx);
  if (endIdx < 0) {
    // Malformed: BEGIN without END. Be conservative — treat the rest of
    // the file as part of the block and warn the caller.
    return { before: text.slice(0, beginIdx), after: '', hadBlock: true, malformed: true };
  }
  // Include the END line itself in what we strip
  const endLineEnd = text.indexOf('\n', endIdx);
  const after = endLineEnd < 0 ? '' : text.slice(endLineEnd + 1);
  return { before: text.slice(0, beginIdx), after, hadBlock: true };
}

// Rewrite the managed block. Atomic: write to a temp file, then rename.
// Preserves file mode if the file already exists; creates with 0600 otherwise.
function writeManagedBlock(entries, configPath = defaultConfigPath()) {
  let existing = '';
  let mode = 0o600;
  if (fs.existsSync(configPath)) {
    existing = fs.readFileSync(configPath, 'utf8');
    try { mode = fs.statSync(configPath).mode & 0o777; } catch { mode = 0o600; }
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  }

  const { before, after, hadBlock, malformed } = splitFile(existing);

  // If splitting found a malformed block, refuse to write — better to fail
  // loudly than to corrupt user state. Caller must fix the file by hand.
  if (malformed) {
    throw new Error(
      `~/.ssh/config has a "${BEGIN}" line but no "${END}" — refusing to rewrite. ` +
      `Fix the file by hand (add the END marker, or remove both) and retry.`
    );
  }

  const block = renderManagedBlock(entries);

  // Compose the new file. If we appended (no prior block), make sure
  // there's a blank line of separation before our block.
  let next;
  if (hadBlock) {
    // Replace in place, preserving surrounding content exactly
    next = before + block + after;
  } else {
    const sep = (existing.length === 0 || existing.endsWith('\n\n')) ? '' :
                existing.endsWith('\n') ? '\n' : '\n\n';
    next = existing + sep + block;
  }

  // Atomic write
  const tmp = configPath + '.shippilot-tmp';
  fs.writeFileSync(tmp, next, { mode });
  fs.renameSync(tmp, configPath);
}

module.exports = {
  BEGIN, END,
  renderManagedBlock,
  splitFile,
  writeManagedBlock,
  defaultConfigPath,
};

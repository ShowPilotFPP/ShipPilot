// Self-update (v0.5.0): matching ShipPilot's own clone to a repo row.
// Run: node test/test-self-update.js (needs node_modules for lib/db).

const assert = require('assert');
const { ownerRepo } = require('../lib/self-update');

assert.strictEqual(ownerRepo('git@github.com:ShowPilotFPP/ShipPilot.git'), 'showpilotfpp/shippilot');
assert.strictEqual(ownerRepo('git@github-shippilot:ShowPilotFPP/ShipPilot.git'), 'showpilotfpp/shippilot'); // SSH config alias
assert.strictEqual(ownerRepo('https://github.com/ShowPilotFPP/ShipPilot'), 'showpilotfpp/shippilot');
assert.strictEqual(ownerRepo('https://github.com/ShowPilotFPP/ShipPilot.git/'), 'showpilotfpp/shippilot');
assert.strictEqual(ownerRepo('ssh://git@github.com/ShowPilotFPP/ShipPilot.git'), 'showpilotfpp/shippilot');
assert.strictEqual(ownerRepo('/srv/git/ShowPilotFPP/ShipPilot.git'), 'showpilotfpp/shippilot');
assert.strictEqual(ownerRepo(''), null);
assert.strictEqual(ownerRepo(null), null);
console.log('PASS: ownerRepo');

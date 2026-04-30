// Validator + mutex tests. Regexes copied inline to avoid loading native
// modules (better-sqlite3, ssh2) which can't build in this sandbox. The
// regexes here MUST stay in sync with lib/environments.js — if you change
// one, change both.

const assert = require('assert');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,255}$/;

// Slug
assert.strictEqual(SLUG_RE.test(''), false);
assert.strictEqual(SLUG_RE.test('a'), false);
assert.strictEqual(SLUG_RE.test('-foo'), false);
assert.strictEqual(SLUG_RE.test('FOO'), false);
assert.strictEqual(SLUG_RE.test('a/b'), false);
assert.strictEqual(SLUG_RE.test('a;rm -rf /'), false);
assert.strictEqual(SLUG_RE.test('showpilot-prod'), true);
assert.strictEqual(SLUG_RE.test('demo-app'), true);
assert.strictEqual(SLUG_RE.test('demo-bundle'), true);
console.log('PASS: slug');

// Host
assert.strictEqual(HOST_RE.test(''), false);
assert.strictEqual(HOST_RE.test('-foo'), false);
assert.strictEqual(HOST_RE.test('host;rm'), false);
assert.strictEqual(HOST_RE.test('192.168.1.230'), true);
assert.strictEqual(HOST_RE.test('192.168.1.232'), true);
assert.strictEqual(HOST_RE.test('demo.showpilot.dev'), true);
console.log('PASS: host');

// User
assert.strictEqual(USER_RE.test(''), false);
assert.strictEqual(USER_RE.test('-root'), false);
assert.strictEqual(USER_RE.test('user;ls'), false);
assert.strictEqual(USER_RE.test('root'), true);
assert.strictEqual(USER_RE.test('deploy'), true);
console.log('PASS: user');

// Path
assert.strictEqual(PATH_RE.test('relative/path'), false);
assert.strictEqual(PATH_RE.test(''), false);
assert.strictEqual(PATH_RE.test('/path with spaces'), false);
assert.strictEqual(PATH_RE.test('/path;rm -rf /'), false);
assert.strictEqual(PATH_RE.test('/opt/showpilot'), true);
assert.strictEqual(PATH_RE.test('/opt/showpilot-demo'), true);
assert.strictEqual(PATH_RE.test('/opt/showpilot-demo-fakeplugin'), true);
console.log('PASS: path');

// shellQuote (matches lib/ssh.js implementation)
function shellQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
assert.strictEqual(shellQuote('hello'), "'hello'");
assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
assert.strictEqual(shellQuote(''), "''");
assert.strictEqual(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'");
console.log('PASS: shellQuote');

// Mutex semantics test (matches lib/deploy.js withEnvLock pattern)
async function mutexTest() {
  const envLocks = new Map();
  async function withEnvLock(envId, fn) {
    const prior = envLocks.get(envId);
    if (prior) await prior.catch(() => {});
    const work = (async () => {
      try { return { ok: true, value: await fn() }; }
      catch (e) { return { ok: false, error: e }; }
    })();
    envLocks.set(envId, work);
    let outcome;
    try { outcome = await work; }
    finally { if (envLocks.get(envId) === work) envLocks.delete(envId); }
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Same env serializes
  const order1 = [];
  const a = withEnvLock(1, async () => { order1.push('a-s'); await sleep(50); order1.push('a-e'); });
  const b = withEnvLock(1, async () => { order1.push('b-s'); await sleep(20); order1.push('b-e'); });
  await Promise.all([a, b]);
  assert.deepStrictEqual(order1, ['a-s', 'a-e', 'b-s', 'b-e']);

  // Different envs run in parallel
  const order2 = [];
  const c = withEnvLock(2, async () => { order2.push('c-s'); await sleep(50); order2.push('c-e'); });
  const d = withEnvLock(3, async () => { order2.push('d-s'); await sleep(10); order2.push('d-e'); });
  await Promise.all([c, d]);
  assert.deepStrictEqual(order2, ['c-s', 'd-s', 'd-e', 'c-e']);

  // Lock released after failure, no unhandled rejection
  await assert.rejects(withEnvLock(4, async () => { throw new Error('boom'); }), /boom/);
  const result = await withEnvLock(4, async () => 'ok');
  assert.strictEqual(result, 'ok');

  // Failure of prior does NOT cascade to next caller
  const orderFail = [];
  const failing = withEnvLock(5, async () => { orderFail.push('fail-s'); await sleep(20); throw new Error('first'); });
  const following = withEnvLock(5, async () => { orderFail.push('next-s'); return 'next'; });
  await assert.rejects(failing, /first/);
  const nextResult = await following;
  assert.strictEqual(nextResult, 'next');
  assert.deepStrictEqual(orderFail, ['fail-s', 'next-s']);

  console.log('PASS: mutex');
}

mutexTest()
  .then(() => console.log('\nAll tests passed.'))
  .catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });

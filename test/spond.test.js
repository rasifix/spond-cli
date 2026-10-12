import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClient, groupRows, rsvpRows, guardianRows, playerRows } from '../src/spond.js';
import { tokenStore } from '../src/store.js';

test('login sends expected body and extracts token, without refresh/password tokens', async () => {
  const client = createClient(undefined, async (url, opts) => {
    assert.equal(String(url), 'https://api.spond.com/core/v1/auth2/login');
    assert.equal(opts.method, 'POST');
    assert.deepEqual(JSON.parse(opts.body), { email: 'test@example.invalid', password: 'secret' });
    assert.equal(opts.redirect, 'error');
    return Response.json({ accessToken: { token: 'abc', expiration: '2099-01-01' }, passwordToken: 'omit' });
  });
  assert.deepEqual(await client.login('test@example.invalid', 'secret'), { token: 'abc', expiration: '2099-01-01' });
});
test('challenge without access token fails', async () => {
  await assert.rejects(createClient(null, async () => Response.json({ challenge: 'private' })).login('a', 'b'), /no token/);
});
test('GET events encodes group and filters and uses bearer token', async () => {
  const client = createClient('abc', async (url, opts) => {
    assert.equal(url.pathname, '/core/v1/sponds');
    assert.equal(url.searchParams.get('groupId'), 'group&test');
    assert.equal(url.searchParams.get('scheduled'), 'false');
    assert.equal(url.searchParams.get('max'), '50');
    assert.equal(opts.method, 'GET');
    assert.equal(opts.headers.Authorization, 'Bearer abc');
    return Response.json([]);
  });
  assert.deepEqual(await client.events('group&test', { limit: 50 }), []);
});
test('GET events can be filtered to a subgroup', async () => {
  const client = createClient('abc', async url => {
    assert.equal(url.searchParams.get('groupId'), 'group-id');
    assert.equal(url.searchParams.get('subGroupId'), 'subgroup-id');
    return Response.json([]);
  });
  assert.deepEqual(await client.events('group-id', { subgroupId: 'subgroup-id' }), []);
});
test('group rows include subgroups with their parent group ID', () => {
  assert.deepEqual(groupRows([
    { id: 'g1', name: 'Club', subGroups: [
      { id: 's1', name: 'Juniors' }, { id: 's2', name: 'Seniors' }
    ] },
    { id: 'g2', name: 'Other' }
  ]), [
    { id: 'g1', name: 'Club', parentId: '' },
    { id: 's1', name: 'Juniors', parentId: 'g1' },
    { id: 's2', name: 'Seniors', parentId: 'g1' },
    { id: 'g2', name: 'Other', parentId: '' }
  ]);
  assert.throws(() => groupRows([{ id: 'g1', name: 'Club', subGroups: {} }]), /subgroup data structure/);
});
test('HTTP errors never surface response secrets', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(createClient('abc', async () => new Response('SECRET', { status })).groups(), e => !e.message.includes('SECRET'));
  }
});
test('malformed responses and network failures fail safely', async () => {
  await assert.rejects(createClient('abc', async () => new Response('<html>')).groups(), /JSON/);
  await assert.rejects(createClient('abc', async () => Response.json({})).events('g'), /event data structure/);
  await assert.rejects(createClient('abc', async () => { throw new Error('SECRET'); }).groups(), /unreachable/);
});
test('RSVP preserves five states, child member identity and unmapped IDs', () => {
  const result = rsvpRows({ responses: {
    acceptedIds: ['child'], declinedIds: ['b'], unansweredIds: ['c'], waitinglistIds: ['d'], unconfirmedIds: ['e']
  } }, [{ id: 'child', firstName: 'Kind', lastName: 'Test', guardians: [{ id: 'guardian' }] }]);
  assert.deepEqual(result.rows.map(r => r.status), ['accepted', 'declined', 'unanswered', 'waitinglist', 'unconfirmed']);
  assert.equal(result.rows[0].name, 'Kind Test');
  assert.equal(result.rows[1].name, '(unmapped)');
  assert.deepEqual(result.missingFields, []);
});
test('missing RSVP fields are explicit; conflicting lists fail', () => {
  assert.equal(rsvpRows({ responses: { acceptedIds: [] } }, []).missingFields.length, 4);
  assert.throws(() => rsvpRows({ responses: { acceptedIds: ['a'], declinedIds: ['a'] } }, []), /Conflicting/);
  assert.throws(() => rsvpRows({}, []), /unavailable/);
});
test('token lifecycle: private permissions, load, expiration and idempotent logout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spond-test-'));
  try {
    const store = tokenStore(dir);
    await assert.rejects(store.load(), /Not logged in/);
    await store.save({ token: 'abc' });
    assert.equal(await store.load(), 'abc');
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(dir, 'token.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
    await store.save({ token: 'def', expiration: '2000-01-01' });
    await assert.rejects(store.load(), /expired/);
    await writeFile(join(dir, 'token.json'), 'not json');
    await assert.rejects(store.load(), /cannot be read/);
    await store.clear(); await store.clear();
    await assert.rejects(store.load(), /Not logged in/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI help and argument validation work without network', () => {
  const bin = new URL('../bin/spond.js', import.meta.url);
  function run(args) { return spawnSync(process.execPath, [bin.pathname, ...args], { encoding: 'utf8' }); }
  assert.equal(run(['--help']).status, 0);
  assert.match(run(['members', 'list']).stderr, /--group/);
  assert.match(run(['players', 'list']).stderr, /--group/);
  assert.match(run(['events', 'list', '--subgroup', 's1']).stderr, /--group is required with --subgroup/);
  assert.match(run(['members', 'list', '--group', 'g', '--subgroup', 's1']).stderr, /not valid for members list/);
  assert.match(run(['events', 'rsvp', '--group', 'g']).stderr, /--event/);
  assert.match(run(['events', 'list', '--group', 'g', '--limit', '0']).stderr, /--limit/);
  assert.match(run(['events', 'list', '--group', 'g', '--from', '2026-02-30']).stderr, /Invalid date/);
  assert.match(run(['login', '--password', 'secret']).stderr, /Unknown option/);
});

test('players include only respondent members', () => {
  assert.deepEqual(playerRows([
    { id: 'p1', firstName: 'Alex', lastName: 'Player', respondent: true },
    { id: 'n1', firstName: 'Casey', lastName: 'Coach', respondent: false },
    { id: 'n2', firstName: 'Sam', lastName: 'Unknown' },
    null
  ]), [{ id: 'p1', name: 'Alex Player' }]);
});

test('guardians retain member links, deduplicate pairs and tolerate absent lists', () => {
  const guardian = { id: 'g1', firstName: 'Alex', lastName: 'Test', email: 'private@example.invalid' };
  const rows = guardianRows([
    { id: 'm1', firstName: 'Kind 1', guardians: [guardian, guardian] },
    { id: 'm2', firstName: 'Kind 2', guardians: [guardian, { id: 'g2', firstName: 'Sam' }] },
    { id: 'm3' }, { id: 'm4', guardians: [] }
  ]);
  assert.deepEqual(rows, [
    { guardianId: 'g1', name: 'Alex Test', email: 'private@example.invalid', memberId: 'm1', memberName: 'Kind 1' },
    { guardianId: 'g1', name: 'Alex Test', email: 'private@example.invalid', memberId: 'm2', memberName: 'Kind 2' },
    { guardianId: 'g2', name: 'Sam', email: '', memberId: 'm2', memberName: 'Kind 2' }
  ]);
  assert.deepEqual(guardianRows([]), []);
  assert.throws(() => guardianRows([{ id: 'm', guardians: {} }]), /guardian data structure/);
  assert.throws(() => guardianRows([{ id: 'm', guardians: [{}] }]), /ID is missing/);
});

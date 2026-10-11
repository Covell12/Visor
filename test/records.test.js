// The generic record API behaves the same on both stores.
'use strict';
process.env.PGLITE_DIR = 'memory://';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadFirestoreRepo } = require('./helpers/fakeFirebase');

const sql = require('../lib/repoSql');
const fsStore = loadFirestoreRepo();

for (const [name, repo] of [['sql', sql], ['firestore', fsStore.repo]]) {
  test(`${name}: put, get, update, list, delete`, async () => {
    await repo.putRecord('assignment', { id: 'a1', classId: 'c1', title: 'Essay', updatedAt: '2026-01-01T00:00:00Z' });
    await repo.putRecord('assignment', { id: 'a2', classId: 'c1', title: 'Debate', updatedAt: '2026-02-01T00:00:00Z' });
    await repo.putRecord('assignment', { id: 'a3', classId: 'c2', title: 'Other' });
    assert.strictEqual((await repo.getRecord('assignment', 'a1')).title, 'Essay');
    assert.strictEqual(await repo.getRecord('assignment', 'nope'), null);
    assert.deepStrictEqual((await repo.listRecords('assignment', { classId: 'c1' })).map(a => a.id), ['a1', 'a2']);
    assert.deepStrictEqual((await repo.listRecords('assignment', { classId: 'c1' }, { updatedBefore: '2026-01-15' })).map(a => a.id), ['a1']);

    const out = await repo.updateRecord('assignment', 'a1', a => { a.title = 'Essay 2'; return 'done'; });
    assert.strictEqual(out, 'done');
    assert.strictEqual((await repo.getRecord('assignment', 'a1')).title, 'Essay 2');
    assert.strictEqual(await repo.updateRecord('assignment', 'missing', () => {}), null);

    // Kinds are separate namespaces
    await repo.putRecord('doc', { id: 'a1', assignmentId: 'a1', studentId: 's1' });
    assert.strictEqual((await repo.getRecord('assignment', 'a1')).title, 'Essay 2');
    assert.deepStrictEqual((await repo.listRecords('doc', { assignmentId: 'a1', studentId: 's1' })).map(d => d.id), ['a1']);
    assert.deepStrictEqual(await repo.listRecords('doc', { assignmentId: 'a1', studentId: 's2' }), []);

    assert.strictEqual(await repo.deleteRecords('assignment', { classId: 'c1' }), 2);
    assert.deepStrictEqual((await repo.listRecords('assignment', { classId: 'c2' })).map(a => a.id), ['a3']);
    await repo.deleteRecord('assignment', 'a3');
    assert.strictEqual(await repo.getRecord('assignment', 'a3'), null);
    await assert.rejects(() => repo.deleteRecords('assignment', {}));
  });

  test(`${name}: withRecords writes several records together, or none`, async () => {
    await repo.putRecord('doc', { id: 'd1', seq: 0 });
    await repo.withRecords(async t => {
      const d = await t.get('doc', 'd1');
      const chunk = (await t.get('opchunk', 'd1:000000')) || { id: 'd1:000000', docId: 'd1', ops: [] };
      chunk.ops.push({ n: 1 }); d.seq = 1;
      t.put('doc', d); t.put('opchunk', chunk);
    });
    assert.strictEqual((await repo.getRecord('doc', 'd1')).seq, 1);
    assert.strictEqual((await repo.getRecord('opchunk', 'd1:000000')).ops.length, 1);
    await assert.rejects(() => repo.withRecords(async t => {
      const d = await t.get('doc', 'd1'); d.seq = 99; t.put('doc', d);
      throw new Error('stop');
    }));
    // In SQL the transaction rolls back; in Firestore the writes were never sent.
    assert.strictEqual((await repo.getRecord('doc', 'd1')).seq, 1);
  });

  test(`${name}: large bodies round-trip`, async () => {
    // Random text doesn't compress, so this crosses the ~900 KB inline limit.
    const big = crypto.randomBytes(1200 * 1024).toString('base64');
    await repo.putRecord('research', { id: 'r-big', sessionId: 's1', blob: big });
    assert.strictEqual((await repo.getRecord('research', 'r-big')).blob, big);
    await repo.updateRecord('research', 'r-big', r => { r.blob = 'small'; });
    assert.strictEqual((await repo.getRecord('research', 'r-big')).blob, 'small');
  });
}

test('firestore: big records go to Storage and come back when they shrink', async () => {
  const { repo, fake } = loadFirestoreRepo();
  const big = crypto.randomBytes(1200 * 1024).toString('base64');
  await repo.putRecord('doc', { id: 'x', blob: big });
  assert.ok(fake.files.has('data/records/doc/x.json.gz'));
  await repo.updateRecord('doc', 'x', r => { r.blob = ''; });
  assert.ok(!fake.files.has('data/records/doc/x.json.gz'));
});

test('core documents carry a classes map', async () => {
  const core = await sql.readCore();
  assert.deepStrictEqual(core.classes, {});
  assert.deepStrictEqual((await fsStore.repo.readCore()).classes, {});
});

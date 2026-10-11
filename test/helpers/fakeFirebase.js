// An in-memory stand-in for the bits of firebase-admin that lib/repoFirestore.js
// uses: collections, documents, equality/range queries, transactions, batches,
// and a Storage bucket. Lets the Firestore store run in tests with no network.
'use strict';

function makeFakeFirebase() {
  const docs = new Map();   // "collection/id" -> fields
  const files = new Map();  // path -> Buffer

  const snapOf = (col, id) => {
    const key = `${col}/${id}`;
    const data = docs.get(key);
    return { id, exists: !!data, get: f => (data ? data[f] : undefined), data: () => data, ref: refOf(col, id) };
  };
  function refOf(col, id) {
    return {
      id, _key: `${col}/${id}`,
      async get() { return snapOf(col, id); },
      async set(fields) { docs.set(`${col}/${id}`, { ...fields }); },
      async delete() { docs.delete(`${col}/${id}`); }
    };
  }
  function query(col, filters) {
    return {
      where(k, op, v) { return query(col, [...filters, [k, op, v]]); },
      async get() {
        const out = [];
        for (const [key, data] of docs) {
          if (!key.startsWith(col + '/')) continue;
          const ok = filters.every(([k, op, v]) => (op === '==' ? data[k] === v : op === '<' ? data[k] != null && data[k] < v : false));
          if (ok) out.push(snapOf(col, key.slice(col.length + 1)));
        }
        return { docs: out };
      }
    };
  }
  const db = {
    collection(col) { return { doc: id => refOf(col, id), ...query(col, []) }; },
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: ref => ref.get(),
        set: (ref, f) => pending.push(() => ref.set(f)),
        delete: ref => pending.push(() => ref.delete())
      };
      const out = await fn(tx);
      for (const p of pending) await p();
      return out;
    },
    batch() { const ops = []; return { delete: ref => ops.push(ref), commit: async () => { for (const r of ops) await r.delete(); } }; },
    settings() {}
  };
  const bucket = {
    name: 'fake-bucket',
    file: p => ({
      name: p,
      async save(buf) { files.set(p, Buffer.from(buf)); },
      async download() { if (!files.has(p)) throw new Error('no such file'); return [files.get(p)]; },
      async delete() { files.delete(p); },
      async exists() { return [files.has(p)]; }
    })
  };
  return { firestore: () => db, bucket: () => bucket, docs, files };
}

// Load lib/repoFirestore.js against a fresh fake.
function loadFirestoreRepo() {
  const path = require('path');
  const adminPath = require.resolve(path.join(__dirname, '..', '..', 'lib', 'firebaseAdmin.js'));
  const repoPath = require.resolve(path.join(__dirname, '..', '..', 'lib', 'repoFirestore.js'));
  const fake = makeFakeFirebase();
  require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { firestore: fake.firestore, bucket: fake.bucket } };
  delete require.cache[repoPath];
  const repo = require(repoPath);
  return { repo, fake };
}

module.exports = { makeFakeFirebase, loadFirestoreRepo };

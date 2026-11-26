'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const target = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const { AiLinesCounter } = require(path.join(target, 'lib'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-commit-stats-'));
const RealDate = global.Date;
const day = '2026-11-25';
let now = `${day}T12:00:00`;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
};

const databases = [];
const create = home => {
  const file = path.join(home, 'internal', 'datafinder-db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  databases.push(db);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.exec('CREATE TABLE datafinder_events (id INTEGER PRIMARY KEY, event_json TEXT, created_at INTEGER, delivered_at INTEGER)');
  return { file, db, insert: db.prepare('INSERT INTO datafinder_events (event_json, created_at, delivered_at) VALUES (?, ?, ?)') };
};
const seconds = text => Math.floor(new RealDate(text).getTime() / 1000);
const today = seconds(`${day}T09:00:00`);
const yesterday = seconds('2026-11-24T23:59:59');
const put = (store, hash, ai, total, {
  amended, timestamp = today, created = today, event = 'git_ai_commit_attribution', encode = false, delivered = true
} = {}) => {
  const params = { commit_hash: hash, amended_from_commit_hash: amended,
    commit_time: timestamp, total_ai_committed_added_lines: ai, total_lines_added: total };
  store.insert.run(JSON.stringify({ event, params: encode ? JSON.stringify(params) : params, local_time_ms: created * 1000 }),
    created, delivered ? created : null);
};
let cases = 0;
const check = (name, fn) => { fn(); cases++; console.log(`ok ${name}`); };

(async () => {
  const root = path.join(tmp, 'data');
  const main = create(root);
  const c = new AiLinesCounter({ root, appRoot: process.argv[3] });
  await c.poll();
  check('a queryable store without commits is a valid zero', () => assert.deepEqual(c.sums(), { ai: 0, total: 0, commits: 0 }));

  put(main, 'zero', 0, 0);
  put(main, 'old', 2, 2);
  put(main, 'previous-day-report', 2, 2, { created: yesterday });
  put(main, 'file-event', 2, 2, { event: 'git_ai_commit_file' });
  main.insert.run(JSON.stringify({ event: 'git_ai_commit_attribution', params: 'malformed' }), yesterday, null);
  await c.poll();
  check('counts only commit-level events reported today, including zero-valued commits', () => {
    assert.deepEqual(c.sums(), { ai: 2, total: 2, commits: 2 });
    assert.equal(c.lastRead.invalid, 0);
  });

  const account = create(path.join(root, 'account'));
  put(account, 'latest', 1, 2, { amended: 'middle', encode: true, delivered: false });
  put(account, 'middle', 2, 2, { amended: 'old' });
  put(main, 'latest', 2, 2, { amended: 'middle', created: today - 1 });
  put(main, 'old', 2, 2, { created: today + 1 });
  await c.poll();
  check('deduplicates across databases and keeps the final revision of an out-of-order amend chain', () => {
    assert.deepEqual(c.sums(), { ai: 1, total: 2, commits: 2 });
    assert.deepEqual(c.lastRead.files, [account.file, main.file].sort());
  });

  main.db.exec('BEGIN');
  put(main, 'new-in-wal', 1, 1);
  await c.poll();
  check('the read-only connection excludes uncommitted SQLite writes', () => {
    assert.deepEqual(c.sums(), { ai: 1, total: 2, commits: 2 });
  });
  main.db.exec('COMMIT');
  await c.poll();
  check('the same reader sees live WAL records after the writer commits', () => {
    assert.deepEqual(c.sums(), { ai: 2, total: 3, commits: 3 });
  });

  const bad = JSON.stringify({ event: 'git_ai_commit_attribution', params: {
    commit_hash: 'incomplete', commit_time: today, total_ai_committed_added_lines: 1
  } });
  const { lastInsertRowid } = account.insert.run(bad, today, null);
  await c.poll();
  check('an incomplete attribution is reported without showing zero or a partial sum', () => {
    assert.strictEqual(c.sums(), null);
    assert.equal(c.lastRead.invalid, 1);
  });
  account.db.prepare('DELETE FROM datafinder_events WHERE id = ?').run(lastInsertRowid);

  const corrupt = path.join(root, 'broken', 'internal', 'datafinder-db');
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  fs.writeFileSync(corrupt, 'not a database');
  await c.poll();
  check('an unreadable database reports unavailable without presenting a partial total', () => {
    assert.strictEqual(c.sums(), null);
    assert(c.lastRead.errors.some(error => error.file === corrupt));
  });
  fs.unlinkSync(corrupt);
  now = '2026-11-26T00:00:01';
  put(main, 'next-day', 1, 1, { timestamp: today, created: seconds(now) });
  await c.poll();
  check('a commit reported after midnight counts on its reporting date', () => {
    assert.deepEqual(c.sums(), { ai: 1, total: 1, commits: 1 });
  });
  const missing = new AiLinesCounter({ root: path.join(tmp, 'missing') });
  await missing.poll();
  check('a missing store is unavailable', () => assert.strictEqual(missing.sums(), null));
  console.log(`${cases} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    global.Date = RealDate;
    for (const db of databases) db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

'use strict';
// Source discovery and incremental reads use real files; only time/errors are controlled.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'lib.js'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-log-sources-'));
let now = new Date('2026-11-03T12:00:00').getTime();
let denied;
let deniedDir;
let deniedStat;
let replaceOnOpen;
let midnightOnOpen;
const opened = [];
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const accessError = () => Object.assign(new Error('test access denied'), { code: 'EACCES' });
const testFs = { ...fs,
  readdirSync(dir, ...args) {
    if (dir === deniedDir) throw accessError();
    return fs.readdirSync(dir, ...args);
  },
  statSync(file, ...args) {
    if (file === deniedStat) throw accessError();
    return fs.statSync(file, ...args);
  },
  promises: { ...fs.promises,
  async open(file, ...args) {
    if (file === denied) throw Object.assign(new Error('test read denied'), { code: 'EACCES' });
    if (file === midnightOnOpen) now = new Date('2026-11-04T00:00:01').getTime();
    if (file === replaceOnOpen) {
      fs.renameSync(file + '.replacement', file);
      replaceOnOpen = undefined;
    }
    opened.push(file);
    return fs.promises.open(file, ...args);
  }
} };
const context = { module: { exports: {} }, Date: TestDate, process, console, Buffer,
  require: name => name === 'fs' ? testFs : require(name) };
vm.runInNewContext(source, context);
const { AiLinesCounter } = context.module.exports;
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok ' + name); }
function write(file, text, date = new TestDate()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, date, date);
  return file;
}
function event(hash, n, day = '2026-11-03') {
  return `${day}T10:00:00.000 INFO datafinder: event [git_ai_commit_attribution] core_payload=${JSON.stringify({
    commit_hash: hash, total_lines_added: n, total_ai_committed_added_lines: n
  })}\n`;
}
function sums(counter) { return JSON.parse(JSON.stringify(counter.sums())); }
(async () => {
  try {
    const logs = path.join(tmp, 'logs'), native = path.join(tmp, 'native');
    const nativeDir = path.join(native, 'tenant/internal/daemon/logs');
    const old = write(path.join(nativeDir, 'git-ai-daemon-2026-10-29.log'), event('a', 1) + event('b', 105));
    const today = write(path.join(nativeDir, 'git-ai-daemon-2026-11-03.log'), event('c', 151));
    const mirror = write(path.join(logs, '20261030T175447/window1/exthost/output_logging_old/10-Trae Coding Analysis Daemon.log'),
      event('a', 1) + event('b', 105) + event('c', 151));
    write(path.join(nativeDir, 'git-ai-daemon-2026-10-28.log'), event('stale', 999), new Date('2026-11-02T12:00:00'));
    const c = new AiLinesCounter(logs, native);
    await c.poll();
    check('automatic reads combine today and old native logs updated today', () => {
      assert.deepStrictEqual(sums(c), { ai: 257, total: 257, commits: 3 });
      assert(!opened.includes(mirror));
    });
    const before = opened.length;
    await c.poll();
    check('unchanged native files are not reopened', () => assert.strictEqual(opened.length, before));
    fs.appendFileSync(old, event('d', 7));
    await c.poll();
    check('an old native file continues to update incrementally', () => assert.strictEqual(c.sums().ai, 264));
    const duplicate = write(path.join(nativeDir, 'git-ai-daemon-2026-10-27.log'), event('a', 1));
    await c.poll();
    check('newly discovered native logs do not duplicate commits', () => assert.strictEqual(c.sums().commits, 4));
    const m = new AiLinesCounter(logs, path.join(tmp, 'missing'));
    await m.poll();
    check('old sessions remain available as a mirror fallback', () => {
      assert.deepStrictEqual(sums(m), { ai: 257, total: 257, commits: 3 });
      assert.strictEqual(m.lastRead.source, 'mirror');
    });
    const brokenRoot = path.join(tmp, 'broken');
    denied = write(path.join(brokenRoot, 'tenant/internal/daemon/logs/git-ai-daemon-2026-11-03.log'), event('unread', 999));
    const fallback = new AiLinesCounter(logs, brokenRoot);
    await fallback.poll();
    check('native read failures fall back to mirrors and retain diagnostics', () => {
      assert.strictEqual(fallback.sums().ai, 257);
      assert.strictEqual(fallback.lastRead.source, 'mirror');
      assert.strictEqual(fallback.lastRead.errors[0].file, denied);
    });
    denied = undefined;
    const partial = new AiLinesCounter(logs, native);
    denied = old;
    await partial.poll();
    check('partial native failures supplement mirrors without counting a commit twice', () => {
      assert.strictEqual(partial.sums().ai, 257);
      assert.strictEqual(partial.lastRead.source, 'native+mirror');
      assert.strictEqual(partial.lastRead.errors.length, 1);
    });
    denied = undefined;
    const emptyRoot = path.join(tmp, 'empty');
    write(path.join(emptyRoot, 'internal/daemon/logs/git-ai-daemon-2026-11-03.log'), '');
    const empty = new AiLinesCounter(logs, emptyRoot);
    await empty.poll();
    check('readable empty native logs are a valid zero, without mirror fallback', () => {
      assert.strictEqual(empty.sums().commits, 0);
      assert.strictEqual(empty.lastRead.source, 'native');
    });
    check('missing optional directories are not reported as access errors', () => {
      assert.strictEqual(empty.lastRead.errors.length, 0);
    });
    const directoriesRoot = path.join(tmp, 'directory-errors');
    write(path.join(directoriesRoot, 'healthy/internal/daemon/logs/git-ai-daemon-2026-11-03.log'), '');
    deniedDir = path.join(directoriesRoot, 'blocked/internal/daemon/logs');
    write(path.join(deniedDir, 'git-ai-daemon-2026-11-03.log'), event('unread', 999));
    const directoryFailure = new AiLinesCounter(logs, directoriesRoot);
    await directoryFailure.poll();
    check('a blocked tenant directory triggers mirror supplementation despite a readable tenant', () => {
      assert.strictEqual(directoryFailure.sums().ai, 257);
      assert.strictEqual(directoryFailure.lastRead.source, 'native+mirror');
      assert.strictEqual(directoryFailure.lastRead.errors[0].file, deniedDir);
    });
    deniedDir = undefined;
    deniedStat = write(path.join(directoriesRoot, 'blocked/internal/daemon/logs/git-ai-daemon-2026-10-29.log'), event('old', 999));
    const statFailure = new AiLinesCounter(logs, directoriesRoot);
    fs.writeFileSync(path.join(directoriesRoot, 'blocked/internal/daemon/logs/git-ai-daemon-2026-11-03.log'), '');
    await statFailure.poll();
    check('candidate modification-time errors also trigger fallback and diagnostics', () => {
      assert.strictEqual(statFailure.sums().ai, 257);
      assert(statFailure.lastRead.errors.some(e => e.file === deniedStat));
    });
    deniedStat = undefined;
    for (const mode of ['same-size', 'larger', 'between-stat-and-open']) {
      const replacementRoot = path.join(tmp, mode);
      const file = write(path.join(replacementRoot, 'internal/daemon/logs/git-ai-daemon-2026-11-03.log'), event('one', 1));
      const reader = new AiLinesCounter(logs, replacementRoot);
      await reader.poll();
      const previousSize = fs.statSync(file).size;
      const content = event('two', 2) + (mode === 'larger' ? event('six', 6) : '');
      write(file + '.replacement', content);
      if (mode === 'between-stat-and-open') {
        fs.appendFileSync(file, '\n'); // Enter the growing-file path, then replace before open.
        replaceOnOpen = file;
      } else fs.renameSync(file + '.replacement', file);
      await reader.poll();
      check(`${mode} replacement resets the offset and preserves collected commits`, () => {
        if (mode === 'same-size') assert.strictEqual(fs.statSync(file).size, previousSize);
        assert.strictEqual(reader.sums().ai, mode === 'larger' ? 9 : 3);
      });
      const opens = opened.length;
      await reader.poll();
      check(`${mode} replacement returns to the no-reopen fast path`, () => {
        assert.strictEqual(opened.length, opens);
      });
    }
    await c.poll(false);
    check('explicit mirror reads preserve cross-source deduplication', () => assert.strictEqual(c.sums().ai, 264));
    now = new Date('2026-11-04T00:01:00').getTime();
    fs.appendFileSync(old, event('tomorrow', 9, '2026-11-04'));
    fs.utimesSync(old, new TestDate(), new TestDate());
    await c.poll();
    check('midnight resets daily totals while the same old log continues', () => {
      assert.deepStrictEqual(sums(c), { ai: 9, total: 9, commits: 1 });
    });
    const restarted = new AiLinesCounter(logs, native);
    await restarted.poll();
    check('restart recovers today from an old log and ignores yesterday events', () => {
      assert.deepStrictEqual(sums(restarted), { ai: 9, total: 9, commits: 1 });
    });
    write(path.join(nativeDir, 'git-ai-daemon-2026-11-04.log'), event('after-restart', 4, '2026-11-04'));
    await restarted.poll();
    check('daemon restart adds a new log without losing earlier daily records', () => assert.strictEqual(restarted.sums().ai, 13));
    fs.writeFileSync(old, event('replacement', 2, '2026-11-04'));
    fs.utimesSync(old, new TestDate(), new TestDate());
    await restarted.poll();
    check('a truncated log is read again and prior collected commits remain deduplicated', () => assert.strictEqual(restarted.sums().ai, 15));
    now = new Date('2026-11-03T23:59:59').getTime();
    const midnightRoot = path.join(tmp, 'midnight');
    midnightOnOpen = write(path.join(midnightRoot, 'internal/daemon/logs/git-ai-daemon-2026-11-03.log'),
      event('yesterday', 100) + event('midnight', 6, '2026-11-04'));
    const crossing = new AiLinesCounter(logs, midnightRoot);
    await crossing.poll();
    await crossing.poll();
    check('a read spanning midnight does not consume and lose the new day event', () => {
      assert.deepStrictEqual(sums(crossing), { ai: 6, total: 6, commits: 1 });
    });
    console.log(`${passed} passed`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });

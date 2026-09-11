'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function harness(t, files = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyu-events-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const events = [];
  let poll;
  const context = {
    module: { exports: {} },
    require: (name) => name === 'child_process' ? { spawn: () => child } : require(name),
    process: { platform: 'linux', stdout: { write: (line) => events.push(JSON.parse(line)) } },
    setTimeout: () => 1, clearTimeout: () => {},
    setInterval: (fn) => { poll = fn; return 1; }, clearInterval: () => {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'codex.js'), 'utf8'), context);
  const result = context.module.exports.runCodex('test', cwd, {}, {
    reviewStatus: () => ({ count: files.length, files }),
  });
  return { cwd, child, events, result, poll: () => poll(), send: (event) => child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n')) };
}

test('nested patch events remain distinct and final Chinese summary survives split UTF-8', async (t) => {
  const h = harness(t);
  for (const id of ['first', 'second']) h.send({ type: 'item.completed', item: {
    id, type: 'file_change', status: 'completed', changes: [{ path: 'a.js', kind: 'update' }],
  } });
  const text = '\u4fee\u6539\u5b8c\u6210';
  const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  const split = bytes.indexOf(Buffer.from(text)) + 1;
  h.child.stdout.emit('data', bytes.subarray(0, split));
  h.child.stdout.emit('data', bytes.subarray(split));
  h.child.emit('close', 0);
  const result = await h.result;
  assert.equal(result.err, null);
  assert.equal(result.stdout.trim(), text);
  assert.equal(h.events.filter((e) => e.data.codexEvent).length, 2);
});

test('polling notices repeated same-size edits beyond the first twenty files', async (t) => {
  const files = Array.from({ length: 21 }, (_, i) => ({ kind: 'modified', path: `${i}.js` }));
  const h = harness(t, files);
  const file = path.join(h.cwd, '20.js');
  fs.writeFileSync(file, 'one');
  h.poll();
  const version = fs.statSync(file).mtimeMs;
  fs.writeFileSync(file, 'two');
  fs.utimesSync(file, new Date(), new Date(version + 2000));
  h.poll();
  h.poll();
  h.child.emit('close', 0);
  await h.result;
  const reviews = h.events.filter((e) => e.data.review);
  assert.equal(reviews.length, 3);
  assert.equal(reviews.at(-1).data.review.count, 21);
  assert.equal(reviews.at(-1).data.review.files.length, 20);
});

test('connection errors are visible immediately and terminal failure cannot look successful', async (t) => {
  const h = harness(t);
  h.send({ type: 'error', message: 'Reconnecting... 502 Bad Gateway' });
  assert.match(h.events.at(-1).data.message, /502 Bad Gateway/);
  assert.equal(h.events.at(-1).data.level, 'error');
  h.send({ type: 'turn.failed', error: { message: 'upstream unavailable' } });
  h.child.emit('close', 0);
  const result = await h.result;
  assert.match(result.err.message, /upstream unavailable/);
});

test('plain output still supplies the task summary', async (t) => {
  const h = harness(t);
  h.child.stdout.emit('data', Buffer.from('Finished the requested edit.\n'));
  h.child.emit('close', 0);
  assert.equal((await h.result).stdout.trim(), 'Finished the requested edit.');
});

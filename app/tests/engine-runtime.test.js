'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const filename = path.resolve(__dirname, '../lib/frameo-engine.js');
const source = fs.readFileSync(filename, 'utf8');
const actualRequire = createRequire(filename);

function fixture(platform, architecture) {
  const launched = [];
  const requests = [];
  function spawn(binaryPath, args, options) {
    launched.push(binaryPath);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = data => {
      requests.push(JSON.parse(data));
      queueMicrotask(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, result: {
          engine: 'simulated', protocolVersion: 1, goos: 'linux',
          goarch: architecture === 'x64' ? 'amd64' : architecture,
        } })));
        child.emit('close', 0);
      });
    };
    child.kill = () => assert.fail('A completed probe must not be terminated');
    return child;
  }
  const localRequire = name => {
    if (name === 'node:child_process') return { spawn };
    if (name === './frameo-temp') return { recoverPrivateDirectories: async () => {} };
    return actualRequire(name);
  };
  const loaded = { exports: {} };
  const runtime = { platform, arch: architecture, memoryUsage: () => process.memoryUsage() };
  // Exercise the actual production runner and constructor. Only its subprocess
  // boundary and the process architecture are simulated, with no native launch.
  new Function('require', 'module', 'exports', '__dirname', 'process', source)(
    localRequire, loaded, loaded.exports, path.dirname(filename), runtime,
  );
  const homey = { settings: { get() {}, set() { assert.fail('A probe must not write identity'); } } };
  return { FrameoEngine: loaded.exports.FrameoEngine, homey, launched, requests };
}

test('production Linux runtimes select only their matching packaged executable', async context => {
  for (const [architecture, executable] of [
    ['arm64', 'homey-frameo-linux-arm64'], ['x64', 'homey-frameo-linux-amd64'],
  ]) {
    const f = fixture('linux', architecture);
    const engine = new f.FrameoEngine({ homey: f.homey });
    context.after(() => engine.close());
    const result = await engine.probe();
    assert.equal(result.goarch, architecture === 'x64' ? 'amd64' : 'arm64');
    assert.deepEqual(f.launched, [path.resolve(__dirname, '../bin', executable)]);
    assert.deepEqual(f.requests, [{ operation: 'probe' }]);
  }
});

test('unsupported operating systems and unknown CPUs reject before a subprocess starts', async context => {
  for (const [platform, architecture] of [
    ['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'arm'], ['linux', 'unknown'], ['linux', '__proto__'],
  ]) {
    const f = fixture(platform, architecture);
    const engine = new f.FrameoEngine({ homey: f.homey });
    context.after(() => engine.close());
    await assert.rejects(engine.probe(), { code: 'UNSUPPORTED_RUNTIME', details: { started: false } });
    await assert.rejects(engine.pair('1234567890'), { code: 'UNSUPPORTED_RUNTIME' });
    assert.deepEqual(f.launched, []);
    assert.deepEqual(f.requests, []);
  }
});

test('an injected protocol runner remains usable on a development runtime', async context => {
  const f = fixture('win32', 'x64');
  let calls = 0;
  const engine = new f.FrameoEngine({ homey: f.homey, runner: async ({ request }) => {
    calls++;
    assert.deepEqual(request, { operation: 'probe' });
    return { ok: true, result: { engine: 'simulated', protocolVersion: 1, goos: 'linux', goarch: 'amd64' } };
  } });
  context.after(() => engine.close());
  assert.equal((await engine.probe()).goarch, 'amd64');
  assert.equal(calls, 1);
  assert.deepEqual(f.launched, []);
});

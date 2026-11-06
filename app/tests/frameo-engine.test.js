'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');
const { FrameoEngine, validatePairCode, runEngineProcess, SETTINGS_KEY } = require('../lib/frameo-engine');

// Synthetic fixture values, never identities from a real frame.
const PRIVATE = '11'.repeat(32);
const PEER = 'ab'.repeat(32);
const CONFIG = { private_key: PRIVATE, client_name: 'Homey', default_frame: PEER,
  frames: { [PEER]: { peer_id: PEER, name: 'Cadre salon', paired_at: '2026-01-01T00:00:00Z' } } };
const FRAME = { peer: PEER, name: 'Cadre salon', width: 2000, height: 1200, mayView: true, protocolConfirmed: true, route: 'local' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nvAAAAAASUVORK5CYII=', 'base64');
const clone = value => JSON.parse(JSON.stringify(value));
function homey(initial) {
  const saved = new Map(initial ? [[SETTINGS_KEY, clone(initial)]] : []);
  return { settings: { get: key => saved.get(key), set: (key, value) => saved.set(key, clone(value)) }, saved };
}
function success(result, config) { return { ok: true, result, ...(config ? { config } : {}) }; }
function image() { return { async getStream() { return Readable.from([PNG]); } }; }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
async function server(t, handler) {
  const srv = http.createServer(handler);
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { srv.closeAllConnections(); await new Promise(resolve => srv.close(resolve)); });
  return `http://127.0.0.1:${srv.address().port}`;
}

test('pairing confirms protocol without sending a test image or exposing identity', async () => {
  const h = homey(), requests = [];
  const engine = new FrameoEngine({ homey: h, runner: async ({ request }) => {
    requests.push(clone(request)); return success({ ...FRAME, config: CONFIG, private_key: PRIVATE }, CONFIG);
  } });
  const result = await engine.pair('1234 5678-90', { name: 'Maison' });
  assert.equal(result.peer, PEER);
  assert.equal(result.protocolConfirmed, true);
  assert.deepEqual(requests, [{ operation: 'pair', code: '1234567890', name: 'Maison' }]);
  assert.equal(h.saved.get(SETTINGS_KEY).private_key, PRIVATE);
  assert(!JSON.stringify(result).includes(PRIVATE));
  assert(!JSON.stringify(engine).includes(PRIVATE));
  assert.deepEqual(await engine.frames(), [{ peer: PEER, name: 'Cadre salon' }]);
});

test('upstream 7–31 digit code validation rejects invalid input before launching', async () => {
  assert.equal(validatePairCode('123-4567'), '1234567');
  assert.equal(validatePairCode('1'.repeat(31)), '1'.repeat(31));
  let calls = 0;
  const engine = new FrameoEngine({ homey: homey(), runner: async () => { calls++; } });
  for (const code of ['123456', '1'.repeat(32), 'abcdefghi', ';12345678']) await assert.rejects(engine.pair(code), { code: 'PAIRING_CODE_INVALID' });
  assert.equal(calls, 0);
});

test('French accents and emoji are bounded by Unicode characters, not split bytes', async () => {
  const h = homey(CONFIG), name = 'é😀'.repeat(50), caption = 'é😀'.repeat(600);
  const engine = new FrameoEngine({ homey: h, runner: async ({ request }) => {
    assert.equal(Array.from(request.name).length, 80);
    assert.equal(request.name, 'é😀'.repeat(40));
    assert.equal(Array.from(request.caption).length, 1000);
    assert.equal(request.caption, 'é😀'.repeat(500));
    assert(!request.name.includes('\ufffd')); assert(!request.caption.includes('\ufffd'));
    return success({ mediaId: '1', bytes: PNG.length, confirmed: true });
  } });
  await engine.sendImage(PEER, image(), { name, caption });
});

test('partial confirmation preserves identity and allows info retry', async () => {
  const h = homey();
  const engine = new FrameoEngine({ homey: h, runner: async ({ request }) => {
    if (request.operation === 'pair') return { ok: false, error: { code: 'PAIR_CONFIRMATION_FAILED', message: PRIVATE },
      config: CONFIG, result: { paired: true, confirmed: false, peer: PEER } };
    assert.equal(request.config.private_key, PRIVATE); return success(FRAME);
  } });
  await assert.rejects(engine.pair('1234567890'), error => {
    assert.equal(error.code, 'PAIR_CONFIRMATION_FAILED');
    assert.deepEqual(error.details, { paired: true, confirmed: false, peer: PEER });
    assert(!error.message.includes(PRIVATE)); return true;
  });
  assert.equal(h.saved.get(SETTINGS_KEY).private_key, PRIVATE);
  assert.equal((await engine.info(PEER)).protocolConfirmed, true);
});

test('failed responses and invalid stored configurations do not replace identity', async () => {
  const h = homey(CONFIG);
  const engine = new FrameoEngine({ homey: h, runner: async () => ({ ok: false, error: { code: 'PAIRING_FAILED' },
    config: { ...CONFIG, private_key: '22'.repeat(32) } }) });
  await assert.rejects(engine.pair('1234567890'), { code: 'PAIRING_FAILED' });
  assert.equal(h.saved.get(SETTINGS_KEY).private_key, PRIVATE);
  const invalid = { private_key: 'invalid', frames: {} }, bad = homey(invalid);
  const other = new FrameoEngine({ homey: bad, runner: async () => assert.fail('No launch expected') });
  await assert.rejects(other.info(PEER), { code: 'ENGINE_CONFIG_INVALID' });
  assert.deepEqual(bad.saved.get(SETTINGS_KEY), invalid);
});

test('unknown peers fail without connecting', async () => {
  const engine = new FrameoEngine({ homey: homey(CONFIG), runner: async () => assert.fail('No connection expected') });
  await assert.rejects(engine.info('cd'.repeat(32)), { code: 'FRAME_UNKNOWN' });
});

test('permissions are never requested automatically during probe, pairing or information checks', async () => {
  const operations = [];
  const engine = new FrameoEngine({ homey: homey(), runner: async ({ request }) => {
    operations.push(request.operation);
    if (request.operation === 'probe') return success({ engine: 'fixture', protocolVersion: 1 });
    if (request.operation === 'pair') return success(FRAME, CONFIG);
    assert.equal(request.operation, 'info');
    return success(FRAME);
  } });
  await engine.probe(); await engine.pair('1234567890'); await engine.info(PEER);
  assert.deepEqual(operations, ['probe', 'pair', 'info']);
});

test('an explicit permission request validates the grant and keeps the existing private identity unchanged', async () => {
  const h = homey(CONFIG), requests = [];
  const replacement = { ...CONFIG, private_key: '22'.repeat(32) };
  const engine = new FrameoEngine({ homey: h, runner: async ({ request, timeoutMs }) => {
    requests.push(clone(request)); assert.equal(timeoutMs, 80000);
    return success({ ...FRAME, mayManage: true, access: 'manage', granted: true, private_key: PRIVATE }, replacement);
  } });
  const result = await engine.permission(PEER, 'manage', { name: 'Maison', network: 'local' });
  assert.deepEqual(requests, [{ operation: 'permission', peer: PEER, access: 'manage', name: 'Maison', network: 'local', config: CONFIG }]);
  assert.equal(result.mayView, true); assert.equal(result.mayManage, true);
  assert.equal(result.protocolConfirmed, true);
  assert(!JSON.stringify(result).includes(PRIVATE));
  assert.deepEqual(h.saved.get(SETTINGS_KEY), CONFIG, 'Only explicit pairing may replace private identity configuration');
});

test('permission responses cannot grant the wrong scope, frame, unconfirmed flags or string booleans', async () => {
  const raw = { ...FRAME, mayManage: true, access: 'manage', granted: true };
  const invalid = [
    { ...raw, granted: false }, { ...raw, granted: 'true' },
    { ...raw, access: 'view' }, { ...raw, peer: 'cd'.repeat(32) },
    { ...raw, mayView: false }, { ...raw, mayView: 'true' },
    { ...raw, mayManage: false }, { ...raw, mayManage: 'true' },
    { ...raw, protocolConfirmed: false },
  ];
  for (const response of invalid) {
    const h = homey(CONFIG);
    const engine = new FrameoEngine({ homey: h, runner: async () => success(response) });
    await assert.rejects(engine.permission(PEER, 'manage'), { code: 'PERMISSION_NOT_GRANTED' });
    assert.deepEqual(h.saved.get(SETTINGS_KEY), CONFIG);
  }
});

test('invalid permission scopes or unknown frames fail before launching the native engine', async () => {
  const engine = new FrameoEngine({ homey: homey(CONFIG), runner: async () => assert.fail('No engine call expected') });
  for (const access of ['', 'admin', 'VIEW', undefined]) await assert.rejects(engine.permission(PEER, access), { code: 'INVALID_ACCESS' });
  await assert.rejects(engine.permission('cd'.repeat(32), 'view'), { code: 'FRAME_UNKNOWN' });
});

test('permission refusal and timeout remain safe errors and cannot replace the private identity', async () => {
  for (const code of ['PERMISSION_DENIED', 'PERMISSION_TIMEOUT', 'PERMISSION_NOT_GRANTED']) {
    const h = homey(CONFIG);
    const engine = new FrameoEngine({ homey: h, runner: async () => ({ ok: false,
      error: { code, message: 'private trace ' + PRIVATE }, config: { ...CONFIG, private_key: '22'.repeat(32) } }) });
    await assert.rejects(engine.permission(PEER, 'view'), error => {
      assert.equal(error.code, code); assert(!error.message.includes(PRIVATE)); return true;
    });
    assert.deepEqual(h.saved.get(SETTINGS_KEY), CONFIG);
  }
});

test('frame details keep reported values and exclude private or unrecognized fields', async () => {
  let details = { ...FRAME, placement: 'Salon', mayManage: false, mayBackup: true, maySharePairing: false,
    maxVideoWidth: 1920, maxVideoHeight: 1080, private_key: PRIVATE, chia_id: PRIVATE,
    model: 'unverified', freeSpace: 12345, currentState: 7 };
  const engine = new FrameoEngine({ homey: homey(CONFIG), runner: async ({ request }) => {
    assert.equal(request.operation, 'info'); return success(details);
  } });
  const result = await engine.info(PEER);
  assert.equal(result.placement, 'Salon');
  assert.equal(result.mayView, true);
  assert.equal(result.mayManage, false);
  assert.equal(result.mayBackup, true);
  assert.equal(result.maxVideoWidth, 1920);
  for (const forbidden of ['private_key', 'chia_id', 'model', 'freeSpace', 'currentState']) {
    assert.equal(Object.hasOwn(result, forbidden), false);
  }
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  details = { ...FRAME, name: '\u0000' + '😀'.repeat(120), placement: PRIVATE, width: '2000', height: -1,
    mayView: 'true', mayManage: undefined, maxVideoWidth: 0, maxVideoHeight: Infinity, route: 'unknown transport' };
  const unknown = await engine.info(PEER);
  assert.equal(Array.from(unknown.name).length, 100);
  assert.equal(unknown.placement, '…');
  for (const field of ['width', 'height', 'mayView', 'mayManage', 'mayBackup', 'maxVideoWidth', 'maxVideoHeight', 'route']) {
    assert.equal(unknown[field], null, field + ' must remain unknown');
  }
});

test('HTTP image sends a private temporary file which is removed after success', async t => {
  const base = await server(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(PNG); });
  let temporary;
  const h = homey(CONFIG);
  const engine = new FrameoEngine({ homey: h, runner: async ({ request }) => {
    assert.equal(request.operation, 'send'); assert.equal(request.name, 'Maison'); assert.equal(request.caption, 'Bonjour'); assert.equal(request.fit, true);
    temporary = request.path; assert(!temporary.includes('userdata'));
    assert.deepEqual(await fs.readFile(temporary), PNG);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(temporary)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(temporary))).mode & 0o777, 0o700);
    }
    return success({ peer: PEER, mediaId: '9223372036854775807', bytes: PNG.length, confirmed: true, route: 'local' });
  } });
  const result = await engine.sendUrl(PEER, base + '/image.png', { caption: 'Bonjour', fit: true, name: 'Maison' });
  assert.equal(result.mediaId, '9223372036854775807'); assert.equal(result.confirmed, true);
  assert(!JSON.stringify(result).includes(temporary));
  await assert.rejects(fs.access(path.dirname(temporary)), { code: 'ENOENT' });
  assert.deepEqual(h.saved.get(SETTINGS_KEY), CONFIG);
});

test('Homey Image streams work and a failed send also removes temporary files', async () => {
  let temporary;
  const engine = new FrameoEngine({ homey: homey(CONFIG), runner: async ({ request }) => {
    temporary = request.path; assert.deepEqual(await fs.readFile(temporary), PNG);
    return { ok: false, error: { code: 'FRAME_UNAVAILABLE', message: 'private trace' } };
  } });
  await assert.rejects(engine.sendImage(PEER, image()), { code: 'FRAME_UNAVAILABLE' });
  await assert.rejects(fs.access(path.dirname(temporary)), { code: 'ENOENT' });
});

test('redirects are bounded; credentials and non-HTTP schemes are rejected', async t => {
  const base = await server(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.url === '/image') { response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(PNG); }
    response.writeHead(302, { Location: request.url === '/start' ? '/image' : '/loop' }); response.end();
  });
  const engine = new FrameoEngine({ homey: homey(CONFIG), runner: async () => success({ mediaId: '1', bytes: PNG.length, confirmed: true }) });
  await engine.sendUrl(PEER, base + '/start');
  await assert.rejects(engine.sendUrl(PEER, base + '/loop'), { code: 'DOWNLOAD_FAILED' });
  for (const value of ['file:///secret', 'http://user:password@127.0.0.1/photo', 'data:image/png;base64,x']) await assert.rejects(engine.sendUrl(PEER, value), { code: 'URL_INVALID' });
});

test('declared and streaming size limits prevent engine sends', async t => {
  const base = await server(t, (request, response) => {
    const headers = { 'Content-Type': 'image/png' };
    if (request.url === '/declared') headers['Content-Length'] = '99999';
    response.writeHead(200, headers); response.write(PNG); response.end(Buffer.alloc(500));
  });
  const engine = new FrameoEngine({ homey: homey(CONFIG), maxBytes: 100, runner: async () => assert.fail('No send expected') });
  await assert.rejects(engine.sendUrl(PEER, base + '/declared'), { code: 'IMAGE_TOO_LARGE' });
  await assert.rejects(engine.sendUrl(PEER, base + '/streamed'), { code: 'IMAGE_TOO_LARGE' });
});

test('HTML and invalid image bytes are rejected before sending', async t => {
  const base = await server(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': request.url === '/mime' ? 'text/html' : 'image/jpeg' }); response.end('<html>not an image</html>');
  });
  const engine = new FrameoEngine({ homey: homey(CONFIG), runner: async () => assert.fail('No send expected') });
  await assert.rejects(engine.sendUrl(PEER, base + '/mime'), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
  await assert.rejects(engine.sendUrl(PEER, base + '/bytes'), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
});

test('global queue serializes calls and bounds pending work', async () => {
  const gate = deferred(); let count = 0;
  const engine = new FrameoEngine({ homey: homey(CONFIG), maxQueued: 1, runner: async () => {
    count++; if (count === 1) await gate.promise; return success(FRAME);
  } });
  const active = engine.info(PEER); await tick();
  const pending = engine.info(PEER);
  await assert.rejects(engine.info(PEER), { code: 'QUEUE_FULL' }); assert.equal(count, 1);
  gate.resolve(); await active; await pending; assert.equal(count, 2);
});

test('deadlines cancel a stalled runner and release the queue', async () => {
  let aborted = false, count = 0;
  const engine = new FrameoEngine({ homey: homey(CONFIG), timeouts: { info: 20 }, runner: async ({ signal }) => {
    if (++count > 1) return success(FRAME);
    signal.addEventListener('abort', () => { aborted = true; }); await new Promise(() => {});
  } });
  await assert.rejects(engine.info(PEER), { code: 'TIMEOUT' }); assert.equal(aborted, true);
  assert.equal((await engine.info(PEER)).peer, PEER);
});

test('queued cancellation is immediate; shutdown aborts remaining work', async () => {
  const engine = new FrameoEngine({ homey: homey(CONFIG), runner: async () => new Promise(() => {}) });
  const active = engine.info(PEER); await tick();
  const controller = new AbortController(), pending = engine.info(PEER, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'ABORTED' });
  const next = engine.info(PEER); engine.close();
  await assert.rejects(active, { code: 'ABORTED' }); await assert.rejects(next, { code: 'ABORTED' });
  await assert.rejects(engine.probe(), { code: 'ABORTED' });
});

test('subprocess stdout/stderr errors do not disclose raw identity or trace', async () => {
  await assert.rejects(runEngineProcess({ binaryPath: process.execPath,
    args: ['-e', `process.stderr.write('${PRIVATE}');process.stdout.write('not-json:${PRIVATE}');`],
    request: { operation: 'probe' }, timeoutMs: 5000 }), error => {
    assert.equal(error.code, 'ENGINE_NOT_READY'); assert(!error.message.includes(PRIVATE)); return true;
  });
});

test('subprocess receives JSON on stdin and accepts structured failure exit', async () => {
  const response = await runEngineProcess({ binaryPath: process.execPath,
    args: ['-e', `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({ok:false,error:{code:r.operation==='pair'?'PAIRING_FAILED':'BAD_OPERATION'}}));process.exitCode=1;});`],
    request: { operation: 'pair', config: CONFIG }, timeoutMs: 5000 });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'PAIRING_FAILED');
});

test('subprocess that never replies is terminated by its runtime bound', async () => {
  await assert.rejects(runEngineProcess({ binaryPath: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
    request: { operation: 'probe' }, timeoutMs: 30 }), { code: 'TIMEOUT' });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse, QrError } = require('../drivers/frameo/pair/qr-code');

test('manual codes remain available with grouping and leading zeros', () => {
  assert.equal(parse('1234567'), '1234567');
  assert.equal(parse(' 0012 3456-78 '), '0012345678');
  assert.equal(parse('123\n456\t7890'), '1234567890');
  assert.equal(parse('1'.repeat(31)), '1'.repeat(31));
});

test('extracts the official Frameo screenshot format without opening it', () => {
  // Public, expired demonstration code from Frameo's official support screenshot:
  // https://support.frameo.com/hc/article_attachments/24624648307346
  assert.equal(parse('https://app.frameo.net/pair#code=5857854305&src=qr'), '5857854305');
  assert.equal(parse('https://app.frameo.com/pair#code=0012345678&src=qr'), '0012345678');
  assert.equal(parse('https://app.frameo.net/pair/#src=qr&code=1234567890'), '1234567890');
  assert.equal(parse('HTTPS://APP.FRAMEO.COM:443/pair#code=1234567890'), '1234567890');
  assert.equal(parse('https://app.frameo.net/pair#code=%31%32%33%34%35%36%37'), '1234567');
});

test('unrecognized domains, URL credentials, ports and schemes are rejected', () => {
  for (const value of [
    'http://app.frameo.net/pair#code=1234567890',
    'https://app.frameo.net.evil.example/pair#code=1234567890',
    'https://evil.example/pair#code=1234567890',
    'https://evil.example/#https://app.frameo.net/pair#code=1234567890',
    'https://user@app.frameo.net/pair#code=1234567890',
    'https://user:secret@app.frameo.net/pair#code=1234567890',
    'https://app.frameo.net:8443/pair#code=1234567890',
    'https://app.frameo.net.:443/pair#code=1234567890',
    'https://app。frameo。net/pair#code=1234567890',
    'frameo://pair#code=1234567890',
    'javascript:1234567890',
    'data:text/plain,1234567890',
    'https:\\app.frameo.net\\pair#code=1234567890',
  ]) assert.throws(() => parse(value), error => error instanceof QrError && error.code === 'QR_INVALID', value);
});

test('only known pairing paths and a unique numeric fragment code are accepted', () => {
  for (const value of [
    'https://app.frameo.net/',
    'https://app.frameo.net/pair',
    'https://app.frameo.net/pair?code=1234567890',
    'https://app.frameo.net/pair?redirect=elsewhere#code=1234567890',
    'https://app.frameo.net/other#code=1234567890',
    'https://app.frameo.net/%70air#code=1234567890',
    'https://app.frameo.net/pair#code=1234567890&code=1234567890',
    'https://app.frameo.net/pair#code=1234567890&%63ode=7654321',
    'https://app.frameo.net/pair#code=1234567890&src=qr&src=qr',
    'https://app.frameo.net/pair#code=1234567890&src=unknown',
    'https://app.frameo.net/pair#code=1234567890&redirect=https://evil.example',
    'https://app.frameo.net/pair#code=1234-567890',
    'https://app.frameo.net/pair#code=1234567%00',
    'https://app.frameo.net/pair#code=1234567#other',
    'https://app.frameo.net/\npair#code=1234567890',
  ]) assert.throws(() => parse(value), { code: 'QR_INVALID' }, value);
});

test('malformed, oversized and non-string payloads fail without echoing content', () => {
  for (const value of [null, undefined, 1234567890, {}, '', '123456', '1'.repeat(32), ' '.repeat(2049),
    '<script>1234567890</script>', 'secret-password 1234567890', '１２３４５６７８９０', '1234\u200b567890']) {
    assert.throws(() => parse(value), error => {
      assert.equal(error.code, 'QR_INVALID');
      assert.equal(error.message, 'QR_INVALID');
      return true;
    });
  }
});

test('browser UMD export parses locally without network or navigation capabilities', () => {
  const source = fs.readFileSync(path.join(__dirname, '../drivers/frameo/pair/qr-code.js'), 'utf8');
  const browser = { URL, URLSearchParams };
  vm.runInNewContext(source, browser, { timeout: 1000 });
  assert.equal(browser.FrameoQr.parse('https://app.frameo.net/pair#code=1234567890&src=qr'), '1234567890');
  assert.equal(browser.fetch, undefined);
  assert.equal(browser.location, undefined);
});

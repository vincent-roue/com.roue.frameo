'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pipeline } = require('node:stream/promises');
const { createRequire } = require('node:module');
const zlib = require('node:zlib');
const { syncWidgetAssets } = require('./widget-assets.cjs');
const root = path.resolve(__dirname, '..'), appRoot = path.join(root, 'app');
let cliPackage;
try { cliPackage = require.resolve('homey/package.json', { paths: [root] }); }
catch {
  const modules = process.env.FRAMEO_TOOLING_DIR || path.resolve(root, '../../audit-geozones/tools/node_modules');
  const packages = JSON.parse(fs.readFileSync(path.join(modules, '.package-map.json'), 'utf8')).packages;
  const key = Object.keys(packages).find(k => k.startsWith('homey@4.6.0('));
  cliPackage = path.join(modules, packages[key].url, 'package.json');
}
const App = require(path.join(path.dirname(cliPackage), 'lib/App.js'));
const cliRequire = createRequire(cliPackage);
const tar = cliRequire('tar-fs');
(async () => {
  await syncWidgetAssets();
  const app = new App(appRoot);
  process.chdir(appRoot);
  await app.preprocess({ copyAppProductionDependencies: false });
  // Homey injects pairing HTML into different webview origins. Bundle every
  // scanner script, stylesheet and brand asset into each view, with no CDN or
  // dependence on relative URLs in an iframe.
  for (const relative of ['drivers/frameo/pair/connect.html', 'drivers/frameo/pair/repair.html', 'settings/index.html']) {
    const filename = path.join(app._homeyBuildPath, relative);
    const readPairFile = asset => {
      const file = path.resolve(path.dirname(filename), asset);
      assert(file.startsWith(app._homeyBuildPath + path.sep), 'UI asset outside app');
      return fs.readFileSync(file);
    };
    let html = fs.readFileSync(filename, 'utf8');
    html = html.replace(/<link rel="stylesheet" href="([^"]+)" data-frameo-inline>/g, (_, relative) => '<style>' + readPairFile(relative).toString('utf8') + '</style>');
    html = html.replace(/<script src="([^"]+)" data-frameo-inline><\/script>/g, (_, relative) => '<script>' + readPairFile(relative).toString('utf8').replace(/<\/script/gi, '<\\/script') + '</script>');
    html = html.replace(/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*?)\sdata-frameo-asset>/g, (_, before, relative, after) => {
      const mime = relative.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      return '<img' + before + 'src="data:' + mime + ';base64,' + readPairFile(relative).toString('base64') + '"' + after + '>';
    });
    assert(!/data-frameo-(?:inline|asset)/.test(html), 'Unbundled pairing resource');
    fs.writeFileSync(filename, html);
  }
  await app._validate({ level: process.argv.includes('--publish') ? 'publish' : 'debug' });
  const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'app.json'), 'utf8')).version;
  const archive = path.join(root, 'frameo-' + version + '-local.tar.gz');
  const packed = tar.pack(app._homeyBuildPath, { dereference: true, map(header) {
    header.mode = header.type === 'directory' || header.name.startsWith('bin/') ? 0o755 : 0o644;
    header.uid = 0; header.gid = 0;
    return header;
  }});
  await pipeline(packed, zlib.createGzip(), fs.createWriteStream(archive));
  const bytes = fs.readFileSync(archive);
  const proof = { at: new Date().toISOString(), version, archive: path.basename(archive), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), publicUpload: false };
  fs.writeFileSync(path.join(root, 'build.safe.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
})().catch(error => { console.error(error.message); process.exitCode = 1; });

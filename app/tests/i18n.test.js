'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const languages = ['fr', 'en', 'nl', 'de'];
const locales = Object.fromEntries(languages.map(language => [language, require('../locales/' + language + '.json')]));
const leaves = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => {
  const id = prefix ? prefix + '.' + key : key;
  return typeof item === 'string' ? [[id, item]] : leaves(item, id);
});
const valueAt = (value, key) => key.split('.').reduce((current, part) => current?.[part], value);
const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const target = path.join(directory, entry.name);
  return entry.isDirectory() ? files(target) : [target];
});

test('all four application locales cover identical keys and preserve interpolation variables', () => {
  const reference = Object.fromEntries(leaves(locales.en));
  for (const language of languages) {
    const translated = Object.fromEntries(leaves(locales[language]));
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(reference).sort(), language + ' locale coverage');
    for (const [id, text] of Object.entries(translated)) {
      assert(text.trim() && text !== id && !/\b(?:TODO|TBD)\b/.test(text), language + ':' + id);
      const tokens = value => [...value.matchAll(/__[a-zA-Z0-9_]+__/g)].map(match => match[0]).sort();
      assert.deepEqual(tokens(text), tokens(reference[id]), language + ':' + id + ' variables');
    }
    assert.equal(locales[language].pair.language, language);
    assert.equal(locales[language].gallery.language, language);
    assert.equal(locales[language].widgets.frameo.language, language);
    assert(fs.readFileSync(path.join(root, language === 'en' ? 'README.txt' : 'README.' + language + '.txt'), 'utf8').trim());
  }
});

test('device, Flow and widget translation objects provide all four supported languages', () => {
  const manifests = [...files(path.join(root, '.homeycompose')).filter(file => file.endsWith('.json')),
    path.join(root, 'drivers/frameo/driver.compose.json'),
    ...['frameo', 'frameo-compact', 'frameo-portrait'].map(id => path.join(root, 'widgets', id, 'widget.compose.json'))];
  let count = 0;
  function inspect(value, location) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.en === 'string') {
      count++;
      for (const language of languages) assert(typeof value[language] === 'string' && value[language].trim(), location + ':' + language);
    } else for (const [key, item] of Object.entries(value)) inspect(item, location + '.' + key);
  }
  for (const file of manifests) inspect(JSON.parse(fs.readFileSync(file, 'utf8')), path.relative(root, file));
  assert(count > 35, 'Validate the real driver, Flow and widget metadata');
  const driver = require('../drivers/frameo/driver.compose.json');
  assert(!driver.capabilities.includes('frameo_next_photo'));
  assert(!driver.capabilities.includes('frameo_refresh'));
  assert.equal(require('../.homeycompose/capabilities/frameo_refresh.json').type, 'boolean',
    'Retain the legacy definition so existing devices can load before migration');
});

test('new device metadata keeps counters first without changing legacy Flow capabilities', () => {
  const driver = require('../drivers/frameo/driver.compose.json');
  const presentation = ['measure_frameo_photos', 'measure_frameo_videos', 'measure_frameo_media',
    'measure_frameo_visible', 'measure_frameo_hidden', 'frameo_latest_received',
    'frameo_last_communication', 'frameo_frame_status', 'frameo_frame_name', 'frameo_frame_placement',
    'frameo_screen_resolution', 'frameo_connection_route', 'frameo_granted_permissions'];
  assert.deepEqual(driver.capabilities.slice(0, presentation.length), presentation);
  for (const id of presentation) {
    const capability = require('../.homeycompose/capabilities/' + id + '.json');
    assert.equal(capability.uiComponent, 'sensor');
    assert(capability.getable && !capability.setable);
    assert.equal(driver.capabilitiesOptions[id].preventTag, true, id + ' avoids duplicate tags');
    assert.equal(driver.capabilitiesOptions[id].preventInsights, true, id + ' avoids duplicate Insights');
  }
  for (const id of ['measure_frameo_photos', 'measure_frameo_videos', 'measure_frameo_media',
    'measure_frameo_visible', 'measure_frameo_hidden']) {
    const capability = require('../.homeycompose/capabilities/' + id + '.json');
    assert(driver.capabilities.includes(id), id + ' is exposed by the driver');
    assert.equal(capability.type, 'number');
    assert.equal(capability.uiComponent, 'sensor');
    assert.equal(capability.decimals, 0);
    assert(capability.getable && !capability.setable);
    assert(fs.existsSync(path.join(root, capability.icon)), id + ' has a native SVG icon');
  }
  for (const id of ['frameo_status', 'frameo_last_sent', 'frameo_last_checked', 'frameo_name', 'frameo_placement',
    'frameo_resolution', 'frameo_connection', 'frameo_permissions', 'frameo_photo_count', 'frameo_video_count', 'frameo_media_checked']) {
    assert(driver.capabilities.includes(id), id + ' remains available to existing Flows');
    assert.equal(require('../.homeycompose/capabilities/' + id + '.json').uiComponent, null);
  }
  assert.equal(require('../.homeycompose/capabilities/frameo_last_checked.json').title.fr, 'Dernier contrôle');
  assert.equal(require('../.homeycompose/capabilities/frameo_last_communication.json').title.fr, 'Dernière communication');
});

test('pairing HTML translations resolve in every supported language', () => {
  for (const file of ['drivers/frameo/pair/connect.html', 'drivers/frameo/pair/repair.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-[a-z]+)?="([a-zA-Z0-9_.]+)"/g)].map(match => match[1]);
    assert(keys.length > 8);
    for (const key of keys) for (const language of languages) assert.equal(typeof valueAt(locales[language], key), 'string', language + ':' + key);
  }
});

test('widget and gallery fallback dictionaries stay consistent with Homey translations in all languages', () => {
  const widget = require('../widgets/frameo/public/widget').translations;
  const gallery = require('../settings/gallery').translations;
  for (const language of languages) {
    assert(widget[language] && gallery[language], language + ' browser dictionaries');
    for (const [key, text] of Object.entries(widget[language])) assert.equal(text, locales[language].widgets.frameo[key], language + ':widget.' + key);
    for (const [key, text] of Object.entries(gallery[language])) assert.equal(text, locales[language].gallery[key], language + ':gallery.' + key);
  }
});

test('each localized guide uses the actual widget, manual button and media detection card names', () => {
  for (const language of languages) {
    const readme = fs.readFileSync(path.join(root, '..', 'docs', 'guides', language === 'en' ? 'README.txt' : 'README.' + language + '.txt'), 'utf8');
    for (const id of ['frameo', 'frameo-compact', 'frameo-portrait']) {
      const widget = require('../widgets/' + id + '/widget.compose.json');
      assert(readme.includes(widget.name[language]), language + ':' + id + ' widget name in guide');
    }
    assert(readme.includes(locales[language].widgets.frameo.next), language + ' manual button in guide');
    for (const id of ['measure_frameo_visible', 'measure_frameo_hidden', 'frameo_latest_received']) {
      const capability = require('../.homeycompose/capabilities/' + id + '.json');
      assert(readme.includes(capability.title[language]), language + ':' + id + ' label in guide');
    }
    assert(readme.includes(locales[language].device.no_media), language + ' empty inventory in guide');
    assert(readme.includes(locales[language].device.media_receive_date_unknown), language + ' unknown receipt date in guide');
    const detection = require('../.homeycompose/flow/triggers/media_detected.json');
    assert(readme.includes(detection.title[language]), language + ' media detection Flow name in guide');
    const refresh = require('../.homeycompose/flow/actions/refresh_frame.json');
    assert(readme.includes(refresh.title[language]), language + ' manual refresh Flow name in guide');
    for (const token of ['detected_at', 'received_at', 'new_count', 'events_truncated']) {
      assert(readme.includes(token), language + ':' + token + ' inventory semantics in guide');
    }
  }
});

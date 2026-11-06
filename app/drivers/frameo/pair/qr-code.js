(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrameoQr = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  class QrError extends Error {
    constructor() {
      super('QR_INVALID');
      this.name = 'FrameoQrError';
      this.code = 'QR_INVALID';
    }
  }

  function invalid() { throw new QrError(); }
  function numericCode(value) { return /^\d{7,31}$/.test(value); }

  // This function only extracts a code. It never navigates, fetches, opens an
  // application, or starts pairing. The user still confirms the code in Homey.
  function parse(value) {
    if (typeof value !== 'string' || value.length > 2048) return invalid();
    var input = value.trim();
    if (!input) return invalid();

    if (/^[\d\s-]+$/.test(input)) {
      var plain = input.replace(/[\s-]/g, '');
      return numericCode(plain) ? plain : invalid();
    }

    // Reject ambiguous URL normalization, credentials and lookalike domains.
    if (/[\u0000-\u0020\u007f\\]/.test(input) ||
        !/^https:\/\/app\.frameo\.(?:net|com)(?::443)?\//i.test(input)) return invalid();
    var url;
    try { url = new URL(input); } catch (_) { return invalid(); }
    if (url.protocol !== 'https:' || !['app.frameo.net', 'app.frameo.com'].includes(url.hostname) ||
        url.username || url.password || url.port ||
        !['/pair', '/pair/'].includes(url.pathname) || url.search || !url.hash) return invalid();

    var parameters;
    try { parameters = new URLSearchParams(url.hash.slice(1)); } catch (_) { return invalid(); }
    if (parameters.getAll('code').length !== 1 || !numericCode(parameters.get('code'))) return invalid();
    for (var entry of parameters.entries()) {
      if (!['code', 'src'].includes(entry[0])) return invalid();
    }
    if (parameters.getAll('src').length > 1 || (parameters.has('src') && parameters.get('src') !== 'qr')) return invalid();
    return parameters.get('code');
  }

  return Object.freeze({ parse: parse, QrError: QrError });
}));

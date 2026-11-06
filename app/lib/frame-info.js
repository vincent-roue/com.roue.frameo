'use strict';

function text(value, limit = 100) {
  return typeof value === 'string'
    ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[0-9a-f]{64}/gi, '…').trim()).slice(0, limit).join('')
    : '';
}
function dimension(value, maximum = 20000) {
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : null;
}
function permission(value) { return typeof value === 'boolean' ? value : null; }

// Allowlist for both native responses and persisted device metadata. Never cache
// arbitrary engine output or Frameo's private identity in a device capability.
function normalizeFrameInfo(value, fallbackName = 'Frameo') {
  return {
    name: text(value?.name) || text(fallbackName) || 'Frameo',
    placement: text(value?.placement),
    width: dimension(value?.width),
    height: dimension(value?.height),
    mayView: permission(value?.mayView),
    mayManage: permission(value?.mayManage),
    maySharePairing: permission(value?.maySharePairing),
    mayBackup: permission(value?.mayBackup),
    maxVideoWidth: dimension(value?.maxVideoWidth, 16384),
    maxVideoHeight: dimension(value?.maxVideoHeight, 16384),
    route: ['local', 'relay'].includes(value?.route) ? value.route : null,
  };
}

module.exports = { normalizeFrameInfo };

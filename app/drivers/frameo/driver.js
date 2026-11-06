'use strict';

const Homey = require('homey');

const ERROR_KEYS = Object.freeze({
  PAIRING_CODE_INVALID: 'errors.code_invalid',
  INVALID_CODE: 'errors.code_invalid',
  PAIRING_FAILED: 'errors.pair_failed',
  PAIRING_EXPIRED: 'errors.code_expired',
  FRAME_UNAVAILABLE: 'errors.frame_unavailable',
  ENGINE_NOT_READY: 'errors.not_ready',
  TIMEOUT: 'errors.timeout',
  ETIMEDOUT: 'errors.timeout',
  BUSY: 'errors.busy',
  QUEUE_FULL: 'errors.busy',
  ABORTED: 'errors.aborted',
  FRAME_UNKNOWN: 'errors.frame_unavailable',
  PAIR_CONFIRMATION_FAILED: 'errors.pair_failed',
});

function normalizeInput(input, translate) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(translate('errors.code_invalid'));
  }
  const code = typeof input.code === 'string' && input.code.length <= 128
    ? input.code.replace(/[\s-]/g, '') : '';
  if (!/^\d{7,31}$/.test(code)) throw new Error(translate('errors.code_invalid'));
  const senderName = typeof input.senderName === 'string' ? input.senderName.trim() : 'Homey';
  if (!senderName || Array.from(senderName).length > 80 || /[\u0000-\u001f\u007f]/.test(senderName)) {
    throw new Error(translate('errors.sender_invalid'));
  }
  const mode = input.mode === undefined ? 'send' : input.mode;
  if (!['send', 'manage'].includes(mode)) throw new Error(translate('errors.access_mode_invalid'));
  return { code, senderName, mode };
}

function publicCandidate(candidate, senderName, mode, translate) {
  const peer = candidate?.data?.id;
  if (typeof peer !== 'string' || !/^[a-f0-9]{64}$/i.test(peer)) {
    throw new Error(translate('errors.pair_failed'));
  }
  const name = typeof candidate.name === 'string'
    ? candidate.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100)
    : '';
  // Deliberately reconstruct the public result: engine identities never reach a view.
  return {
    name: name || 'Frameo',
    data: { id: peer.toLowerCase() },
    store: { peer: peer.toLowerCase(), access_mode_initialized: true },
    settings: { sender_name: senderName, photo_access_mode: mode },
  };
}

class FrameoDriver extends Homey.Driver {
  async onPair(session) {
    this.registerPairingHandlers(session, null);
  }

  async onRepair(session, device) {
    this.registerPairingHandlers(session, device);
    session.setHandler('refresh_frame', async () => {
      try {
        await device.refreshInfo();
        return { refreshed: true };
      } catch (error) {
        throw new Error(this.homey.__(ERROR_KEYS[error?.code] || 'errors.refresh_failed'));
      }
    });
  }

  registerPairingHandlers(session, repairDevice) {
    let busy = false;
    let closed = false;
    let pairedPeer = null;
    let pairedSender = 'Homey';
    let pairedMode = 'send';
    const translate = (key) => this.homey.__(key);
    session.setHandler('disconnect', async () => { closed = true; });
    const accessState = async (input = {}, fresh = true) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
      if (busy || closed) throw new Error(translate('errors.busy'));
      const peer = repairDevice?.getData().id || pairedPeer;
      if (!peer || (input.peer !== undefined && input.peer !== peer)) throw new Error(translate('errors.wrong_frame'));
      busy = true;
      try {
        const device = repairDevice || this.getDevices().find(item => item.getData().id === peer);
        if (input.mode === 'manage' && device) await device.setAccessMode('manage');
        const senderName = device?.getSetting('sender_name') || pairedSender;
        let info;
        if (device) { info = fresh ? await device.refreshInfo() : device.lastInfo; }
        else {
          await this.homey.app.waitUntilReady();
          info = await this.homey.app.engine.info(peer, { name: senderName });
        }
        return { peer, name: info?.name || device?.getName() || 'Frameo', senderName,
          mode: device?.accessMode() || pairedMode, mayView: info?.mayView === true, mayManage: info?.mayManage === true };
      } catch (error) {
        throw new Error(translate(ERROR_KEYS[error?.code] || 'errors.refresh_failed'));
      } finally { busy = false; }
    };
    session.setHandler('get_access_state', async input => accessState(input));
    session.setHandler('check_permissions', async input => accessState(input));
    session.setHandler('pair_frame', async (input) => {
      if (busy || closed) throw new Error(translate('errors.busy'));
      const { code, senderName, mode } = normalizeInput(input, translate);
      busy = true;
      try {
        if (typeof this.homey.app.waitUntilReady === 'function') await this.homey.app.waitUntilReady();
        const raw = await this.homey.app.pairFrame(code, senderName, mode);
        const candidate = publicCandidate(raw, senderName, mode, translate);
        pairedPeer = candidate.data.id; pairedSender = senderName; pairedMode = mode;
        if (closed) throw new Error(translate('errors.session_closed'));
        if (repairDevice) {
          const expectedPeer = String(repairDevice.getData().id || '').toLowerCase();
          if (candidate.data.id !== expectedPeer) throw new Error(translate('errors.wrong_frame'));
          await repairDevice.setStoreValue('peer', candidate.data.id);
          await repairDevice.setSettings({ sender_name: senderName, photo_access_mode: mode });
          await repairDevice.setAccessMode?.(mode);
          await repairDevice.refreshInfo();
          return { repaired: true, peer: candidate.data.id, senderName, mode, name: repairDevice.getName(),
            mayView: repairDevice.lastInfo?.mayView === true, mayManage: repairDevice.lastInfo?.mayManage === true };
        }
        if (this.getDevices().some((device) => String(device.getData().id).toLowerCase() === candidate.data.id)) {
          throw new Error(translate('errors.already_added'));
        }
        return candidate;
      } catch (error) {
        // Known local validation messages contain no protocol output or credentials.
        const localKeys = ['errors.session_closed', 'errors.wrong_frame', 'errors.already_added', 'errors.pair_failed'];
        if (localKeys.some((key) => error?.message === translate(key))) throw error;
        throw new Error(translate(ERROR_KEYS[error?.code] || 'errors.pair_failed'));
      } finally {
        busy = false;
      }
    });
  }
}

module.exports = FrameoDriver;

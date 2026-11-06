'use strict';

const { randomUUID } = require('node:crypto');
const GROUPS_KEY = 'frameo_groups';
const PEER = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const clone = value => JSON.parse(JSON.stringify(value));
function publicName(value, maximum = 80) {
  return typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/https?:\/\/\S+/gi, '…').replace(/[a-f0-9]{64}/gi, '…').trim()).slice(0, maximum).join('') : '';
}
function coded(code) { const error = new Error(code); error.code = code; return error; }

class FrameoGroups {
  constructor(app) { this.app = app; this.groups = []; this.writes = Promise.resolve(); this.ready = this.load(); }
  async load() {
    const saved = await this.app.homey.settings.get(GROUPS_KEY);
    if (saved == null) return;
    if (!saved || saved.version !== 1 || !Array.isArray(saved.groups) || saved.groups.length > 32 || Buffer.byteLength(JSON.stringify(saved)) > 256 * 1024) throw coded('GROUP_INVALID');
    const seen = new Set();
    this.groups = saved.groups.map(value => {
      if (!UUID.test(value?.id || '') || seen.has(value.id) || !publicName(value.name) || !Array.isArray(value.frameIds) || value.frameIds.length > 64 || value.frameIds.some(id => typeof id !== 'string' || !PEER.test(id))) throw coded('GROUP_INVALID');
      seen.add(value.id);
      return { id: value.id, name: publicName(value.name), frameIds: [...new Set(value.frameIds.map(id => id.toLowerCase()))] };
    });
  }
  async list() { await this.ready; return { groups: clone(this.groups) }; }
  async get(id) {
    await this.ready;
    const group = this.groups.find(value => value.id === id);
    if (!group) throw coded('GROUP_NOT_FOUND');
    return clone(group);
  }
  async mutate(operation) {
    const task = this.writes.catch(() => {}).then(async () => {
      await this.ready;
      const next = clone(this.groups);
      const result = operation(next);
      await this.app.homey.settings.set(GROUPS_KEY, { version: 1, groups: next });
      this.groups = next;
      return clone(result);
    });
    this.writes = task;
    return task;
  }
  save({ id, name, frameIds } = {}) {
    if ((id !== undefined && !UUID.test(id)) || !publicName(name) || !Array.isArray(frameIds) || frameIds.length > 64 || frameIds.some(peer => typeof peer !== 'string' || !PEER.test(peer))) return Promise.reject(coded('GROUP_INVALID'));
    const peers = [...new Set(frameIds.map(peer => peer.toLowerCase()))];
    const known = new Set(this.app.getDevices().filter(device => !device.stopped).map(device => String(device.getData().id).toLowerCase()));
    if (peers.some(peer => !known.has(peer))) return Promise.reject(coded('GROUP_FRAME_UNKNOWN'));
    return this.mutate(groups => {
      const index = id ? groups.findIndex(value => value.id === id) : -1;
      if (id && index < 0) throw coded('GROUP_NOT_FOUND');
      if (!id && groups.length >= 32) throw coded('GROUP_LIMIT');
      const group = { id: id || randomUUID(), name: publicName(name), frameIds: peers };
      if (index < 0) groups.push(group); else groups[index] = group;
      return { group };
    });
  }
  delete(id) {
    return this.mutate(groups => {
      const index = groups.findIndex(value => value.id === id);
      if (index < 0) throw coded('GROUP_NOT_FOUND');
      groups.splice(index, 1);
      return { deleted: true };
    });
  }
  removeFrame(peer) {
    return this.mutate(groups => {
      let changed = 0;
      for (const group of groups) {
        const before = group.frameIds.length;
        group.frameIds = group.frameIds.filter(id => id !== String(peer).toLowerCase());
        if (group.frameIds.length !== before) changed++;
      }
      return { changed };
    });
  }
}

module.exports = { FrameoGroups, GROUPS_KEY, publicName, coded };

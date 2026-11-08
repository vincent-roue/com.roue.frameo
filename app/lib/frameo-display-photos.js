'use strict';

const { randomUUID } = require('node:crypto');
const { validateMediaId } = require('./frameo-engine');
const { coded, publicName } = require('./frameo-groups');

const KEY = 'frameo_display_photos';
const LIMIT = 64;
const PEER = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

class FrameoDisplayPhotos {
  constructor(app) {
    this.app = app;
    this.photos = [];
    this.writes = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    const saved = await this.app.homey.settings.get(KEY);
    if (saved == null) return;
    if (saved.version !== 1 || !Array.isArray(saved.photos) || saved.photos.length > LIMIT) throw coded('DISPLAY_PHOTO_INVALID');
    const ids = new Set();
    this.photos = saved.photos.map(photo => {
      const { id, frameId, mediaId } = photo || {};
      const name = publicName(photo?.name);
      if (typeof id !== 'string' || !UUID.test(id) || ids.has(id) || typeof frameId !== 'string' || !PEER.test(frameId) || !name) {
        throw coded('DISPLAY_PHOTO_INVALID');
      }
      ids.add(id);
      return { id, frameId, mediaId: validateMediaId(mediaId), name };
    });
  }

  async names(frameId) {
    await this.ready;
    return new Map(this.photos.filter(photo => photo.frameId === frameId).map(photo => [photo.mediaId, photo.name]));
  }

  async suggest(frameId, query) {
    await this.ready;
    const search = publicName(query).toLocaleLowerCase();
    return this.photos.filter(photo => photo.frameId === frameId && photo.name.toLocaleLowerCase().includes(search))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30).map(({ id, name }) => ({ id, name }));
  }

  async resolve(frameId, id) {
    await this.ready;
    const photo = this.photos.find(value => value.id === id && value.frameId === frameId);
    if (!photo) throw coded('DISPLAY_PHOTO_NOT_FOUND');
    return photo.mediaId;
  }

  mutate(operation) {
    const task = this.writes.catch(() => {}).then(async () => {
      await this.ready;
      const next = [...this.photos];
      const result = await operation(next);
      if (next.length !== this.photos.length || next.some((photo, index) => photo !== this.photos[index])) {
        await this.app.homey.settings.set(KEY, { version: 1, photos: next });
        this.photos = next;
      }
      return result;
    });
    this.writes = task;
    return task;
  }

  save(selection) {
    return this.mutate(async next => {
      const name = selection.name === null ? null : publicName(selection.name);
      if (name === '') throw coded('DISPLAY_PHOTO_INVALID');
      const { mediaId } = await this.app.gallery.selectDisplayPhoto(selection);
      const frameId = selection.id;
      const index = next.findIndex(photo => photo.frameId === frameId && photo.mediaId === mediaId);
      if (name === null) {
        if (index >= 0) next.splice(index, 1);
      } else {
        if (next.some((photo, position) => position !== index && photo.frameId === frameId && photo.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
          throw coded('DISPLAY_PHOTO_NAME_TAKEN');
        }
        if (index < 0 && next.length >= LIMIT) throw coded('DISPLAY_PHOTO_LIMIT');
        const photo = { id: index >= 0 ? next[index].id : randomUUID(), frameId, mediaId, name };
        if (index >= 0) next[index] = photo;
        else next.push(photo);
      }
      return { name };
    });
  }

  remove(frameId, mediaId) {
    return this.mutate(photos => {
      for (let index = photos.length - 1; index >= 0; index--) {
        if (photos[index].frameId === frameId && (mediaId === undefined || photos[index].mediaId === mediaId)) photos.splice(index, 1);
      }
    });
  }
}

module.exports = { FrameoDisplayPhotos };

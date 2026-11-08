(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('./settings-i18n'), require('./diagnostic-report'));
  else root.FrameoSettings = factory(root.FrameoSettingsI18n, root.FrameoDiagnosticReport);
})(typeof window === 'object' ? window : globalThis, function (translations, diagnosticReport) {
  'use strict';
  const MAX_BYTES = 8 * 1024 * 1024,
    UPLOAD_CHUNK_BYTES = 192 * 1024,
    MAX_ITEMS = 24,
    TERMINAL = new Set(['succeeded', 'failed', 'uncertain', 'partial']);
  const clean = (value) =>
    typeof value === 'string'
      ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').trim())
          .slice(0, 160)
          .join('')
      : '';
  function fileMime(file) {
    if (/heic|heif/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || ''))
      throw Error('HEIC');
    if (!Number.isSafeInteger(file.size) || file.size < 3) throw Error('IMAGE_INVALID');
    if (file.size > MAX_BYTES) throw Error('IMAGE_TOO_LARGE');
    const mime =
      file.type ||
      (/\.png$/i.test(file.name || '')
        ? 'image/png'
        : /\.jpe?g$/i.test(file.name || '')
          ? 'image/jpeg'
          : '');
    if (!['image/jpeg', 'image/png'].includes(mime)) throw Error('IMAGE_INVALID');
    return mime;
  }
  async function validateFile(file) {
    const mime = fileMime(file),
      bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    if ((mime === 'image/jpeg' && !jpeg) || (mime === 'image/png' && !png))
      throw Error('IMAGE_INVALID');
    return mime;
  }
  async function imageDimensions(file) {
    const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (bytes[0] !== 255 || bytes[1] !== 216) return null;
    for (let at = 2; at + 8 < bytes.length; ) {
      if (bytes[at] !== 255) {
        at++;
        continue;
      }
      const marker = bytes[at + 1];
      if (marker === 255) {
        at++;
        continue;
      }
      if (marker === 218 || marker === 217) return null;
      const length = (bytes[at + 2] << 8) | bytes[at + 3];
      if (length < 2) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
        return {
          height: (bytes[at + 5] << 8) | bytes[at + 6],
          width: (bytes[at + 7] << 8) | bytes[at + 8],
        };
      at += length + 2;
    }
    return null;
  }
  async function thumbnail(file, window, document) {
    const dimensions = await imageDimensions(file);
    // A thumbnail is optional. Avoid decoding a 48 MP original on the phone;
    // its original bytes can still be submitted without canvas conversion.
    if (
      !dimensions ||
      dimensions.width < 1 ||
      dimensions.height < 1 ||
      dimensions.width * dimensions.height > 16000000
    )
      throw Error('THUMBNAIL_SKIPPED');
    const canvas = document.createElement('canvas');
    let bitmap, source, image;
    try {
      if (typeof window.createImageBitmap === 'function')
        bitmap = await window.createImageBitmap(file);
      else {
        source = window.URL.createObjectURL(file);
        image = new window.Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(Error('IMAGE_INVALID'));
          image.src = source;
        });
        bitmap = image;
      }
      const width = bitmap.width || bitmap.naturalWidth,
        height = bitmap.height || bitmap.naturalHeight;
      if (!width || !height) throw Error('IMAGE_INVALID');
      const scale = Math.min(1, 160 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
      if (!blob || blob.size > 128 * 1024) throw Error('IMAGE_INVALID');
      return {
        url: window.URL.createObjectURL(blob),
        bytes: blob.size,
        pixels: canvas.width * canvas.height,
      };
    } finally {
      bitmap?.close?.();
      if (image) {
        image.onload = image.onerror = null;
        image.src = '';
      }
      if (source) window.URL.revokeObjectURL(source);
      canvas.width = canvas.height = 0;
    }
  }
  function create(options) {
    const { Homey, document, window, gallery } = options;
    const ids = [
      'app-error',
      'send-form',
      'send-target',
      'send-target-hint',
      'send-files',
      'send-selection',
      'send-empty',
      'send-count',
      'send-clear',
      'send-url',
      'send-add-url',
      'send-caption',
      'send-fit',
      'send-defer',
      'send-error',
      'send-submit',
      'send-progress',
      'send-progress-title',
      'send-progress-text',
      'send-meter',
      'send-keep-open',
      'send-stop',
      'send-results',
      'group-list',
      'group-form',
      'group-editor-title',
      'group-name',
      'group-members',
      'group-status',
      'group-error',
      'group-save',
      'group-new',
      'group-remove-panel',
      'group-remove-confirm',
      'group-remove-cancel',
      'activity-list',
      'activity-empty',
      'activity-refresh',
      'activity-clear',
      'activity-error',
      'diagnostic-load',
      'diagnostic-status',
      'diagnostic-error',
      'diagnostic-preview',
      'diagnostic-summary',
      'diagnostic-json',
      'diagnostic-download',
      'diagnostic-copy',
    ];
    const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const tabs = ['send', 'gallery', 'groups', 'activity'];
    const supported = (value) =>
      typeof value === 'string' && Object.hasOwn(translations, value.toLowerCase().split(/[-_]/)[0])
        ? value.toLowerCase().split(/[-_]/)[0]
        : null;
    let homeyLang;
    try {
      homeyLang = supported(Homey.__('settings_ui.language'));
    } catch {}
    const lang =
      homeyLang || supported(options.language) || supported(window.navigator?.language) || 'en';
    const t = (key, tokens) => {
      let value;
      try {
        value = Homey.__('settings_ui.' + key, tokens);
      } catch {}
      if (typeof value !== 'string' || !value || value === 'settings_ui.' + key)
        value = translations[lang][key] || translations.en[key] || key;
      return value.replace(/__([a-z_]+)__/g, (all, name) =>
        tokens?.[name] !== undefined ? String(tokens[name]) : all,
      );
    };
    let destroyed = false,
      initialized = false,
      sending = false,
      preparing = false,
      stop = false,
      groupBusy = false,
      editingGroup = null,
      removeGroup = null;
    let frames = [],
      groups = [],
      queue = [],
      nextId = 0,
      activeTab = 'send',
      pollTimer = null,
      pollResolve = null,
      activeUpload = null,
      thumbnailBytes = 0,
      thumbnailPixels = 0;
    let diagnosticBusy = false,
      diagnosticText = '',
      diagnosticAt = '',
      diagnosticUrl = null,
      diagnosticTimer = null;
    const abortedUploads = new Set();
    const listeners = [],
      pending = new Set(),
      urls = new Set();
    function listen(target, event, handler) {
      target.addEventListener(event, handler);
      listeners.push(() => target.removeEventListener(event, handler));
    }
    function api(method, route, body) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let rejected = false;
        const done = (error, value) => {
          if (settled) {
            if (rejected && route === '/uploads/start' && typeof value?.uploadId === 'string') {
              abortUpload({ id: value.uploadId, phase: 'uploading' });
            }
            return;
          }
          settled = true;
          rejected = Boolean(error);
          window.clearTimeout(timer);
          pending.delete(done);
          error
            ? reject(error)
            : value?.error
              ? reject(Object.assign(Error('API_ERROR'), { code: value.error.code }))
              : resolve(value);
        };
        done.route = route;
        const timer = window.setTimeout(
          () => done(Object.assign(Error('TIMEOUT'), { code: 'TIMEOUT' })),
          options.apiTimeoutMs ||
            (route.startsWith('/transfers/job?') || /^\/uploads\/(start|chunk)$/.test(route)
              ? 45000
              : 210000),
        );
        pending.add(done);
        try {
          const promise = Homey.api(method, route, body || null, done);
          if (promise?.then) promise.then((value) => done(null, value), done);
        } catch (error) {
          done(error);
        }
      });
    }
    function reason(error, status) {
      if (status === 'uncertain') return t('reason_unverified');
      const code = String(error?.code || error?.message || error || '').toUpperCase();
      const translatedKey = {
        GROUP_INVALID: 'group_invalid',
        GROUP_NOT_FOUND: 'group_not_found',
        GROUP_LIMIT: 'group_limit',
        GROUP_FRAME_UNKNOWN: 'group_frame_unknown',
        TRANSFER_TARGET_INVALID: 'transfer_target_invalid',
        TRANSFER_SOURCE_INVALID: 'transfer_source_invalid',
        TRANSFER_BATCH_EXPIRED: 'transfer_batch_expired',
        TRANSFER_JOURNAL_FAILED: 'transfer_journal_failed',
        UPLOAD_INVALID: 'upload_invalid',
        UPLOAD_NOT_FOUND: 'upload_not_found',
        UPLOAD_OFFSET_INVALID: 'upload_offset_invalid',
        UPLOAD_INCOMPLETE: 'upload_incomplete',
        UPLOAD_LIMIT: 'upload_limit',
        UPLOAD_FAILED: 'upload_failed',
      }[code];
      if (translatedKey) {
        try {
          const key = 'errors.' + translatedKey;
          const value = Homey.__(key);
          if (typeof value === 'string' && value && value !== key) return value;
        } catch {}
      }
      if (/HEIC/.test(code)) return t('heic');
      if (/IMAGE_TOO_LARGE|FILE_TOO_LARGE|MEDIA_TOO_LARGE/.test(code)) return t('too_large');
      if (/IMAGE_INVALID|IMAGE_FORMAT|INVALID_IMAGE|FORMAT_UNSUPPORTED/.test(code))
        return t('reason_format');
      if (/PERMISSION|ACCESS/.test(code)) return t('reason_permission');
      if (/BUSY|QUEUE_FULL/.test(code)) return t('reason_busy');
      if (/GROUP_EMPTY/.test(code)) return t('reason_group_empty');
      if (/TIMEOUT|FRAME_UNAVAILABLE/.test(code)) return t('reason_offline');
      if (/ABORTED/.test(code)) return t('reason_aborted');
      return t('reason_unknown');
    }
    function message(id, text) {
      el[id].textContent = text || '';
      el[id].hidden = !text;
    }
    function node(tag, className, text) {
      const value = document.createElement(tag);
      if (className) value.className = className;
      if (text !== undefined) value.textContent = text;
      return value;
    }
    function button(label, handler) {
      const value = node('button', 'secondary-button', label);
      value.type = 'button';
      value.addEventListener('click', handler);
      return value;
    }
    function release(item) {
      if (item.thumb && urls.has(item.thumb)) {
        window.URL.revokeObjectURL(item.thumb);
        urls.delete(item.thumb);
        thumbnailBytes -= item.thumbBytes || 0;
        thumbnailPixels -= item.thumbPixels || 0;
      }
      item.thumb = null;
      item.file = null;
    }
    function selectedTarget() {
      const value = el['send-target'].value || '',
        separator = value.indexOf(':');
      if (separator < 0) return null;
      const type = value.slice(0, separator),
        id = value.slice(separator + 1);
      if (type === 'frame' && frames.some((frame) => frame.id === id)) return { frameId: id };
      if (type === 'group' && groups.some((group) => group.id === id)) return { groupId: id };
      return null;
    }
    function controls() {
      const locked = sending || preparing;
      for (const id of [
        'send-target',
        'send-files',
        'send-url',
        'send-add-url',
        'send-caption',
        'send-fit',
        'send-defer',
        'send-clear',
      ])
        el[id].disabled = locked;
      const target = selectedTarget(),
        empty =
          target?.groupId && !groups.find((group) => group.id === target.groupId)?.frameIds.length;
      el['send-submit'].disabled = locked || !queue.length || !target || empty;
      el['send-stop'].disabled = !sending || stop;
      el['send-stop'].hidden = !sending;
      el['send-stop'].textContent = t(
        activeUpload?.phase === 'uploading' ? 'upload_stop' : 'send_stop',
      );
      el['send-keep-open'].hidden = !sending;
      message('send-target-hint', empty ? t('target_empty') : '');
    }
    function renderTargets() {
      const previous = el['send-target'].value;
      el['send-target'].replaceChildren();
      const placeholder = node('option', '', t('choose_target'));
      placeholder.value = '';
      el['send-target'].append(placeholder);
      for (const [type, items, label] of [
        ['frame', frames, 'target_frames'],
        ['group', groups, 'target_groups'],
      ]) {
        if (!items.length) continue;
        const section = node('optgroup');
        section.label = t(label);
        for (const item of items) {
          const option = node(
            'option',
            '',
            clean(item.name) +
              (type === 'group' ? ' · ' + t('targets_count', { count: item.frameIds.length }) : ''),
          );
          option.value = type + ':' + item.id;
          option.disabled = type === 'group' && !item.frameIds.length;
          section.append(option);
        }
        el['send-target'].append(section);
      }
      el['send-target'].value = previous || '';
      if (!selectedTarget()) el['send-target'].value = '';
      controls();
    }
    function focusEditor(item) {
      const editor = node('details', 'selection-focus');
      const summary = node('summary', '', t('focus_edit'));
      const hint = node('p', 'quiet', t('focus_hint'));
      hint.id = 'selection-focus-hint-' + item.id;
      const target = node('button', 'focus-target');
      target.type = 'button';
      target.setAttribute('aria-label', t('focus_edit') + ' · ' + item.name);
      target.setAttribute('aria-describedby', hint.id);
      const image = node('img');
      image.alt = '';
      image.src = item.thumb;
      const marker = node('span', 'focus-marker');
      marker.setAttribute('aria-hidden', 'true');
      const reset = button(t('focus_reset'), () => {
        if (sending || preparing || destroyed) return;
        delete item.center;
        paint();
      });
      function paint() {
        const [x, y] = item.center || [0.5, 0.5];
        marker.setAttribute('style', 'left:' + x * 100 + '%;top:' + y * 100 + '%');
        reset.disabled = !item.center;
      }
      function move(x, y) {
        if (sending || preparing || destroyed) return;
        const unit = value => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
        item.center = [unit(x), unit(y)];
        paint();
      }
      target.addEventListener('click', event => {
        if (event.detail === 0) return;
        const rect = image.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) move(x, y);
      });
      target.addEventListener('keydown', event => {
        const step = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[event.key];
        if (!Array.isArray(step)) return;
        event.preventDefault();
        const [x, y] = item.center || [0.5, 0.5];
        move(x + step[0], y + step[1]);
      });
      target.append(image, marker);
      editor.append(summary, hint, target, reset);
      paint();
      return editor;
    }
    function renderQueue() {
      el['send-selection'].replaceChildren();
      el['send-empty'].hidden = queue.length > 0;
      el['send-count'].textContent = t('photo_count', { count: queue.length });
      queue.forEach((item, index) => {
        const row = node('li', 'selection-item'),
          thumb = item.thumb
            ? node('img', 'selection-thumb')
            : node(
                'span',
                'selection-thumb selection-placeholder',
                item.url ? 'URL' : 'JPEG / PNG',
              );
        if (item.thumb) {
          thumb.src = item.thumb;
          thumb.alt = '';
        }
        const detail = node('div');
        detail.append(
          node('p', 'selection-name', item.name),
          node(
            'span',
            'selection-size',
            item.file ? (item.file.size / 1024 / 1024).toFixed(1) + ' MiB' : t('item_url'),
          ),
        );
        const actions = node('div', 'selection-actions');
        for (const [sign, key, offset] of [
          ['↑', 'move_up', -1],
          ['↓', 'move_down', 1],
        ]) {
          const control = button(sign, () => {
            if (sending || preparing) return;
            const other = index + offset;
            if (other < 0 || other >= queue.length) return;
            [queue[index], queue[other]] = [queue[other], queue[index]];
            renderQueue();
          });
          control.setAttribute('aria-label', t(key) + ' · ' + item.name);
          control.disabled =
            sending || preparing || index + offset < 0 || index + offset >= queue.length;
          actions.append(control);
        }
        const remove = button('×', () => {
          if (sending || preparing) return;
          release(item);
          queue = queue.filter((value) => value !== item);
          renderQueue();
        });
        remove.setAttribute('aria-label', t('remove') + ' · ' + item.name);
        remove.disabled = sending || preparing;
        actions.append(remove);
        row.append(thumb, detail, actions);
        if (item.thumb && !el['send-fit'].checked && !sending) row.append(focusEditor(item));
        el['send-selection'].append(row);
      });
      controls();
    }
    async function addFiles(files) {
      if (sending || preparing || destroyed) return;
      preparing = true;
      message('send-error', '');
      controls();
      const errors = [];
      try {
        for (const file of Array.from(files || [])) {
          if (destroyed) break;
          if (queue.length >= MAX_ITEMS) {
            errors.push(t('max_items'));
            break;
          }
          try {
            const mime = await validateFile(file);
            if (destroyed) break;
            const item = {
              id: ++nextId,
              file,
              mime,
              name: clean(file.name) || t('item_image', { index: queue.length + 1 }),
              thumb: null,
            };
            try {
              const made = await (options.makeThumbnail
                ? options.makeThumbnail(file)
                : thumbnail(file, window, document));
              const thumb = typeof made === 'string' ? { url: made, bytes: 0, pixels: 0 } : made;
              if (thumb?.url) {
                if (
                  destroyed ||
                  thumbnailBytes + thumb.bytes > 3 * 1024 * 1024 ||
                  thumbnailPixels + thumb.pixels > 1000000
                )
                  window.URL.revokeObjectURL(thumb.url);
                else {
                  item.thumb = thumb.url;
                  item.thumbBytes = thumb.bytes;
                  item.thumbPixels = thumb.pixels;
                  thumbnailBytes += thumb.bytes;
                  thumbnailPixels += thumb.pixels;
                  urls.add(item.thumb);
                }
              }
            } catch {
              /* A valid original can still be sent when thumbnail decoding is unavailable. */
            }
            if (destroyed) break;
            queue.push(item);
          } catch (error) {
            errors.push(clean(file.name) + ' — ' + reason(error));
          }
        }
      } finally {
        preparing = false;
        if (!destroyed) {
          el['send-files'].value = '';
          renderQueue();
          message('send-error', errors.join('\n'));
        }
      }
    }
    function addUrl() {
      if (sending || preparing || destroyed) return;
      try {
        if (queue.length >= MAX_ITEMS) throw Error('MAX_ITEMS');
        if (queue.some((item) => item.url)) throw Error('URL_ONE');
        const url = new URL(el['send-url'].value.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw Error('URL_INVALID');
        queue.push({ id: ++nextId, url: url.href, name: t('item_url') });
        el['send-url'].value = '';
        message('send-error', '');
        renderQueue();
      } catch (error) {
        message(
          'send-error',
          t(
            error.message === 'MAX_ITEMS'
              ? 'max_items'
              : error.message === 'URL_ONE'
                ? 'url_one'
                : 'invalid_url',
          ),
        );
      }
    }
    function statusText(status) {
      return t(
        {
          succeeded: 'received',
          failed: 'failed',
          uncertain: 'uncertain',
          partial: 'partial',
          queued: 'queued',
          waiting: 'waiting_for_frame',
          running: 'running',
        }[status] || 'uncertain',
      );
    }
    function renderJob(job, container, label) {
      const card = node('article', 'result-card'),
        heading = node('div', 'result-heading');
      heading.append(
        node(
          'h3',
          '',
          label ||
            clean(job.targetName) ||
            t(job.initiator === 'flow' ? 'source_flow' : 'source_manual'),
        ),
        node('span', 'result-badge', statusText(job.status)),
      );
      card.append(heading);
      if (job.createdAt) {
        let date = '';
        try {
          date = new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(
            new Date(job.createdAt),
          );
        } catch {}
        card.append(node('span', 'quiet', date));
      }
      const rows = node('ul', 'result-rows');
      for (const result of Array.isArray(job.results) ? job.results : []) {
        const row = node('li', 'result-row'),
          badge = node('span', 'result-badge', statusText(result.status));
        badge.dataset.state = result.status;
        row.append(node('strong', '', clean(result.name)), badge);
        if (result.status === 'failed' || result.status === 'uncertain')
          row.append(
            node(
              'span',
              'result-reason',
              typeof result.reason === 'string'
                ? result.reason.slice(0, 500)
                : reason(result.code, result.status),
            ),
          );
        rows.append(row);
      }
      card.append(rows);
      container.append(card);
      return card;
    }
    function sleep() {
      return new Promise((resolve) => {
        pollResolve = resolve;
        pollTimer = window.setTimeout(() => {
          pollTimer = null;
          pollResolve = null;
          resolve();
        }, options.pollIntervalMs || 1000);
      });
    }
    async function waitJob(id) {
      for (let attempt = 0; attempt < 900 && !destroyed; attempt++) {
        const response = await api('GET', '/transfers/job?jobId=' + encodeURIComponent(id));
        const job = response?.job;
        if (!job || job.id !== id || !['queued', 'running', 'waiting', ...TERMINAL].includes(job.status))
          throw Error('JOB_UNVERIFIED');
        if (TERMINAL.has(job.status) || (job.status === 'waiting' && job.phase === 'waiting')) return job;
        el['send-progress-text'].textContent = statusText(job.status);
        await sleep();
      }
      throw Error('JOB_UNVERIFIED');
    }
    function abortUpload(upload = activeUpload) {
      if (!upload || upload.phase !== 'uploading' || abortedUploads.has(upload.id)) return;
      abortedUploads.add(upload.id);
      if (activeUpload === upload) activeUpload = null;
      // The abort is best effort, including during page removal. Do not create
      // another tracked timer or retry a request after the page has closed.
      try {
        const response = Homey.api('POST', '/uploads/abort', { uploadId: upload.id }, () => {});
        response?.catch?.(() => {});
      } catch {}
    }
    function uploadStopped() {
      if (stop || destroyed)
        throw Object.assign(Error('UPLOAD_STOPPED'), { code: 'UPLOAD_STOPPED' });
    }
    async function uploadFile(item, batchId) {
      await validateFile(item.file);
      uploadStopped();
      let upload;
      try {
        const started = await api('POST', '/uploads/start', {
          batchId,
          mime: item.mime,
          bytes: item.file.size,
        });
        if (typeof started?.uploadId !== 'string') throw Error('UPLOAD_INVALID');
        upload = { id: started.uploadId, phase: 'uploading' };
        activeUpload = upload;
        controls();
        if (started.chunkBytes !== UPLOAD_CHUNK_BYTES) throw Error('UPLOAD_INVALID');
        let offset = 0;
        el['send-progress-text'].textContent = t('upload_progress', { percent: 0 });
        while (offset < item.file.size) {
          uploadStopped();
          const end = Math.min(offset + UPLOAD_CHUNK_BYTES, item.file.size);
          // Read and encode one bounded slice, never the complete original.
          let bytes = new Uint8Array(await item.file.slice(offset, end).arrayBuffer());
          uploadStopped();
          if (bytes.length !== end - offset) throw Error('UPLOAD_INVALID');
          let binary = '';
          for (let at = 0; at < bytes.length; at += 32768)
            binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
          let payload = { uploadId: upload.id, offset, data: window.btoa(binary) };
          bytes = null;
          binary = null;
          let acknowledgement;
          try {
            acknowledgement = await api('POST', '/uploads/chunk', payload);
          } finally {
            payload.data = null;
            payload = null;
          }
          uploadStopped();
          if (acknowledgement?.offset !== end) throw Error('UPLOAD_OFFSET_INVALID');
          offset = end;
          el['send-progress-text'].textContent = t('upload_progress', {
            percent: Math.floor((offset / item.file.size) * 100),
          });
        }
        uploadStopped();
        return upload;
      } catch (error) {
        abortUpload(upload);
        throw error;
      }
    }
    async function sendSelection(event) {
      event?.preventDefault();
      if (sending || preparing || destroyed) return;
      const target = selectedTarget();
      if (!target || !queue.length) {
        message('send-error', t('send_none'));
        return;
      }
      sending = true;
      stop = false;
      controls();
      renderQueue();
      message('send-error', '');
      el['send-progress'].hidden = false;
      el['send-progress-title'].textContent = t('send_active');
      el['send-results'].replaceChildren();
      const selection = [...queue],
        caption = el['send-caption'].value || '',
        fit = el['send-fit'].checked === true,
        defer = el['send-defer'].checked === true;
      el['send-defer'].checked = false;
      let batchId,
        uncertain = false,
        waiting = false,
        cancelledUpload = false,
        done = 0,
        activeJob = false;
      el['send-meter'].max = selection.length;
      el['send-meter'].value = 0;
      try {
        const started = await api('POST', '/transfers/start', target);
        if (typeof started?.batchId !== 'string') throw Error('JOB_UNVERIFIED');
        batchId = started.batchId;
        for (let index = 0; index < selection.length && !stop && !destroyed; index++) {
          const item = selection[index];
          el['send-progress-title'].textContent = t('progress', {
            index: index + 1,
            total: selection.length,
          });
          el['send-progress-text'].textContent = t('preparing', {
            index: index + 1,
            total: selection.length,
          });
          let upload;
          try {
            if (!item.url) upload = await uploadFile(item, batchId);
          } catch (error) {
            cancelledUpload = error?.code === 'UPLOAD_STOPPED';
            if (!destroyed)
              message(
                'send-error',
                item.name +
                  ' — ' +
                  t('source_not_sent') +
                  (error?.code === 'UPLOAD_STOPPED' ? '' : ' · ' + reason(error)),
              );
            stop = true;
            break;
          }
          if (destroyed || stop) {
            abortUpload(upload);
            break;
          }
          activeJob = true;
          if (upload) {
            upload.phase = 'submitting';
            activeUpload = null;
          }
          // Once submitted, remove the source from the editable queue. A lost
          // confirmation must never turn into a one-click duplicate resend.
          queue = queue.filter((value) => value !== item);
          release(item);
          renderQueue();
          let accepted;
          if (upload)
            accepted = await api('POST', '/uploads/finish', {
              uploadId: upload.id,
              caption,
              fit,
              ...(!fit && item.center ? { center: item.center } : {}),
              ...(defer ? { defer } : {}),
            });
          else
            accepted = await api('POST', '/transfers/manual', {
              batchId,
              url: item.url,
              caption,
              fit,
              ...(defer ? { defer } : {}),
            });
          if (typeof accepted?.jobId !== 'string') throw Error('JOB_UNVERIFIED');
          const job = await waitJob(accepted.jobId);
          activeJob = false;
          if (destroyed) break;
          renderJob(job, el['send-results'], t('item_image', { index: index + 1 }));
          if (job.status === 'waiting') waiting = true;
          done++;
          el['send-meter'].value = done;
          if (job.status === 'uncertain' || job.summary?.uncertain > 0) {
            uncertain = true;
            stop = true;
          }
        }
        if (!destroyed)
          el['send-progress-title'].textContent = t(
            cancelledUpload
              ? 'upload_cancelled'
              : uncertain
                ? 'send_uncertain'
                : stop
                  ? 'send_stopping'
                  : waiting
                    ? 'send_deferred'
                    : 'send_done',
          );
      } catch (error) {
        if (!destroyed) {
          uncertain = activeJob;
          message(
            'send-error',
            t(uncertain ? 'send_uncertain' : 'send_failed') +
              ' ' +
              reason(error, uncertain ? 'uncertain' : null),
          );
        }
      } finally {
        if (batchId && !destroyed)
          try {
            await api('POST', '/transfers/finish', { batchId });
          } catch {}
        sending = false;
        if (!destroyed) {
          controls();
          renderQueue();
          el['send-keep-open'].hidden = true;
          el['send-stop'].hidden = true;
          await loadActivity().catch(() => {});
        }
      }
    }
    function renderGroups() {
      el['group-list'].replaceChildren();
      for (const group of groups) {
        const card = node('article', 'group-card');
        card.append(
          node('h3', '', clean(group.name)),
          node(
            'p',
            'quiet',
            group.frameIds.length
              ? t('targets_count', { count: group.frameIds.length })
              : t('group_empty'),
          ),
        );
        const actions = node('div', 'editor-actions');
        actions.append(
          button(t('group_edit'), () => editGroup(group)),
          button(t('group_remove'), () => {
            if (sending || groupBusy) return;
            removeGroup = group.id;
            el['group-remove-panel'].hidden = false;
          }),
        );
        card.append(actions);
        el['group-list'].append(card);
      }
    }
    function editGroup(group) {
      editingGroup = group?.id || null;
      el['group-editor-title'].textContent = t(editingGroup ? 'group_edit' : 'group_new');
      el['group-name'].value = group?.name || '';
      el['group-members'].replaceChildren();
      if (!frames.length) el['group-members'].append(node('p', 'quiet', t('group_no_frames')));
      for (const frame of frames) {
        const label = node('label', 'group-member'),
          input = node('input');
        input.type = 'checkbox';
        input.value = frame.id;
        input.checked = group?.frameIds.includes(frame.id) || false;
        label.append(input, node('span', '', clean(frame.name)));
        el['group-members'].append(label);
      }
      message('group-error', '');
      message('group-status', '');
    }
    async function saveGroup(event) {
      event?.preventDefault();
      if (groupBusy || destroyed) return;
      const name = el['group-name'].value.trim();
      if (!name || Array.from(name).length > 80) {
        message('group-error', reason({ code: 'GROUP_INVALID' }));
        return;
      }
      const frameIds = [
        ...new Set(
          Array.from(el['group-members'].querySelectorAll('input'))
            .filter((input) => input.checked)
            .map((input) => input.value),
        ),
      ];
      groupBusy = true;
      el['group-save'].disabled = true;
      try {
        await api('POST', '/groups/save', {
          ...(editingGroup ? { id: editingGroup } : {}),
          name,
          frameIds,
        });
        await loadGroups();
        editGroup(null);
        message('group-status', t('group_saved'));
      } catch (error) {
        message('group-error', reason(error));
      } finally {
        groupBusy = false;
        el['group-save'].disabled = false;
      }
    }
    async function deleteGroup() {
      if (groupBusy || !removeGroup || destroyed || sending) return;
      groupBusy = true;
      el['group-remove-confirm'].disabled = true;
      try {
        await api('POST', '/groups/delete', { id: removeGroup });
        removeGroup = null;
        el['group-remove-panel'].hidden = true;
        await loadGroups();
        editGroup(null);
        message('group-status', t('group_removed'));
      } catch (error) {
        message('group-error', reason(error));
      } finally {
        groupBusy = false;
        el['group-remove-confirm'].disabled = false;
      }
    }
    async function loadGroups() {
      const value = await api('GET', '/groups');
      groups = Array.isArray(value?.groups)
        ? value.groups
            .filter((group) => typeof group.id === 'string' && Array.isArray(group.frameIds))
            .slice(0, 64)
            .map((group) => ({ ...group, frameIds: [...new Set(group.frameIds)] }))
        : [];
      renderGroups();
      renderTargets();
    }
    async function loadActivity() {
      if (destroyed) return;
      try {
        const value = await api('GET', '/transfers/history');
        if (destroyed) return;
        const jobs = Array.isArray(value?.jobs) ? value.jobs.slice(0, 50) : [];
        el['activity-list'].replaceChildren();
        el['activity-empty'].hidden = jobs.length > 0;
        for (const job of jobs) renderJob(job, el['activity-list']);
        message('activity-error', '');
      } catch (error) {
        if (!destroyed) message('activity-error', t('metadata_error'));
      }
    }
    function revokeDiagnosticUrl() {
      if (diagnosticTimer !== null) window.clearTimeout(diagnosticTimer);
      diagnosticTimer = null;
      if (diagnosticUrl !== null) window.URL.revokeObjectURL(diagnosticUrl);
      diagnosticUrl = null;
    }
    function clearDiagnostic() {
      revokeDiagnosticUrl();
      diagnosticText = '';
      diagnosticAt = '';
      el['diagnostic-json'].value = '';
      el['diagnostic-summary'].textContent = '';
      el['diagnostic-preview'].hidden = true;
    }
    async function loadDiagnostic() {
      if (diagnosticBusy || destroyed) return;
      diagnosticBusy = true;
      el['diagnostic-load'].disabled = true;
      clearDiagnostic();
      message('diagnostic-error', '');
      message('diagnostic-status', t('diagnostic_loading'));
      try {
        const value = await api('GET', '/diagnostics');
        if (destroyed) return;
        const text = diagnosticReport.serialize(value?.report);
        diagnosticText = text;
        diagnosticAt = value.report.generatedAt;
        const number = new Intl.NumberFormat(lang);
        const date = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' });
        el['diagnostic-summary'].textContent = t('diagnostic_summary', {
          date: date.format(new Date(diagnosticAt)),
          frames:
            value.report.counts.frames === null ? '—' : number.format(value.report.counts.frames),
          size: number.format(Math.ceil(text.length / 1024)),
        });
        el['diagnostic-json'].value = text;
        el['diagnostic-preview'].hidden = false;
        message('diagnostic-status', t('diagnostic_ready'));
      } catch {
        if (!destroyed) {
          clearDiagnostic();
          message('diagnostic-status', '');
          message('diagnostic-error', t('diagnostic_failed'));
        }
      } finally {
        diagnosticBusy = false;
        if (!destroyed) el['diagnostic-load'].disabled = false;
      }
    }
    function downloadDiagnostic() {
      if (destroyed || !diagnosticText) return;
      revokeDiagnosticUrl();
      let link;
      try {
        const blob = new window.Blob([diagnosticText], { type: 'application/json;charset=utf-8' });
        diagnosticUrl = window.URL.createObjectURL(blob);
        link = document.createElement('a');
        link.href = diagnosticUrl;
        link.download =
          'frameo-diagnostic-' + diagnosticAt.replace(/[-:]/g, '').slice(0, 13) + '.json';
        link.hidden = true;
        document.body.append(link);
        link.click();
        diagnosticTimer = window.setTimeout(revokeDiagnosticUrl, 30000);
        // A webview can ignore download requests. Never announce that a file
        // has been saved; copying the already visible JSON remains available.
        message('diagnostic-status', t('diagnostic_download_requested'));
      } catch {
        revokeDiagnosticUrl();
        message('diagnostic-status', t('diagnostic_copy_hint'));
      } finally {
        link?.remove();
      }
    }
    function selectDiagnostic() {
      el['diagnostic-json'].focus();
      el['diagnostic-json'].select();
      el['diagnostic-json'].setSelectionRange(0, diagnosticText.length);
    }
    async function copyDiagnostic() {
      if (destroyed || !diagnosticText) return;
      const text = diagnosticText;
      selectDiagnostic();
      let copied = false;
      try {
        // Start the write directly inside the user's click. Fetching the
        // report here first would lose WebKit's transient user activation.
        if (typeof window.navigator?.clipboard?.writeText === 'function') {
          await window.navigator.clipboard.writeText(text);
          copied = true;
        } else if (typeof document.execCommand === 'function') {
          copied = document.execCommand('copy') === true;
        }
      } catch {}
      if (!destroyed && diagnosticText === text) {
        message('diagnostic-status', t(copied ? 'diagnostic_copied' : 'diagnostic_manual_copy'));
      }
    }
    async function metadata() {
      const response = await api('GET', '/gallery/frames');
      if (destroyed) return;
      frames = (Array.isArray(response?.frames) ? response.frames : [])
        .filter((frame) => typeof frame.id === 'string')
        .slice(0, 64);
      await loadGroups();
      editGroup(null);
    }
    function switchTab(tab) {
      if (destroyed || !tabs.includes(tab)) return;
      activeTab = tab;
      for (const name of tabs) {
        const button = document.getElementById('tab-' + name);
        button.setAttribute('aria-selected', name === tab ? 'true' : 'false');
        button.tabIndex = name === tab ? 0 : -1;
        document.getElementById('panel-' + name).hidden = name !== tab;
      }
      Promise.resolve(gallery?.setActive?.(tab === 'gallery')).catch(() =>
        message('app-error', t('metadata_error')),
      );
      if (tab === 'activity') void loadActivity();
    }
    function beforeUnload(event) {
      if (sending) {
        event.preventDefault();
        event.returnValue = t('close_warning');
        return event.returnValue;
      }
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stop = true;
      clearDiagnostic();
      abortUpload();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollResolve?.();
      pollResolve = null;
      for (const done of [...pending]) done(Object.assign(Error('ABORTED'), { code: 'ABORTED' }));
      queue.forEach(release);
      queue = [];
      for (const url of urls) window.URL.revokeObjectURL(url);
      urls.clear();
      listeners.splice(0).forEach((remove) => remove());
    }
    async function init() {
      if (initialized || destroyed) return;
      initialized = true;
      document.documentElement.lang = lang;
      document.querySelectorAll('[data-app-i18n]').forEach((value) => {
        value.textContent = t(value.dataset.appI18n);
      });
      for (const tab of tabs) {
        const button = document.getElementById('tab-' + tab);
        listen(button, 'click', () => switchTab(tab));
        listen(button, 'keydown', (event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const at = tabs.indexOf(activeTab),
            next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          switchTab(tabs[next]);
          document.getElementById('tab-' + tabs[next]).focus();
        });
      }
      listen(el['send-files'], 'change', () => addFiles(el['send-files'].files));
      listen(el['send-add-url'], 'click', addUrl);
      listen(el['send-target'], 'change', controls);
      listen(el['send-fit'], 'change', renderQueue);
      listen(el['send-form'], 'submit', sendSelection);
      listen(el['send-clear'], 'click', () => {
        if (sending || preparing) return;
        queue.forEach(release);
        queue = [];
        renderQueue();
      });
      listen(el['send-stop'], 'click', () => {
        stop = true;
        abortUpload();
        for (const done of [...pending]) {
          if (/^\/uploads\/(start|chunk)$/.test(done.route))
            done(Object.assign(Error('UPLOAD_STOPPED'), { code: 'UPLOAD_STOPPED' }));
        }
        controls();
        el['send-progress-text'].textContent = t('send_stopping');
      });
      listen(el['group-form'], 'submit', saveGroup);
      listen(el['group-new'], 'click', () => editGroup(null));
      listen(el['group-remove-confirm'], 'click', deleteGroup);
      listen(el['group-remove-cancel'], 'click', () => {
        removeGroup = null;
        el['group-remove-panel'].hidden = true;
      });
      listen(el['activity-refresh'], 'click', loadActivity);
      listen(el['diagnostic-load'], 'click', loadDiagnostic);
      listen(el['diagnostic-download'], 'click', downloadDiagnostic);
      listen(el['diagnostic-copy'], 'click', copyDiagnostic);
      listen(el['activity-clear'], 'click', async () => {
        try {
          await api('POST', '/transfers/clear', {});
          await loadActivity();
        } catch {
          message('activity-error', t('metadata_error'));
        }
      });
      listen(window, 'beforeunload', beforeUnload);
      listen(window, 'pagehide', destroy);
      switchTab('send');
      renderQueue();
      try {
        await metadata();
      } catch {
        if (!destroyed) message('app-error', t('metadata_error'));
      }
    }
    return {
      init,
      destroy,
      switchTab,
      addFiles,
      addUrl,
      sendSelection,
      loadActivity,
      loadDiagnostic,
      stats: () => ({
        items: queue.length,
        thumbnailUrls: urls.size,
        thumbnailBytes,
        thumbnailPixels,
        sending,
        preparing,
        activeTab,
      }),
    };
  }
  return {
    create,
    translations,
    validateFile,
    imageDimensions,
    createThumbnail: thumbnail,
    MAX_BYTES,
    MAX_ITEMS,
    UPLOAD_CHUNK_BYTES,
  };
});

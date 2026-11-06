(function (root) {
  'use strict';

  const CANCELLED = Symbol('cancelled');
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const LIVE_INTERVAL = 250;
  const CAMERA_TIMEOUT = 10000;
  const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

  function create(options) {
    const { button, fileInput, overlay, video, canvas, closeButton, photoButton, status,
      translate, onCode, decode } = options;
    const returnFocusElement = options.returnFocusElement || button;
    const previewElement = options.previewElement;
    const parseCode = options.parseCode || root.FrameoQr?.parse;
    const document = root.document;
    let disabled = false;
    let destroyed = false;
    let active = false;
    let generation = 0;
    let stream = null;
    let loopTimer = null;
    let cancelOpening = null;
    let cancelImage = null;
    let objectUrl = null;
    let photoPickerOpen = false;

    function message(key) { status.textContent = translate(key) || key; }
    function current(token) { return !destroyed && !disabled && active && token === generation; }
    function stopTracks(value) {
      for (const track of value?.getTracks?.() || []) {
        try { track.stop(); } catch { /* Already stopped. */ }
      }
    }
    function suspendCamera() {
      if (previewElement) previewElement.hidden = true;
      if (loopTimer !== null) root.clearTimeout(loopTimer);
      loopTimer = null;
      cancelOpening?.();
      cancelOpening = null;
      stopTracks(stream);
      stream = null;
      try { video.pause(); } catch { /* No video was playing. */ }
      video.srcObject = null;
    }
    function releaseImage() {
      cancelImage?.();
      cancelImage = null;
      if (objectUrl !== null) root.URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    function show() { overlay.hidden = false; active = true; }
    function stop() {
      generation++;
      active = false;
      photoPickerOpen = false;
      suspendCamera();
      releaseImage();
      overlay.hidden = true;
    }

    function choosePhoto() {
      if (disabled || destroyed) return;
      stop();
      show();
      message('qr.scan_hint');
      photoPickerOpen = true;
      // Must remain synchronous with the user's tap for the iOS file picker.
      fileInput.click();
    }

    function draw(source, maximum) {
      const width = Number(source.videoWidth || source.naturalWidth || source.width);
      const height = Number(source.videoHeight || source.naturalHeight || source.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
      const scale = Math.min(1, maximum / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    }

    function deliver(result, token) {
      if (!current(token) || !result) return false;
      const payload = typeof result === 'string' ? result : result.data;
      let code;
      try {
        if (typeof payload !== 'string' || typeof parseCode !== 'function') throw new Error();
        code = parseCode(payload);
        if (typeof code !== 'string' || !/^\d{7,31}$/.test(code)) throw new Error();
      } catch {
        message('qr.wrong_code');
        return false;
      }
      stop();
      message('qr.scanned');
      // This only fills the caller's field. Pairing remains a separate user action.
      onCode(code);
      return true;
    }

    function schedule(token) {
      if (!current(token)) return;
      loopTimer = root.setTimeout(() => { loopTimer = null; void scanFrame(token); }, LIVE_INTERVAL);
    }
    async function scanFrame(token) {
      if (!current(token)) return;
      try {
        if (video.readyState >= 2) {
          const pixels = draw(video, 1000);
          if (pixels && deliver(await decode(pixels), token)) return;
        }
      } catch {
        if (current(token)) message('qr.camera_error');
      }
      schedule(token);
    }

    async function start() {
      if (disabled || destroyed) return false;
      stop();
      show();
      const token = generation;
      const media = root.navigator?.mediaDevices;
      if (root.isSecureContext !== true || typeof media?.getUserMedia !== 'function') {
        // No await before this fallback: an iPhone must still see the original tap.
        choosePhoto();
        message('qr.camera_unavailable');
        return false;
      }
      message('qr.camera_starting');
      let openingCancelled = false;
      let timer;
      let cancel;
      const interrupted = new Promise((_, reject) => {
        cancel = () => { openingCancelled = true; reject(CANCELLED); };
        cancelOpening = cancel;
        timer = root.setTimeout(() => { openingCancelled = true; reject(new Error('camera timeout')); }, CAMERA_TIMEOUT);
      });
      const opening = (async () => {
        const acquired = await media.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (openingCancelled || !current(token)) { stopTracks(acquired); throw CANCELLED; }
        stream = acquired;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = acquired;
        await video.play();
        if (openingCancelled || !current(token)) throw CANCELLED;
      })();
      try {
        await Promise.race([opening, interrupted]);
        if (!current(token)) return false;
        if (previewElement) previewElement.hidden = false;
        message('qr.scan_hint');
        schedule(token);
        return true;
      } catch (error) {
        openingCancelled = true;
        if (!current(token) || error === CANCELLED) return false;
        stopTracks(stream);
        stream = null;
        video.srcObject = null;
        const key = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)
          ? 'qr.camera_denied'
          : ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(error?.name)
            ? 'qr.camera_unavailable' : 'qr.camera_error';
        message(key);
        // The photo button offers a new gesture. Never auto-click after awaiting permission.
        return false;
      } finally {
        root.clearTimeout(timer);
        if (cancelOpening === cancel) cancelOpening = null;
      }
    }

    function loadImage(url) {
      return new Promise((resolve, reject) => {
        const image = new root.Image();
        const cancel = () => {
          image.onload = image.onerror = null;
          image.src = '';
          reject(CANCELLED);
        };
        cancelImage = cancel;
        image.onload = () => {
          image.onload = image.onerror = null;
          if (cancelImage === cancel) cancelImage = null;
          resolve(image);
        };
        image.onerror = () => {
          image.onload = image.onerror = null;
          if (cancelImage === cancel) cancelImage = null;
          reject(new Error('image decode failed'));
        };
        image.src = url;
      });
    }

    async function readPhoto() {
      photoPickerOpen = false;
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file || disabled || destroyed || !active) return;
      generation++;
      const token = generation;
      suspendCamera();
      releaseImage();
      const type = String(file.type || '').toLowerCase();
      const filenameAllowed = /\.(?:jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
      if ((type && !IMAGE_TYPES.has(type)) || (!type && !filenameAllowed)) { message('qr.invalid_photo'); return; }
      if (!Number.isFinite(file.size) || file.size <= 0) { message('qr.invalid_photo'); return; }
      if (file.size > MAX_FILE_BYTES) { message('qr.photo_too_large'); return; }
      message('qr.reading_photo');
      let photoUrl;
      try {
        photoUrl = root.URL.createObjectURL(file);
        objectUrl = photoUrl;
        const image = await loadImage(photoUrl);
        if (!current(token)) return;
        const pixels = draw(image, 1600);
        if (!pixels) { message('qr.invalid_photo'); return; }
        const result = await decode(pixels);
        if (!current(token)) return;
        if (!result) message('qr.no_code');
        else deliver(result, token);
      } catch (error) {
        if (current(token) && error !== CANCELLED) message('qr.photo_error');
      } finally {
        if (photoUrl && objectUrl === photoUrl) {
          root.URL.revokeObjectURL(photoUrl);
          objectUrl = null;
        }
      }
    }

    function close() { stop(); if (!disabled && !destroyed) returnFocusElement.focus?.(); }
    function visibilityChanged() {
      if (!document.hidden) return;
      // A native photo picker can temporarily hide the WebView. Keep that one-file
      // selection alive while still stopping every live camera resource.
      if (photoPickerOpen) suspendCamera();
      else stop();
    }
    function pickerCancelled() { photoPickerOpen = false; }
    function onStart() { void start(); }
    function onPhoto() { choosePhoto(); }
    function onFile() { void readPhoto(); }
    button.addEventListener('click', onStart);
    closeButton.addEventListener('click', close);
    photoButton.addEventListener('click', onPhoto);
    fileInput.addEventListener('change', onFile);
    fileInput.addEventListener('cancel', pickerCancelled);
    document.addEventListener('visibilitychange', visibilityChanged);
    root.addEventListener('pagehide', stop);
    root.addEventListener('beforeunload', stop);
    root.addEventListener('unload', stop);

    function setDisabled(value) {
      disabled = Boolean(value);
      button.disabled = fileInput.disabled = photoButton.disabled = disabled;
      if (disabled) stop();
    }
    function destroy() {
      if (destroyed) return;
      stop();
      destroyed = true;
      button.removeEventListener('click', onStart);
      closeButton.removeEventListener('click', close);
      photoButton.removeEventListener('click', onPhoto);
      fileInput.removeEventListener('change', onFile);
      fileInput.removeEventListener('cancel', pickerCancelled);
      document.removeEventListener('visibilitychange', visibilityChanged);
      root.removeEventListener('pagehide', stop);
      root.removeEventListener('beforeunload', stop);
      root.removeEventListener('unload', stop);
    }
    return { start, stop, destroy, setDisabled };
  }

  root.FrameoScanner = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})(typeof window !== 'undefined' ? window : globalThis);

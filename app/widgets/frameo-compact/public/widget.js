(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrameoWidget = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const HEIGHTS = Object.freeze({ compact: '65%', square: '100%', portrait: '135%' });
  const MAX_BYTES = 4 * 1024 * 1024;
  const translations = Object.freeze({
    fr: {
      language: 'fr',
      timeout_title: 'Le chargement prend trop de temps', timeout_hint: 'Le cadre n’a pas répondu à temps. Vous pouvez réessayer.',
      next: 'Changer la photo', retry: 'Réessayer', loading: 'Chargement…', photo_alt: 'Photo du cadre Frameo',
      no_frame_title: 'Choisissez votre cadre', no_frame_hint: 'Sélectionnez un cadre photo dans les réglages du widget.',
      send_title: 'Mode envoi seul', send_hint: 'Dans les réglages du cadre dans Homey, choisissez « Envoyer et gérer les photos ».',
      permission_title: 'Consultation à autoriser', permission_hint: 'Sur le cadre : Paramètres → Mes amis, choisissez le nom d’expéditeur défini pour Homey et autorisez la consultation des photos.',
      empty_title: 'Aucune photo visible', empty_hint: 'Ajoutez une photo ou rendez-la visible dans le diaporama du cadre, puis réessayez.',
      offline_title: 'Cadre indisponible', offline_hint: 'Vérifiez sa connexion, puis réessayez.',
      busy_title: 'Opération en cours', busy_hint: 'Une opération est en cours. Réessayez dans un instant.',
      error_title: 'Photo indisponible', error_hint: 'La photo n’a pas pu être affichée. Réessayez.',
    },
    en: {
      language: 'en',
      timeout_title: 'Loading took too long', timeout_hint: 'The frame did not respond in time. You can try again.',
      next: 'Change photo', retry: 'Try again', loading: 'Loading…', photo_alt: 'Photo from the Frameo frame',
      no_frame_title: 'Choose your frame', no_frame_hint: 'Select a photo frame in the widget settings.',
      send_title: 'Send-only mode', send_hint: 'In the frame’s settings in Homey, choose “Send and manage photos”.',
      permission_title: 'Viewing access needed', permission_hint: 'On the frame: Settings → My friends, choose the sender name configured for Homey and allow viewing photos.',
      empty_title: 'No visible photos', empty_hint: 'Add a photo or make one visible in the frame’s slideshow, then try again.',
      offline_title: 'Frame unavailable', offline_hint: 'Check its connection, then try again.',
      busy_title: 'Operation in progress', busy_hint: 'An operation is in progress. Try again in a moment.',
      error_title: 'Photo unavailable', error_hint: 'The photo could not be displayed. Please try again.',
    },
    nl: {
      language: 'nl',
      timeout_title: 'Het laden duurt te lang', timeout_hint: 'De fotolijst reageerde niet op tijd. Je kunt het opnieuw proberen.',
      next: 'Andere foto', retry: 'Opnieuw proberen', loading: 'Laden…', photo_alt: 'Foto uit de Frameo-fotolijst',
      no_frame_title: 'Kies je fotolijst', no_frame_hint: 'Selecteer een fotolijst in de instellingen van de widget.',
      send_title: 'Alleen verzenden', send_hint: 'Kies in de instellingen van de fotolijst in Homey voor ‘Foto’s verzenden en beheren’.',
      permission_title: 'Toegang tot foto’s nodig', permission_hint: 'Op de fotolijst: Instellingen → Mijn vrienden. Kies de afzendernaam die voor Homey is ingesteld en sta het bekijken van foto’s toe.',
      empty_title: 'Geen zichtbare foto’s', empty_hint: 'Voeg een foto toe of maak er een zichtbaar in de diavoorstelling van de fotolijst en probeer het opnieuw.',
      offline_title: 'Fotolijst niet beschikbaar', offline_hint: 'Controleer de verbinding en probeer het opnieuw.',
      busy_title: 'Bewerking bezig', busy_hint: 'Er wordt een bewerking uitgevoerd. Probeer het zo nog eens.',
      error_title: 'Foto niet beschikbaar', error_hint: 'De foto kon niet worden weergegeven. Probeer het opnieuw.',
    },
    de: {
      language: 'de',
      timeout_title: 'Das Laden dauert zu lange', timeout_hint: 'Der Bilderrahmen hat nicht rechtzeitig geantwortet. Versuche es erneut.',
      next: 'Foto wechseln', retry: 'Erneut versuchen', loading: 'Wird geladen…', photo_alt: 'Foto vom Frameo-Bilderrahmen',
      no_frame_title: 'Wähle deinen Bilderrahmen', no_frame_hint: 'Wähle einen Bilderrahmen in den Widget-Einstellungen.',
      send_title: 'Nur senden', send_hint: 'Wähle in den Einstellungen des Bilderrahmens in Homey „Fotos senden und verwalten“.',
      permission_title: 'Zugriff zum Ansehen nötig', permission_hint: 'Auf dem Bilderrahmen: Einstellungen → Meine Freunde. Wähle den für Homey eingestellten Absendernamen und erlaube das Ansehen von Fotos.',
      empty_title: 'Keine sichtbaren Fotos', empty_hint: 'Füge ein Foto hinzu oder mache eines in der Diashow des Bilderrahmens sichtbar und versuche es erneut.',
      offline_title: 'Bilderrahmen nicht verfügbar', offline_hint: 'Prüfe die Verbindung und versuche es erneut.',
      busy_title: 'Vorgang läuft', busy_hint: 'Ein Vorgang läuft gerade. Versuche es gleich noch einmal.',
      error_title: 'Foto nicht verfügbar', error_hint: 'Das Foto konnte nicht angezeigt werden. Versuche es erneut.',
    },
  });
  const ERROR_STATES = Object.freeze({
    WIDGET_DEVICE_INVALID: 'no_frame', ACCESS_MODE_SEND: 'send', PERMISSION_REQUIRED: 'permission',
    MEDIA_NOT_FOUND: 'empty', FRAME_UNAVAILABLE: 'offline', FRAME_UNKNOWN: 'offline',
    ENGINE_NOT_READY: 'offline', TIMEOUT: 'offline', WIDGET_TIMEOUT: 'timeout', BUSY: 'busy', QUEUE_FULL: 'busy',
  });

  function imageBytes(value, window) {
    if (!value || typeof value.mediaId !== 'string' || !/^-?(?:0|[1-9]\d{0,18})$/.test(value.mediaId) || value.mime !== 'image/jpeg' || typeof value.data !== 'string' ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 3 || value.bytes > MAX_BYTES ||
      value.data.length > Math.ceil(MAX_BYTES / 3) * 4 || value.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) ||
      !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 ||
      value.width > 2048 || value.height > 2048 || value.width * value.height > 4000000) throw new Error('IMAGE_INVALID');
    const decoded = window.atob(value.data);
    if (decoded.length !== value.bytes || window.btoa(decoded) !== value.data ||
      decoded.charCodeAt(0) !== 255 || decoded.charCodeAt(1) !== 216 || decoded.charCodeAt(2) !== 255) throw new Error('IMAGE_INVALID');
    return Uint8Array.from(decoded, char => char.charCodeAt(0));
  }

  function create({ Homey, document, window, language, format: fixedFormat, requestTimeoutMs = 45000 }) {
    let homeyLanguage;
    try { homeyLanguage = Homey.__('widgets.frameo.language'); } catch {}
    const languageCode = value => typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : '';
    const locale = [homeyLanguage, language, window.navigator?.language, 'en'].map(languageCode).find(code => Object.hasOwn(translations, code));
    const elements = Object.fromEntries(['widget', 'frame-name', 'photo-stage', 'photo', 'state', 'state-title', 'state-hint', 'next-photo', 'next-label']
      .map(id => [id, document.getElementById(id)]));
    let initialized = false, destroyed = false, busy = false, deviceId = null, generation = 0, photoUrl = null;
    let state = 'loading', currentMediaId = null, revalidateOnShow = false;
    const pendingApi = new Set();
    const apiDeadline = Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0 ? Math.min(requestTimeoutMs, 45000) : 45000;
    let rotationInterval = 0, rotationTimer = null, intersection = null;
    let intersecting = typeof window.IntersectionObserver !== 'function', pageHidden = false, initialRequested = false;

    function visible() {
      return !destroyed && !pageHidden && document.hidden !== true && document.visibilityState !== 'hidden' && intersecting;
    }
    function stopRotation() {
      if (rotationTimer !== null) { window.clearTimeout(rotationTimer); rotationTimer = null; }
    }
    function scheduleRotation() {
      stopRotation();
      if (!rotationInterval || !visible() || busy || state !== 'photo' || !deviceId) return;
      // A single timer, starting after the last displayed success. There is no
      // catch-up queue, background rotation, or automatic retry after errors.
      rotationTimer = window.setTimeout(() => {
        rotationTimer = null;
        if (visible() && state === 'photo' && !busy) void request(true, true);
      }, rotationInterval);
    }
    function visibilityChanged() {
      stopRotation();
      if (!visible()) {
        if (photoUrl || busy) {
          revalidateOnShow = true; generation++;
          for (const done of [...pendingApi]) done({ code: 'ABORTED' });
          busy = false; clearPhoto(); showState('loading');
        }
        return;
      }
      if (!deviceId) return;
      if (!initialRequested || revalidateOnShow) { revalidateOnShow = false; void request(false); }
      else scheduleRotation();
    }
    function api(method, path, body) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (error, value) => {
          if (settled) return;
          settled = true; window.clearTimeout(timer); pendingApi.delete(done);
          error ? reject(error) : resolve(value);
        };
        const timer = window.setTimeout(() => done({ code: 'WIDGET_TIMEOUT' }), apiDeadline);
        pendingApi.add(done);
        try { Promise.resolve(Homey.api(method, path, body)).then(value => done(null, value), error => done(error)); }
        catch (error) { done(error); }
      });
    }
    function galleryChanged(value) {
      if (destroyed || !value || value.id !== deviceId || typeof value.mediaId !== 'string') return;
      const affected = value.mediaId === currentMediaId;
      if (!affected && !busy) return;
      generation++; stopRotation();
      for (const done of [...pendingApi]) done({ code: 'ABORTED' });
      busy = false;
      if (affected) { clearPhoto(); showState('error'); }
      else if (photoUrl) showState('photo');
      else showState('error');
    }
    function t(key) {
      const fullKey = 'widgets.frameo.' + key;
      try { const translated = Homey.__(fullKey); if (typeof translated === 'string' && translated && translated !== fullKey) return translated; } catch {}
      return translations[locale][key];
    }
    function name(value) {
      return typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 100).join('') : '';
    }
    function updateButton() {
      elements['next-photo'].disabled = destroyed || busy || !deviceId || state === 'no_frame';
      elements['next-label'].textContent = busy ? t('loading') : t(['photo', 'loading', 'no_frame'].includes(state) ? 'next' : 'retry');
      elements['photo-stage'].setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    function showState(next) {
      state = next;
      elements.widget.dataset.state = next;
      elements.state.hidden = next === 'photo';
      elements.photo.hidden = next !== 'photo';
      elements['state-title'].textContent = next === 'loading' ? t('loading') : next === 'photo' ? '' : t(next + '_title');
      elements['state-hint'].textContent = ['loading', 'photo'].includes(next) ? '' : t(next + '_hint');
      updateButton();
    }
    function clearPhoto() {
      elements.photo.onload = null; elements.photo.onerror = null;
      elements.photo.removeAttribute('src'); elements.photo.hidden = true; currentMediaId = null;
      if (photoUrl) { window.URL.revokeObjectURL(photoUrl); photoUrl = null; }
    }
    function displayPhoto(value, token) {
      const bytes = imageBytes(value, window);
      // Keep one image element and one live Blob URL. Revoke the old source
      // before creating its replacement, including when the widget is removed.
      clearPhoto();
      showState('loading');
      const url = window.URL.createObjectURL(new window.Blob([bytes], { type: 'image/jpeg' }));
      photoUrl = url; currentMediaId = value.mediaId;
      const label = name(value.name);
      if (label) { elements['frame-name'].textContent = label; elements['frame-name'].title = label; }
      elements.photo.alt = t('photo_alt') + (label ? ' — ' + label : '');
      elements.photo.onload = function () {
        if (!destroyed && token === generation && photoUrl === url) { showState('photo'); scheduleRotation(); }
      };
      elements.photo.onerror = function () {
        if (!destroyed && token === generation && photoUrl === url) { stopRotation(); clearPhoto(); showState('error'); }
      };
      elements.photo.src = url;
    }
    async function request(next, automatic = false) {
      if (destroyed || busy || !deviceId) return;
      if (automatic && (!visible() || state !== 'photo')) return;
      stopRotation();
      initialRequested = true;
      busy = true;
      const token = ++generation;
      if (!photoUrl) showState('loading');
      else updateButton();
      try {
        const value = next
          ? await api('POST', '/next', { deviceId })
          : await api('GET', '/photo?deviceId=' + encodeURIComponent(deviceId), {});
        if (destroyed || token !== generation) return;
        if (value?.error) throw { code: typeof value.error.code === 'string' ? value.error.code : 'WIDGET_ERROR' };
        displayPhoto(value, token);
      } catch (error) {
        if (destroyed || token !== generation) return;
        clearPhoto();
        const code = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : error;
        showState(typeof code === 'string' && Object.hasOwn(ERROR_STATES, code) ? ERROR_STATES[code] : 'error');
      } finally {
        if (!destroyed && token === generation) { busy = false; updateButton(); if (state === 'photo') scheduleRotation(); }
      }
    }
    const nextPhoto = () => request(true);
    function pageHide(event) {
      if (!event.persisted) { destroy(); return; }
      pageHidden = true; visibilityChanged();
    }
    function pageShow() { if (!destroyed) { pageHidden = false; visibilityChanged(); } }
    function destroy() {
      if (destroyed) return;
      destroyed = true; generation++;
      for (const done of [...pendingApi]) done({ code: 'ABORTED' });
      stopRotation();
      intersection?.disconnect(); intersection = null;
      clearPhoto();
      elements['next-photo'].removeEventListener('click', nextPhoto);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      window.removeEventListener('unload', destroy);
      updateButton();
    }
    async function init() {
      if (initialized || destroyed) return;
      initialized = true;
      document.documentElement.lang = locale;
      let settings;
      try { settings = Homey.getSettings() || {}; } catch { settings = {}; }
      if (settings.auto_change === true && Number.isInteger(settings.interval_minutes) && settings.interval_minutes >= 1 && settings.interval_minutes <= 1440) {
        rotationInterval = settings.interval_minutes * 60 * 1000;
      }
      const fixed = Object.hasOwn(HEIGHTS, fixedFormat);
      const format = fixed ? fixedFormat : Object.hasOwn(HEIGHTS, settings.format) ? settings.format : 'square';
      elements.widget.dataset.format = format;
      const selected = settings.frame;
      if (typeof selected?.id === 'string' && /^[a-f0-9]{64}$/i.test(selected.id)) deviceId = selected.id.toLowerCase();
      elements['frame-name'].textContent = name(selected?.name);
      elements['frame-name'].title = name(selected?.name);
      elements['next-photo'].addEventListener('click', nextPhoto);
      if (typeof Homey.on === 'function') Homey.on('gallery.changed', galleryChanged);
      document.addEventListener('visibilitychange', visibilityChanged);
      window.addEventListener('pagehide', pageHide);
      window.addEventListener('pageshow', pageShow);
      window.addEventListener('unload', destroy);
      if (typeof window.IntersectionObserver === 'function') {
        intersection = new window.IntersectionObserver(entries => {
          if (destroyed) return;
          const entry = entries.find(item => item.target === elements.widget);
          if (entry) { intersecting = entry.isIntersecting === true && entry.intersectionRatio > 0; visibilityChanged(); }
        }, { threshold: 0.01 });
        intersection.observe(elements.widget);
      }
      showState(deviceId ? 'loading' : 'no_frame');
      if (fixed) Homey.ready();
      else Homey.ready({ height: HEIGHTS[format] });
      if (deviceId && visible()) await request(false);
    }
    return Object.freeze({ init, destroy });
  }

  return Object.freeze({ create, translations });
});

(function () {
  'use strict';
  var repair = document.body.dataset.mode === 'repair';
  var form = document.getElementById('pair-form');
  var codeInput = document.getElementById('code');
  var senderInput = document.getElementById('sender');
  var submit = document.getElementById('submit');
  var status = document.getElementById('status');
  var errorBox = document.getElementById('error');
  var scanButton = document.getElementById('scan');
  var refreshButton = document.getElementById('refresh');
  var manageAccessButton = document.getElementById('manage-access');
  var modeSend = document.getElementById('access-mode-send');
  var modeView = document.getElementById('access-mode-view');
  var modeManage = document.getElementById('access-mode-manage');
  var connectionContent = document.getElementById('connection-content');
  var accessGuide = document.getElementById('access-guide');
  var accessSender = document.getElementById('access-sender');
  var accessStatus = document.getElementById('access-status');
  var accessError = document.getElementById('access-error');
  var verifyButton = document.getElementById('access-verify');
  var laterButton = document.getElementById('access-later');
  var backButton = document.getElementById('access-back');
  var pendingCandidate = null;
  var pendingMode = 'send';
  var createdCandidate = null;
  var activeAccessState = null;
  var completed = false;
  var busy = false;
  function t(key) { return Homey.__(key); }
  var language = '';
  try { language = String(t('pair.language')).toLowerCase().split(/[-_]/)[0]; } catch (_) {}
  if (!['fr', 'en', 'nl', 'de'].includes(language)) language = String(navigator.language || 'en').toLowerCase().split(/[-_]/)[0];
  if (!['fr', 'en', 'nl', 'de'].includes(language)) language = 'en';
  if (document.documentElement) document.documentElement.lang = language;
  function selectedMode() { return modeManage.checked || modeView && modeView.checked ? 'manage' : 'send'; }
  function needsManagement() { return modeManage.checked; }
  function accessSatisfied(state) { return state.mayView && (!needsManagement() || state.mayManage); }
  document.querySelectorAll('[data-i18n]').forEach(function (element) { element.textContent = t(element.dataset.i18n); });
  Homey.setTitle(t(repair ? 'repair.title' : 'pair.title'));
  var mobile = Boolean(navigator.userAgentData && navigator.userAgentData.mobile) || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  scanButton.hidden = !mobile;
  document.getElementById('manual-divider').hidden = !mobile;
  var scanner = FrameoScanner.create({
    button: scanButton, fileInput: document.getElementById('qr-file'), overlay: document.getElementById('scanner-overlay'),
    video: document.getElementById('scanner-video'), canvas: document.getElementById('scanner-canvas'),
    closeButton: document.getElementById('scanner-close'), photoButton: document.getElementById('scanner-photo'),
    returnFocusElement: codeInput, previewElement: document.getElementById('scanner-video').parentElement,
    status: document.getElementById('scanner-status'), translate: t, parseCode: FrameoQr.parse,
    decode: function (image) { return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' }); },
    onCode: function (code) {
      if (busy || pendingCandidate || createdCandidate || activeAccessState || completed) return;
      codeInput.value = code.length === 10 ? code.match(/.{1,2}/g).join(' ') : code;
      codeInput.removeAttribute('aria-invalid'); errorBox.textContent = ''; status.textContent = t('qr.scanned');
      submit.focus();
    }
  });
  function setBusy(value) {
    busy = value;
    var locked = Boolean(pendingCandidate || createdCandidate);
    submit.disabled = value || Boolean(createdCandidate) || completed;
    codeInput.disabled = senderInput.disabled = modeSend.disabled = modeManage.disabled = value || locked || completed;
    if (modeView) modeView.disabled = value || locked || completed;
    if (refreshButton) refreshButton.disabled = value || completed;
    if (manageAccessButton) manageAccessButton.disabled = value || completed;
    verifyButton.disabled = laterButton.disabled = value || completed;
    if (backButton) backButton.disabled = value || completed;
    scanner.setDisabled(value || locked || Boolean(activeAccessState) || completed);
  }
  function finish() {
    if (completed) return;
    completed = true;
    setBusy(false);
    Homey.done();
  }
  function accessState(value, fallback) {
    value = value || {}; fallback = fallback || {};
    var peer = value.peer || (value.data && value.data.id) || fallback.peer;
    if (typeof peer !== 'string' || !peer) throw new Error(t('access.error'));
    var settings = value.settings || {};
    return {
      peer: peer,
      senderName: value.senderName || settings.sender_name || fallback.senderName || senderInput.value.trim() || 'Homey',
      mode: value.mode || settings.photo_access_mode || fallback.mode || 'manage',
      mayView: value.mayView === true,
      mayManage: value.mayManage === true
    };
  }
  function showAccessGuide(value, fallback) {
    activeAccessState = accessState(value, fallback);
    connectionContent.hidden = true;
    accessGuide.hidden = false;
    // Sender names are user-controlled. Never render them as HTML.
    accessSender.textContent = activeAccessState.senderName;
    var enableCopy = document.getElementById('access-enable-copy');
    if (enableCopy) enableCopy.textContent = t(needsManagement() ? 'access.guide_enable' : 'access.guide_enable_view');
    accessStatus.textContent = accessSatisfied(activeAccessState) ? t(needsManagement() ? 'access.verified' : 'access.verified_view') : '';
    accessError.textContent = '';
    if (typeof scanner.stop === 'function') scanner.stop();
    setBusy(false);
    verifyButton.focus();
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }
  codeInput.addEventListener('input', function () { codeInput.removeAttribute('aria-invalid'); errorBox.textContent = ''; status.textContent = ''; });
  codeInput.addEventListener('blur', function () {
    var code = codeInput.value.replace(/[\s-]/g, '');
    if (/^\d{10}$/.test(code)) codeInput.value = code.match(/.{1,2}/g).join(' ');
  });
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy || completed || createdCandidate || activeAccessState) return;
    var code, senderName = senderInput.value.trim(), mode = pendingCandidate ? pendingMode : selectedMode();
    if (!pendingCandidate) {
      try { code = FrameoQr.parse(codeInput.value); }
      catch (_) { errorBox.textContent = t('errors.code_invalid'); codeInput.setAttribute('aria-invalid', 'true'); codeInput.focus(); return; }
      if (!senderName || Array.from(senderName).length > 80 || /[\u0000-\u001f\u007f]/.test(senderName)) {
        errorBox.textContent = t('errors.sender_invalid'); senderInput.closest('details').open = true; senderInput.focus(); return;
      }
    }
    setBusy(true); errorBox.textContent = ''; status.textContent = t(pendingCandidate ? 'pair.adding' : (repair ? 'repair.connecting' : 'pair.connecting'));
    try {
      if (repair) {
        var repaired = await Homey.emit('pair_frame', { code: code, senderName: senderName, mode: mode });
        codeInput.value = ''; status.textContent = t('repair.success');
        if (mode === 'manage') {
          if (!repaired || (!repaired.peer && !(repaired.data && repaired.data.id))) repaired = await Homey.emit('get_access_state', {});
          showAccessGuide(repaired, { senderName: senderName, mode: mode });
          return;
        }
      } else {
        if (!pendingCandidate) {
          pendingCandidate = await Homey.emit('pair_frame', { code: code, senderName: senderName, mode: mode });
          pendingMode = mode;
          codeInput.value = '';
        }
        status.textContent = t('pair.adding');
        await Homey.createDevice(pendingCandidate);
        createdCandidate = pendingCandidate;
        pendingCandidate = null;
        status.textContent = t('pair.success');
        if (mode === 'manage') {
          showAccessGuide(createdCandidate, { senderName: senderName, mode: mode });
          return;
        }
      }
      finish();
    } catch (error) {
      status.textContent = ''; errorBox.textContent = error && error.message || t('errors.pair_failed');
      submit.textContent = t(pendingCandidate ? 'pair.retry_add' : (repair ? 'repair.submit' : 'pair.submit'));
      if (!pendingCandidate && !createdCandidate) codeInput.focus();
    } finally { setBusy(false); }
  });
  verifyButton.addEventListener('click', async function () {
    if (busy || completed || !activeAccessState) return;
    setBusy(true); accessError.textContent = ''; accessStatus.textContent = t('access.verifying');
    try {
      var result = await Homey.emit('check_permissions', { peer: activeAccessState.peer });
      if (result && result.peer && result.peer !== activeAccessState.peer) throw new Error(t('access.error'));
      activeAccessState = accessState(result, activeAccessState);
      if (accessSatisfied(activeAccessState)) {
        accessStatus.textContent = t(needsManagement() ? 'access.verified' : 'access.verified_view');
        finish();
      } else {
        accessStatus.textContent = t(needsManagement() ? 'access.pending' : 'access.pending_view');
      }
    } catch (error) {
      accessStatus.textContent = '';
      accessError.textContent = error && error.message || t('access.error');
    } finally { setBusy(false); }
  });
  laterButton.addEventListener('click', function () {
    if (busy || completed || !activeAccessState) return;
    finish();
  });
  if (backButton) backButton.addEventListener('click', function () {
    if (busy || completed) return;
    activeAccessState = null;
    accessGuide.hidden = true;
    connectionContent.hidden = false;
    accessStatus.textContent = accessError.textContent = '';
    setBusy(false);
    if (manageAccessButton) manageAccessButton.focus();
  });
  if (manageAccessButton) manageAccessButton.addEventListener('click', async function () {
    if (busy || completed || activeAccessState) return;
    setBusy(true); status.textContent = t('access.verifying'); errorBox.textContent = '';
    try {
      var state = await Homey.emit('get_access_state', { mode: 'manage' });
      modeManage.checked = true; modeSend.checked = false;
      if (modeView) modeView.checked = false;
      showAccessGuide(state, { mode: 'manage' });
      status.textContent = '';
    } catch (error) {
      status.textContent = ''; errorBox.textContent = error && error.message || t('access.error');
    } finally { setBusy(false); }
  });
  if (refreshButton) refreshButton.addEventListener('click', async function () {
    if (busy || completed || activeAccessState) return;
    setBusy(true); status.textContent = t('repair.connecting'); errorBox.textContent = '';
    try { await Homey.emit('refresh_frame', {}); status.textContent = t('repair.success'); finish(); }
    catch (error) { status.textContent = ''; errorBox.textContent = error && error.message || t('errors.refresh_failed'); }
    finally { setBusy(false); }
  });
}());

/* Preview-only instrumentation. The server injects this script before model
   scripts; raw artifacts are served byte-for-byte without this code. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var scriptParams = new URLSearchParams(document.currentScript ? new URL(document.currentScript.src, location.href).search : '');
  var result = {
    source: 'lab-harness', runId: params.get('labRun') || scriptParams.get('labRun'),
    attempt: Number(params.get('attempt') || scriptParams.get('attempt')),
    nonce: params.get('nonce') || scriptParams.get('nonce'), collected: true, errors: 0, canvas: false,
    structure: null, animation: null, buttonCount: 0, controlsTotal: 0,
    controlsTested: 0, controlsCapped: false, buttons: [], inputFound: null,
    inputTyped: null, inputValid: null, inputValidationMessage: null, rowCount: null,
  };
  var failingClick = null;
  var appFrames = 0;
  var sent = false;
  var nativeRAF = window.requestAnimationFrame.bind(window);
  function postResult() {
    if (sent) return;
    sent = true;
    try { window.parent.postMessage(result, '*'); } catch (_) { /* parent unavailable */ }
  }

  // Count only callbacks registered by generated code. Harness sampling uses
  // nativeRAF directly below, so its own activity cannot pass this check.
  window.requestAnimationFrame = function (callback) {
    return nativeRAF(function (timestamp) {
      appFrames += 1;
      callback(timestamp);
    });
  };

  function noteError() {
    result.errors += 1;
    if (failingClick) failingClick.threwException = true;
  }
  window.addEventListener('error', noteError);
  window.addEventListener('unhandledrejection', noteError);
  // Preserve anchor click handlers but prevent their default navigation.
  document.addEventListener('click', function (event) {
    if (event.target && event.target.closest && event.target.closest('a[href]')) event.preventDefault();
  }, true);

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function nextFrame() { return new Promise(function (resolve) { nativeRAF(resolve); }); }
  function visible(el) {
    var rect = el.getBoundingClientRect();
    var style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
  function labelOf(el) {
    return String(el.getAttribute('aria-label') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  function scopeOf(el) {
    return el.closest('section, form, article, [role="tabpanel"], li') || el.parentElement || el;
  }
  function scopeSnapshot(el) {
    var scope = scopeOf(el);
    return scope ? scope.innerHTML + '|' + Array.prototype.map.call(scope.attributes || [], function (a) { return a.name + '=' + a.value; }).join('|') : '';
  }
  function visibleControls() {
    return Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], summary, a[href]')).filter(function (el) {
      return visible(el) && !el.disabled;
    });
  }
  function canvasHash(canvas) {
    try {
      var context = canvas.getContext('2d');
      if (!context || !canvas.width || !canvas.height) return null;
      var image = context.getImageData(0, 0, canvas.width, canvas.height).data;
      var hash = 2166136261;
      // Sample all pixels up to a fixed bound, including real color bytes.
      var stride = Math.max(4, Math.floor(image.length / 12000 / 4) * 4);
      for (var i = 0; i < image.length; i += stride) hash = Math.imul(hash ^ image[i], 16777619);
      return String(hash >>> 0);
    } catch (_) { return null; }
  }
  function testInput() {
    var candidates = Array.prototype.slice.call(document.querySelectorAll('input:not([type="hidden"]), textarea'));
    var input = candidates.find(function (el) {
      var type = String(el.type || 'text').toLowerCase();
      return visible(el) && ['text', 'email', 'url', 'tel', 'search'].indexOf(type) !== -1;
    });
    result.inputFound = Boolean(input);
    if (!input) return;
    try {
      var oldValue = input.value;
      var type = String(input.type || 'text').toLowerCase();
      input.focus();
      input.value = type === 'email' ? 'invalid-email' : (input.required || input.pattern) ? '' : oldValue + 'bench';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      result.inputTyped = type === 'email' ? true : input.value !== oldValue;
      result.inputValid = input.checkValidity();
      result.inputValidationMessage = String(input.validationMessage || '').slice(0, 300);
      input.value = oldValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {
      result.inputTyped = false;
      result.inputValid = null;
    }
  }
  function landingStructure() {
    return Boolean(document.querySelector('header') && document.querySelector('nav') &&
      document.querySelector('main') && document.querySelector('footer') &&
      document.querySelectorAll('button').length >= 3);
  }

  async function run() {
    // The external harness was inserted before model scripts. Wait for the
    // document's load event and two paint frames before observing the artifact.
    if (document.readyState !== 'complete') {
      await new Promise(function (resolve) { window.addEventListener('load', resolve, { once: true }); });
    }
    await nextFrame(); await nextFrame();
    result.canvas = Boolean(document.querySelector('canvas'));
    result.structure = landingStructure();
    result.rowCount = document.querySelectorAll('table tbody tr').length;
    testInput();

    var controls = visibleControls();
    result.controlsTotal = controls.length;
    result.controlsTested = Math.min(controls.length, 25);
    result.controlsCapped = controls.length > 25;
    result.buttonCount = result.controlsTotal;
    var testWindowStart = performance.now();
    var startFrames = appFrames;
    for (var index = 0; index < result.controlsTested; index += 1) {
      var el = controls[index];
      var entry = { label: labelOf(el), threwException: false, changedDom: false };
      result.buttons.push(entry);
      var before = scopeSnapshot(el);
      failingClick = entry;
      try { el.click(); } catch (_) { entry.threwException = true; }
      await wait(110);
      var after = scopeSnapshot(el);
      entry.changedDom = before !== after;
      failingClick = null;
      await wait(30);
    }

    // Sample actual application rAF requests and canvas pixels separately from
    // harness frames. Pixel bytes catch same-sized visual changes.
    var canvas = document.querySelector('canvas');
    var pixelStart = canvas ? canvasHash(canvas) : null;
    await wait(Math.max(0, 1500 - (performance.now() - testWindowStart)));
    var pixelEnd = canvas ? canvasHash(canvas) : null;
    result.animation = appFrames - startFrames > 2 || (pixelStart !== null && pixelEnd !== null && pixelStart !== pixelEnd);
    result.animationMeasurement = { applicationFrames: appFrames - startFrames, canvasChanged: pixelStart !== null && pixelEnd !== null ? pixelStart !== pixelEnd : null };
    postResult();
  }

  // Keep the collection bounded even when a model-created page hangs a handler.
  Promise.race([run().then(function () { return 'done'; }), wait(7000).then(function () { return 'timeout'; })]).then(function (winner) {
    if (winner === 'timeout') {
      result.collected = false;
      result.errors = null;
      result.animation = null;
      postResult();
    }
  }).catch(function () {
    result.collected = false;
    result.errors = null;
    postResult();
  });
})();

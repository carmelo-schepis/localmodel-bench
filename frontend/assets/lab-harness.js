/* Runs inside sandboxed artifact previews only (injected by /api/lab/runs/{id}/artifacts/{attempt}).
   Measures the generated page, then reports one result message to the parent frame. */
(function () {
  'use strict';
  var result = {
    source: 'lab-harness',
    collected: true,
    errors: 0,
    canvas: false,
    structure: false,
    animation: null,
    buttonCount: 0,
    buttons: [],
    inputFound: null,
    inputTyped: false,
  };
  var failingClick = null;

  function noteError() {
    result.errors += 1;
    if (failingClick) {
      failingClick.threwException = true;
      failingClick = null;
    }
  }
  window.addEventListener('error', noteError);
  window.addEventListener('unhandledrejection', noteError);

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function frame() { return new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); }); }

  function visible(el) {
    var rect = el.getBoundingClientRect();
    var style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function snapshot() {
    try { return document.documentElement.outerHTML; }
    catch (err) { return null; }
  }

  function canvasSignature() {
    var canvas = document.querySelector('canvas');
    if (!canvas) return null;
    try { return canvas.offsetWidth + ':' + canvas.toDataURL().length; }
    catch (err) { return 'unreadable:' + canvas.offsetWidth; }
  }

  function labelOf(el) {
    var text = el.getAttribute('aria-label') || el.textContent || el.tagName;
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function testInput() {
    var input = null;
    var candidates = [].slice.call(document.querySelectorAll('input:not([type="hidden"]), textarea'));
    for (var i = 0; i < candidates.length; i += 1) {
      if (visible(candidates[i])) { input = candidates[i]; break; }
    }
    result.inputFound = Boolean(input);
    if (!input) return;
    try {
      input.focus();
      var before = input.value;
      input.value = before + 'bench';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      result.inputTyped = input.value.indexOf('bench') !== -1;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) { result.inputTyped = false; }
  }

  function clickableElements() {
    var selectors = 'button, [role="button"], summary, a[href]';
    return [].slice.call(document.querySelectorAll(selectors)).filter(function (el) {
      if (!visible(el)) return false;
      if (el.disabled) return false;
      // Skip anchor-only tabs whose only purpose is page navigation proxies for this test.
      return true;
    }).slice(0, 25);
  }

  async function run() {
    var guard = 0;
    while (document.readyState !== 'complete' && guard < 40) { guard += 1; await wait(120); }
    await frame();
    result.canvas = Boolean(document.querySelector('canvas'));
    result.structure = Boolean(
      document.querySelector('header') && document.querySelector('footer') &&
      document.querySelector('h1, h2') && [].slice.call(document.querySelectorAll('ul li, ol li')).length >= 2);
    testInput();

    // Give the page a keyboard nudge (safe if unused) and start the animation window.
    try { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); } catch (err) { /* synthetic events unsupported */ }
    var animationStart = canvasSignature();
    var mutations = 0;
    var observer = new MutationObserver(function () { mutations += 1; });
    if (document.body) observer.observe(document.body, { childList: true, attributes: true, characterData: true, subtree: true });

    var clickables = clickableElements();
    result.buttonCount = clickables.length;
    for (var index = 0; index < clickables.length; index += 1) {
      var el = clickables[index];
      var entry = { label: labelOf(el), threwException: false, changedDom: false };
      result.buttons.push(entry);
      var before = snapshot();
      failingClick = entry;
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await wait(150);
      } catch (err) {
        entry.threwException = true;
      }
      failingClick = null;
      var after = snapshot();
      if (before !== null && after !== null && before !== after) entry.changedDom = true;
      await wait(60);
    }

    await wait(Math.max(0, 1500 - (result.buttons.length * 210)));
    observer.disconnect();
    var animationEnd = canvasSignature();
    result.animation = mutations > 4 || (animationStart !== null && animationStart !== animationEnd);
    try { window.parent.postMessage(result, '*'); } catch (err) { /* no reachable parent */ }
  }

  run();
})();

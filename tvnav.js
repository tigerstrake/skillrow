/* TV remote support. ES5. Loaded after app.js.
 *  - spatial navigation with arrow keys over every visible button/input/select/list item (scoped to the open dialog)
 *  - Enter activates (buttons, list items, checkboxes; selects cycle their options)
 *  - Back (10009) / Escape: close dialog -> leave History -> ask to exit the app
 *  - number keys type into the focused field (fields are read-only on the TV so the on-screen keyboard never opens);
 *    m:ss fields fill like a microwave ("2","0","0","0" -> 20:00); +/- stepper buttons next to every field
 *  - color keys: Red = End workout, Green = New workout, Yellow = Row/History, Blue = Bluetooth panel; Play = Just row
 *  - SkillRowTV.confirm(msg, onYes, {yes, no}) remote-friendly confirm dialog
 * TV mode (read-only fields, digit capture) is on when window.tizen exists or with ?tv=1. Arrow navigation is always on. */
(function (global) {
  'use strict';
  var doc = document;
  var TV = typeof global.tizen !== 'undefined' || /[?&]tv=1/.test(global.location.search);
  var root = doc.documentElement;
  if (TV) root.className += ' tv kbnav';
  // heavy focus ring only while navigating with keys (a tap on an iPad should not leave a yellow ring)
  function kbnav(on) {
    if (TV) return;
    var has = /\bkbnav\b/.test(root.className);
    if (on && !has) root.className += ' kbnav';
    else if (!on && has) root.className = root.className.replace(/\s*\bkbnav\b/, '');
  }
  ['mousedown', 'touchstart', 'pointerdown'].forEach(function (n) { doc.addEventListener(n, function () { kbnav(false); }, true); });

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, CH_UP: 427, CH_DOWN: 428 };

  // ------------------------------------------------------------------ register remote keys
  var regLog = [];
  (function registerKeys() {
    var ti; try { ti = global.tizen && global.tizen.tvinputdevice; } catch (e) { ti = null; }
    if (!ti) return;
    var names = ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
      'ChannelUp', 'ChannelDown', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Minus'];
    var map = { ColorF0Red: 'RED', ColorF1Green: 'GREEN', ColorF2Yellow: 'YELLOW', ColorF3Blue: 'BLUE', MediaPlayPause: 'PLAYPAUSE',
      MediaPlay: 'PLAY', MediaPause: 'PAUSE', MediaStop: 'STOP', ChannelUp: 'CH_UP', ChannelDown: 'CH_DOWN' };
    names.forEach(function (n) {
      try {
        ti.registerKey(n);
        try { var k = ti.getKey(n); if (k && map[n]) KEY[map[n]] = k.code; } catch (e) { /* keep default code */ }
        regLog.push(n + ' ok');
      } catch (e) { regLog.push(n + ' failed: ' + (e && e.message)); }
    });
  })();

  // ------------------------------------------------------------------ focusables + geometry
  var FOCUS_SEL = 'button, input:not([type=checkbox]):not([type=hidden]), select, [tabindex], .hist-item, .opp-list label, [data-scroll]';
  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.hidden || el.closest('[hidden]')) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = global.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function openOverlays() {
    var o = Array.prototype.slice.call(doc.querySelectorAll('.overlay')).filter(function (x) { return !x.hidden; });
    // the confirm dialog sits on top of everything
    o.sort(function (a, b) { return (+(global.getComputedStyle(b).zIndex) || 0) - (+(global.getComputedStyle(a).zIndex) || 0); });
    return o;
  }
  function scope() { var o = openOverlays(); return o.length ? o[0] : doc.body; }
  function focusables(root) {
    return Array.prototype.slice.call((root || scope()).querySelectorAll(FOCUS_SEL)).filter(function (el) {
      if (el.tabIndex === -2) return false;
      if (el.getAttribute('data-nofocus') != null) return false;
      return visible(el);
    });
  }
  function ensureTabbable(el) { if (el && el.tabIndex < 0 && el.getAttribute('tabindex') == null) el.setAttribute('tabindex', '0'); }
  var lastRect = null;
  function focusEl(el) {
    if (!el) return false;
    ensureTabbable(el);
    try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { try { el.scrollIntoView(false); } catch (e2) { /* ignore */ } }
    lastRect = el.getBoundingClientRect();
    if (el.tagName === 'INPUT') el.setAttribute('data-fresh', '1');
    return true;
  }
  function current() {
    var a = doc.activeElement;
    if (!a || a === doc.body || !visible(a) || !scope().contains(a)) return null;
    return a;
  }
  function preferred(root) {
    var list = focusables(root);
    if (!list.length) return null;
    var pick = function (sel) { for (var i = 0; i < list.length; i++) if (list[i].matches(sel)) return list[i]; return null; };
    return pick('[data-autofocus]') || pick('.seg button.active') || pick('.btn.primary') || list[0];
  }
  function nearestTo(rect, list) {
    if (!rect) return null;
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2, best = null, bd = 1e12;
    list.forEach(function (el) {
      var r = el.getBoundingClientRect(), dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = el; }
    });
    return best;
  }

  function move(dir) {
    var cur = current(), list = focusables();
    if (!list.length) return false;
    if (!cur) return focusEl(nearestTo(lastRect, list) || preferred());
    var a = cur.getBoundingClientRect(), best = null, bestScore = 1e12;
    var acx = a.left + a.width / 2, acy = a.top + a.height / 2;
    list.forEach(function (el) {
      if (el === cur || el.contains(cur) || cur.contains(el)) return;
      var b = el.getBoundingClientRect(), bcx = b.left + b.width / 2, bcy = b.top + b.height / 2, main, cross, overlap;
      if (dir === 'right') { if (b.left < a.right - 4 && bcx <= acx + 1) return; main = Math.max(0, b.left - a.right); overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); cross = overlap > 0 ? 0 : Math.abs(bcy - acy); }
      else if (dir === 'left') { if (b.right > a.left + 4 && bcx >= acx - 1) return; main = Math.max(0, a.left - b.right); overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); cross = overlap > 0 ? 0 : Math.abs(bcy - acy); }
      else if (dir === 'down') { if (b.top < a.bottom - 4 && bcy <= acy + 1) return; main = Math.max(0, b.top - a.bottom); overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left); cross = overlap > 0 ? 0 : Math.abs(bcx - acx); }
      else { if (b.bottom > a.top + 4 && bcy >= acy - 1) return; main = Math.max(0, a.top - b.bottom); overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left); cross = overlap > 0 ? 0 : Math.abs(bcx - acx); }
      var score = main + cross * 2.5 + (overlap > 0 ? 0 : 40);
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) return focusEl(best);
    return false;
  }

  function scrollable(el) { return el && el.getAttribute('data-scroll') != null; }
  function scrollBy(el, dir) {
    var max = el.scrollHeight - el.clientHeight;
    if (max <= 2) return false;
    var step = Math.max(80, el.clientHeight * 0.6);
    if (dir === 'down' && el.scrollTop < max - 2) { el.scrollTop = Math.min(max, el.scrollTop + step); return true; }
    if (dir === 'up' && el.scrollTop > 2) { el.scrollTop = Math.max(0, el.scrollTop - step); return true; }
    return false;
  }

  // ------------------------------------------------------------------ field entry (digits + steppers)
  var FIELDS = {   // id -> kind/step/min
    'in-distance': { kind: 'int', step: 100, min: 50 }, 'in-calories': { kind: 'int', step: 10, min: 5 },
    'in-race-distance': { kind: 'int', step: 100, min: 100 }, 'iv-reps': { kind: 'int', step: 1, min: 1 },
    'in-time': { kind: 'time', step: 60, min: 10 }, 'iv-rest': { kind: 'time', step: 15, min: 0 },
    'in-target': { kind: 'time', step: 1, min: 60, empty: 120 }, 'in-pacer': { kind: 'time', step: 1, min: 60, empty: 120 },
    'iv-work': { kind: 'dyn' }
  };
  function fieldInfo(inp) {
    var f = FIELDS[inp.id];
    if (!f) return inp.type === 'number' ? { kind: 'int', step: +inp.step || 1, min: +inp.min || 0 } : null;
    if (f.kind === 'dyn') {
      var t = doc.getElementById('iv-type');
      return t && t.value === 'time' ? { kind: 'time', step: 15, min: 5 } : { kind: 'int', step: 50, min: 50 };
    }
    return f;
  }
  function parseT(s) {
    s = String(s || '').trim(); if (!s) return null;
    var p = s.split(':'), v = 0;
    for (var i = 0; i < p.length; i++) { var n = +p[i]; if (!isFinite(n)) return null; v = v * 60 + n; }
    return v;
  }
  function fmtT(v) { v = Math.max(0, Math.round(v)); var m = Math.floor(v / 60), s = v % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function setVal(inp, v) {
    inp.value = v;
    var ev; try { ev = new Event('input', { bubbles: true }); } catch (e) { ev = doc.createEvent('Event'); ev.initEvent('input', true, true); }
    inp.dispatchEvent(ev);
    try { ev = new Event('change', { bubbles: true }); } catch (e) { ev = doc.createEvent('Event'); ev.initEvent('change', true, true); }
    inp.dispatchEvent(ev);
    inp.classList.add('flash'); setTimeout(function () { inp.classList.remove('flash'); }, 250);
  }
  function typeDigit(inp, d) {
    var info = fieldInfo(inp) || { kind: 'text' };
    var buf = inp.getAttribute('data-fresh') === '1' ? '' : (inp.getAttribute('data-buf') || '');
    inp.removeAttribute('data-fresh');
    if (info.kind === 'time') {
      buf = (buf + d).replace(/^0+/, '').slice(-4);
      var n = buf ? +buf : 0, secs = n % 100, mins = Math.floor(n / 100);
      setVal(inp, mins + ':' + (secs < 10 ? '0' : '') + secs);
    } else {
      buf = (buf + d).replace(/^0+/, '').slice(-5);
      setVal(inp, buf || '0');
    }
    inp.setAttribute('data-buf', buf);
  }
  function stepField(inp, dir) {
    var info = fieldInfo(inp); if (!info) return;
    inp.removeAttribute('data-buf'); inp.setAttribute('data-fresh', '1');
    if (info.kind === 'time') {
      var v = parseT(inp.value); if (v == null) v = info.empty || 0;
      else v = Math.round(v / info.step) * info.step + dir * info.step;
      setVal(inp, fmtT(Math.max(info.min || 0, v)));
    } else {
      var n = Math.round(+inp.value || 0), st = info.step;
      n = dir > 0 ? Math.floor(n / st) * st + st : Math.ceil(n / st) * st - st;
      setVal(inp, String(Math.max(info.min || 0, n)));
    }
  }
  function decorateFields(root) {
    Array.prototype.slice.call((root || doc).querySelectorAll('input:not([type=checkbox])')).forEach(function (inp) {
      if (inp.getAttribute('data-tvdone')) return;
      inp.setAttribute('data-tvdone', '1');
      if (TV) { inp.readOnly = true; inp.setAttribute('inputmode', 'none'); }
      if (!fieldInfo(inp) && !FIELDS[inp.id]) return;
      var info0 = fieldInfo(inp);
      if (inp.type === 'number') { try { inp.type = 'text'; } catch (e) { /* ignore */ } }   // avoid native spinners
      if (!TV && info0 && info0.kind === 'int') { inp.setAttribute('inputmode', 'numeric'); inp.setAttribute('pattern', '[0-9]*'); }
      var minus = doc.createElement('button'), plus = doc.createElement('button');
      minus.className = 'btn step'; plus.className = 'btn step';
      minus.type = plus.type = 'button';
      minus.textContent = '−'; plus.textContent = '+';
      minus.setAttribute('data-step-for', inp.id); minus.setAttribute('data-dir', '-1');
      plus.setAttribute('data-step-for', inp.id); plus.setAttribute('data-dir', '1');
      inp.parentNode.insertBefore(minus, inp);
      if (inp.nextSibling) inp.parentNode.insertBefore(plus, inp.nextSibling); else inp.parentNode.appendChild(plus);
    });
  }
  doc.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-step-for]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var inp = doc.getElementById(b.getAttribute('data-step-for'));
    if (inp) stepField(inp, +b.getAttribute('data-dir'));
  }, true);
  doc.addEventListener('focusin', function (e) {
    var t = e.target;
    if (t && t.tagName === 'INPUT') { t.setAttribute('data-fresh', '1'); }
    if (t && t.getBoundingClientRect) lastRect = t.getBoundingClientRect();
  });

  // ------------------------------------------------------------------ confirm dialog
  var confirmCb = null;
  function confirmDlg(msg, onYes, opts) {
    opts = opts || {};
    var ov = doc.getElementById('tv-confirm');
    if (!ov) {
      ov = doc.createElement('div'); ov.id = 'tv-confirm'; ov.className = 'overlay'; ov.style.zIndex = '50';
      ov.innerHTML = '<div class="modal confirm"><h2 id="tv-confirm-msg"></h2><div class="modal-foot">' +
        '<button class="btn big" id="tv-confirm-no"></button><button class="btn primary big" id="tv-confirm-yes"></button></div></div>';
      doc.body.appendChild(ov);
      doc.getElementById('tv-confirm-no').onclick = function () { closeConfirm(false); };
      doc.getElementById('tv-confirm-yes').onclick = function () { closeConfirm(true); };
    }
    doc.getElementById('tv-confirm-msg').textContent = msg;
    doc.getElementById('tv-confirm-yes').textContent = opts.yes || 'Yes';
    doc.getElementById('tv-confirm-no').textContent = opts.no || 'Cancel';
    confirmCb = { yes: onYes, no: opts.onNo, prev: doc.activeElement };
    ov.hidden = false;
    focusEl(doc.getElementById(opts.focusYes ? 'tv-confirm-yes' : 'tv-confirm-no'));
  }
  function closeConfirm(yes) {
    var ov = doc.getElementById('tv-confirm'); if (ov) ov.hidden = true;
    var cb = confirmCb; confirmCb = null;
    if (cb && cb.prev && visible(cb.prev)) focusEl(cb.prev);
    try { if (cb) { if (yes && cb.yes) cb.yes(); else if (!yes && cb.no) cb.no(); } } catch (e) { console.error('confirm action', e); }
  }

  // ------------------------------------------------------------------ back / exit
  function exitApp() {
    try { global.tizen.application.getCurrentApplication().exit(); }
    catch (e) { try { global.close(); } catch (e2) { /* ignore */ } }
  }
  function closeOverlay(ov) {
    var c = ov.querySelector('[data-close]');
    if (c) c.click(); else ov.hidden = true;
  }
  function back() {
    var ov = openOverlays()[0];
    if (ov) { if (ov.id === 'tv-confirm') closeConfirm(false); else closeOverlay(ov); return; }
    var hist = doc.getElementById('history');
    if (hist && !hist.hidden) { var t = doc.querySelector('.tab[data-view="live"]'); if (t) t.click(); return; }
    var app = global.SkillRowApp, active = app && app.workout && app.workout.active;
    confirmDlg(active ? 'A workout is in progress and will NOT be saved. Exit SkillRow anyway?' : 'Exit SkillRow?', exitApp, { yes: 'Exit', no: 'Stay' });
  }

  function clickIfVisible(id) { var b = doc.getElementById(id); if (b && visible(b)) { b.click(); return true; } return false; }
  function toggleView() {
    var hist = doc.getElementById('history');
    var t = doc.querySelector('.tab[data-view="' + (hist && !hist.hidden ? 'live' : 'history') + '"]');
    if (t) t.click();
  }

  // ------------------------------------------------------------------ key handler (capture: runs before app.js)
  global.addEventListener('keydown', function (e) {
    var k = e.keyCode, t = e.target, dirs = {}, handled = true;
    dirs[KEY.LEFT] = 'left'; dirs[KEY.RIGHT] = 'right'; dirs[KEY.UP] = 'up'; dirs[KEY.DOWN] = 'down';
    var isInput = t && t.tagName === 'INPUT' && t.type !== 'checkbox';
    if (dirs[k] || k === KEY.ENTER) kbnav(true);
    var editable = isInput && !t.readOnly;
    if (k === KEY.BACK || (k === KEY.ESC)) { back(); }
    else if (dirs[k]) {
      if (editable && (k === KEY.LEFT || k === KEY.RIGHT)) {   // desktop: let caret move inside the text unless at the edge
        var atStart = t.selectionStart === 0 && t.selectionEnd === 0, atEnd = t.selectionStart === t.value.length;
        if ((k === KEY.LEFT && !atStart) || (k === KEY.RIGHT && !atEnd)) { handled = false; }
        else move(dirs[k]);
      } else if (scrollable(t) && (k === KEY.UP || k === KEY.DOWN) && scrollBy(t, dirs[k])) { /* scrolled */ }
      else if (!move(dirs[k]) && scrollable(scope().querySelector('[data-scroll]')) && (k === KEY.UP || k === KEY.DOWN)) { scrollBy(scope().querySelector('[data-scroll]'), dirs[k]); }
    }
    else if (k === KEY.ENTER) {
      if (!current()) { move('down'); }
      else if (t.tagName === 'SELECT') {
        var n = t.options.length; if (n) { t.selectedIndex = (t.selectedIndex + 1) % n; setVal(t, t.value); }
      } else if (isInput) {
        if (editable) handled = false;     // desktop: app.js Enter = start
        else { t.classList.add('flash'); setTimeout(function () { t.classList.remove('flash'); }, 250); hint('Use the number keys or the − / + buttons'); }
      } else if (t.tagName === 'LABEL') { t.click(); }
      else { t.click(); }
    }
    else if ((k >= 48 && k <= 57) || (k >= 96 && k <= 105)) {
      if (isInput && !editable) typeDigit(t, String(k >= 96 ? k - 96 : k - 48)); else handled = false;
    }
    else if (k === KEY.RED || k === KEY.STOP) { if (!clickIfVisible('btn-end')) hint('No workout running'); }
    else if (k === KEY.GREEN) { if (!openOverlays().length) clickIfVisible('btn-setup'); }
    else if (k === KEY.YELLOW) { if (!openOverlays().length) toggleView(); }
    else if (k === KEY.BLUE) { if (global.SkillRowTVUI) global.SkillRowTVUI.togglePanel(); }
    else if (k === KEY.PLAY || k === KEY.PLAYPAUSE) { if (!openOverlays().length && !clickIfVisible('btn-quick-free')) handled = false; }
    else if (k === KEY.CH_UP || k === KEY.CH_DOWN) {
      var sc = (t && scrollable(t)) ? t : scope().querySelector('[data-scroll]');
      if (sc) scrollBy(sc, k === KEY.CH_UP ? 'up' : 'down');
    }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ------------------------------------------------------------------ hints
  function hint(msg) {
    var h = doc.getElementById('tv-hint');
    if (!h) { h = doc.createElement('div'); h.id = 'tv-hint'; doc.body.appendChild(h); }
    h.textContent = msg; h.style.display = 'block';
    clearTimeout(hint.t); hint.t = setTimeout(function () { h.style.display = 'none'; }, 2500);
  }

  // ------------------------------------------------------------------ focus management on dialogs / re-renders
  var wasOpen = {}, histState = { on: false, first: null, pending: false };
  function onDom() {
    decorateFields(doc);
    openOverlaysChanged();
    // History view: land on the session list (selected item, else newest) instead of the detail pane
    var hist = doc.getElementById('history');
    var histOn = !!(hist && !hist.hidden), items = doc.getElementById('hist-items');
    var itemsFirst = items && items.firstElementChild;
    if (!histOn) { histState.pending = false; histState.first = null; }
    else if (!histState.on || itemsFirst !== histState.first) histState.pending = true;   // view opened or list re-rendered
    histState.on = histOn; histState.first = itemsFirst;
    if (histOn && histState.pending && !openOverlays().length) {
      var it = doc.querySelector('#hist-items .hist-item.sel') || doc.querySelector('#hist-items .hist-item');
      if (it && visible(it)) { histState.pending = false; focusEl(it); return; }
      if (items && items.querySelector('.muted, .err')) histState.pending = false;   // empty list / error: leave focus alone
    }
    // focused element was removed by a re-render -> recover near the old position
    if (!current()) {
      var list = focusables();
      var el = nearestTo(lastRect, list);
      if (el && doc.activeElement !== el && (doc.activeElement === doc.body || !doc.activeElement || !doc.contains(doc.activeElement) || !visible(doc.activeElement))) focusEl(el);
    }
  }
  var prevFocus = [];
  function openOverlaysChanged() {
    Array.prototype.slice.call(doc.querySelectorAll('.overlay')).forEach(function (ov) {
      var open = !ov.hidden, key = ov.id || 'x';
      if (open && !wasOpen[key]) {
        prevFocus.push(doc.activeElement);
        wasOpen[key] = true;
        if (!ov.contains(doc.activeElement)) setTimeout(function () { if (!ov.hidden && !ov.contains(doc.activeElement)) focusEl(preferred(ov)); }, 30);
      } else if (!open && wasOpen[key]) {
        wasOpen[key] = false;
        var p = prevFocus.pop();
        setTimeout(function () { if (!current()) focusEl(p && visible(p) && scope().contains(p) ? p : preferred()); }, 30);
      }
    });
  }
  var pending = false;
  function schedule() { if (pending) return; pending = true; setTimeout(function () { pending = false; try { onDom(); } catch (e) { console.error('tvnav', e); } }, 60); }
  if (global.MutationObserver) {
    new MutationObserver(schedule).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  } else setInterval(schedule, 500);

  // mark scroll containers so the remote can scroll them
  ['hist-detail', 'done-body'].forEach(function (id) { var el = doc.getElementById(id); if (el) { el.setAttribute('data-scroll', ''); el.setAttribute('tabindex', '0'); } });
  var ss = doc.querySelector('.splits-scroll'); if (ss) { ss.setAttribute('data-scroll', ''); ss.setAttribute('tabindex', '0'); }
  var fsb = doc.getElementById('btn-fs'); if (fsb && TV) fsb.hidden = true;

  decorateFields(doc);
  setTimeout(function () { if (!current()) focusEl(doc.getElementById('btn-quick-free') || preferred()); }, 300);

  global.SkillRowTV = { confirm: confirmDlg, hint: hint, focus: focusEl, move: move, back: back, exit: exitApp, isTV: TV, keys: KEY, keyLog: regLog,
    _typeDigit: typeDigit, _stepField: stepField };
})(window);

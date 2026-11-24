/* TV chrome. ES5. Loaded before app.js (so the transport can report state immediately).
 *  - Bluetooth state pill in the top bar + a big banner whenever the rower is not streaming
 *  - Bluetooth panel (Blue key / pill): state, device, packet counters, last packet hex + parsed values,
 *    devices seen while scanning, log, Rescan / Forget rower / Heart rate on-off / Exit
 *  - bottom key legend (color keys)
 *  - screen saver off (webapis.appcommon) while the app is open
 *  - "Delete session" button in History detail (sessions live in localStorage on the TV)
 *  - shrinks a tile's number when it is wider than its tile (e.g. 1:02:34 or 10234 on a landscape phone) */
(function (global) {
  'use strict';
  var doc = document, st = null, panelOpen = false;
  function $(id) { return doc.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var platform = [];

  // ------------------------------------------------------------------ screen saver / platform
  function screenSaverOff() {
    try {
      var ac = global.webapis && global.webapis.appcommon;
      if (!ac) { platform.push('webapis.appcommon: n/a'); return; }
      ac.setScreenSaver(ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
        function () { platform.push('screen saver: off'); }, function (e) { platform.push('screen saver error: ' + (e && e.message)); });
    } catch (e) { platform.push('setScreenSaver threw: ' + (e && e.message)); }
  }
  function platformInfo() {
    try { if (global.webapis && webapis.productinfo) platform.push('model: ' + webapis.productinfo.getModel() + ' / fw ' + (webapis.productinfo.getFirmware ? webapis.productinfo.getFirmware() : '?')); } catch (e) { platform.push('productinfo: ' + (e && e.message)); }
    try { if (global.tizen && tizen.systeminfo) platform.push('tizen ' + tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version')); } catch (e) { /* ignore */ }
    try { platform.push('UA: ' + navigator.userAgent.replace(/^.*?(Chrome\/[0-9.]+).*$/, '$1')); } catch (e) { /* ignore */ }
    platform.push('screen ' + global.innerWidth + 'x' + global.innerHeight + ' @' + (global.devicePixelRatio || 1));
  }

  // ------------------------------------------------------------------ DOM
  function build() {
    var bar = $('topbar');
    if (bar && !$('btn-ble')) {
      var pill = doc.createElement('button');
      pill.id = 'btn-ble'; pill.className = 'btn ble-pill'; pill.innerHTML = '<span class="dot"></span><span id="ble-txt">Bluetooth…</span>';
      pill.onclick = togglePanel;
      var conn = bar.querySelector('.conn');
      bar.insertBefore(pill, conn || null);
    }
    if (!$('ble-banner')) {
      var b = doc.createElement('div'); b.id = 'ble-banner'; b.hidden = true; doc.body.appendChild(b);
      b.addEventListener('click', function (e) {
        var t = cur(), btn = e.target && e.target.closest && e.target.closest('button');
        if (!btn && t && t.name === 'native') { openPanel(); return; }   // iOS app: tap the banner for details
        if (!btn || !t) return;
        if (btn.id === 'ban-connect' && t.connectRower) t.connectRower(false);
        else if (btn.id === 'ban-details') openPanel();
      });
    }
    if (!$('key-legend')) {
      var k = doc.createElement('div'); k.id = 'key-legend';
      k.innerHTML = '<span><i class="red"></i>End</span><span><i class="green"></i>New workout</span><span><i class="yellow"></i>Row / History</span>' +
        '<span><i class="blue"></i>Bluetooth</span><span class="muted">Arrows + OK to select &middot; Back to close</span>';
      doc.body.appendChild(k);
    }
    if (!$('ble-panel')) {
      var p = doc.createElement('div'); p.id = 'ble-panel'; p.className = 'overlay'; p.hidden = true; p.style.zIndex = '20';
      p.innerHTML = '<div class="modal wide ble-modal"><div class="modal-head"><h2>Bluetooth</h2><button class="btn icon" data-close>&times;</button></div>' +
        '<div id="ble-body" data-scroll tabindex="0"></div>' +
        '<div class="modal-foot wrap"><button class="btn" id="ble-any">Choose any device</button><button class="btn" id="ble-disc">Disconnect</button>' +
        '<button class="btn" id="ble-forget">Forget rower</button><button class="btn" id="ble-hr">Heart rate: off</button>' +
        '<button class="btn" id="ble-exit">Exit app</button><button class="btn primary big" id="ble-rescan">Rescan</button><button class="btn big" data-close>Close</button></div></div>';
      doc.body.appendChild(p);
      Array.prototype.forEach.call(p.querySelectorAll('[data-close]'), function (c) { c.onclick = closePanel; });
      $('ble-rescan').onclick = function () { var t = cur(); if (t && t.rescan) t.rescan(); };
      $('ble-any').onclick = function () { var t = cur(); if (t && t.connectRower) t.connectRower(true); };
      $('ble-disc').onclick = function () { var t = cur(); if (t && t.forgetHr) t.forgetHr(); else if (t && t.disconnect) t.disconnect(); };
      $('ble-forget').onclick = function () { var t = cur(); if (t && t.forget) t.forget(); };
      $('ble-hr').onclick = function () {
        var t = cur(); if (!t) return;
        if (t.setHr) t.setHr(!(st && st.hrEnabled));
        else if (t.connectHr) { if (st && st.hrPhase && st.hrPhase !== 'off') t.disconnectHr(); else t.connectHr(); }
        render();
      };
      $('ble-exit').onclick = function () { if (global.SkillRowTV) global.SkillRowTV.back(); };
    }
  }
  function cur() { return global.SkillRowTransport && global.SkillRowTransport.current; }
  function togglePanel() { if (panelOpen) closePanel(); else openPanel(); }
  function openPanel() { build(); $('ble-panel').hidden = false; panelOpen = true; render(); }
  function closePanel() { var p = $('ble-panel'); if (p) p.hidden = true; panelOpen = false; }
  // app.js closeOverlays() hides every .overlay: keep our flag in sync
  setInterval(function () { var p = $('ble-panel'); if (p && p.hidden) panelOpen = false; if (panelOpen) render(); }, 1000);

  var lastPill = '';
  function render() {
    build();
    var s = st || { phase: 'init', text: 'Starting…' };
    var good = s.phase === 'streaming' || s.phase === 'bridge' && s.rowerConnected;
    var cls = good ? 'on' : (s.phase === 'error' || s.phase === 'off' || s.phase === 'reconnecting' || s.phase === 'unauthorized' || s.phase === 'unsupported' ? 'bad' : 'warn');
    var shortTxt = { init: 'Bluetooth…', scanning: 'Searching rower', notfound: 'Rower not found', connecting: 'Connecting…', discovering: 'Connecting…',
      streaming: 'Rower connected', reconnecting: 'Reconnecting…', error: 'Bluetooth error', off: 'Bluetooth off', bridge: 'Bridge', needgesture: 'Connect rower',
      waiting: 'Waiting for rower', unauthorized: 'Bluetooth denied', unsupported: 'No Bluetooth' }[s.phase] || s.phase;
    if (s.transport === 'websocket') shortTxt = s.phase === 'streaming' ? 'Rower (bridge)' : (s.phase === 'error' ? 'Bridge offline' : 'Bridge: ' + shortTxt);
    if (s.transport === 'fake') shortTxt = 'Fake rower';
    var pillKey = cls + shortTxt;
    if (pillKey !== lastPill) {
      lastPill = pillKey;
      var pill = $('btn-ble'); pill.className = 'btn ble-pill ' + cls;
      pill.querySelector('.dot').className = 'dot ' + (cls === 'on' ? 'on' : cls === 'warn' ? 'warn' : '');
      $('ble-txt').textContent = shortTxt;
    }
    var ban = $('ble-banner');
    var nat = s.transport === 'native';
    var showBan = !good && s.transport !== 'fake';
    ban.hidden = !showBan;
    if (showBan) {
      var t = '<b>' + esc(s.text || shortTxt) + '</b>';
      if (nat && (s.phase === 'waiting' || s.phase === 'scanning')) t += '<span>It connects by itself as soon as the rower wakes up &middot; tap for details</span>';
      else if (s.phase === 'scanning' || s.phase === 'notfound') t += '<span>Press Blue for details &middot; ' + esc(String(s.foundCount || 0)) + ' Bluetooth devices seen</span>';
      if (s.transport === 'webbluetooth') t += '<div class="ban-btns"><button class="btn primary big" id="ban-connect">' + (s.phase === 'needgesture' ? 'Connect rower' : 'Choose rower again') +
        '</button><button class="btn big" id="ban-details">Details</button></div>';
      if (ban.innerHTML !== t) ban.innerHTML = t;
      ban.className = cls;
    }
    if (!panelOpen) return;
    var web = s.transport === 'webbluetooth', tz = s.transport === 'tizen-ble';   // nat (iOS app) is set above
    var hrBtn = $('ble-hr');
    if (hrBtn) {
      if (web) hrBtn.textContent = s.hrPhase && s.hrPhase !== 'off' ? 'Disconnect HR (' + s.hrPhase + ')' : 'Connect heart rate';
      else hrBtn.textContent = 'Heart rate: ' + (s.hrEnabled ? 'on (' + (s.hrPhase || '') + ')' : 'off');
      hrBtn.hidden = !(web || tz || nat);
    }
    $('ble-forget').hidden = !tz;
    $('ble-any').hidden = !web; $('ble-disc').hidden = !(web || (nat && s.hrDevice));
    $('ble-disc').textContent = nat ? 'Forget heart rate' : 'Disconnect';
    $('ble-rescan').textContent = web ? 'Connect rower' : nat ? 'Use a different rower' : 'Rescan';
    $('ble-rescan').hidden = !(web || tz || nat);
    $('ble-exit').hidden = !(global.SkillRowTV && global.SkillRowTV.isTV);
    var h = '<table class="kv">';
    function row(k, v) { h += '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>'; }
    row('Transport', esc(s.transport));
    row('State', '<b class="' + (cls === 'on' ? 'good' : cls === 'bad' ? 'bad' : '') + '">' + esc(s.phase) + '</b> &nbsp;' + esc(s.text || ''));
    if (s.error) row('Last error', '<span class="bad">' + esc(s.error) + '</span>');
    if (s.device || s.address) row('Rower', esc((s.device || '') + ' ' + (s.address || '')));
    if (s.url) row('Bridge', esc(s.url));
    if (nat) row('Bluetooth', esc(s.bt || ''));
    if (s.deviceInfo && Object.keys(s.deviceInfo).length) row('Rower info', esc(Object.keys(s.deviceInfo).map(function (k) { return k + ' ' + s.deviceInfo[k]; }).join(' · ')));
    if (s.counts) row('Packets', 'rower ' + s.counts.rower + ' &middot; force ' + s.counts.force + ' &middot; strokes ' + s.counts.stroke +
      (s.counts.hr != null ? ' &middot; hr ' + s.counts.hr : '') + (s.counts.adv != null ? ' &middot; adverts ' + s.counts.adv : ''));
    if (s.lastAt) row('Last data', Math.round((Date.now() - s.lastAt) / 1000) + ' s ago');
    if (s.lastHex) row('Last packet', '<code>' + esc(s.lastHex) + '</code>');
    if (s.lastParsed) row('Parsed', '<code>' + esc(JSON.stringify(s.lastParsed)) + '</code>');
    if (s.services) row('Services', '<code>' + esc(s.services) + '</code>');
    if (s.hrEnabled || s.hrDevice) row('Heart rate', esc((s.hrPhase || '') + ' ' + (s.hrDevice || '')));
    var sess = global.SkillRowSessions && global.SkillRowSessions.usage();
    if (sess) row('Saved sessions', sess.sessions + ' (' + Math.round(sess.chars / 1024) + ' K chars' + (sess.persistent ? '' : ', NOT persistent') + ')');
    row('Platform', esc(platform.join(' | ')));
    if (global.SkillRowTV && global.SkillRowTV.keyLog && global.SkillRowTV.keyLog.length) {
      var failed = global.SkillRowTV.keyLog.filter(function (x) { return x.indexOf('failed') >= 0; });
      row('Remote keys', failed.length ? '<span class="bad">' + esc(failed.join(', ')) + '</span>' : 'registered');
    }
    h += '</table>';
    var found = s.found ? Object.keys(s.found).map(function (k) { return s.found[k]; }) : [];
    if (found.length) {
      found.sort(function (a, b) { return (b.rssi || -999) - (a.rssi || -999); });
      h += '<h3>Devices seen (' + found.length + ')</h3><table class="kv small">' + found.slice(0, 30).map(function (f) {
        return '<tr><td>' + esc(f.name || '(no name)') + '</td><td>' + esc(f.address) + '</td><td>' + esc(f.rssi != null ? f.rssi + ' dBm' : '') + '</td><td><code>' + esc(f.uuids || '') + '</code></td></tr>';
      }).join('') + '</table>';
    }
    if (s.log && s.log.length) h += '<h3>Log</h3><pre class="ble-log">' + esc(s.log.slice(-40).reverse().join('\n')) + '</pre>';
    var body = $('ble-body');
    if (body.innerHTML !== h) { var top = body.scrollTop; body.innerHTML = h; body.scrollTop = top; }
  }

  var renderT = null;
  function linkState(s) {
    st = s;
    var root = doc.documentElement, want = 'tr-' + (s.transport || 'none');
    if (root.className.indexOf(want) < 0) root.className = root.className.replace(/\s*\btr-[a-z-]+/g, '') + ' ' + want;
    if (renderT) return;
    renderT = setTimeout(function () { renderT = null; try { render(); } catch (e) { console.error('tv-ui', e); } }, 150);
  }

  // ------------------------------------------------------------------ history delete button
  function decorateHistory() {
    var box = $('hist-detail');
    if (!box || !global.SkillRowSessions || $('btn-hist-del') || !box.querySelector('h3')) return;
    var sel = doc.querySelector('.hist-item.sel');
    if (!sel) return;
    var id = sel.getAttribute('data-id');
    var wrap = doc.createElement('div'); wrap.className = 'field';
    var b = doc.createElement('button'); b.className = 'btn danger'; b.id = 'btn-hist-del'; b.textContent = 'Delete this session';
    b.onclick = function () {
      var go = function () {
        try { global.SkillRowSessions.remove(id); } catch (e) { console.error('delete', e); }
        box.innerHTML = '<div class="muted">Deleted.</div>';
        var r = $('btn-hist-refresh'); if (r) r.click();
      };
      if (global.SkillRowTV) global.SkillRowTV.confirm('Delete this session permanently?', go, { yes: 'Delete', no: 'Keep' }); else if (global.confirm('Delete?')) go();
    };
    wrap.appendChild(b); box.appendChild(wrap);
  }

  // ------------------------------------------------------------------ fit tile numbers to their width
  // CSS sizes the numbers (vw / container units); this only shrinks one that still overflows. Re-measured only when
  // the text length, the tile width or the layout changes, so it costs nothing per frame.
  var fitGen = 0, fitQueued = false;
  function fitValues() {
    fitQueued = false;
    var els = doc.querySelectorAll('#tiles .tile .value');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], cw = el.clientWidth;
      if (!cw) { el._fitKey = null; continue; }   // hidden: retry when shown
      var key = fitGen + '|' + el.textContent.length + '|' + cw;
      if (el._fitKey === key) continue;
      el.style.fontSize = '';
      var sw = el.scrollWidth;
      if (sw > cw + 1) el.style.fontSize = (parseFloat(global.getComputedStyle(el).fontSize) * cw / sw * 0.97).toFixed(1) + 'px';
      el._fitKey = key;
    }
  }
  function queueFit(relayout) {
    if (relayout) fitGen++;
    if (fitQueued) return;
    fitQueued = true;
    (global.requestAnimationFrame || setTimeout)(fitValues);
  }
  function initFit() {
    var tiles = $('tiles');
    if (!tiles) return;
    global.addEventListener('resize', function () { queueFit(true); });
    if (global.MutationObserver) {
      new MutationObserver(function () { queueFit(false); }).observe(tiles, { childList: true, characterData: true, subtree: true });
      var live = $('live');   // .racing switches the tile layout
      if (live) new MutationObserver(function () { queueFit(true); }).observe(live, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
    if (global.ResizeObserver) new global.ResizeObserver(function () { queueFit(true); }).observe(tiles);
    queueFit(true);
  }

  function init() {
    build(); platformInfo(); screenSaverOff(); render(); initFit();
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') screenSaverOff(); });
    if (global.MutationObserver) {
      var hd = $('hist-detail');
      if (hd) new MutationObserver(function () { setTimeout(decorateHistory, 50); }).observe(hd, { childList: true });
    }
    // flex `gap` is Chrome 84+: older TVs get margin fallbacks (see tv.css .no-flexgap)
    try {
      var f = doc.createElement('div'); f.style.display = 'flex'; f.style.flexDirection = 'column'; f.style.rowGap = '1px';
      f.appendChild(doc.createElement('div')); f.appendChild(doc.createElement('div'));
      doc.body.appendChild(f); var ok = f.scrollHeight === 1; doc.body.removeChild(f);
      if (!ok) doc.documentElement.className += ' no-flexgap';
    } catch (e) { /* ignore */ }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();

  global.SkillRowTVUI = { linkState: linkState, togglePanel: togglePanel, openPanel: openPanel, closePanel: closePanel, platform: platform };
})(window);

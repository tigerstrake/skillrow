/* Tizen BLE transport: talks to the Technogym SkillRow directly via tizen.bluetooth (Tizen web API, TV profile 6.0+).
 * ES5, callback based, everything in try/catch, every step logged to state.log (shown in the Bluetooth panel).
 *
 * Flow: getLEAdapter -> startScan (15 s, repeat) -> match name "Rower*" or service 1826 -> stopScan -> connect
 *       -> getService(FTMS) -> 2AD1 addValueChangeListener; optional Technogym force service (force + end-of-stroke)
 *       -> watch disconnect (device/adapter connect-state listener + isConnected() polling + data silence)
 *       -> on drop: direct reconnect once, then rescan forever.
 * Optional HR (off by default, toggle in the Bluetooth panel): scans for 0x180D after the rower is streaming.
 * Messages emitted are identical to the Python bridge's (see ftms.js). */
(function (global) {
  'use strict';
  var F = global.SkillRowFTMS;
  var BASE = '-0000-1000-8000-00805f9b34fb';
  var FTMS_SVC = '00001826' + BASE, ROWER_DATA = '00002ad1' + BASE;
  var TG_SVC = '6e40244a-b5a3-f393-e0a9-e50e24dcca9e', TG_FORCE = '6e408f0b-b5a3-f393-e0a9-e50e24dcca9e', TG_STROKE = '6e403e57-b5a3-f393-e0a9-e50e24dcca9e';
  var HR_SVC = '0000180d' + BASE, HR_MEAS = '00002a37' + BASE;
  var SCAN_MS = 15000, CONNECT_MS = 20000, SILENCE_MS = 60000;

  // normalise any UUID form ("1826", "0x1826", "00001826", full, upper case, braces) to lower-case 128-bit
  function norm(u) {
    if (u == null) return '';
    var s = String(u).toLowerCase().replace(/[{}\s]/g, '').replace(/^0x/, '');
    if (/^[0-9a-f]{4}$/.test(s)) return '0000' + s + BASE;
    if (/^[0-9a-f]{8}$/.test(s)) return s + BASE;
    if (/^[0-9a-f]{32}$/.test(s)) return s.substr(0, 8) + '-' + s.substr(8, 4) + '-' + s.substr(12, 4) + '-' + s.substr(16, 4) + '-' + s.substr(20);
    return s;
  }
  function variants(full) {   // forms to try with getService()
    var v = [full, full.toUpperCase()];
    if (full.slice(8) === BASE) { var sh = full.substr(4, 4); v.push(sh, sh.toUpperCase(), full.substr(0, 8)); }
    return v;
  }
  function errStr(e) { if (!e) return 'unknown error'; return (e.name ? e.name + ': ' : '') + (e.message || String(e)); }
  function ts() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
  function store(k, v) {
    try {
      if (arguments.length > 1) { global.localStorage.setItem('skillrow.tv.' + k, JSON.stringify(v)); return v; }
      var r = global.localStorage.getItem('skillrow.tv.' + k); return r == null ? null : JSON.parse(r);
    } catch (e) { return null; }
  }
  function devName(d) { try { return d.name || ''; } catch (e) { return ''; } }
  function devUuids(d) { var u = []; try { u = d.uuids || []; } catch (e) { /* ignore */ } var out = []; for (var i = 0; i < u.length; i++) out.push(norm(u[i])); return out; }
  function hasUuid(d, full) { return devUuids(d).indexOf(full) >= 0; }

  function create() {
    var h = null, agg = null, adapter = null;
    var st = {
      transport: 'tizen-ble', phase: 'init', text: 'Starting Bluetooth…', error: null, device: null, address: store('rowerAddr'),
      found: {}, foundCount: 0, log: [], counts: { rower: 0, force: 0, stroke: 0, hr: 0, adv: 0 }, lastHex: '', lastParsed: null, lastAt: 0,
      services: null, hrEnabled: !!store('hrEnabled'), hrPhase: 'off', hrDevice: null, attempts: 0
    };
    var gen = 0;                  // bumps on every (re)start of the rower pipeline; stale callbacks compare against it
    var scanning = false, scanMode = null, timers = {}, dev = null, subs = [], connWatch = null, pollT = null;
    var hrGen = 0, hrDev = null, hrSubs = [], hrWatch = null;
    var status = { connected: false, device: null, hr_connected: false, hr_device: null };

    function log(msg) {
      st.log.push(ts() + '  ' + msg);
      if (st.log.length > 120) st.log.splice(0, st.log.length - 120);
      try { if (global.console) console.log('[BLE] ' + msg); } catch (e) { /* ignore */ }
      push();
    }
    function push() { try { if (global.SkillRowTVUI && global.SkillRowTVUI.linkState) global.SkillRowTVUI.linkState(st); } catch (e) { /* ignore */ } }
    function phase(p, text, isErr) { st.phase = p; st.text = text; if (isErr) st.error = text; log((isErr ? 'ERROR ' : '') + text); }
    function sendStatus() { if (h) h.message({ type: 'status', data: { connected: status.connected, device: status.device, hr_connected: status.hr_connected, hr_device: status.hr_device } }); }
    function later(name, fn, ms) { clearTimeout(timers[name]); timers[name] = setTimeout(function () { try { fn(); } catch (e) { log('ERROR in ' + name + ': ' + errStr(e)); } }, ms); }
    function cancel(name) { clearTimeout(timers[name]); delete timers[name]; }

    // ------------------------------------------------------------ scanning (shared by rower + HR)
    function stopScan() {
      cancel('scanTimeout');
      if (!adapter) return;
      try { adapter.stopScan(); } catch (e) { log('stopScan: ' + errStr(e)); }
      scanning = false; scanMode = null;
    }
    function startScan(mode, onDevice, onTimeout, ms) {
      if (scanning) stopScan();
      try {
        adapter.startScan(function (d) {
          try { recordAdv(d); if (scanning && scanMode === mode) onDevice(d); } catch (e) { log('scan callback: ' + errStr(e)); }
        }, function (e) {
          scanning = false; log('ERROR scan error: ' + errStr(e));
          if (mode === 'rower') { st.error = 'Scan failed: ' + errStr(e); later('rescan', scanForRower, 4000); }
        });
        scanning = true; scanMode = mode;
      } catch (e) {
        scanning = false;
        log('ERROR startScan threw: ' + errStr(e));
        if (e && e.name === 'InvalidStateError') { try { adapter.stopScan(); } catch (e2) { /* ignore */ } }
        return false;
      }
      later('scanTimeout', function () { stopScan(); onTimeout(); }, ms);
      return true;
    }
    function recordAdv(d) {
      st.counts.adv++;
      var a = d.address, f = st.found[a];
      if (!f) { st.foundCount++; if (st.foundCount > 80) return; f = st.found[a] = { address: a }; }
      f.name = devName(d) || f.name || ''; f.uuids = devUuids(d).map(shortUuid).join(' '); f.t = Date.now();
      try { if (d.rssi != null) f.rssi = d.rssi; } catch (e) { /* ignore */ }
      if (st.counts.adv % 10 === 1) push();
    }
    function shortUuid(u) { return u.slice(8) === BASE ? u.substr(4, 4) : u; }

    // ------------------------------------------------------------ rower pipeline
    function init() {
      if (typeof global.tizen === 'undefined' || !global.tizen.bluetooth) {
        phase('error', 'tizen.bluetooth API is not available on this TV (needs Tizen 6.0+ and the bluetooth privilege).', true);
        later('init', init, 15000); return;
      }
      try {
        var cap = global.tizen.systeminfo && global.tizen.systeminfo.getCapability('http://tizen.org/feature/network.bluetooth.le');
        log('feature network.bluetooth.le = ' + cap);
      } catch (e) { log('getCapability: ' + errStr(e)); }
      try { adapter = global.tizen.bluetooth.getLEAdapter(); }
      catch (e) { phase('error', 'getLEAdapter failed: ' + errStr(e), true); later('init', init, 10000); return; }
      try {
        var da = global.tizen.bluetooth.getDefaultAdapter();
        if (da && da.powered === false) { phase('off', 'Bluetooth is OFF. Turn it on in TV Settings > Connection > Bluetooth.', true); later('init', init, 5000); return; }
      } catch (e) { log('getDefaultAdapter: ' + errStr(e) + ' (ignored)'); }
      scanForRower();
    }

    function isRower(d) {
      var n = devName(d).toLowerCase();
      return n.indexOf('rower') === 0 || hasUuid(d, FTMS_SVC) || (st.address && d.address === st.address);
    }

    function scanForRower() {
      cancel('rescan');
      var g = ++gen;
      st.attempts++;
      phase('scanning', 'Searching for the rower… (start rowing or press a key on the rower to wake it)');
      var ok = startScan('rower', function (d) {
        if (g !== gen) return;
        if (hrWanted() && !status.hr_connected && hasUuid(d, HR_SVC) && !hasUuid(d, FTMS_SVC)) st.hrCandidate = d;
        if (isRower(d)) { stopScan(); log('found ' + (devName(d) || '?') + ' ' + d.address); connectRower(d, false); }
      }, function () {
        if (g !== gen) return;
        phase('notfound', 'Rower not found. Is it switched on? Rescanning…');
        later('rescan', scanForRower, 3000);
      }, SCAN_MS);
      if (!ok) { st.error = 'Could not start scan'; later('rescan', scanForRower, 4000); }
    }

    function connectRower(d, direct) {
      var g = ++gen, done = false;
      dev = d; st.device = devName(d) || st.device || 'Rower'; st.address = d.address;
      phase('connecting', (direct ? 'Reconnecting to ' : 'Connecting to ') + st.device + '…');
      later('connTimeout', function () {
        if (done || g !== gen) return; done = true;
        log('ERROR connect timed out after ' + (direct ? 10 : CONNECT_MS / 1000) + ' s');
        safeDisconnect(d); afterFailure();
      }, direct ? 10000 : CONNECT_MS);
      function afterFailure() { if (g === gen) later('rescan', scanForRower, 2000); }
      try {
        d.connect(function () {
          if (done || g !== gen) return; done = true; cancel('connTimeout');
          log('connected, discovering services');
          later('discover', function () { setupRower(d, g, 0); }, 400);
        }, function (e) {
          if (done || g !== gen) return; done = true; cancel('connTimeout');
          log('ERROR connect failed: ' + errStr(e));
          safeDisconnect(d); afterFailure();
        });
      } catch (e) {
        done = true; cancel('connTimeout');
        log('ERROR connect threw: ' + errStr(e)); afterFailure();
      }
    }

    function safeDisconnect(d) { try { if (d) d.disconnect(function () { }, function () { }); } catch (e) { /* ignore */ } }

    function getSvc(d, full) {
      var vs = variants(full), errs = [];
      for (var i = 0; i < vs.length; i++) {
        try { var s = d.getService(vs[i]); if (s) return s; } catch (e) { errs.push(vs[i] + ' ' + errStr(e)); }
      }
      // fallback: enumerate and match ourselves
      try {
        if (typeof d.getServiceAllUuids === 'function') {
          var all = d.getServiceAllUuids() || [];
          st.services = all.map(function (u) { return shortUuid(norm(u)); }).join(' ');
          for (var j = 0; j < all.length; j++) if (norm(all[j]) === full) { try { return d.getService(all[j]); } catch (e) { errs.push('enum ' + errStr(e)); } }
        }
      } catch (e) { errs.push('getServiceAllUuids ' + errStr(e)); }
      log('service ' + shortUuid(full) + ' not found: ' + errs.slice(0, 3).join(' | '));
      return null;
    }
    function findChar(svc, full) {
      var cs = [];
      try { cs = svc.characteristics || []; } catch (e) { log('characteristics: ' + errStr(e)); }
      for (var i = 0; i < cs.length; i++) { try { if (norm(cs[i].uuid) === full) return cs[i]; } catch (e) { /* ignore */ } }
      log('characteristic ' + shortUuid(full) + ' not found (have: ' + cs.map(function (c) { try { return shortUuid(norm(c.uuid)); } catch (e) { return '?'; } }).join(' ') + ')');
      return null;
    }
    function listen(list, ch, cb, label) {
      try {
        var id = ch.addValueChangeListener(function (v) { try { cb(v); } catch (e) { log('ERROR ' + label + ' handler: ' + errStr(e)); } });
        list.push({ ch: ch, id: id }); log('subscribed ' + label);
        return true;
      } catch (e) { log('ERROR subscribe ' + label + ': ' + errStr(e)); return false; }
    }
    function unlisten(list) {
      while (list.length) { var s = list.pop(); try { s.ch.removeValueChangeListener(s.id); } catch (e) { /* ignore */ } }
    }

    function setupRower(d, g, attempt) {
      if (g !== gen) return;
      var ftms = getSvc(d, FTMS_SVC);
      if (!ftms) {
        if (attempt < 3) { log('retrying service discovery (' + (attempt + 1) + ')'); later('discover', function () { setupRower(d, g, attempt + 1); }, 1000); return; }
        phase('error', 'Connected but FTMS service 1826 not found. Services: ' + (st.services || '?'), true);
        teardown(); safeDisconnect(d); later('rescan', scanForRower, 3000); return;
      }
      var rc = findChar(ftms, ROWER_DATA);
      if (!rc || !listen(subs, rc, function (v) {
        if (g !== gen) return;
        var b = F.toBytes(v);
        st.counts.rower++; st.lastAt = Date.now(); st.lastHex = F.hex(b);
        st.lastParsed = agg.onRower(b);
        if (st.phase !== 'streaming') { phase('streaming', 'Connected: ' + st.device); }
        if (st.counts.rower % 5 === 1) push();
      }, 'rower data 2AD1')) {
        phase('error', 'Could not subscribe to rower data 2AD1', true);
        teardown(); safeDisconnect(d); later('rescan', scanForRower, 3000); return;
      }
      var tg = getSvc(d, TG_SVC);
      if (tg) {
        var fc = findChar(tg, TG_FORCE), sc = findChar(tg, TG_STROKE);
        if (fc) listen(subs, fc, function (v) { if (g === gen) { st.counts.force++; agg.onForce(F.toBytes(v)); } }, 'force curve');
        if (sc) listen(subs, sc, function (v) { if (g === gen) { st.counts.stroke++; agg.onStroke(F.toBytes(v)); } }, 'end of stroke');
      } else log('no Technogym force service (force curve disabled)');

      watchConnection(d, g);
      store('rowerAddr', d.address);
      status.connected = true; status.device = st.device; sendStatus();
      st.error = null;
      phase('streaming', 'Connected: ' + st.device);
      st.lastAt = Date.now();
      if (hrWanted()) later('hr', hrStart, 3000);
    }

    function watchConnection(d, g) {
      var cb = {
        onconnected: function () { },
        ondisconnected: function (dd) {
          try { if (dd && dd.address && dd.address !== d.address) return; } catch (e) { /* ignore */ }
          if (g === gen) onRowerLost('rower disconnected');
        }
      };
      connWatch = null;
      try { if (typeof d.addConnectStateChangeListener === 'function') connWatch = { obj: d, id: d.addConnectStateChangeListener(cb) }; }
      catch (e) { log('device connect listener: ' + errStr(e)); }
      if (!connWatch) {
        try { connWatch = { obj: adapter, id: adapter.addConnectStateChangeListener(cb) }; } catch (e) { log('adapter connect listener: ' + errStr(e)); }
      }
      clearInterval(pollT);
      pollT = setInterval(function () {
        if (g !== gen) { clearInterval(pollT); return; }
        try { if (typeof d.isConnected === 'function' && d.isConnected() === false) { onRowerLost('isConnected() = false'); return; } } catch (e) { /* ignore */ }
        if (Date.now() - st.lastAt > SILENCE_MS) { onRowerLost('no data for ' + Math.round(SILENCE_MS / 1000) + ' s'); return; }
        if (Date.now() - st.lastAt > 8000 && st.phase === 'streaming') { st.text = 'Connected: ' + st.device + ' (no data for ' + Math.round((Date.now() - st.lastAt) / 1000) + ' s)'; push(); }
      }, 3000);
    }

    function teardown() {
      unlisten(subs);
      clearInterval(pollT); pollT = null;
      if (connWatch) { try { connWatch.obj.removeConnectStateChangeListener(connWatch.id); } catch (e) { /* ignore */ } connWatch = null; }
    }

    function onRowerLost(reason) {
      var d = dev;
      gen++;               // invalidate all callbacks of this connection
      teardown();
      hrStop('rower lost');
      status.connected = false; sendStatus();
      phase('reconnecting', 'Rower connection lost (' + reason + '). Reconnecting…', true);
      safeDisconnect(d);
      if (d) later('reconnect', function () { connectRower(d, true); }, 1500);
      else later('rescan', scanForRower, 1500);
    }

    // ------------------------------------------------------------ optional heart rate
    function hrWanted() { return st.hrEnabled; }
    function hrStart() {
      if (!hrWanted() || status.hr_connected || !status.connected || scanning) return;
      var g = ++hrGen;
      st.hrPhase = 'scanning'; log('HR: scanning for 180D');
      var cand = st.hrCandidate; st.hrCandidate = null;
      function tryDev(d) {
        stopScan();
        st.hrPhase = 'connecting'; st.hrDevice = devName(d) || d.address; log('HR: connecting ' + st.hrDevice);
        var done = false;
        later('hrConn', function () { if (!done) { done = true; log('HR: connect timeout'); safeDisconnect(d); hrRetry(g); } }, 15000);
        try {
          d.connect(function () {
            if (done || g !== hrGen) return; done = true; cancel('hrConn');
            later('hrDisc', function () {
              var s = getSvc(d, HR_SVC), c = s && findChar(s, HR_MEAS);
              if (!c || !listen(hrSubs, c, function (v) {
                if (g !== hrGen) return;
                var bpm = F.parseHr(F.toBytes(v)); st.counts.hr++; st.hrLastAt = Date.now();
                if (bpm) agg.onHr(bpm);
              }, 'heart rate 2A37')) { safeDisconnect(d); hrRetry(g); return; }
              hrDev = d; st.hrPhase = 'streaming'; status.hr_connected = true; status.hr_device = st.hrDevice; sendStatus();
              try { if (typeof d.addConnectStateChangeListener === 'function') hrWatch = { obj: d, id: d.addConnectStateChangeListener({ onconnected: function () { }, ondisconnected: function () { if (g === hrGen) hrStop('HR disconnected', true); } }) }; } catch (e) { /* ignore */ }
            }, 400);
          }, function (e) { if (done) return; done = true; cancel('hrConn'); log('HR: connect failed ' + errStr(e)); hrRetry(g); });
        } catch (e) { done = true; cancel('hrConn'); log('HR: connect threw ' + errStr(e)); hrRetry(g); }
      }
      if (cand) { tryDev(cand); return; }
      var best = null;
      startScan('hr', function (d) {
        if (g !== hrGen || !hasUuid(d, HR_SVC) || hasUuid(d, FTMS_SVC) || d.address === st.address) return;
        var n = devName(d).toLowerCase();
        if (n.indexOf('whoop') >= 0) { tryDev(d); return; }
        if (!best) best = d;
      }, function () {
        if (g !== hrGen) return;
        if (best) tryDev(best); else { st.hrPhase = 'not found'; log('HR: no heart-rate device found'); hrRetry(g); }
      }, 8000);
    }
    function hrRetry(g) { if (g === hrGen && hrWanted()) { st.hrPhase = 'retry'; later('hr', hrStart, 20000); } }
    function hrStop(why, retry) {
      hrGen++;
      unlisten(hrSubs);
      if (hrWatch) { try { hrWatch.obj.removeConnectStateChangeListener(hrWatch.id); } catch (e) { /* ignore */ } hrWatch = null; }
      if (hrDev) safeDisconnect(hrDev); hrDev = null;
      if (scanMode === 'hr') stopScan();
      if (status.hr_connected) { status.hr_connected = false; status.hr_device = null; sendStatus(); agg.onHr(null); log('HR stopped: ' + why); }
      st.hrPhase = hrWanted() ? 'waiting' : 'off';
      if (retry && hrWanted()) later('hr', hrStart, 10000);
    }

    // ------------------------------------------------------------ public
    var api = {
      name: 'tizen-ble',
      start: function (handlers) {
        h = handlers;
        agg = F.createAggregator(function (m) { if (h) h.message(m); });
        h.open(true);        // no bridge on the TV: the "server" link is always up
        sendStatus();
        later('init', init, 200);
      },
      rescan: function () {   // manual "Rescan" from the panel
        log('manual rescan');
        gen++; teardown(); hrStop('rescan'); stopScan();
        if (status.connected) { status.connected = false; sendStatus(); }
        safeDisconnect(dev); dev = null;
        later('rescan', function () { if (!adapter) init(); else scanForRower(); }, 800);
      },
      forget: function () { store('rowerAddr', null); st.address = null; log('forgot saved rower address'); },
      setHr: function (on) {
        st.hrEnabled = !!on; store('hrEnabled', st.hrEnabled); log('heart rate ' + (on ? 'enabled' : 'disabled'));
        if (on) later('hr', hrStart, 500); else hrStop('disabled');
        push();
      },
      state: function () { return st; },
      _norm: norm
    };
    return api;
  }

  global.SkillRowTizenBLE = { create: create, norm: norm };
})(window);

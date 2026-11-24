/* Web Bluetooth transport (desktop Chrome/Edge, Android Chrome, iOS via the Bluefy browser). ES2017-safe, promise based.
 * requestDevice needs a user gesture: SkillRowTVUI shows a big "Connect rower" button that calls connectRower().
 * On load, navigator.bluetooth.getDevices() (if available) re-attaches a previously permitted rower without a gesture.
 * On gattserverdisconnected: device.gatt.connect() again with backoff (1 s .. 15 s, forever) on the same device object.
 * Optional heart-rate strap (0x180D) via connectHr(). Messages are identical to the Python bridge's (see ftms.js). */
(function (global) {
  'use strict';
  var F = global.SkillRowFTMS;
  var FTMS_SVC = 0x1826, ROWER_DATA = 0x2ad1, DEVINFO = 0x180a, HR_SVC = 0x180d, HR_MEAS = 0x2a37;
  var TG_SVC = '6e40244a-b5a3-f393-e0a9-e50e24dcca9e', TG_FORCE = '6e408f0b-b5a3-f393-e0a9-e50e24dcca9e', TG_STROKE = '6e403e57-b5a3-f393-e0a9-e50e24dcca9e';
  var OPTIONAL = [FTMS_SVC, TG_SVC, HR_SVC, DEVINFO];
  var SILENCE_MS = 60000;

  function errStr(e) { if (!e) return 'unknown error'; return (e.name ? e.name + ': ' : '') + (e.message || String(e)); }
  function ts() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }

  function create() {
    var h = null, agg = null, bt = global.navigator.bluetooth;
    var st = { transport: 'webbluetooth', phase: 'needgesture', text: 'Tap "Connect rower" to pair the rower', error: null, device: null,
      log: [], counts: { rower: 0, force: 0, stroke: 0, hr: 0 }, lastHex: '', lastParsed: null, lastAt: 0, attempts: 0,
      hrPhase: 'off', hrDevice: null, canConnect: true, canHr: true };
    var status = { connected: false, device: null, hr_connected: false, hr_device: null };
    var rower = { dev: null, gen: 0, backoff: 1000, timer: null, chars: [], poll: null };
    var hr = { dev: null, gen: 0, backoff: 2000, timer: null, chars: [] };

    function push() { try { if (global.SkillRowTVUI && global.SkillRowTVUI.linkState) global.SkillRowTVUI.linkState(st); } catch (e) { /* ignore */ } }
    function log(msg) { st.log.push(ts() + '  ' + msg); if (st.log.length > 120) st.log.splice(0, st.log.length - 120); try { console.log('[WebBT] ' + msg); } catch (e) { /* ignore */ } push(); }
    function phase(p, text, isErr) { st.phase = p; st.text = text; if (isErr) st.error = text; log((isErr ? 'ERROR ' : '') + text); }
    function sendStatus() { if (h) h.message({ type: 'status', data: { connected: status.connected, device: status.device, hr_connected: status.hr_connected, hr_device: status.hr_device } }); }

    function sub(list, svc, uuid, cb, label, optional) {
      return svc.getCharacteristic(uuid).then(function (ch) {
        var fn = function (ev) { try { cb(ev.target.value); } catch (e) { log('ERROR ' + label + ' handler: ' + errStr(e)); } };
        ch.addEventListener('characteristicvaluechanged', fn);
        list.push({ ch: ch, fn: fn });
        return ch.startNotifications().then(function () { log('subscribed ' + label); return true; });
      }).catch(function (e) { if (!optional) throw e; log(label + ' unavailable: ' + errStr(e)); return false; });
    }
    function unsub(list) {
      while (list.length) { var s = list.pop(); try { s.ch.removeEventListener('characteristicvaluechanged', s.fn); } catch (e) { /* ignore */ } }
    }

    // ------------------------------------------------------------ rower
    function attachRower(dev) {
      if (rower.dev && rower.dev !== dev) { try { rower.dev.removeEventListener('gattserverdisconnected', onRowerDisc); } catch (e) { /* ignore */ } try { rower.dev.gatt.disconnect(); } catch (e) { /* ignore */ } }
      rower.dev = dev; rower.backoff = 1000;
      st.device = dev.name || 'Rower';
      dev.removeEventListener('gattserverdisconnected', onRowerDisc);
      dev.addEventListener('gattserverdisconnected', onRowerDisc);
      connectRowerGatt();
    }
    function connectRowerGatt() {
      clearTimeout(rower.timer);
      var dev = rower.dev; if (!dev) return;
      var g = ++rower.gen;
      st.attempts++;
      phase('connecting', 'Connecting to ' + st.device + '…');
      unsub(rower.chars);
      var timeout = new Promise(function (res, rej) { setTimeout(function () { rej(new Error('connect timed out (20 s)')); }, 20000); });
      Promise.race([dev.gatt.connect(), timeout]).then(function (server) {
        if (g !== rower.gen) return null;
        log('GATT connected, getting services');
        return server.getPrimaryService(FTMS_SVC).then(function (svc) {
          return sub(rower.chars, svc, ROWER_DATA, function (v) {
            if (g !== rower.gen) return;
            var b = F.toBytes(v);
            st.counts.rower++; st.lastAt = Date.now(); st.lastHex = F.hex(b);
            st.lastParsed = agg.onRower(b);
            if (st.counts.rower % 5 === 1) push();
          }, 'rower data 2AD1', false);
        }).then(function () {
          return server.getPrimaryService(TG_SVC).then(function (svc) {
            return sub(rower.chars, svc, TG_FORCE, function (v) { if (g === rower.gen) { st.counts.force++; agg.onForce(F.toBytes(v)); } }, 'force curve', true)
              .then(function () { return sub(rower.chars, svc, TG_STROKE, function (v) { if (g === rower.gen) { st.counts.stroke++; agg.onStroke(F.toBytes(v)); } }, 'end of stroke', true); });
          }).catch(function (e) { log('no Technogym force service: ' + errStr(e)); });
        }).then(function () {
          if (g !== rower.gen) return;
          rower.backoff = 1000; st.error = null; st.lastAt = Date.now();
          status.connected = true; status.device = st.device; sendStatus();
          phase('streaming', 'Connected: ' + st.device);
          clearInterval(rower.poll);
          rower.poll = setInterval(function () {
            if (g !== rower.gen) { clearInterval(rower.poll); return; }
            if (Date.now() - st.lastAt > SILENCE_MS) { log('no data for 60 s, reconnecting'); try { dev.gatt.disconnect(); } catch (e) { /* ignore */ } onRowerDisc(); }
          }, 5000);
        });
      }).catch(function (e) {
        if (g !== rower.gen) return;
        try { dev.gatt.disconnect(); } catch (e2) { /* ignore */ }
        retryRower('Connect failed: ' + errStr(e));
      });
    }
    function retryRower(why) {
      status.connected = false; sendStatus();
      var wait = rower.backoff; rower.backoff = Math.min(rower.backoff * 2, 15000);
      phase('reconnecting', why + '. Retrying in ' + Math.round(wait / 1000) + ' s… (is the rower on?)', true);
      clearTimeout(rower.timer);
      rower.timer = setTimeout(connectRowerGatt, wait);
    }
    function onRowerDisc() {
      rower.gen++;   // invalidate callbacks of the old connection
      clearInterval(rower.poll); unsub(rower.chars);
      if (!rower.dev) return;
      retryRower('Rower disconnected');
    }

    function connectRower(all) {   // must run inside a user gesture (click/tap)
      if (!bt || !bt.requestDevice) { phase('error', 'This browser has no Web Bluetooth (use Chrome, Edge or Bluefy on iOS)', true); return Promise.resolve(null); }
      var opts = all ? { acceptAllDevices: true, optionalServices: OPTIONAL }
        : { filters: [{ services: [FTMS_SVC] }, { namePrefix: 'Rower' }], optionalServices: OPTIONAL };
      log('requestDevice ' + (all ? '(all devices)' : '(FTMS / "Rower")'));
      return bt.requestDevice(opts).then(function (dev) {
        log('picked ' + (dev.name || '?') + ' ' + (dev.id || ''));
        attachRower(dev); return dev;
      }).catch(function (e) {
        if (e && e.name === 'NotFoundError') phase(status.connected ? st.phase : 'needgesture', 'No device chosen (' + (e.message || 'cancelled') + ')');
        else phase('error', 'requestDevice: ' + errStr(e), true);
        return null;
      });
    }

    function tryRemembered() {
      if (!bt || typeof bt.getDevices !== 'function') { log('getDevices() not supported: tap Connect rower'); return; }
      bt.getDevices().then(function (list) {
        list = list || [];
        log('getDevices: ' + list.length + ' permitted device(s)');
        var r = null, hrd = null;
        list.forEach(function (d) { var n = (d.name || '').toLowerCase(); if (!r && n.indexOf('rower') === 0) r = d; else if (!hrd && /whoop|polar|hrm|heart|tickr|wahoo|garmin/.test(n)) hrd = d; });
        if (r && !rower.dev) attachRower(r);
        if (hrd && !hr.dev && st.hrRemember) attachHr(hrd);
      }).catch(function (e) { log('getDevices failed: ' + errStr(e)); });
    }

    // ------------------------------------------------------------ heart rate
    function attachHr(dev) {
      if (hr.dev && hr.dev !== dev) { try { hr.dev.gatt.disconnect(); } catch (e) { /* ignore */ } }
      hr.dev = dev; hr.backoff = 2000; st.hrDevice = dev.name || 'HR';
      dev.removeEventListener('gattserverdisconnected', onHrDisc);
      dev.addEventListener('gattserverdisconnected', onHrDisc);
      connectHrGatt();
    }
    function connectHrGatt() {
      clearTimeout(hr.timer);
      var dev = hr.dev; if (!dev) return;
      var g = ++hr.gen;
      st.hrPhase = 'connecting'; push();
      unsub(hr.chars);
      dev.gatt.connect().then(function (server) { return server.getPrimaryService(HR_SVC); }).then(function (svc) {
        return sub(hr.chars, svc, HR_MEAS, function (v) {
          if (g !== hr.gen) return;
          var bpm = F.parseHr(F.toBytes(v)); st.counts.hr++;
          if (bpm) agg.onHr(bpm);
        }, 'heart rate 2A37', false);
      }).then(function () {
        if (g !== hr.gen) return;
        hr.backoff = 2000; st.hrPhase = 'streaming';
        status.hr_connected = true; status.hr_device = st.hrDevice; sendStatus(); push();
      }).catch(function (e) {
        if (g !== hr.gen) return;
        log('HR connect failed: ' + errStr(e));
        onHrDisc();
      });
    }
    function onHrDisc() {
      hr.gen++; unsub(hr.chars);
      if (status.hr_connected) { status.hr_connected = false; status.hr_device = null; sendStatus(); agg.onHr(null); }
      if (!hr.dev) return;
      var wait = hr.backoff; hr.backoff = Math.min(hr.backoff * 2, 30000);
      st.hrPhase = 'reconnecting in ' + Math.round(wait / 1000) + ' s'; push();
      clearTimeout(hr.timer); hr.timer = setTimeout(connectHrGatt, wait);
    }
    function connectHr() {
      if (!bt || !bt.requestDevice) return Promise.resolve(null);
      log('requestDevice (heart rate 180D)');
      return bt.requestDevice({ filters: [{ services: [HR_SVC] }], optionalServices: [HR_SVC, DEVINFO] }).then(function (dev) {
        log('HR picked ' + (dev.name || '?')); attachHr(dev); return dev;
      }).catch(function (e) { log('HR requestDevice: ' + errStr(e)); return null; });
    }

    var api = {
      name: 'webbluetooth',
      start: function (handlers) {
        h = handlers;
        agg = F.createAggregator(function (m) { if (h) h.message(m); });
        h.open(true);
        sendStatus();
        if (bt && bt.getAvailability) bt.getAvailability().then(function (ok) { if (!ok) phase('off', 'Bluetooth is not available or turned off on this device', true); }).catch(function () { /* ignore */ });
        push();
        tryRemembered();
      },
      connectRower: connectRower,
      connectHr: connectHr,
      rescan: function () { return connectRower(false); },
      disconnect: function () {
        var d = rower.dev; rower.dev = null; rower.gen++; clearTimeout(rower.timer); clearInterval(rower.poll); unsub(rower.chars);
        if (d) { try { d.gatt.disconnect(); } catch (e) { /* ignore */ } }
        status.connected = false; sendStatus(); phase('needgesture', 'Disconnected. Tap "Connect rower"');
      },
      disconnectHr: function () {
        var d = hr.dev; hr.dev = null; hr.gen++; clearTimeout(hr.timer); unsub(hr.chars);
        if (d) { try { d.gatt.disconnect(); } catch (e) { /* ignore */ } }
        if (status.hr_connected) { status.hr_connected = false; status.hr_device = null; sendStatus(); agg.onHr(null); }
        st.hrPhase = 'off'; push();
      },
      state: function () { return st; }
    };
    return api;
  }

  global.SkillRowWebBLE = { create: create };
})(window);

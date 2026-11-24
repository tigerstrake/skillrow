/* Native transport: the SkillRow iOS app (ios/ in the repo) does Bluetooth in CoreBluetooth and forwards raw packets.
 * Selected by transport.js only when window.webkit.messageHandlers.skillrow exists (i.e. inside the app), so
 * browsers / Bluefy are unaffected. ES2017-safe.
 *
 * Native -> JS:  SkillRowNative.onPacket('2ad1' | '6e408f0b' | '6e403e57' | '2a37', [bytes])   (or onPacket({char, bytes}))
 *                SkillRowNative.onState({bt, phase, text, connected, device, deviceId, hrEnabled, hrPhase, hrConnected,
 *                                        hrDevice, deviceInfo, seen:[{id,name,rssi,kind}], log:[..], keepAwake})
 * JS -> native:  webkit.messageHandlers.skillrow.postMessage({cmd: 'ready' | 'rescan' | 'forget' | 'forgetHr' |
 *                                                                  'hr', on} | {cmd: 'keepAwake', on})
 * The phone connects by itself (remembered rower, pending connect that completes when the rower powers on), so
 * there is no "Connect" button: the UI shows "Waiting for rower — turn it on" until data flows.
 * Packets are parsed here with ftms.js, so the messages to app.js are identical to every other transport. */
(function (global) {
  'use strict';
  var F = global.SkillRowFTMS;

  function handler() {
    try { return (global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.skillrow) || null; } catch (e) { return null; }
  }
  function available() { return !!handler(); }
  function post(m) { var hd = handler(); if (hd) { try { hd.postMessage(m); } catch (e) { /* ignore */ } } }

  function create() {
    var h = null, agg = null;
    var st = { transport: 'native', phase: 'init', text: 'Starting Bluetooth…', error: null, device: null, address: null,
      log: [], counts: { rower: 0, force: 0, stroke: 0, hr: 0 }, lastHex: '', lastParsed: null, lastAt: 0,
      hrEnabled: true, hrPhase: 'off', hrDevice: null, found: null, foundCount: 0, bt: 'unknown' };
    var status = { connected: false, device: null, hr_connected: false, hr_device: null };
    var pushT = 0;

    function push() { try { if (global.SkillRowTVUI && global.SkillRowTVUI.linkState) global.SkillRowTVUI.linkState(st); } catch (e) { /* ignore */ } }
    function sendStatus() { if (h) h.message({ type: 'status', data: { connected: status.connected, device: status.device, hr_connected: status.hr_connected, hr_device: status.hr_device } }); }

    function onPacket(ch, bytes) {
      if (ch && typeof ch === 'object') { bytes = ch.bytes; ch = ch.char; }
      if (!agg) return;
      var b = F.toBytes(bytes || []);
      switch (String(ch).toLowerCase()) {
        case '2ad1':
          st.counts.rower++; st.lastAt = Date.now(); st.lastHex = F.hex(b);
          st.lastParsed = agg.onRower(b);
          if (!status.connected) { status.connected = true; status.device = st.device; sendStatus(); }
          if (Date.now() - pushT > 1000) { pushT = Date.now(); push(); }
          break;
        case '6e408f0b': st.counts.force++; agg.onForce(b); break;
        case '6e403e57': st.counts.stroke++; agg.onStroke(b); break;
        case '2a37': { st.counts.hr++; var bpm = F.parseHr(b); if (bpm) agg.onHr(bpm); break; }
        default: break;
      }
    }

    function onState(s) {
      if (!s) return;
      st.bt = s.bt || st.bt;
      st.phase = s.phase || st.phase;
      st.text = s.text || st.text;
      st.error = (st.phase === 'off' || st.phase === 'unauthorized' || st.phase === 'unsupported') ? st.text : null;
      st.device = s.device || null;
      st.address = s.deviceId ? String(s.deviceId).slice(0, 8) : null;
      st.deviceInfo = s.deviceInfo || null;
      st.log = s.log || [];
      st.hrEnabled = s.hrEnabled !== false;
      st.hrPhase = st.hrEnabled ? (s.hrPhase || 'searching') : 'off';
      st.hrDevice = s.hrDevice || null;
      st.keepAwake = s.keepAwake !== false;
      var found = {}, n = 0;
      (s.seen || []).forEach(function (d) { found[d.id] = { name: d.name, address: String(d.id).slice(0, 8), rssi: d.rssi, uuids: d.kind }; n++; });
      st.found = n ? found : null; st.foundCount = n;

      var connected = !!s.connected, hrc = !!s.hrConnected;
      var changed = connected !== status.connected || (st.device || null) !== status.device || hrc !== status.hr_connected || (hrc ? st.hrDevice : null) !== status.hr_device;
      if (status.hr_connected && !hrc && agg) agg.onHr(null);
      status.connected = connected; status.device = st.device; status.hr_connected = hrc; status.hr_device = hrc ? st.hrDevice : null;
      if (changed) sendStatus();
      push();
    }

    var api = {
      name: 'native',
      start: function (handlers) {
        h = handlers;
        agg = F.createAggregator(function (m) { if (h) h.message(m); });
        global.SkillRowNative = { onPacket: onPacket, onState: onState };
        h.open(true);
        sendStatus();
        push();
        post({ cmd: 'ready' });
      },
      rescan: function () { post({ cmd: 'rescan' }); },          // forget the remembered rower and adopt the next one found
      forget: function () { post({ cmd: 'forget' }); },
      forgetHr: function () { post({ cmd: 'forgetHr' }); },
      setHr: function (on) { st.hrEnabled = !!on; post({ cmd: 'hr', on: !!on }); push(); },
      keepAwake: function (on) { post({ cmd: 'keepAwake', on: !!on }); },
      state: function () { return st; }
    };
    return api;
  }

  global.SkillRowNativeBLE = { create: create, available: available };
})(window);

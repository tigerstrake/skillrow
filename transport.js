/* Transport selection. ES5. Override with ?transport=native|tizen|webbluetooth|ws|fake.
 *   ?fake=1 (or ?transport=fake)     -> fake rower that generates real FTMS byte packets (tests the parser path)
 *   webkit.messageHandlers.skillrow  -> SkillRow iOS app, CoreBluetooth in Swift (transport-native.js); only inside the app
 *   window.tizen && tizen.bluetooth  -> Tizen BLE (transport-tizen.js)
 *   navigator.bluetooth              -> Web Bluetooth (transport-webbluetooth.js; Chrome, Edge, Bluefy on iOS)
 *   otherwise                        -> WebSocket to the Python bridge: ?ws=host:port, default location.host,
 *                                       or localhost:8765 when served by the static test server (port 8790)
 * Every transport: start({open(bool), message(msg)}) and feeds the same JSON messages as the bridge.
 * Link state for the on-screen pill/panel goes to window.SkillRowTVUI.linkState(state) when present. */
(function (global) {
  'use strict';
  var F = global.SkillRowFTMS;

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(global.location ? global.location.search : '');
    return m ? decodeURIComponent(m[1]) : null;
  }
  function ui(st) { try { if (global.SkillRowTVUI && global.SkillRowTVUI.linkState) global.SkillRowTVUI.linkState(st); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------------ WebSocket (bridge)
  function WsTransport() {
    var h, ws = null, timer = null, backoff = 500, st = { transport: 'websocket', phase: 'connecting', text: 'Connecting to bridge…', log: [] };
    function url() {
      var host = qs('ws');
      if (!host) host = global.location.port === '8790' ? 'localhost:8765' : global.location.host;
      return (global.location.protocol === 'https:' ? 'wss://' : 'ws://') + host + '/ws';
    }
    function set(phase, text) { st.phase = phase; st.text = text; st.url = url(); ui(st); }
    function connect() {
      clearTimeout(timer);
      try { ws = new WebSocket(url()); } catch (e) { set('error', 'WebSocket: ' + e.message); timer = setTimeout(connect, backoff); return; }
      ws.onopen = function () { backoff = 500; h.open(true); set('bridge', 'Bridge connected (' + url() + ')'); };
      ws.onclose = function () {
        h.open(false); set('error', 'Bridge disconnected, retrying… (' + url() + ')');
        timer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 5000);
      };
      ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.type === 'status' && m.data) {
          st.device = m.data.device; st.rowerConnected = !!m.data.connected;
          set(m.data.connected ? 'streaming' : 'scanning', m.data.connected ? 'Rower via bridge: ' + (m.data.device || '') : 'Bridge: searching for rower');
        }
        h.message(m);
      };
    }
    this.name = 'websocket';
    this.start = function (handlers) { h = handlers; set('connecting', 'Connecting to ' + url()); connect(); };
    this.state = function () { return st; };
  }

  // ------------------------------------------------------------------ fake rower
  function FakeTransport() {
    var h, agg, st = { transport: 'fake', phase: 'streaming', text: 'Fake rower (?fake=1)', counts: { rower: 0, force: 0, stroke: 0 }, log: [] };
    var t0, dist = 0, strokes = 0, last, nextStroke, curve = null, seq = 0, cal = 0, tick = 0;
    var paceBase = +(qs('pace') || 125), speed = +(qs('speed') || 1);
    function step() {
      var now = Date.now() / 1000, dtw = (now - last) * speed, el = (now - t0) * speed;
      last = now; tick++;
      var pace = paceBase + 8 * Math.sin(el / 30) + (Math.random() * 4 - 2);
      dist += dtw * 500 / pace; cal += dtw * 0.18;
      var power = Math.round(2.8 * Math.pow(500 / pace, 3));
      var m = { distance: dist, pace: pace, avgPace: el > 1 ? 500 * el / Math.max(dist, 1) : 0, power: power, avgPower: power,
        resistance: 5, met: 8.0, elapsed: el, strokeRate: 26, strokeCount: strokes, avgStrokeRate: 26, calories: cal };
      // real machine alternates two packet layouts
      agg.onRower(tick % 2 ? F.encodeRowerA(m) : F.encodeRowerB(m)); st.counts.rower++;
      if (el >= nextStroke && !curve) { curve = []; seq = 0; for (var k = 0; k < 40; k++) curve.push(Math.round(80 * Math.pow(Math.sin(Math.PI * k / 40), 1.5)) + Math.floor(Math.random() * 4)); }
      if (curve) {
        var pkt = [seq].concat(curve.slice(seq * 10, seq * 10 + 10));
        agg.onForce(pkt); st.counts.force++; seq++;
        if (seq * 10 >= curve.length) { agg.onStroke([1]); st.counts.stroke++; strokes++; curve = null; nextStroke = el + 60 / 26; }
      }
      st.lastHex = F.hex(tick % 2 ? F.encodeRowerA(m) : F.encodeRowerB(m)); st.lastAt = Date.now();
      if (tick % 8 === 0) ui(st);
    }
    this.name = 'fake';
    this.start = function (handlers) {
      h = handlers; agg = F.createAggregator(function (msg) { h.message(msg); });
      t0 = last = Date.now() / 1000; nextStroke = 1;
      h.open(true);
      h.message({ type: 'status', data: { connected: true, device: 'Fake Rower', hr_connected: false, hr_device: null } });
      ui(st);
      setInterval(step, 250);
    };
    this.state = function () { return st; };
  }

  function select() {
    var want = qs('transport') || (qs('fake') === '1' ? 'fake' : null);
    var tr, tizenBt = false, webBt = false, nativeBt = false;
    try { nativeBt = !!(global.SkillRowNativeBLE && global.SkillRowNativeBLE.available()); } catch (e) { nativeBt = false; }
    try { tizenBt = typeof global.tizen !== 'undefined' && !!global.tizen.bluetooth; } catch (e) { tizenBt = false; }
    try { webBt = !!(global.navigator && global.navigator.bluetooth); } catch (e) { webBt = false; }
    if (want === 'fake') tr = new FakeTransport();
    else if (want === 'ws') tr = new WsTransport();
    else if ((want === 'native' || !want) && nativeBt) tr = global.SkillRowNativeBLE.create();
    else if ((want === 'tizen' || (!want && tizenBt)) && global.SkillRowTizenBLE) tr = global.SkillRowTizenBLE.create();
    else if ((want === 'webbluetooth' || (!want && webBt)) && global.SkillRowWebBLE) tr = global.SkillRowWebBLE.create();
    else tr = new WsTransport();
    api.current = tr;
    return tr;
  }

  var api = { select: select, current: null, qs: qs };
  global.SkillRowTransport = api;
})(window);

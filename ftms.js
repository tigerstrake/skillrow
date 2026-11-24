/* SkillRow FTMS / Technogym protocol (port of backend/server.py parse_rower, on_metrics and force-curve handling).
 * ES5 only (runs on old Tizen Chromium). Exposes window.SkillRowFTMS (also works under JXA / plain JS engines).
 *
 *   SkillRowFTMS.parseRower(bytes)  -> {strokeRate, strokeCount, distance, pace, ...}   (FTMS 0x2AD1)
 *   SkillRowFTMS.parseHr(bytes)     -> bpm                                              (0x2A37)
 *   SkillRowFTMS.createAggregator(emit) -> {onRower(bytes), onForce(bytes), onStroke(bytes), onHr(bpm), reset(), metrics}
 *     emit(msg) receives the same JSON messages the Python bridge sends over /ws:
 *       {type:'metrics', t, data}, {type:'forceLive', data:[..]}, {type:'forceCurve', data:[..]}, {type:'stroke', t}, {type:'hr', data}
 *   SkillRowFTMS.toBytes(v)  normalizes Tizen byte[] (may be signed, -128..127), Uint8Array, DataView, hex string -> plain 0..255 array
 *   SkillRowFTMS.hex(bytes)
 */
(function (global) {
  'use strict';

  function toBytes(v) {
    var out = [], i;
    if (v == null) return out;
    if (typeof v === 'string') {
      var s = v.replace(/[^0-9a-fA-F]/g, '');
      for (i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
      return out;
    }
    if (typeof DataView !== 'undefined' && v instanceof DataView) {
      for (i = 0; i < v.byteLength; i++) out.push(v.getUint8(i));
      return out;
    }
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) v = new Uint8Array(v);
    var n = v.length >>> 0;
    for (i = 0; i < n; i++) out.push((+v[i]) & 0xff);
    return out;
  }

  function hex(b) {
    var s = '', i, x;
    b = b || [];
    for (i = 0; i < b.length; i++) { x = (b[i] & 0xff).toString(16); s += (x.length < 2 ? '0' : '') + x; }
    return s;
  }

  // FTMS Rower Data (0x2AD1). Technogym also uses flag bit13 = elapsed time in 0.1 s (uint32 LE).
  function parseRower(raw) {
    var d = toBytes(raw), m = {};
    if (d.length < 2) return m;
    var flags = d[0] | (d[1] << 8), i = 2;
    function need(n) { if (i + n > d.length) throw new RangeError('short'); }
    function u8() { need(1); return d[i++]; }
    function u16() { need(2); var v = d[i] | (d[i + 1] << 8); i += 2; return v; }
    function s16() { var v = u16(); return v >= 0x8000 ? v - 0x10000 : v; }
    function u24() { need(3); var v = d[i] | (d[i + 1] << 8) | (d[i + 2] << 16); i += 3; return v; }
    function u32() { need(4); var v = (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)) + d[i + 3] * 16777216; i += 4; return v; }
    try {
      if (!(flags & 1)) { m.strokeRate = u8() / 2; m.strokeCount = u16(); }
      if (flags & (1 << 1)) m.avgStrokeRate = u8() / 2;
      if (flags & (1 << 2)) m.distance = u24();
      if (flags & (1 << 3)) { var p = u16(); m.pace = p ? p : null; }          // s / 500 m
      if (flags & (1 << 4)) { var ap = u16(); m.avgPace = ap ? ap : null; }
      if (flags & (1 << 5)) m.power = s16();
      if (flags & (1 << 6)) m.avgPower = s16();
      if (flags & (1 << 7)) m.resistance = s16();
      if (flags & (1 << 8)) {
        var e = u16(), eh = u16(), em = u8();
        if (e !== 0xffff) m.calories = e;
        if (eh !== 0xffff) m.caloriesPerHour = eh;
        if (em !== 0xff) m.caloriesPerMin = em;
      }
      if (flags & (1 << 9)) m.heartRateMachine = u8();
      if (flags & (1 << 10)) m.met = u8() / 10;
      if (flags & (1 << 11)) m.elapsed = u16();
      if (flags & (1 << 12)) m.remaining = u16();
      if ((flags & (1 << 13)) && d.length >= i + 4) m.elapsedPrecise = u32() / 10;
    } catch (err) { /* truncated packet: keep what we have (same as the Python IndexError path) */ }
    return m;
  }

  function parseHr(raw) {
    var d = toBytes(raw);
    if (d.length < 2) return null;
    if (d[0] & 1) return d.length >= 3 ? (d[1] | (d[2] << 8)) : null;
    return d[1];
  }

  function nowS() { return Date.now() / 1000; }

  function createAggregator(emit) {
    var metrics = {}, curve = [];
    function send(m) { try { emit(m); } catch (e) { if (global.console) console.error('emit', e); } }
    function copy(o) { var r = {}, k; for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }

    function emitCurve() {
      if (curve.length) { send({ type: 'forceCurve', data: curve.slice() }); curve = []; }
    }
    var agg = {
      metrics: metrics,
      onMetrics: function (m) {           // merge like server.py on_metrics
        var prevPrecise = metrics.elapsedPrecise, k;
        for (k in m) if (Object.prototype.hasOwnProperty.call(m, k)) metrics[k] = m[k];
        if ('elapsedPrecise' in m) metrics.elapsed = m.elapsedPrecise;
        else if ('elapsed' in m && prevPrecise != null && Math.abs(m.elapsed - prevPrecise) < 2) metrics.elapsed = Math.max(prevPrecise, m.elapsed);
        if (metrics.heartRate == null && m.heartRateMachine) metrics.heartRate = m.heartRateMachine;
        send({ type: 'metrics', t: nowS(), data: copy(metrics) });
        return metrics;
      },
      onRower: function (raw) { return agg.onMetrics(parseRower(raw)); },
      onForce: function (raw) {          // [seq][~10 samples]; seq 0 = new stroke
        var d = toBytes(raw);
        if (!d.length) return;
        if (d[0] === 0 && curve.length) emitCurve();
        for (var i = 1; i < d.length; i++) curve.push(d[i]);
        send({ type: 'forceLive', data: curve.slice() });
      },
      onStroke: function () {            // 1 byte at end of stroke
        emitCurve();
        send({ type: 'stroke', t: nowS() });
      },
      onHr: function (bpm) {
        if (bpm == null) { metrics.heartRate = null; return; }
        metrics.heartRate = bpm;
        send({ type: 'hr', data: bpm });
      },
      reset: function () {
        var k; for (k in metrics) if (Object.prototype.hasOwnProperty.call(metrics, k)) delete metrics[k];
        curve = [];
      }
    };
    return agg;
  }

  // Encoder (used by the fake transport and tests): builds Technogym-style packets.
  function u16le(a, v) { v = Math.round(v) & 0xffff; a.push(v & 0xff, v >> 8); }
  function encodeRowerA(m) {   // flags 0x0cfd like the real machine
    var a = [0xfd, 0x0c], d = Math.round(m.distance || 0);
    a.push(d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff);
    u16le(a, m.pace || 0); u16le(a, m.avgPace || 0); u16le(a, m.power || 0); u16le(a, m.avgPower || 0);
    u16le(a, m.resistance || 0); a.push(Math.round((m.met || 0) * 10) & 0xff); u16le(a, Math.floor(m.elapsed || 0));
    return a;
  }
  function encodeRowerB(m) {   // flags 0x2102: stroke rate/count, avg rate, energy, precise elapsed
    var a = [0x02, 0x21];
    a.push(Math.round((m.strokeRate || 0) * 2) & 0xff); u16le(a, m.strokeCount || 0);
    a.push(Math.round((m.avgStrokeRate || 0) * 2) & 0xff);
    u16le(a, m.calories || 0); u16le(a, 0xffff); a.push(0xff);
    var e = Math.round((m.elapsed || 0) * 10);
    a.push(e & 0xff, (e >> 8) & 0xff, (e >> 16) & 0xff, (e >>> 24) & 0xff);
    return a;
  }

  global.SkillRowFTMS = { parseRower: parseRower, parseHr: parseHr, createAggregator: createAggregator,
    toBytes: toBytes, hex: hex, encodeRowerA: encodeRowerA, encodeRowerB: encodeRowerB };
})(typeof window !== 'undefined' ? window : this);

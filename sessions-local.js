/* Local replacement for the bridge's /api/sessions REST API (list/get/save/delete) backed by localStorage.
 * ES5. window.SkillRowSessions.fetch(url, opts) mimics window.fetch for those URLs so app.js stays unchanged.
 * Layout: skillrow.sessIdx = [summary rows, newest first], skillrow.sess.<id> = full session JSON.
 * Samples are downsampled to <= MAX_SAMPLES so each session stays ~50-100 KB. On quota errors the oldest
 * sessions first lose their samples, then are deleted. */
(function (global) {
  'use strict';
  var IDX = 'skillrow.sessIdx', PFX = 'skillrow.sess.', MAX_SAMPLES = 900, MAX_SESSIONS = 300;
  var ls = null;
  try { ls = global.localStorage; ls.setItem('skillrow.__t', '1'); ls.removeItem('skillrow.__t'); } catch (e) { ls = null; }
  var mem = {};   // fallback if localStorage is unavailable (sessions then only live until the app closes)
  function getRaw(k) { return ls ? ls.getItem(k) : (k in mem ? mem[k] : null); }
  function setRaw(k, v) { if (ls) ls.setItem(k, v); else mem[k] = v; }
  function delRaw(k) { if (ls) ls.removeItem(k); else delete mem[k]; }
  function getJ(k, d) { try { var v = getRaw(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }

  function index() { var a = getJ(IDX, []); return Array.isArray(a) ? a : []; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function newId(ts) {
    var d = new Date(ts || Date.now());
    var base = 'session-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    var id = base, k = 2;
    while (getRaw(PFX + id) != null) { id = base + '-' + k; k++; }
    return id;
  }
  function r1(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : v; }
  function downsample(samples) {
    if (!Array.isArray(samples)) return [];
    var out = [], n = samples.length, i;
    if (n <= MAX_SAMPLES) out = samples.slice();
    else {
      var t0 = samples[0].t || 0, t1 = samples[n - 1].t || 0, step = (t1 - t0) / (MAX_SAMPLES - 1), next = t0;
      for (i = 0; i < n; i++) {
        if (i === n - 1 || (samples[i].t || 0) >= next) { out.push(samples[i]); next = (samples[i].t || 0) + step; }
      }
    }
    return out.map(function (s) {
      return { t: r1(s.t), distance: r1(s.distance), pace: r1(s.pace), power: s.power, spm: r1(s.spm), hr: s.hr };
    });
  }
  function summaryRow(id, j) {
    var o = {}, k;
    for (k in j) if (Object.prototype.hasOwnProperty.call(j, k) && k !== 'samples' && k !== 'forceCurves' && k !== 'curves' && k !== 'machine') o[k] = j[k];
    o.id = id;
    return o;
  }
  function trySet(k, v) {
    for (var attempt = 0; attempt < 40; attempt++) {
      try { setRaw(k, v); return true; } catch (e) {
        if (!evictOne(k)) throw e;
      }
    }
    return false;
  }
  function evictOne(keep) {   // oldest first: drop samples, then the whole session
    var idx = index(), i, j;
    for (i = idx.length - 1; i >= 0; i--) {
      var key = PFX + idx[i].id;
      if (key === keep) continue;
      j = getJ(key, null);
      if (j && j.samples && j.samples.length) { j.samples = []; j.samplesDropped = true; try { setRaw(key, JSON.stringify(j)); return true; } catch (e) { /* fall through */ } }
    }
    for (i = idx.length - 1; i >= 0; i--) {
      if (PFX + idx[i].id === keep) continue;
      delRaw(PFX + idx[i].id); idx.splice(i, 1);
      try { setRaw(IDX, JSON.stringify(idx)); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  var api = {
    list: function () { return index(); },
    get: function (id) { var j = getJ(PFX + id, null); if (j) j.id = id; return j; },
    save: function (j) {
      if (!j || typeof j !== 'object') throw new Error('bad session');
      j.source = j.source || 'app';
      j.samples = downsample(j.samples);
      var id = newId(Date.parse(j.startedAt) || Date.now());
      trySet(PFX + id, JSON.stringify(j));
      var idx = index().filter(function (r) { return r.id !== id; });
      idx.unshift(summaryRow(id, j));
      idx.sort(function (a, b) { return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0); });
      while (idx.length > MAX_SESSIONS) { var old = idx.pop(); delRaw(PFX + old.id); }
      trySet(IDX, JSON.stringify(idx));
      return id;
    },
    remove: function (id) {
      delRaw(PFX + id);
      var idx = index().filter(function (r) { return r.id !== id; });
      trySet(IDX, JSON.stringify(idx));
      return true;
    },
    usage: function () {
      var n = 0, k, i;
      try { if (ls) for (i = 0; i < ls.length; i++) { k = ls.key(i); n += k.length + (ls.getItem(k) || '').length; } } catch (e) { /* ignore */ }
      return { sessions: index().length, chars: n, persistent: !!ls };
    },
    // fetch() lookalike for app.js
    fetch: function (url, opts) {
      opts = opts || {};
      var method = String(opts.method || 'GET').toUpperCase();
      var path = String(url).replace(/^[a-z]+:\/\/[^\/]+/i, '').split('?')[0];
      function resp(status, data) {
        return Promise.resolve({ ok: status >= 200 && status < 300, status: status,
          json: function () { return Promise.resolve(data); }, text: function () { return Promise.resolve(JSON.stringify(data)); } });
      }
      try {
        var m = path.match(/^\/api\/sessions\/?([^\/]*)$/);
        if (!m) return resp(404, { error: 'not found' });
        var id = m[1] ? decodeURIComponent(m[1]) : '';
        if (!id && method === 'GET') return resp(200, api.list());
        if (!id && method === 'POST') return resp(200, { id: api.save(typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) });
        if (id && method === 'GET') { var j = api.get(id); return j ? resp(200, j) : resp(404, { error: 'not found' }); }
        if (id && method === 'DELETE') { api.remove(id); return resp(200, { ok: true, id: id }); }
        return resp(405, { error: 'method' });
      } catch (e) {
        return Promise.reject(e);
      }
    }
  };
  global.SkillRowSessions = api;
})(window);

/* SkillRow frontend: live dashboard, workouts, history, race integration. Vanilla JS, no build.
 * TV copy of web/app.js. Changes (marked 'TV:'): pluggable transport (transport.js), sessions API via
 * SkillRowSessions.fetch (localStorage), in-app confirm dialog. Keep the rest in sync with web/app.js. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- utils
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtPace(s, tenths) {
    s = num(s);
    if (s == null || s <= 0 || s > 3599) return '--:--';
    if (tenths === false) { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
    s = Math.round(s * 10) / 10;
    const m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }
  function fmtTime(s, tenths) {
    s = num(s);
    if (s == null) return '--:--';
    const neg = s < 0; s = Math.abs(s);
    if (!tenths) s = Math.floor(s + 1e-6);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const ss = tenths ? (sec < 10 ? '0' : '') + sec.toFixed(1) : String(Math.floor(sec)).padStart(2, '0');
    return (neg ? '-' : '') + (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + ss;
  }
  function fmtDelta(s) { // signed seconds, + = slower/behind
    if (num(s) == null) return '';
    const sign = s > 0.05 ? '+' : s < -0.05 ? '−' : '±';
    const a = Math.abs(s);
    return sign + (a >= 60 ? fmtTime(a) : a.toFixed(1));
  }
  function parseTime(str) { // "2:05", "2:05.3", "125", "1:02:03"
    if (str == null) return null;
    str = String(str).trim();
    if (!str) return null;
    const parts = str.split(':').map(Number);
    if (parts.some((p) => !isFinite(p) || p < 0)) return null;
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s > 0 ? s : null;
  }
  // TV: sessions API goes through SkillRowSessions (localStorage) when present
  const apiFetch = (u, o) => (window.SkillRowSessions && window.SkillRowSessions.fetch ? window.SkillRowSessions.fetch(u, o) : fetch(u, o));
  const fmtInt = (v) => (num(v) == null ? '--' : Math.round(v).toLocaleString('en-US'));

  const store = {
    get(k, d) { try { const v = localStorage.getItem('skillrow.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('skillrow.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const prefs = Object.assign({ mode: 'distance', distance: 2000, time: 1200, calories: 100, splitLen: 500, target: '',
    interval: { reps: 8, workType: 'distance', work: 500, rest: 60 }, raceDistance: 2000, view: 'live' }, store.get('prefs', {}));
  const savePrefs = () => store.set('prefs', prefs);

  // ---------------------------------------------------------------- audio cue
  let actx = null;
  function beep(freq, dur, n) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      n = n || 1;
      for (let i = 0; i < n; i++) {
        const o = actx.createOscillator(), g = actx.createGain();
        const t0 = actx.currentTime + i * (dur + 0.08);
        o.frequency.value = freq || 880; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.start(t0); o.stop(t0 + dur + 0.02);
      }
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- wake lock
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* ignore */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && W && W.active) keepAwake(true); });

  // ---------------------------------------------------------------- state
  const live = { raw: {}, lastRaw: null, hr: null, maxHr: null, lastMsg: 0, status: {}, wsOpen: false };
  const trend = []; // {t (wall s), pace, power}
  const TREND_SECS = 300;
  const force = { cur: [], prev: [], curDone: false, scale: 100 };
  let W = null; // current workout

  // ---------------------------------------------------------------- websocket
  let ws = null, wsTimer = null, wsBackoff = 500;
  function connect() {
    // TV: transport.js picks Tizen BLE / fake / WebSocket and feeds the same message stream into handle()
    const TP = window.SkillRowTransport;
    if (TP && typeof TP.select === 'function') {
      let tr = null;
      try { tr = TP.select(); } catch (e) { console.error('transport select', e); }
      if (tr) {
        try {
          tr.start({
            open: (v) => { live.wsOpen = !!v; renderConn(); },
            message: (m) => { try { handle(m); } catch (e) { console.error('handle', m && m.type, e); } },
          });
          return;
        } catch (e) { console.error('transport start', e); }
      }
    }
    clearTimeout(wsTimer);
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
    catch (e) { wsTimer = setTimeout(connect, wsBackoff); return; }
    ws.onopen = () => { live.wsOpen = true; wsBackoff = 500; renderConn(); };
    ws.onclose = () => { live.wsOpen = false; renderConn(); wsTimer = setTimeout(connect, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 5000); };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      try { handle(m); } catch (e) { console.error('handle', m && m.type, e); }
    };
  }

  function handle(m) {
    switch (m.type) {
      case 'status': live.status = m.data || {}; renderConn(); break;
      case 'metrics': onMetrics(m.data || {}, m.t); break;
      case 'hr': if (num(m.data)) { setHr(m.data); renderHr(); } break;
      case 'forceLive': onForceLive(m.data || []); break;
      case 'forceCurve': onForceCurve(m.data || []); break;
      case 'stroke': force.curDone = true; break; // forceCurve normally follows and finalizes
    }
  }

  function setHr(v) {
    if (!num(v) || v <= 0) return;
    live.hr = v;
    if (W && W.active) W.maxHr = Math.max(W.maxHr || 0, v);
    live.maxHr = Math.max(live.maxHr || 0, v);
  }

  function onForceCurve(d) {
    if (!d.length) return;
    // if the in-progress stroke was never streamed (or already completed), shift it to prev
    if (force.curDone && force.cur.length > 3) force.prev = force.cur;
    force.cur = d.slice(); force.curDone = true; dirtyForce = true;
  }
  function onForceLive(d) {
    if (!d.length) return;
    // a new stroke has started if the previous one completed or the array shrank
    if (force.curDone || d.length < force.cur.length) {
      if (force.cur.length > 3) force.prev = force.cur;
      force.curDone = false;
    }
    force.cur = d.slice();
    dirtyForce = true;
  }

  // ---------------------------------------------------------------- metrics + workout math
  function onMetrics(d, t) {
    const now = Date.now() / 1000;
    live.lastMsg = now;
    const prevRaw = live.lastRaw;
    live.raw = Object.assign({}, d);
    if (num(d.heartRate)) setHr(d.heartRate);

    // machine reset detection: distance or elapsed going backwards
    if (prevRaw && ((num(d.distance) != null && num(prevRaw.distance) != null && d.distance < prevRaw.distance - 5) ||
        (num(d.elapsed) != null && num(prevRaw.elapsed) != null && d.elapsed < prevRaw.elapsed - 5))) {
      onMachineReset(prevRaw);
    }
    live.lastRaw = live.raw;

    if (num(d.pace) || num(d.power)) {
      const last = trend[trend.length - 1];
      const pt = { t: now, pace: num(d.pace) && d.pace > 0 && d.pace < 600 ? d.pace : null, power: num(d.power) };
      if (last && now - last.t < 1) { last.pace = pt.pace; last.power = pt.power; } else trend.push(pt);
      while (trend.length && trend[0].t < now - TREND_SECS - 5) trend.shift();
      dirtyTrend = true;
    }

    if (W && W.active) workoutTick(now);
    render();
  }

  function onMachineReset(prevRaw) {
    trend.length = 0;
    if (!W || !W.active || !W.base) return;
    // fold the segment rowed before the reset into the accumulator, new base is zero
    for (const k of ['distance', 'elapsed', 'calories', 'strokes']) {
      const rawK = k === 'strokes' ? 'strokeCount' : k;
      W.acc[k] += Math.max(0, (num(prevRaw[rawK]) || 0) - W.base[k]);
      W.base[k] = 0;
    }
    W.resets++;
    console.info('machine reset detected; workout continues');
  }

  function rel() { // values relative to workout (or raw machine values if no workout)
    const r = live.raw;
    if (!W || !W.base) {
      return { distance: num(r.distance) || 0, elapsed: num(r.elapsed) || 0, calories: num(r.calories) || 0, strokes: num(r.strokeCount) || 0,
        avgPace: num(r.avgPace), avgPower: num(r.avgPower), avgSpm: num(r.avgStrokeRate), machine: true };
    }
    if (!W.active && W.final) return W.final;
    if (W.waitGo) return { distance: 0, elapsed: 0, calories: 0, strokes: 0, avgPace: null, avgPower: null, avgSpm: null };
    const o = {
      distance: W.acc.distance + Math.max(0, (num(r.distance) || 0) - W.base.distance),
      elapsed: W.acc.elapsed + Math.max(0, (num(r.elapsed) || 0) - W.base.elapsed),
      calories: W.acc.calories + Math.max(0, (num(r.calories) || 0) - W.base.calories),
      strokes: W.acc.strokes + Math.max(0, (num(r.strokeCount) || 0) - W.base.strokes),
    };
    // races run on wall-clock time since GO so the user shares the opponents' clock
    if (W.goWall && W.active) o.elapsed = Math.max(0, Date.now() / 1000 - W.goWall);
    o.avgPace = o.distance > 5 ? (o.elapsed * 500) / o.distance : null;
    o.avgPower = W.powT > 0 ? W.powSum / W.powT : num(r.power);
    o.avgSpm = o.elapsed > 10 ? (o.strokes * 60) / o.elapsed : num(r.strokeRate);
    return o;
  }

  function newWorkout(cfg) {
    return {
      cfg, active: true, base: null, acc: { distance: 0, elapsed: 0, calories: 0, strokes: 0 }, resets: 0,
      startedAt: new Date().toISOString(), samples: [], splits: [], splitStart: { distance: 0, elapsed: 0, powSum: 0, powT: 0, strokes: 0, i: 0 },
      powSum: 0, powT: 0, lastEl: null, maxHr: null, final: null, raceResults: null,
      // intervals
      rep: 0, phase: 'work', segStart: { distance: 0, elapsed: 0, powSum: 0, powT: 0, strokes: 0 }, restUntil: 0, reps: [],
    };
  }

  function takeBaseline() {
    const r = live.raw;
    W.base = { distance: num(r.distance) || 0, elapsed: num(r.elapsed) || 0, calories: num(r.calories) || 0, strokes: num(r.strokeCount) || 0 };
  }

  function workoutTick(now) {
    if (W.waitGo) return; // race countdown: nothing counts yet
    if (!W.base) takeBaseline();
    const o = rel();
    const r = live.raw;
    // time-weighted avg power on machine elapsed
    if (W.lastEl != null && o.elapsed > W.lastEl && num(r.power) != null) {
      const dt = Math.min(5, o.elapsed - W.lastEl);
      W.powSum += r.power * dt; W.powT += dt;
    }
    W.lastEl = o.elapsed;

    // samples (dedupe identical t)
    const s = { t: Math.round(o.elapsed * 10) / 10, distance: Math.round(o.distance * 10) / 10, pace: num(r.pace), power: num(r.power), spm: num(r.strokeRate), hr: live.hr };
    const last = W.samples[W.samples.length - 1];
    if (last && last.t === s.t) W.samples[W.samples.length - 1] = s; else W.samples.push(s);

    const c = W.cfg;
    if (c.mode === 'interval') { intervalTick(o, now); }
    else {
      splitTick(o);
      let done = false;
      if (c.mode === 'distance' || c.mode === 'race') done = o.distance >= c.goal;
      else if (c.mode === 'time') done = o.elapsed >= c.goal;
      else if (c.mode === 'calories') done = o.calories >= c.goal;
      if (W.race) {
        try { W.race.update({ distance: o.distance, elapsed: o.elapsed, pace: num(r.pace), strokeRate: num(r.strokeRate) }); }
        catch (e) { console.error('race.update', e); }
      }
      if (done) finishWorkout(true);
    }
  }

  // interpolate elapsed time at which a given relative distance was crossed
  function timeAtDistance(samples, dist) {
    for (let i = samples.length - 1; i > 0; i--) {
      const a = samples[i - 1], b = samples[i];
      if (a.distance <= dist && b.distance >= dist) {
        if (b.distance === a.distance) return b.t;
        return a.t + ((dist - a.distance) / (b.distance - a.distance)) * (b.t - a.t);
      }
    }
    return samples.length ? samples[samples.length - 1].t : 0;
  }

  function splitTick(o) {
    const L = W.cfg.splitLen;
    const ss = W.splitStart;
    while (o.distance >= ss.distance + L) {
      const end = ss.distance + L;
      const tEnd = timeAtDistance(W.samples, end);
      pushSplit(W.splits, end - ss.distance, end, tEnd - ss.elapsed, ss, o, tEnd);
      ss.distance = end; ss.elapsed = tEnd; ss.powSum = W.powSum; ss.powT = W.powT; ss.strokes = o.strokes; ss.i = W.samples.length - 1;
      beep(990, 0.12, 1);
    }
  }

  function pushSplit(arr, len, distEnd, time, ss, o, tEnd) {
    const pT = W.powT - ss.powT;
    const strokes = o.strokes - ss.strokes;
    const seg = W.samples.slice(ss.i || 0).filter((s) => s.hr);
    const hr = seg.length ? Math.round(seg.reduce((a, s) => a + s.hr, 0) / seg.length) : null;
    arr.push({ n: arr.length + 1, distance: Math.round(distEnd), len: Math.round(len), time: Math.round(time * 10) / 10,
      pace: len > 0 ? Math.round(((time * 500) / len) * 10) / 10 : null,
      power: pT > 0 ? Math.round((W.powSum - ss.powSum) / pT) : null,
      spm: time > 0 ? Math.round(((strokes * 60) / time) * 10) / 10 : null, hr, end: Math.round((tEnd || o.elapsed) * 10) / 10 });
  }

  function intervalTick(o, now) {
    const c = W.cfg, iv = c.interval, seg = W.segStart;
    if (W.phase === 'work') {
      const segDist = o.distance - seg.distance, segTime = o.elapsed - seg.elapsed;
      const done = iv.workType === 'distance' ? segDist >= iv.work : segTime >= iv.work;
      if (done) {
        pushSplit(W.splits, segDist, o.distance, segTime, Object.assign({ i: seg.i }, seg), o, o.elapsed);
        W.rep++;
        if (W.rep >= iv.reps) { finishWorkout(true); return; }
        W.phase = 'rest'; W.restUntil = now + iv.rest; beep(660, 0.25, 2);
      }
    } else if (now >= W.restUntil) {
      W.phase = 'work';
      Object.assign(seg, { distance: o.distance, elapsed: o.elapsed, powSum: W.powSum, powT: W.powT, strokes: o.strokes, i: W.samples.length - 1 });
      beep(1100, 0.35, 1);
    }
  }
  // rest countdown needs to tick even when the machine stops sending
  setInterval(() => { if (W && W.active && W.cfg.mode === 'interval' && W.phase === 'rest') { intervalTick(rel(), Date.now() / 1000); render(); } }, 250);

  // ---------------------------------------------------------------- start / finish
  function startWorkout(cfg) {
    if (W && W.race) { try { W.race.destroy(); } catch (e) { /* ignore */ } }
    W = newWorkout(cfg);
    force.prev = []; force.cur = [];
    setupRace(cfg);
    if (live.lastMsg && !W.waitGo) takeBaseline();
    keepAwake(true);
    showView('live');
    render();
    renderSplits(true);
  }

  function setupRace(cfg) {
    const wrap = $('#race-wrap'), cont = $('#race-container'), liveEl = $('#live');
    cont.innerHTML = '';
    if (cfg.mode !== 'race') { wrap.hidden = true; liveEl.classList.remove('racing'); return; }
    wrap.hidden = false; liveEl.classList.add('racing');
    const R = window.SkillRowRace;
    $('#race-missing').hidden = !!(R && R.create);
    if (!R || typeof R.create !== 'function') return;
    try {
      W.race = R.create(cont, { distance: cfg.goal, opponents: cfg.opponents || [] });
      const w = W;
      W.race.onFinish = (results) => { w.raceResults = results; if (W === w && !w.active) renderDone(); };
      // baseline is taken at GO (after the race's 3-2-1 countdown); fallback timer if no event arrives
      const go = () => { if (W !== w || !w.waitGo) return; w.waitGo = false; w.goWall = Date.now() / 1000; if (live.lastMsg) takeBaseline(); beep(1200, 0.3, 1); render(); };
      W.race.onEvent = (e) => { if (!e) return; if (e.kind === 'go') go(); else if (e.kind === 'countdown') beep(700, 0.12, 1); };
      W.waitGo = true;
      if (W.race.start) W.race.start();
      setTimeout(go, 3300);
    } catch (e) { console.error('race create', e); W.race = null; $('#race-missing').hidden = false; }
    requestAnimationFrame(resizeCanvases);
  }

  function finishWorkout(completed) {
    if (!W || !W.active) return;
    const o = rel();
    if (W.cfg.mode === 'race' || W.cfg.mode === 'distance') {
      // clamp to goal with interpolated finish time
      if (o.distance >= W.cfg.goal) { o.elapsed = timeAtDistance(W.samples, W.cfg.goal); o.distance = W.cfg.goal; o.avgPace = (o.elapsed * 500) / o.distance; }
    }
    // final partial split
    if (W.cfg.mode !== 'interval') {
      const ss = W.splitStart;
      if (o.distance - ss.distance >= 10) pushSplit(W.splits, o.distance - ss.distance, o.distance, o.elapsed - ss.elapsed, ss, o, o.elapsed);
    }
    W.final = Object.assign({}, o);
    W.active = false; W.completed = completed;
    if (W.race) { try { W.race.update({ distance: o.distance, elapsed: o.elapsed, pace: num(live.raw.pace), strokeRate: num(live.raw.strokeRate) }); } catch (e) { /* ignore */ } }
    beep(880, 0.2, 3);
    keepAwake(false);
    render();
    renderSplits(true);
    const w = W;
    // give race.js a moment to call onFinish, then show results
    setTimeout(() => { if (W === w) { renderDone(); $('#done').hidden = false; } }, W.race ? 1200 : 0);
    if (o.distance >= 50 || o.elapsed >= 30) saveSession(w); else $('#done-save').textContent = 'Too short to save.';
  }

  function sessionPayload(w) {
    const f = w.final;
    return {
      startedAt: w.startedAt, type: w.cfg.mode, goal: goalDesc(w.cfg), completed: !!w.completed,
      summary: { distance: Math.round(f.distance), time: Math.round(f.elapsed * 10) / 10, avgPace: f.avgPace ? Math.round(f.avgPace * 10) / 10 : null,
        avgPower: f.avgPower ? Math.round(f.avgPower) : null, calories: Math.round(f.calories), strokes: Math.round(f.strokes),
        avgSpm: f.avgSpm ? Math.round(f.avgSpm * 10) / 10 : null, maxHr: w.maxHr || null },
      splits: w.splits, samples: w.samples, source: 'app',
      race: w.cfg.mode === 'race' ? { opponents: (w.cfg.opponents || []).map((o) => ({ name: o.name, type: o.type, pace: o.pace, basePace: o.basePace, profile: o.profile })), results: w.raceResults || fallbackRaceResults(w) } : undefined,
    };
  }

  async function saveSession(w) {
    const el = $('#done-save');
    el.textContent = 'Saving…';
    try {
      const res = await apiFetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sessionPayload(w)) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      w.savedId = j.id;
      el.textContent = 'Saved ✓';
      histCache = null;
    } catch (e) {
      el.textContent = 'Save failed: ' + e.message;
      try { const q = store.get('unsaved', []); q.push(sessionPayload(w)); store.set('unsaved', q.slice(-5)); } catch (e2) { /* ignore */ }
    }
  }
  async function flushUnsaved() {
    const q = store.get('unsaved', []);
    if (!q.length) return;
    const left = [];
    for (const p of q) {
      try { const r = await apiFetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); if (!r.ok) left.push(p); }
      catch (e) { left.push(p); }
    }
    store.set('unsaved', left);
  }

  function goalDesc(c) {
    const g = { mode: c.mode, targetPace: c.targetPace || null, splitLen: c.splitLen };
    if (c.mode === 'distance' || c.mode === 'race') g.distance = c.goal;
    if (c.mode === 'time') g.time = c.goal;
    if (c.mode === 'calories') g.calories = c.goal;
    if (c.mode === 'interval') g.interval = c.interval;
    return g;
  }
  function goalLabel(c) {
    switch (c.mode) {
      case 'free': return 'Just row';
      case 'distance': return c.goal + ' m';
      case 'time': return fmtTime(c.goal) + ' time';
      case 'calories': return c.goal + ' kcal';
      case 'race': return 'Race ' + c.goal + ' m';
      case 'interval': { const iv = c.interval; return iv.reps + '× ' + (iv.workType === 'distance' ? iv.work + 'm' : fmtTime(iv.work)) + ' / ' + fmtTime(iv.rest) + ' rest'; }
    }
    return '';
  }

  // race fallback: compute opponent finish times ourselves when race.js gives none
  function fallbackRaceResults(w) {
    const D = w.cfg.goal, out = [{ name: 'You', time: w.final ? w.final.elapsed : null, isUser: true }];
    for (const op of w.cfg.opponents || []) {
      let t = null;
      if (num(op.pace)) t = (D * op.pace) / 500;
      else if (op.samples && op.samples.length) {
        const s = op.samples;
        if (s[s.length - 1].distance >= D) t = timeAtDistance(s, D);
      }
      out.push({ name: op.name || 'Opponent', time: t, isUser: false });
    }
    out.sort((a, b) => (a.time == null) - (b.time == null) || a.time - b.time);
    return out;
  }

  // ---------------------------------------------------------------- render live
  const el = {};
  ['v-pace', 'a-pace', 'v-vs', 'v-elapsed', 's-elapsed', 'v-distance', 's-distance', 'v-power', 'a-power', 'v-spm', 'a-spm', 'v-hr', 'a-hr',
    'v-cal', 'a-cal', 'v-strokes', 'a-res', 'a-dps', 'wo-label', 'wo-panel', 'idle-panel', 'wo-title', 'wo-phase', 'wo-remaining', 'wo-remaining-lbl',
    'wo-bar', 'wo-proj', 'btn-end', 'btn-setup', 'split-len-lbl', 'v-split', 's-split', 'l-split'].forEach((id) => { el[id] = document.getElementById(id); });
  const setText = (e, t) => { if (e && e.textContent !== t) e.textContent = t; };

  function render() {
    const r = live.raw, o = rel();
    const stale = Date.now() / 1000 - live.lastMsg > 4;
    const pace = stale ? null : num(r.pace);
    setText(el['v-pace'], fmtPace(pace));
    setText(el['a-pace'], fmtPace(o.avgPace));
    setText(el['v-elapsed'], fmtTime(o.elapsed));
    setText(el['v-distance'], fmtInt(o.distance));
    setText(el['v-power'], stale ? '--' : fmtInt(r.power));
    setText(el['a-power'], fmtInt(o.avgPower));
    setText(el['v-spm'], stale || !num(r.strokeRate) ? '--' : (Math.round(r.strokeRate * 10) / 10).toString());
    setText(el['a-spm'], o.avgSpm ? (Math.round(o.avgSpm * 10) / 10).toString() : '--');
    setText(el['v-cal'], fmtInt(o.calories));
    setText(el['a-cal'], o.elapsed > 30 ? fmtInt((o.calories * 3600) / o.elapsed) : '--');
    setText(el['v-strokes'], fmtInt(o.strokes));
    setText(el['a-res'], num(r.resistance) != null ? String(r.resistance) : '--');
    setText(el['a-dps'], o.strokes > 3 ? (o.distance / o.strokes).toFixed(1) : '--');
    renderHr();
    renderSplitTile(o);

    const active = !!(W && W.active);
    el['btn-end'].hidden = !active;
    el['btn-setup'].hidden = active;
    el['wo-label'].classList.toggle('active', active);
    setText(el['wo-label'], W ? (active ? '● ' : 'Finished: ') + goalLabel(W.cfg) : 'Machine totals');
    setText(el['split-len-lbl'], W ? (W.cfg.mode === 'interval' ? 'per rep' : W.cfg.splitLen + ' m') : '');

    // target pace comparison on pace tile
    const tp = W && W.cfg.targetPace;
    const vs = el['v-vs'];
    if (tp && o.avgPace) {
      const d = o.avgPace - tp;
      vs.textContent = fmtDelta(d) + ' vs ' + fmtPace(tp, false);
      vs.className = 'vs ' + (d <= 0 ? 'good' : 'bad');
    } else vs.textContent = '';
    setText(el['s-elapsed'], W && W.cfg.mode === 'time' ? 'of ' + fmtTime(W.cfg.goal) : ' ');
    setText(el['s-distance'], W && (W.cfg.mode === 'distance' || W.cfg.mode === 'race') ? 'of ' + W.cfg.goal + ' m' : ' ');

    el['idle-panel'].hidden = !!W;
    el['wo-panel'].hidden = !W;
    if (W) renderWorkoutPanel(o, pace);
    if (W && W.splits.length !== renderedSplits) renderSplits();
  }

  function renderSplitTile(o) {
    let v = '--:--', sub = '\u00a0', lbl = 'Split';
    if (W && W.base) {
      const ss = W.cfg.mode === 'interval' ? W.segStart : W.splitStart;
      const d = o.distance - ss.distance, t = o.elapsed - ss.elapsed;
      if (W.cfg.mode === 'interval') { lbl = 'Rep pace'; sub = W.phase === 'rest' ? 'resting' : 'rep ' + Math.min(W.rep + 1, W.cfg.interval.reps) + ' · ' + fmtTime(t); }
      else { lbl = 'Split ' + (W.splits.length + 1); sub = fmtInt(Math.max(0, W.cfg.splitLen - d)) + ' m to go · ' + fmtTime(t); }
      if (d > 5 && W.active) v = fmtPace((t * 500) / d);
      if (!W.active) { const ls = W.splits[W.splits.length - 1]; v = ls ? fmtPace(ls.pace) : '--:--'; sub = 'last split'; }
    } else {
      const d500 = o.distance % 500; sub = fmtInt(500 - d500) + ' m to next 500';
    }
    setText(el['v-split'], v); setText(el['s-split'], sub); setText(el['l-split'], lbl);
  }

  function renderHr() {
    setText(el['v-hr'], live.hr && Date.now() / 1000 - live.lastMsg < 10 ? String(Math.round(live.hr)) : (live.hr ? String(Math.round(live.hr)) : '--'));
    const mx = W && W.maxHr ? W.maxHr : live.maxHr;
    setText(el['a-hr'], mx ? String(Math.round(mx)) : '--');
  }

  function renderWorkoutPanel(o, pace) {
    const c = W.cfg;
    setText(el['wo-title'], goalLabel(c));
    const ph = el['wo-phase'];
    const rem = el['wo-remaining'];
    rem.classList.remove('rest');
    let frac = 0, remTxt = '--', remLbl = 'remaining', proj = [];
    const curP = pace || null, avgP = o.avgPace;
    const tp = c.targetPace;

    if (!W.active) { ph.textContent = W.completed ? 'DONE' : 'ENDED'; ph.className = 'phase work'; }
    else if (c.mode !== 'interval') { ph.textContent = ''; ph.className = 'phase'; }

    if (c.mode === 'distance' || c.mode === 'race') {
      const left = Math.max(0, c.goal - o.distance);
      frac = o.distance / c.goal; remTxt = fmtInt(left) + ' m';
      if (curP) proj.push(['Finish @ current', fmtTime(o.elapsed + (left * curP) / 500)]);
      if (avgP) proj.push(['Finish @ avg', fmtTime(o.elapsed + (left * avgP) / 500)]);
      if (tp) {
        proj.push(['Target finish', fmtTime((c.goal * tp) / 500)]);
        const ahead = o.elapsed - (o.distance * tp) / 500; // + = behind
        if (o.distance > 10) proj.push(['vs target', fmtDelta(ahead) + ' s', ahead <= 0 ? 'good' : 'bad']);
      }
    } else if (c.mode === 'time') {
      const left = Math.max(0, c.goal - o.elapsed);
      frac = o.elapsed / c.goal; remTxt = fmtTime(left);
      if (curP) proj.push(['Distance @ current', fmtInt(o.distance + (left * 500) / curP) + ' m']);
      if (avgP) proj.push(['Distance @ avg', fmtInt(o.distance + (left * 500) / avgP) + ' m']);
      if (tp) {
        proj.push(['Target distance', fmtInt((c.goal * 500) / tp) + ' m']);
        const metersAhead = o.distance - (o.elapsed * 500) / tp;
        if (o.elapsed > 5) proj.push(['vs target', (metersAhead >= 0 ? '+' : '−') + Math.abs(Math.round(metersAhead)) + ' m', metersAhead >= 0 ? 'good' : 'bad']);
      }
    } else if (c.mode === 'calories') {
      const left = Math.max(0, c.goal - o.calories);
      frac = o.calories / c.goal; remTxt = fmtInt(left) + ' kcal';
      if (o.calories > 0 && o.elapsed > 20) proj.push(['Finish @ avg rate', fmtTime(o.elapsed + (left * o.elapsed) / o.calories)]);
      if (tp && o.distance > 10) { const ahead = o.elapsed - (o.distance * tp) / 500; proj.push(['vs target pace', fmtDelta(ahead) + ' s', ahead <= 0 ? 'good' : 'bad']); }
    } else if (c.mode === 'interval') {
      const iv = c.interval, seg = W.segStart;
      const repN = Math.min(W.rep + 1, iv.reps);
      if (!W.active) { remTxt = W.splits.length + ' reps'; frac = W.splits.length / iv.reps; }
      else if (W.phase === 'rest') {
        ph.textContent = 'REST'; ph.className = 'phase rest';
        rem.classList.add('rest');
        const left = Math.max(0, W.restUntil - Date.now() / 1000);
        remTxt = fmtTime(Math.ceil(left)); remLbl = 'rest · next: rep ' + (W.rep + 1) + ' of ' + iv.reps;
        frac = W.rep / iv.reps;
      } else {
        ph.textContent = 'REP ' + repN + '/' + iv.reps; ph.className = 'phase work';
        const sd = o.distance - seg.distance, st = o.elapsed - seg.elapsed;
        if (iv.workType === 'distance') {
          const left = Math.max(0, iv.work - sd); remTxt = fmtInt(left) + ' m'; remLbl = 'remaining in rep · ' + fmtTime(st);
          frac = (W.rep + Math.min(1, sd / iv.work)) / iv.reps;
          if (sd > 5) proj.push(['Rep pace', fmtPace((st * 500) / sd)]);
          if (curP) proj.push(['Rep finish @ current', fmtTime(st + (left * curP) / 500)]);
        } else {
          const left = Math.max(0, iv.work - st); remTxt = fmtTime(left); remLbl = 'remaining in rep · ' + fmtInt(sd) + ' m';
          frac = (W.rep + Math.min(1, st / iv.work)) / iv.reps;
          if (sd > 5) proj.push(['Rep pace', fmtPace((st * 500) / sd)]);
        }
        if (tp && sd > 5) { const d = (st * 500) / sd - tp; proj.push(['vs target', fmtDelta(d) + ' /500m', d <= 0 ? 'good' : 'bad']); }
      }
      const best = W.splits.reduce((b, s) => (s.pace && (!b || s.pace < b) ? s.pace : b), null);
      if (best) proj.push(['Best rep pace', fmtPace(best)]);
    } else { // free
      remTxt = fmtInt(o.distance) + ' m'; remLbl = fmtTime(o.elapsed) + ' rowed';
      frac = 0;
      if (tp && o.distance > 10) { const ahead = o.elapsed - (o.distance * tp) / 500; proj.push(['vs target', fmtDelta(ahead) + ' s', ahead <= 0 ? 'good' : 'bad']); }
      if (avgP) proj.push(['Proj. 2k @ avg', fmtTime(4 * avgP)]);
    }
    if (W.resets) proj.push(['Machine resets', String(W.resets)]);
    setText(rem, remTxt);
    setText(el['wo-remaining-lbl'], remLbl);
    el['wo-bar'].style.width = Math.max(0, Math.min(100, frac * 100)).toFixed(1) + '%';
    el['wo-bar'].parentElement.style.visibility = c.mode === 'free' ? 'hidden' : '';
    const html = proj.map((p) => '<span class="k">' + esc(p[0]) + '</span><span class="' + (p[2] || '') + '">' + esc(p[1]) + '</span>').join('');
    if (el['wo-proj'].innerHTML !== html) el['wo-proj'].innerHTML = html;
  }

  let renderedSplits = -1;
  function splitsHtml(splits, opts) {
    opts = opts || {};
    const best = splits.reduce((b, s) => (s.pace && (b == null || s.pace < b) ? s.pace : b), null);
    return splits.map((s) => '<tr class="' + (s.pace === best && splits.length > 1 ? 'best' : '') + '"><td>' + s.n + '</td><td>' + fmtInt(s.distance) +
      '</td><td>' + fmtTime(s.time, true) + '</td><td>' + fmtPace(s.pace) + '</td><td>' + fmtInt(s.power) + '</td><td>' +
      (s.spm != null ? s.spm : '--') + '</td><td>' + (s.hr || '--') + '</td></tr>').join('') + (opts.extra || '');
  }
  function renderSplits(force_) {
    if (!W) return;
    const tb = $('#splits-table tbody');
    renderedSplits = W.splits.length;
    const rows = W.splits.slice().reverse();
    tb.innerHTML = splitsHtml(rows.map((s) => s)) || '<tr><td colspan="7" class="muted">No splits yet</td></tr>';
  }

  function renderConn() {
    $('#conn-ws').className = 'dot ' + (live.wsOpen ? 'on' : '');
    $('#conn-ws').title = live.wsOpen ? 'Server connected' : 'Server disconnected - reconnecting';
    const st = live.status || {};
    const rw = $('#conn-rower'), hr = $('#conn-hr');
    $('.dot', rw).className = 'dot ' + (live.wsOpen && st.connected ? 'on' : '');
    $('.lbl', rw).textContent = st.connected ? 'Rower' : 'Rower: searching';
    rw.title = st.device || 'not connected';
    $('.dot', hr).className = 'dot ' + (live.wsOpen && st.hr_connected ? 'on' : '');
    hr.title = st.hr_device || 'no HR strap';
  }
  setInterval(() => { render(); }, 1000);

  // ---------------------------------------------------------------- canvases
  let dirtyForce = true, dirtyTrend = true;
  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(c.clientWidth * dpr)), h = Math.max(10, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return dpr;
  }
  function resizeCanvases() { dirtyForce = dirtyTrend = true; }
  window.addEventListener('resize', resizeCanvases);

  function drawForce() {
    const c = $('#c-force'); if (!c.clientWidth) return;
    const dpr = fitCanvas(c), ctx = c.getContext('2d'), W_ = c.width, H = c.height;
    ctx.clearRect(0, 0, W_, H);
    const cur = force.cur, prev = force.prev;
    const mx = Math.max(40, ...cur, ...prev);
    force.scale = force.scale * 0.8 + mx * 1.1 * 0.2;
    if (force.scale < mx) force.scale = mx * 1.05;
    const n = Math.max(cur.length, prev.length, 40);
    const pad = 6 * dpr;
    const X = (i) => pad + (i / (n - 1)) * (W_ - 2 * pad), Y = (v) => H - pad - (v / force.scale) * (H - 2 * pad);
    ctx.strokeStyle = '#262c35'; ctx.lineWidth = 1 * dpr;
    for (let g = 1; g < 4; g++) { const y = pad + (g / 4) * (H - 2 * pad); ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W_ - pad, y); ctx.stroke(); }
    const line = (arr, color, fill, width) => {
      if (arr.length < 2) return;
      ctx.beginPath(); ctx.moveTo(X(0), Y(arr[0]));
      for (let i = 1; i < arr.length; i++) ctx.lineTo(X(i), Y(arr[i]));
      ctx.lineWidth = width * dpr; ctx.strokeStyle = color; ctx.lineJoin = 'round'; ctx.stroke();
      if (fill) { ctx.lineTo(X(arr.length - 1), Y(0)); ctx.lineTo(X(0), Y(0)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
    };
    line(prev, 'rgba(138,148,163,0.55)', null, 2);
    line(cur, '#39c6ff', 'rgba(57,198,255,0.15)', 3.5);
    const peak = cur.length ? Math.max(...cur) : null;
    setText($('#force-peak'), peak ? 'peak ' + peak + (prev.length ? ' · prev ' + Math.max(...prev) : '') : '');
  }

  function drawTrend() {
    const c = $('#c-trend'); if (!c.clientWidth) return;
    const dpr = fitCanvas(c), ctx = c.getContext('2d'), W_ = c.width, H = c.height;
    ctx.clearRect(0, 0, W_, H);
    if (trend.length < 2) { ctx.fillStyle = '#8a94a3'; ctx.font = 14 * dpr + 'px -apple-system, sans-serif'; ctx.fillText('waiting for data…', 10 * dpr, 24 * dpr); return; }
    const now = Date.now() / 1000, t0 = now - TREND_SECS;
    drawSeriesChart(ctx, W_, H, dpr, trend, { x: (p) => p.t, x0: t0, x1: now, tickFmt: (t) => '-' + Math.round((now - t) / 60) + 'm', ticks: [t0, t0 + 60, t0 + 120, t0 + 180, t0 + 240] , target: W && W.cfg.targetPace });
  }

  // shared chart: pace (inverted, left axis) and power (right axis)
  function drawSeriesChart(ctx, W_, H, dpr, pts, o) {
    const padL = 46 * dpr, padR = 40 * dpr, padT = 8 * dpr, padB = 18 * dpr;
    const paces = pts.map((p) => p.pace).filter((v) => num(v) && v > 0 && v < 600);
    const pows = pts.map((p) => p.power).filter((v) => num(v) != null);
    const xs = (x) => padL + ((x - o.x0) / Math.max(1e-6, o.x1 - o.x0)) * (W_ - padL - padR);
    ctx.font = 11 * dpr + 'px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
    // x ticks
    ctx.fillStyle = '#8a94a3'; ctx.strokeStyle = '#20252d'; ctx.lineWidth = dpr;
    (o.ticks || []).forEach((t) => { const x = xs(t); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillText(o.tickFmt(t), x, H - padB / 2); });
    const series = (vals, key, lo, hi, invert, color, width) => {
      const ys = (v) => { const f = (v - lo) / Math.max(1e-6, hi - lo); return padT + (invert ? f : 1 - f) * (H - padT - padB); };
      ctx.beginPath(); let started = false;
      for (const p of pts) {
        const v = p[key];
        if (!(num(v) && (key !== 'pace' || (v > 0 && v < 600)))) { started = false; continue; }
        const x = xs(o.x(p)), y = ys(Math.max(lo, Math.min(hi, v)));
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width * dpr; ctx.lineJoin = 'round'; ctx.stroke();
      return ys;
    };
    if (pows.length) {
      const lo = 0, hi = Math.max(50, ...pows) * 1.1;
      series(pows, 'power', lo, hi, false, 'rgba(255,176,46,0.85)', 2);
      ctx.fillStyle = '#ffb02e'; ctx.textAlign = 'left';
      ctx.fillText(Math.round(hi) + 'W', W_ - padR + 4 * dpr, padT + 6 * dpr); ctx.fillText('0', W_ - padR + 4 * dpr, H - padB - 4 * dpr);
    }
    if (paces.length) {
      let lo = Math.min(...paces), hi = Math.max(...paces);
      if (o.target) { lo = Math.min(lo, o.target); hi = Math.max(hi, o.target); }
      const span = Math.max(10, hi - lo); lo -= span * 0.1; hi += span * 0.1;
      const ys = series(paces, 'pace', lo, hi, true, '#39c6ff', 2.5);
      ctx.fillStyle = '#39c6ff'; ctx.textAlign = 'right';
      ctx.fillText(fmtPace(lo, false), padL - 4 * dpr, padT + 6 * dpr); ctx.fillText(fmtPace(hi, false), padL - 4 * dpr, H - padB - 4 * dpr);
      if (o.target) {
        const y = ys(o.target); ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.strokeStyle = 'rgba(61,220,132,0.8)'; ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W_ - padR, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#3ddc84'; ctx.fillText(fmtPace(o.target, false), padL - 4 * dpr, y);
      }
    }
  }

  function frame() {
    if (!$('#live').hidden) {
      if (dirtyForce) { dirtyForce = false; drawForce(); }
      if (dirtyTrend) { dirtyTrend = false; drawTrend(); }
    }
    requestAnimationFrame(frame);
  }
  setInterval(() => { dirtyTrend = true; }, 2000); // keep the time axis scrolling

  // ---------------------------------------------------------------- setup modal
  let setupMode = prefs.mode;
  let raceSel = null; // {presets:[], selected:Set, ghost:{id, samples, name}}
  function openSetup(mode) {
    if (mode) setupMode = mode;
    $('#setup').hidden = false;
    $('#in-target').value = prefs.target || '';
    $('#in-split').value = String(prefs.splitLen);
    $('#setup-err').textContent = '';
    renderSetup();
  }
  function closeOverlays() { $$('.overlay').forEach((o) => { o.hidden = true; }); }

  function presetBtns(list, cur, fmt, key) {
    return '<div class="presets">' + list.map((v) => '<button class="btn' + (v === cur ? ' sel' : '') + '" data-preset="' + key + '" data-v="' + v + '">' + fmt(v) + '</button>').join('') + '</div>';
  }

  function renderSetup() {
    $$('#mode-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === setupMode));
    const body = $('#setup-body');
    let h = '';
    if (setupMode === 'free') h = '<p class="hint">Row freely. Values start at zero now; splits are recorded and the session is saved when you press End.</p>';
    else if (setupMode === 'distance') {
      h = presetBtns([500, 1000, 2000, 5000, 10000], prefs.distance, (v) => v + ' m', 'distance') +
        '<div class="field">Custom <input id="in-distance" type="number" min="50" step="50" value="' + prefs.distance + '"> m</div>';
    } else if (setupMode === 'time') {
      h = presetBtns([300, 600, 1200, 1800, 2700, 3600], prefs.time, (v) => fmtTime(v), 'time') +
        '<div class="field">Custom <input id="in-time" value="' + fmtTime(prefs.time) + '" size="8"> (m:ss)</div>';
    } else if (setupMode === 'calories') {
      h = presetBtns([50, 100, 200, 300, 500], prefs.calories, (v) => v + ' kcal', 'calories') +
        '<div class="field">Custom <input id="in-calories" type="number" min="5" value="' + prefs.calories + '"> kcal</div>';
    } else if (setupMode === 'interval') {
      const iv = prefs.interval;
      h = '<div class="presets">' + [['8×500m / 1:00', 8, 'distance', 500, 60], ['4×1000m / 2:00', 4, 'distance', 1000, 120], ['5×1500m / 3:00', 5, 'distance', 1500, 180],
        ['10×1:00 / 1:00', 10, 'time', 60, 60], ['4×4:00 / 2:00', 4, 'time', 240, 120], ['8×250m / 0:30', 8, 'distance', 250, 30]].map((p) =>
        '<button class="btn" data-iv=\'' + JSON.stringify(p.slice(1)) + '\'>' + p[0] + '</button>').join('') + '</div>' +
        '<div class="field"><input id="iv-reps" type="number" min="1" value="' + iv.reps + '" style="width:5em"> reps of ' +
        '<input id="iv-work" value="' + (iv.workType === 'distance' ? iv.work : fmtTime(iv.work)) + '" size="6"> ' +
        '<select id="iv-type"><option value="distance"' + (iv.workType === 'distance' ? ' selected' : '') + '>meters</option><option value="time"' + (iv.workType === 'time' ? ' selected' : '') + '>time (m:ss)</option></select>' +
        ' with <input id="iv-rest" value="' + fmtTime(iv.rest) + '" size="6"> rest</div><p class="hint">Rest is timed by the app; distance rowed during rest is not counted toward reps.</p>';
    } else if (setupMode === 'race') {
      h = renderRaceSetup();
    }
    body.innerHTML = h;
    if (setupMode === 'race') wireRaceSetup();
  }

  function renderRaceSetup() {
    const R = window.SkillRowRace;
    let h = presetBtns([500, 1000, 2000, 5000], prefs.raceDistance, (v) => v + ' m', 'raceDistance') +
      '<div class="field">Custom <input id="in-race-distance" type="number" min="100" step="100" value="' + prefs.raceDistance + '"> m</div>';
    if (!R || typeof R.create !== 'function') h += '<p class="err">race.js is not loaded; you can still row the distance but no race view will show.</p>';
    h += '<div class="panel-title">Opponents</div><div class="opp-list" id="opp-list"><span class="muted">Loading…</span></div>' +
      '<div class="field">Pacer at <input id="in-pacer" placeholder="2:00" size="6"> /500m <button class="btn small" id="btn-add-pacer">Add pacer</button></div>' +
      '<div class="field">Ghost of past session <select id="in-ghost"><option value="">(none)</option></select> <span id="ghost-status" class="hint"></span></div>';
    return h;
  }

  async function wireRaceSetup() {
    if (!raceSel) raceSel = { presets: [], selected: new Set(store.get('raceOpps', [0, 1, 2])), custom: [], ghost: null };
    const R = window.SkillRowRace;
    const sessions = await loadSessions().catch(() => []);
    // user's recent average pace for presets
    let avg = null;
    const recent = sessions.find((s) => sumOf(s).avgPace);
    if (recent) avg = sumOf(recent).avgPace;
    try { raceSel.presets = R && R.presetOpponents ? (R.presetOpponents(avg) || []) : defaultOpponents(avg); }
    catch (e) { console.error('presetOpponents', e); raceSel.presets = defaultOpponents(avg); }
    renderOppList();
    const sel = $('#in-ghost');
    if (sel) {
      sel.innerHTML = '<option value="">(none)</option>' + sessions.map((s) => {
        const su = sumOf(s);
        return '<option value="' + esc(s.id) + '">' + esc(fmtDate(s.startedAt)) + ' · ' + fmtInt(su.distance) + ' m · ' + fmtTime(su.time) + ' · ' + fmtPace(su.avgPace) + '</option>';
      }).join('');
      if (raceSel.ghost) sel.value = raceSel.ghost.id;
      sel.onchange = () => loadGhost(sel.value);
    }
    const addP = $('#btn-add-pacer');
    if (addP) addP.onclick = () => {
      const p = parseTime($('#in-pacer').value);
      if (!p) { $('#in-pacer').focus(); return; }
      raceSel.custom.push({ name: 'Pacer ' + fmtPace(p, false), type: 'constant', pace: p });
      $('#in-pacer').value = ''; renderOppList();
    };
  }

  function defaultOpponents(avg) {
    const b = avg || 130;
    return [{ name: 'Steady', type: 'constant', pace: Math.round(b) }, { name: 'Faster', type: 'constant', pace: Math.round(b - 5) }, { name: 'Slower', type: 'constant', pace: Math.round(b + 5) }];
  }

  async function loadGhost(id) {
    const st = $('#ghost-status');
    if (!id) { raceSel.ghost = null; if (st) st.textContent = ''; return; }
    if (st) st.textContent = 'loading…';
    try {
      const s = await (await apiFetch('/api/sessions/' + encodeURIComponent(id))).json();
      const samples = normSamples(s.samples || []).map((p) => ({ t: p.t, distance: p.distance }));
      if (samples.length < 2) throw new Error('no samples');
      raceSel.ghost = { id, name: 'Ghost ' + fmtDate(s.startedAt, true), samples };
      if (st) st.textContent = 'loaded (' + fmtInt(samples[samples.length - 1].distance) + ' m)';
    } catch (e) { raceSel.ghost = null; if (st) st.textContent = 'failed: ' + e.message; }
  }

  function oppMeta(o) {
    if (num(o.pace)) return fmtPace(o.pace, false) + ' /500m';
    if (o.type === 'profile') return (o.profile || 'profile') + ' ~' + fmtPace(o.basePace, false);
    if (o.type === 'adaptive') return 'adapts to you (' + (o.offset > 0 ? '+' : '') + (o.offset || 0) + ' s)';
    if (o.type) return o.type;
    return '';
  }
  function renderOppList() {
    const box = $('#opp-list'); if (!box) return;
    const all = raceSel.presets.map((o, i) => ({ o, key: 'p' + i, on: raceSel.selected.has(i) }))
      .concat(raceSel.custom.map((o, i) => ({ o, key: 'c' + i, on: true })));
    box.innerHTML = all.map((x) => '<label><input type="checkbox" data-key="' + x.key + '"' + (x.on ? ' checked' : '') + '> ' + esc(x.o.name || 'Opponent') +
      '<span class="meta">' + esc(oppMeta(x.o)) + '</span></label>').join('') || '<span class="muted">No presets</span>';
    $$('input', box).forEach((cb) => cb.onchange = () => {
      const k = cb.dataset.key, i = +k.slice(1);
      if (k[0] === 'p') { if (cb.checked) raceSel.selected.add(i); else raceSel.selected.delete(i); store.set('raceOpps', Array.from(raceSel.selected)); }
      else if (!cb.checked) { raceSel.custom.splice(i, 1); renderOppList(); }
    });
  }

  function readSetup() {
    const c = { mode: setupMode, splitLen: +$('#in-split').value || 500 };
    const tpStr = $('#in-target').value.trim();
    c.targetPace = tpStr ? parseTime(tpStr) : null;
    if (tpStr && !c.targetPace) throw new Error('Target pace should look like 2:05');
    prefs.target = tpStr; prefs.splitLen = c.splitLen;
    if (setupMode === 'distance') {
      c.goal = Math.round(+$('#in-distance').value);
      if (!(c.goal >= 50)) throw new Error('Distance must be at least 50 m');
      prefs.distance = c.goal;
    } else if (setupMode === 'time') {
      c.goal = parseTime($('#in-time').value);
      if (!(c.goal >= 10)) throw new Error('Time should look like 20:00');
      prefs.time = c.goal;
    } else if (setupMode === 'calories') {
      c.goal = Math.round(+$('#in-calories').value);
      if (!(c.goal >= 1)) throw new Error('Enter calories');
      prefs.calories = c.goal;
    } else if (setupMode === 'interval') {
      const type = $('#iv-type').value;
      const work = type === 'distance' ? Math.round(+$('#iv-work').value) : parseTime($('#iv-work').value);
      const iv = { reps: Math.round(+$('#iv-reps').value), workType: type, work, rest: parseTime($('#iv-rest').value) || 0 };
      if (!(iv.reps >= 1) || !(work > 0)) throw new Error('Check interval settings');
      c.interval = iv; prefs.interval = iv;
      c.splitLen = 1e9; // splits are per rep
    } else if (setupMode === 'race') {
      c.goal = Math.round(+$('#in-race-distance').value);
      if (!(c.goal >= 100)) throw new Error('Race distance must be at least 100 m');
      prefs.raceDistance = c.goal;
      const opps = [];
      if (raceSel) {
        raceSel.presets.forEach((o, i) => { if (raceSel.selected.has(i)) opps.push(o); });
        raceSel.custom.forEach((o) => opps.push(o));
        if (raceSel.ghost) opps.push({ name: raceSel.ghost.name, type: 'ghost', samples: raceSel.ghost.samples });
      }
      c.opponents = opps;
    }
    prefs.mode = setupMode; savePrefs();
    return c;
  }

  // ---------------------------------------------------------------- completion
  function renderDone() {
    if (!W || !W.final) return;
    const f = W.final;
    $('#done-title').textContent = (W.completed ? 'Complete: ' : 'Ended: ') + goalLabel(W.cfg);
    let h = '<div class="sum-grid">' + [['Distance', fmtInt(f.distance) + ' m'], ['Time', fmtTime(f.elapsed, true)], ['Avg pace', fmtPace(f.avgPace)],
      ['Avg power', fmtInt(f.avgPower) + ' W'], ['Calories', fmtInt(f.calories)], ['Strokes', fmtInt(f.strokes)],
      ['Avg rate', f.avgSpm ? f.avgSpm.toFixed(1) : '--'], ['Max HR', W.maxHr ? Math.round(W.maxHr) : '--']]
      .map((x) => '<div class="s"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div></div>').join('') + '</div>';
    if (W.cfg.targetPace && f.avgPace) h += '<p>Target ' + fmtPace(W.cfg.targetPace, false) + ' /500m: you were <b class="' + (f.avgPace <= W.cfg.targetPace ? 'good' : 'bad') + '">' + fmtDelta(f.avgPace - W.cfg.targetPace) + ' s/500m</b></p>';
    if (W.cfg.mode === 'race') {
      const res = W.raceResults || fallbackRaceResults(W);
      h += '<h3>Race results</h3><table class="race-results">' + res.map((r, i) => '<tr class="' + (r.isUser ? 'me' : '') + '"><td>' + (i + 1) + '</td><td>' + esc(r.name) +
        '</td><td>' + (num(r.time) != null ? fmtTime(r.time, true) + (r.projected ? ' <span class="muted">(proj.)</span>' : '') : 'DNF') + '</td></tr>').join('') + '</table>';
    }
    if (W.splits.length) h += '<h3>Splits</h3><table class="splits"><thead><tr><th>#</th><th>Dist</th><th>Split</th><th>Pace</th><th>W</th><th>spm</th><th>HR</th></tr></thead><tbody>' + splitsHtml(W.splits) + '</tbody></table>';
    h += '<canvas class="detail-chart" id="c-done"></canvas>';
    $('#done-body').innerHTML = h;
    requestAnimationFrame(() => drawSessionChart($('#c-done'), W.samples, W.cfg.targetPace));
  }

  function drawSessionChart(c, samples, target) {
    if (!c || !c.clientWidth) return;
    const pts = normSamples(samples);
    const dpr = fitCanvas(c), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (pts.length < 2) { ctx.fillStyle = '#8a94a3'; ctx.font = 14 * dpr + 'px sans-serif'; ctx.fillText('No samples', 10 * dpr, 24 * dpr); return; }
    const t1 = pts[pts.length - 1].t;
    const step = t1 > 1800 ? 600 : t1 > 600 ? 300 : t1 > 180 ? 60 : 30;
    const ticks = []; for (let t = 0; t <= t1; t += step) ticks.push(t);
    drawSeriesChart(ctx, c.width, c.height, dpr, pts, { x: (p) => p.t, x0: 0, x1: t1, ticks, tickFmt: (t) => fmtTime(t), target });
  }

  // samples may come from other recorders with unix t / absolute distance: normalise to relative
  function normSamples(samples) {
    if (!samples || !samples.length) return [];
    const t0 = samples[0].t > 1e6 ? samples[0].t : 0;
    const d0 = samples[0].distance > 0 && t0 ? samples[0].distance : 0;
    return samples.filter((s) => num(s.t) != null).map((s) => Object.assign({}, s, { t: s.t - t0, distance: (num(s.distance) || 0) - d0, spm: s.spm != null ? s.spm : s.strokeRate, hr: s.hr != null ? s.hr : s.heartRate }));
  }

  // ---------------------------------------------------------------- history
  let histCache = null, histSel = null;
  async function loadSessions(forceReload) {
    if (histCache && !forceReload) return histCache;
    const r = await apiFetch('/api/sessions');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    histCache = (Array.isArray(j) ? j : j.sessions || []).slice().sort((a, b) => toMs(b.startedAt) - toMs(a.startedAt));
    return histCache;
  }
  function toMs(v) { if (num(v)) return v > 1e12 ? v : v * 1000; const d = Date.parse(v); return isFinite(d) ? d : 0; }
  function fmtDate(v, short) {
    const ms = toMs(v); if (!ms) return '?';
    const d = new Date(ms);
    return short ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) :
      d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function sumOf(s) {
    const su = s.summary || s;
    const o = { distance: num(su.distance), time: num(su.time) != null ? su.time : num(su.elapsed), avgPace: num(su.avgPace), avgPower: num(su.avgPower),
      calories: num(su.calories), strokes: num(su.strokes) != null ? su.strokes : num(su.strokeCount), avgSpm: num(su.avgSpm) != null ? su.avgSpm : num(su.avgStrokeRate), maxHr: num(su.maxHr) };
    if (!o.avgPace && o.distance > 0 && o.time) o.avgPace = (o.time * 500) / o.distance;
    return o;
  }
  function typeLabel(s) {
    const g = s.goal;
    if (g && typeof g === 'object') {
      try { return goalLabel({ mode: g.mode || s.type, goal: g.distance || g.time || g.calories, interval: g.interval }); } catch (e) { /* fallthrough */ }
    }
    return s.type || 'session';
  }

  async function renderHistory(forceReload) {
    const box = $('#hist-items');
    box.innerHTML = '<div class="muted">Loading…</div>';
    let list;
    try { list = await loadSessions(forceReload); } catch (e) { box.innerHTML = '<div class="err">Could not load: ' + esc(e.message) + '</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="muted">No sessions yet.</div>'; return; }
    box.innerHTML = list.map((s) => {
      const su = sumOf(s);
      return '<div class="hist-item' + (s.id === histSel ? ' sel' : '') + '" data-id="' + esc(s.id) + '"><div class="d">' + esc(fmtDate(s.startedAt)) + ' · ' + esc(typeLabel(s)) +
        '</div><div class="m">' + fmtInt(su.distance) + ' m · ' + fmtTime(su.time) + ' · ' + fmtPace(su.avgPace) + '</div></div>';
    }).join('');
    $$('.hist-item', box).forEach((it) => { it.onclick = () => showDetail(it.dataset.id); });
  }

  async function showDetail(id) {
    histSel = id;
    $$('.hist-item').forEach((it) => it.classList.toggle('sel', it.dataset.id === id));
    const box = $('#hist-detail');
    box.innerHTML = '<div class="muted">Loading…</div>';
    let s;
    try { const r = await apiFetch('/api/sessions/' + encodeURIComponent(id)); if (!r.ok) throw new Error('HTTP ' + r.status); s = await r.json(); }
    catch (e) { box.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; return; }
    const su = sumOf(s);
    const samples = normSamples(s.samples || []);
    let splits = Array.isArray(s.splits) && s.splits.length ? s.splits : computeSplits(samples, 500);
    let h = '<h3>' + esc(fmtDate(s.startedAt)) + ' · ' + esc(typeLabel(s)) + '</h3>' +
      '<div class="sum-grid">' + [['Distance', fmtInt(su.distance) + ' m'], ['Time', fmtTime(su.time, true)], ['Avg pace', fmtPace(su.avgPace)], ['Avg power', fmtInt(su.avgPower) + ' W'],
        ['Calories', fmtInt(su.calories)], ['Strokes', fmtInt(su.strokes)], ['Avg rate', su.avgSpm ? (+su.avgSpm).toFixed(1) : '--'], ['Max HR', su.maxHr || maxOf(samples, 'hr') || '--']]
        .map((x) => '<div class="s"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div></div>').join('') + '</div>';
    if (s.race && s.race.results) h += '<h3>Race</h3><table class="race-results">' + s.race.results.map((r, i) => '<tr class="' + (r.isUser ? 'me' : '') + '"><td>' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td>' + (num(r.time) != null ? fmtTime(r.time, true) : 'DNF') + '</td></tr>').join('') + '</table>';
    h += '<canvas class="detail-chart" id="c-detail"></canvas>';
    if (splits.length) h += '<h3>Splits</h3><table class="splits"><thead><tr><th>#</th><th>Dist</th><th>Split</th><th>Pace</th><th>W</th><th>spm</th><th>HR</th></tr></thead><tbody>' + splitsHtml(splits) + '</tbody></table>';
    if (samples.length > 2) h += '<div class="field"><button class="btn primary" id="btn-race-ghost">Race this ghost</button></div>';
    box.innerHTML = h;
    requestAnimationFrame(() => drawSessionChart($('#c-detail'), samples, s.goal && s.goal.targetPace));
    const rg = $('#btn-race-ghost');
    if (rg) rg.onclick = async () => {
      raceSel = raceSel || { presets: [], selected: new Set(), custom: [], ghost: null };
      raceSel.selected = new Set(); raceSel.custom = [];
      raceSel.ghost = { id, name: 'Ghost ' + fmtDate(s.startedAt, true), samples: samples.map((p) => ({ t: p.t, distance: p.distance })) };
      const d = su.distance ? Math.min(Math.round(su.distance / 100) * 100, Math.floor(samples[samples.length - 1].distance)) : prefs.raceDistance;
      prefs.raceDistance = d > 100 ? d : prefs.raceDistance;
      openSetup('race');
    };
  }
  const maxOf = (arr, k) => arr.reduce((m, s) => (num(s[k]) && s[k] > m ? s[k] : m), 0) || null;

  function computeSplits(samples, L) {
    const out = [];
    if (samples.length < 2) return out;
    let start = { d: 0, t: 0, i: 0 };
    const total = samples[samples.length - 1].distance;
    for (let d = L; d <= total; d += L) {
      const t = timeAtDistance(samples, d);
      const seg = samples.filter((s) => s.distance > start.d && s.distance <= d);
      const avg = (k) => { const v = seg.map((s) => s[k]).filter((x) => num(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const pw = avg('power'), sp = avg('spm'), hr = avg('hr');
      out.push({ n: out.length + 1, distance: d, time: Math.round((t - start.t) * 10) / 10, pace: Math.round((t - start.t) * 10) / 10 * 500 / L,
        power: pw && Math.round(pw), spm: sp && Math.round(sp * 10) / 10, hr: hr && Math.round(hr) });
      start = { d, t };
    }
    return out;
  }

  // ---------------------------------------------------------------- views + wiring
  function showView(v) {
    prefs.view = v; savePrefs();
    $('#live').hidden = v !== 'live';
    $('#history').hidden = v !== 'history';
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    if (v === 'history') renderHistory(true);
    else resizeCanvases();
  }

  $$('.tab').forEach((t) => { t.onclick = () => showView(t.dataset.view); });
  $('#btn-setup').onclick = () => openSetup();
  $('#btn-quick-free').onclick = () => { startWorkout({ mode: 'free', splitLen: prefs.splitLen, targetPace: parseTime(prefs.target) }); };
  $('#btn-quick-2k').onclick = () => { setupMode = 'distance'; prefs.distance = 2000; openSetup('distance'); };
  $('#btn-quick-race').onclick = () => openSetup('race');
  $('#btn-end').onclick = () => {
    if (!(W && W.active)) return;
    // TV: window.confirm is unreliable on Tizen; use the remote-friendly dialog from tvnav.js
    if (window.SkillRowTV && window.SkillRowTV.confirm) window.SkillRowTV.confirm('End this workout and save it?', () => { if (W && W.active) finishWorkout(false); }, { yes: 'End & save', no: 'Keep rowing' });
    else if (confirm('End this workout and save it?')) finishWorkout(false);
  };
  $('#btn-hist-refresh').onclick = () => renderHistory(true);
  $('#btn-fs').onclick = toggleFs;
  $('#btn-done-again').onclick = () => { closeOverlays(); if (W) { const cfg = Object.assign({}, W.cfg); startWorkout(cfg); } };
  $$('[data-close]').forEach((b) => { b.onclick = closeOverlays; });
  $$('.overlay').forEach((o) => o.addEventListener('mousedown', (e) => { if (e.target === o) closeOverlays(); }));
  $('#mode-seg').onclick = (e) => { const b = e.target.closest('button'); if (b) { setupMode = b.dataset.mode; renderSetup(); } };
  $('#setup-body').addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) {
      prefs[p.dataset.preset] = +p.dataset.v;
      const inp = { distance: '#in-distance', time: '#in-time', calories: '#in-calories', raceDistance: '#in-race-distance' }[p.dataset.preset];
      $$('[data-preset="' + p.dataset.preset + '"]').forEach((b) => b.classList.toggle('sel', b === p));
      if (inp && $(inp)) $(inp).value = p.dataset.preset === 'time' ? fmtTime(+p.dataset.v) : p.dataset.v;
      return;
    }
    const ivb = e.target.closest('[data-iv]');
    if (ivb) {
      const a = JSON.parse(ivb.dataset.iv);
      $('#iv-reps').value = a[0]; $('#iv-type').value = a[1]; $('#iv-work').value = a[1] === 'distance' ? a[2] : fmtTime(a[2]); $('#iv-rest').value = fmtTime(a[3]);
    }
  });
  $('#btn-start').onclick = () => {
    let cfg;
    try { cfg = readSetup(); } catch (e) { $('#setup-err').textContent = e.message; return; }
    closeOverlays();
    beep(880, 0.08, 1); // also unlocks audio on user gesture
    startWorkout(cfg);
  };

  function toggleFs() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } catch (e) { /* ignore */ }
  }
  document.addEventListener('fullscreenchange', resizeCanvases);
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) { if (e.key === 'Enter' && !$('#setup').hidden) $('#btn-start').click(); return; }
    if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.key === 'Escape') closeOverlays();
    else if ((e.key === 'n' || e.key === 'N') && !(W && W.active)) openSetup();
  });
  window.addEventListener('beforeunload', (e) => { if (W && W.active && W.samples.length > 10) { e.preventDefault(); e.returnValue = ''; } });

  // debug handle
  window.SkillRowApp = { get workout() { return W; }, live, trend, force, startWorkout, finishWorkout, rel };

  showView('live');
  renderConn();
  connect();
  flushUnsaved();
  requestAnimationFrame(frame);

  // test hook for simulator screenshots: ?demo=free|race|setup|history|done (use with ?fake=1; done rows 20 s, then ends + saves)
  const demo = (/[?&]demo=(\w+)/.exec(location.search) || [])[1];
  if (demo) {
    setTimeout(() => {
      if (demo === 'done') { startWorkout({ mode: 'free', splitLen: 100, targetPace: null }); setTimeout(() => finishWorkout(false), 20000); }
      else if (demo === 'free') startWorkout({ mode: 'free', splitLen: 500, targetPace: null });
      else if (demo === 'race') startWorkout({ mode: 'race', splitLen: 500, targetPace: null, goal: 2000, opponents: window.SkillRowRace ? window.SkillRowRace.presetOpponents(null).slice(0, 3) : [] });
      else if (demo === 'setup') openSetup((/[?&]mode=(\w+)/.exec(location.search) || [])[1] || 'distance');
      else if (demo === 'history') { showView('history'); setTimeout(() => { const it = $('.hist-item'); if (it) it.click(); }, 800); }
    }, 1500);
  }
})();

/*
 * SkillRow Race module  (window.SkillRowRace)
 * ------------------------------------------------------------------------
 * Plain vanilla JS, no dependencies. Renders a top-down regatta course on a
 * single <canvas> (scaled with ResizeObserver + devicePixelRatio) with:
 *   - lanes, buoy lines, 100/250 m markers, start + finish line
 *   - one sculling boat per competitor, oars animated from stroke rate
 *   - camera that follows the user's boat (auto-zooms to keep rivals in view)
 *   - top bar: position + metres to go, and a full-course progress strip
 *   - leaderboard with gap to the user in metres and seconds
 *   - overtake callouts, final-500 m banner, 3-2-1-GO countdown, results
 *
 * TIMING MODEL (important for fairness):
 *   Opponents move on RACE TIME = wall-clock seconds since "GO", measured
 *   with performance.now(). They do NOT use the user's `elapsed` value.
 *   The user's position comes only from race.update({distance, ...}).
 *   So ghosts and pacers run at true real-time speed regardless of how
 *   often (or late) update() is called. The user's finish time, however,
 *   is taken from the `elapsed` values passed to update() (interpolated
 *   to the exact crossing of the finish line); if `elapsed` is omitted,
 *   race time is used instead. The integrator should therefore make the
 *   user's distance/elapsed start at 0 at GO (e.g. subtract the machine's
 *   values captured at GO) so both clocks share the same origin.
 *
 * API
 *   const race = SkillRowRace.create(containerEl, {
 *     distance: 2000,
 *     opponents: [ {name, type:'constant', pace, color?},
 *                  {name, type:'ghost', samples:[{t, distance, strokeRate?}]},
 *                  {name, type:'profile', basePace, profile:'fly-and-die'|'negative-split'|'even'|'surge'},
 *                  {name, type:'adaptive', offset} ],
 *     // optional extras:
 *     userName: 'You', userColor: '#ffcc33',
 *     timeScale: 1          // test-only: speeds up race time (sim harness)
 *   });
 *   race.update({distance, elapsed, pace, strokeRate});
 *   race.start(); race.reset(); race.destroy();
 *   race.onFinish = results => {}   // [{name, time, isUser, projected}] sorted by time
 *   race.onEvent  = e => {}         // {kind:'countdown', n} | {kind:'go'} |
 *                                   // {kind:'overtake', who, by:'user'|'opponent'} |
 *                                   // {kind:'final500'} | {kind:'opponentFinish', who, time} |
 *                                   // {kind:'finish', results}
 *   race.configure({distance?, opponents?})  // extra: rebuild + reset
 *   race.getStandings()                      // extra: current leaderboard data
 *   SkillRowRace.presetOpponents(userAvgPace) // -> opponent config list
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- helpers
  var FONT = 'system-ui, -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
  var PALETTE = ['#4cc9f0', '#f45b8d', '#7ae582', '#b39dff', '#ff9248', '#2ee6c5', '#ff6b6b', '#c6f432', '#5aa9ff', '#e9a6ff'];
  var USER_COLOR = '#ffcc33';
  var DEFAULT_PACE = 130; // 2:10 /500m

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v) { v = +v; return isFinite(v) ? v : null; }
  function easeOut(t) { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); }
  function hash(a, b) {
    var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function hexRgb(hex) {
    hex = String(hex || '#888').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex.slice(0, 6), 16);
    if (!isFinite(n)) n = 0x888888;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) { var c = hexRgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function shade(hex, f) { // f>0 lighten, f<0 darken
    var c = hexRgb(hex);
    for (var i = 0; i < 3; i++) c[i] = Math.round(f >= 0 ? c[i] + (255 - c[i]) * f : c[i] * (1 + f));
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }
  function fmtTime(s) {
    if (s == null || !isFinite(s) || s < 0) return '--:--';
    var tenths = Math.round(s * 10), m = Math.floor(tenths / 600), rem = tenths - m * 600;
    var sec = Math.floor(rem / 10), t = rem % 10;
    return m + ':' + (sec < 10 ? '0' : '') + sec + '.' + t;
  }
  function fmtClock(s) {
    if (s == null || !isFinite(s) || s < 0) s = 0;
    var tot = Math.floor(s), m = Math.floor(tot / 60), sec = tot - m * 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function fmtPace(p) {
    var t = Math.round(p), m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function rateForPace(p) { return clamp(18 + (150 - p) * 0.33, 17, 42); }
  function rrect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fitText(ctx, str, maxW) {
    if (ctx.measureText(str).width <= maxW) return str;
    var s = str;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }
  function font(px, weight) { return (weight || 600) + ' ' + Math.round(px) + 'px ' + FONT; }

  // ------------------------------------------------------------------- CSS
  var CSS = '' +
    '.srr-root{position:relative;width:100%;height:100%;min-height:300px;overflow:hidden;' +
    'background:#061220;border-radius:12px;user-select:none;-webkit-user-select:none;}' +
    '.srr-root canvas.srr-canvas{position:absolute;top:0;left:0;right:0;bottom:0;display:block;width:100%;height:100%;}';
  function injectCSS() {
    if (typeof document === 'undefined' || document.getElementById('srr-style')) return;
    var st = document.createElement('style');
    st.id = 'srr-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ------------------------------------------------------ opponent models
  // Piecewise-linear (t, d) table; used for ghosts and precomputed profiles.
  function makeTable(ts, ds, rates) {
    var n = ts.length;
    var endSpeed = 500 / DEFAULT_PACE;
    if (n >= 2) {
      var j = n - 1;
      while (j > 0 && ts[n - 1] - ts[j] < 30) j--;
      var dt = ts[n - 1] - ts[j], dd = ds[n - 1] - ds[j];
      if (dt > 0 && dd > 0) endSpeed = dd / dt;
      else if (ts[n - 1] > 0 && ds[n - 1] > 0) endSpeed = ds[n - 1] / ts[n - 1];
    }
    function distAt(t) {
      if (t <= ts[0]) return ts[0] > 0 ? ds[0] * Math.max(0, t) / ts[0] : ds[0];
      if (t >= ts[n - 1]) return ds[n - 1] + (t - ts[n - 1]) * endSpeed;
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
      var span = ts[hi] - ts[lo];
      return span > 0 ? lerp(ds[lo], ds[hi], (t - ts[lo]) / span) : ds[hi];
    }
    function timeAt(d) {
      if (d <= ds[0]) return ds[0] > 0 ? ts[0] * d / ds[0] : ts[0];
      if (d > ds[n - 1]) return ts[n - 1] + (d - ds[n - 1]) / endSpeed;
      var lo = 0, hi = n - 1; // smallest hi with ds[hi] >= d
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ds[mid] >= d) hi = mid; else lo = mid; }
      var span = ds[hi] - ds[lo];
      return span > 0 ? lerp(ts[lo], ts[hi], (d - ds[lo]) / span) : ts[hi];
    }
    function rateAt(t) {
      if (!rates) return rateForPace(500 / Math.max(0.5, (distAt(t + 2) - distAt(Math.max(0, t - 2))) / (t + 2 - Math.max(0, t - 2))));
      var lo = 0, hi = n - 1;
      if (t <= ts[0]) return rates[0];
      if (t >= ts[n - 1]) return rates[n - 1];
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
      return rates[lo];
    }
    return { distAt: distAt, timeAt: timeAt, rateAt: rateAt };
  }

  function ghostTable(samples) {
    var arr = (samples || []).filter(function (s) { return s && isFinite(+s.t) && isFinite(+s.distance); })
      .map(function (s) { return { t: +s.t, d: +s.distance, r: num(s.strokeRate != null ? s.strokeRate : s.spm) }; })
      .sort(function (a, b) { return a.t - b.t; });
    if (!arr.length || arr[0].t > 0) arr.unshift({ t: 0, d: 0, r: arr.length ? arr[0].r : null });
    var ts = [], ds = [], rs = [], maxD = 0, haveRates = false;
    for (var i = 0; i < arr.length; i++) {
      if (ts.length && arr[i].t <= ts[ts.length - 1]) continue;
      maxD = Math.max(maxD, arr[i].d); // enforce monotonic distance
      ts.push(arr[i].t); ds.push(maxD);
      rs.push(arr[i].r != null && arr[i].r > 0 ? arr[i].r : null);
      if (arr[i].r > 0) haveRates = true;
    }
    if (ts.length === 1) { ts.push(1); ds.push(500 / DEFAULT_PACE); rs.push(null); }
    if (haveRates) { var last = 24; for (var k = 0; k < rs.length; k++) { if (rs[k] == null) rs[k] = last; else last = rs[k]; } }
    return makeTable(ts, ds, haveRates ? rs : null);
  }

  function profileOffset(kind, f, d) {
    var off = 0;
    switch (kind) {
      case 'fly-and-die': off = -9 + 20 * Math.pow(f, 1.3); break;        // fast start, fades hard
      case 'negative-split': off = 5 - 9 * f; if (f > 0.875) off -= 4; break; // builds, sprints home
      case 'surge': off = ((d % 400) / 400) < 0.25 ? -7 : 2.5; break;      // 100 m pushes every 400 m
      default: off = 0;
    }
    if (d < 150) off -= 6 * (1 - d / 150); // racing start
    return off;
  }

  function profileTable(basePace, kind, D) {
    var dt = 0.1, t = 0, d = 0, v = 0, ts = [0], ds = [0], rs = [rateForPace(basePace) + 6];
    var maxT = Math.max(600, D / 500 * basePace * 3);
    while (d < D + 80 && t < maxT) {
      var off = profileOffset(kind, clamp(d / D, 0, 1), d);
      var pace = clamp(basePace + off, 70, 300);
      var target = 500 / pace;
      v += (target - v) * (1 - Math.exp(-dt / (t < 4 ? 0.9 : 1.6)));
      d += v * dt; t += dt;
      ts.push(t); ds.push(d);
      rs.push(rateForPace(pace) + (d < 150 ? 6 : 0) + (kind === 'surge' && off < 0 ? 3 : 0));
    }
    return makeTable(ts, ds, rs);
  }

  // ------------------------------------------------------------- presets
  function presetOpponents(userAvgPace) {
    var p = num(userAvgPace);
    if (!p || p <= 0) p = DEFAULT_PACE;
    p = clamp(p, 85, 220);
    var fast = Math.round(p - 3), slow = Math.round(p + 4);
    return [
      { name: 'Pacer ' + fmtPace(fast), type: 'constant', pace: fast },
      { name: 'Pacer ' + fmtPace(slow), type: 'constant', pace: slow },
      { name: 'Fly & Die', type: 'profile', basePace: Math.round(p - 1), profile: 'fly-and-die' },
      { name: 'Negative Split', type: 'profile', basePace: Math.round(p), profile: 'negative-split' },
      { name: 'Rival', type: 'adaptive', offset: -1.5 },
      { name: 'World Class 1:30', type: 'constant', pace: 90 }
    ];
  }

  // --------------------------------------------------------------- create
  function create(container, options) {
    if (!container) throw new Error('SkillRowRace.create: container element required');
    injectCSS();
    options = options || {};
    var timeScale = num(options.timeScale) > 0 ? +options.timeScale : 1;
    var userName = options.userName || 'You';
    var userColor = options.userColor || USER_COLOR;

    var root = document.createElement('div');
    root.className = 'srr-root';
    var canvas = document.createElement('canvas');
    canvas.className = 'srr-canvas';
    root.appendChild(canvas);
    container.appendChild(root);
    var ctx = canvas.getContext('2d');

    var api = { onFinish: null, onEvent: null };
    var W = 1, H = 1, dpr = 1, L = null;
    var raf = 0, lastFrame = 0, destroyed = false;

    // race state
    var D = 2000, opps = [], nLanes = 1, userLane = 0;
    var state = 'idle', goAt = 0, lastCountN = 0;
    var userFinished = false, results = null, showResults = false, resultsAt = 0;
    var final500 = false, viewM = 60, callouts = [], puddles = [];
    var user;

    function emit(e) {
      if (typeof api.onEvent === 'function') { try { api.onEvent(e); } catch (err) { console.error(err); } }
    }
    function raceTime(now) {
      return state === 'racing' ? Math.max(0, (now - goAt) / 1000 * timeScale) : 0;
    }
    function freshUser() {
      return { d: 0, disp: 0, elapsed: 0, pace: 0, rate: 0, speed: 0, lastWall: null, hist: [],
        phase: 0, finishTime: null, lane: 0, color: userColor, name: userName, isUser: true, puddleDone: false };
    }

    function buildOpponents(list) {
      opps = [];
      (list || []).forEach(function (cfg, i) {
        if (!cfg) return;
        var o = {
          cfg: cfg, name: String(cfg.name || ('Boat ' + (i + 1))), type: cfg.type || 'constant',
          color: cfg.color || PALETTE[i % PALETTE.length], isUser: false,
          d: 0, disp: 0, prevD: 0, vel: 0, phase: hash(i, 7), rate: 24,
          finishTime: null, finishEmitted: false, tFinish: null, model: null,
          rel: 0, lastCallout: -1e9, simT: 0, aSpeed: 0, seed: hash(i, 99) * 10, puddleDone: false
        };
        if (o.type === 'constant') {
          var pace = num(cfg.pace) > 0 ? +cfg.pace : DEFAULT_PACE;
          o.model = { distAt: function (t) { return Math.max(0, t) * 500 / pace; },
            timeAt: function (d) { return d * pace / 500; }, rateAt: function () { return rateForPace(pace); } };
        } else if (o.type === 'ghost') {
          o.model = ghostTable(cfg.samples);
        } else if (o.type === 'profile') {
          var bp = num(cfg.basePace) > 0 ? +cfg.basePace : (num(cfg.pace) > 0 ? +cfg.pace : DEFAULT_PACE);
          o.model = profileTable(bp, cfg.profile || 'even', D);
        } else { // adaptive
          o.type = 'adaptive';
          o.offset = num(cfg.offset) != null ? +cfg.offset : -2;
        }
        if (o.model) o.tFinish = o.model.timeAt(D);
        opps.push(o);
      });
      nLanes = opps.length + 1;
      userLane = Math.floor(opps.length / 2);
      var lane = 0;
      opps.forEach(function (o) { if (lane === userLane) lane++; o.lane = lane++; });
    }

    function resetState() {
      state = 'idle'; goAt = 0; lastCountN = 0;
      userFinished = false; results = null; showResults = false;
      final500 = false; viewM = 60; callouts = []; puddles = [];
      user = freshUser(); user.lane = userLane;
      opps.forEach(function (o, i) {
        o.d = o.disp = o.prevD = o.vel = 0; o.finishTime = null; o.finishEmitted = false;
        o.rel = 0; o.lastCallout = -1e9; o.simT = 0; o.aSpeed = 0; o.phase = hash(i, 7);
      });
    }

    function configure(opts) {
      opts = opts || {};
      if (num(opts.distance) > 0) D = +opts.distance;
      buildOpponents(opts.opponents !== undefined ? opts.opponents : opps.map(function (o) { return o.cfg; }));
      resetState();
      L = layout();
    }

    // ------------------------------------------------------ user tracking
    function userRollingPace() {
      var h = user.hist;
      if (h.length >= 2) {
        var a = h[0], b = h[h.length - 1];
        if (b.t - a.t >= 3 && b.d > a.d) return clamp(500 * (b.t - a.t) / (b.d - a.d), 70, 300);
      }
      return user.pace > 0 ? clamp(user.pace, 70, 300) : null;
    }

    function update(data) {
      if (!data || destroyed) return;
      var now = performance.now();
      var d = num(data.distance);
      if (d == null) return;
      var e = num(data.elapsed);
      var prevD = user.d, prevE = user.elapsed, prevWall = user.lastWall;
      user.d = Math.max(0, d);
      user.elapsed = e != null ? e : raceTime(now);
      user.pace = num(data.pace) > 0 ? +data.pace : 0;
      user.rate = num(data.strokeRate) > 0 ? +data.strokeRate : 0;
      if (user.pace > 0 && user.pace < 600) user.speed = 500 / user.pace;
      else if (prevWall != null && now > prevWall) user.speed = Math.max(0, (user.d - prevD) / ((now - prevWall) / 1000 * timeScale));
      else user.speed = 0;
      var ht = now / 1000 * timeScale;
      user.hist.push({ t: ht, d: user.d });
      while (user.hist.length > 2 && ht - user.hist[0].t > 20) user.hist.shift();
      if (Math.abs(user.d - user.disp) > 40) user.disp = user.d;
      user.lastWall = now;

      if (!userFinished && state !== 'idle' && user.d >= D) {
        var t = user.elapsed;
        if (prevD < D && user.d > prevD && user.elapsed > prevE) {
          t = prevE + (D - prevD) / (user.d - prevD) * (user.elapsed - prevE);
        }
        finishUser(t, now);
      }
    }

    function oppTime(o, rt) {
      if (o.finishTime != null) return { time: o.finishTime, projected: false };
      if (o.model) return { time: o.tFinish, projected: rt < o.tFinish };
      var v = Math.max(0.5, o.aSpeed || 500 / DEFAULT_PACE);
      return { time: rt + Math.max(0, D - o.d) / v, projected: true };
    }

    function finishUser(t, now) {
      userFinished = true;
      user.finishTime = t;
      var rt = raceTime(now);
      var res = [{ name: userName, time: t, isUser: true, projected: false }];
      opps.forEach(function (o) {
        var ot = oppTime(o, rt);
        res.push({ name: o.name, time: ot.time, isUser: false, projected: ot.projected, color: o.color });
      });
      res.sort(function (a, b) { return a.time - b.time; });
      results = res; showResults = true; resultsAt = now;
      var pos = res.findIndex(function (r) { return r.isUser; }) + 1;
      pushCallout('Finished ' + ordinal(pos) + '!  ' + fmtTime(t), '#ffcc33', now);
      emit({ kind: 'finish', results: res });
      if (typeof api.onFinish === 'function') { try { api.onFinish(res); } catch (err) { console.error(err); } }
    }

    function start() {
      if (destroyed) return;
      resetState();
      state = 'countdown';
      goAt = performance.now() + 3000;
      lastCountN = 0;
    }

    function pushCallout(text, color, now) {
      callouts.push({ text: text, color: color, born: null, queued: now });
      if (callouts.length > 4) callouts.splice(0, callouts.length - 4);
    }

    // ----------------------------------------------------------- simulate
    function coast(d) { return d <= D ? d : D + 20 * (1 - Math.exp(-(d - D) / 20)); }

    function simulate(now, dt) {
      if (state === 'countdown') {
        var rem = (goAt - now) / 1000;
        var n = Math.ceil(rem);
        if (rem > 0 && n !== lastCountN && n <= 3) { lastCountN = n; emit({ kind: 'countdown', n: n }); }
        if (now >= goAt) { state = 'racing'; emit({ kind: 'go' }); }
      }
      var rt = raceTime(now);
      var sdt = dt * timeScale;

      // user display position: extrapolate from last update, ease toward it
      var predicted = user.d;
      if (user.lastWall != null && state === 'racing') {
        predicted = user.d + user.speed * Math.min((now - user.lastWall) / 1000 * timeScale, 2.5 * timeScale);
      }
      if (userFinished) predicted = coast(predicted); // drift to a stop past the line
      user.disp += (predicted - user.disp) * (1 - Math.exp(-dt * 5 * Math.sqrt(timeScale)));
      var stale = user.lastWall == null || (now - user.lastWall) > 4000;
      var urate = stale ? 0 : user.rate || (user.speed > 0.5 ? rateForPace(500 / user.speed) : 0);
      if (state === 'racing' && urate > 0) user.phase = (user.phase + sdt * urate / 60) % 1;
      user.animRate = state === 'racing' ? urate : 0;

      // opponents
      var refPace = userRollingPace();
      opps.forEach(function (o) {
        o.prevD = o.d;
        if (state !== 'racing') { o.d = 0; }
        else if (o.model) {
          o.d = o.model.distAt(rt);
          o.rate = o.model.rateAt(rt);
          if (!o.finishEmitted && rt >= o.tFinish) { o.finishTime = o.tFinish; }
        } else {
          // adaptive rival: follows the user's rolling pace + offset, rubber-banded
          var steps = 0;
          while (o.simT < rt - 1e-6 && steps < 20000) {
            var h = Math.min(0.1, rt - o.simT);
            var target = clamp((refPace || DEFAULT_PACE) + o.offset, 75, 240);
            var v = 500 / target;
            var gap = o.d - user.disp;
            v *= 1 + clamp(-gap / 40, -0.18, 0.18);
            v *= 1 + 0.025 * Math.sin(o.simT / 7 + o.seed);
            if (o.d >= D) v *= 0.6;
            o.aSpeed += (v - o.aSpeed) * (1 - Math.exp(-h / (o.simT < 4 ? 0.8 : 2)));
            var nd = o.d + o.aSpeed * h;
            if (o.finishTime == null && o.d < D && nd >= D) o.finishTime = o.simT + h * (D - o.d) / (nd - o.d);
            o.d = nd; o.simT += h; steps++;
          }
          o.rate = rateForPace(500 / Math.max(0.5, o.aSpeed));
        }
        if (o.finishTime != null && !o.finishEmitted) {
          o.finishEmitted = true;
          emit({ kind: 'opponentFinish', who: o.name, time: o.finishTime });
          if (!userFinished) pushCallout(o.name + ' finished  ' + fmtTime(o.finishTime), '#9fb3c8', now);
        }
        o.disp = coast(o.d);
        var inst = dt > 0 ? (o.d - o.prevD) / sdt : 0;
        if (isFinite(inst)) o.vel += (inst - o.vel) * (1 - Math.exp(-dt * 3));
        var coasting = o.d > D + 5;
        o.animRate = state === 'racing' && !coasting ? o.rate : 0;
        if (o.animRate > 0) o.phase = (o.phase + sdt * o.animRate / 60) % 1;
      });

      // overtakes (relative to user display position)
      if (state === 'racing') {
        var eventsOn = rt > 8 && user.disp > 25 && !userFinished;
        opps.forEach(function (o) {
          var diff = o.disp - user.disp, nr = o.rel;
          if (diff > 1) nr = 1; else if (diff < -1) nr = -1;
          if (nr !== o.rel) {
            if (o.rel !== 0 && eventsOn && o.d < D) {
              var by = nr < 0 ? 'user' : 'opponent';
              emit({ kind: 'overtake', who: o.name, by: by });
              if (now - o.lastCallout > 4000) {
                o.lastCallout = now;
                pushCallout(by === 'user' ? 'You passed ' + o.name + '!' : o.name + ' passed you',
                  by === 'user' ? '#5ef0a0' : '#ff7b7b', now);
              }
            }
            o.rel = nr;
          }
        });
        if (!final500 && D > 500 && user.disp >= D - 500 && !userFinished) {
          final500 = true;
          emit({ kind: 'final500' });
          pushCallout('FINAL 500 m', '#ffcc33', now);
        }
      }

      // camera zoom: keep nearby rivals in view
      var ahead = 0, behind = 0;
      opps.forEach(function (o) {
        var g = o.disp - user.disp;
        if (g > 0 && g < 110) ahead = Math.max(ahead, g);
        if (g < 0 && -g < 70) behind = Math.max(behind, -g);
      });
      var targetView = clamp(Math.max(55, (ahead + 12) / 0.58, (behind + 10) / 0.34), 55, 150);
      viewM += (targetView - viewM) * (1 - Math.exp(-dt * 0.8));

      // callouts
      if (callouts.length) {
        var c0 = callouts[0];
        if (c0.born == null) c0.born = now;
        var life = callouts.length > 1 ? 1800 : 2600;
        if (now - c0.born > life) callouts.shift();
      }
      // puddles
      for (var i = puddles.length - 1; i >= 0; i--) if (now - puddles[i].born > 3200) puddles.splice(i, 1);
    }

    // ------------------------------------------------------------- layout
    function layout() {
      var n = nLanes;
      var fs = clamp(Math.min(W / 30, H / 23), 11, 30);
      var pad = Math.round(clamp(fs * 0.55, 6, 16));
      var topH = clamp(Math.max(fs * 3.7, n * Math.max(6, fs * 0.36) + fs * 1.5), 48, H * 0.27);
      var hudW = clamp(fs * 8.8, 110, W * 0.36);
      var hud = { x: pad, y: pad, w: hudW, h: topH };
      var mini = { x: pad * 2 + hudW, y: pad, w: W - hudW - pad * 3, h: topH };
      var y0 = pad * 2 + topH;
      var wide = W / H >= 1.3 && W >= 700;
      var rowH = clamp(fs * 1.65, 18, 64), headH = fs * 1.7;
      var board, course;
      if (wide) {
        var bw = clamp(W * 0.27, 240, 470);
        board = { x: W - pad - bw, y: y0, w: bw, h: Math.min(H - y0 - pad, headH + n * rowH + pad) };
        course = { x: pad, y: y0, w: W - bw - pad * 3, h: H - y0 - pad };
      } else {
        var bh = Math.min(headH + n * rowH + pad, (H - y0) * 0.4);
        board = { x: pad, y: H - pad - bh, w: W - pad * 2, h: bh };
        course = { x: pad, y: y0, w: W - pad * 2, h: board.y - pad - y0 };
      }
      rowH = Math.min(rowH, (board.h - headH - pad * 0.5) / Math.max(1, n));
      course.h = Math.max(40, course.h);
      return { fs: fs, pad: pad, hud: hud, mini: mini, board: board, course: course, rowH: rowH, headH: headH, wide: wide };
    }

    function resize() {
      var r = root.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      dpr = global.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      L = layout();
    }

    // ---------------------------------------------------------- standings
    function standings(now) {
      var rt = raceTime(now);
      var ref = 500 / (userRollingPace() || DEFAULT_PACE);
      var list = [{ ref: user, name: userName, color: userColor, isUser: true, d: user.disp,
        finished: userFinished, time: user.finishTime }];
      opps.forEach(function (o) {
        list.push({ ref: o, name: o.name, color: o.color, isUser: false, d: o.disp,
          finished: o.finishTime != null, time: o.finishTime });
      });
      list.forEach(function (e) {
        if (e.isUser) { e.gapM = 0; e.gapS = 0; return; }
        e.gapM = e.d - user.disp;
        if (e.finished && userFinished) e.gapS = user.finishTime - e.time;
        else e.gapS = e.gapM / (e.gapM > 0 ? ref : Math.max(0.5, e.ref.vel || ref));
      });
      list.sort(function (a, b) {
        if (a.finished && b.finished) return a.time - b.time;
        if (a.finished) return -1;
        if (b.finished) return 1;
        return b.d - a.d;
      });
      list.forEach(function (e, i) { e.pos = i + 1; });
      return { list: list, rt: rt };
    }

    // ----------------------------------------------------------- drawing
    function draw(now) {
      if (!L) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      var bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#071423'); bg.addColorStop(1, '#040b14');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      var st = standings(now);
      drawCourse(now);
      drawHud(st);
      drawMini();
      drawBoard(st);
      drawOverlays(now);
    }

    function drawCourse(now) {
      var c = L.course, fs = L.fs, n = nLanes;
      var laneH = c.h / n;
      var pxPerM = c.w / viewM;
      var camX = user.disp - viewM * 0.38;
      var X = function (m) { return c.x + (m - camX) * pxPerM; };
      var laneY = function (i) { return c.y + laneH * (i + 0.5); };

      ctx.save();
      rrect(ctx, c.x, c.y, c.w, c.h, Math.min(14, fs * 0.6));
      ctx.clip();
      var g = ctx.createLinearGradient(0, c.y, 0, c.y + c.h);
      g.addColorStop(0, '#0b3550'); g.addColorStop(0.5, '#0d4363'); g.addColorStop(1, '#0a3049');
      ctx.fillStyle = g; ctx.fillRect(c.x, c.y, c.w, c.h);

      // finish zone tint + beyond-finish
      var xf = X(D);
      if (xf < c.x + c.w) {
        ctx.fillStyle = 'rgba(255,204,51,0.05)';
        ctx.fillRect(Math.max(c.x, X(D - 250)), c.y, Math.min(c.x + c.w, xf) - Math.max(c.x, X(D - 250)), c.h);
      }

      // user lane highlight
      ctx.fillStyle = 'rgba(255,214,90,0.07)';
      ctx.fillRect(c.x, c.y + laneH * userLane, c.w, laneH);

      // ripples (world-anchored so they scroll with the camera)
      var cell = 6, k0 = Math.floor(camX / cell) - 1, k1 = Math.ceil((camX + viewM) / cell) + 1;
      ctx.lineWidth = Math.max(1, laneH * 0.025);
      ctx.lineCap = 'round';
      var tt = now / 1000;
      for (var li = 0; li < n; li++) {
        for (var k = k0; k <= k1; k++) {
          var r1 = hash(k, li * 31 + 1), r2 = hash(k, li * 31 + 2), r3 = hash(k, li * 31 + 3);
          var x = X(k * cell + r1 * cell);
          var y = c.y + laneH * li + laneH * (0.12 + 0.76 * r2) + Math.sin(tt * 0.8 + r3 * 6) * laneH * 0.02;
          var len = (0.6 + r3 * 1.4) * pxPerM;
          ctx.strokeStyle = 'rgba(180,225,255,' + (0.05 + 0.07 * r3) + ')';
          ctx.beginPath();
          ctx.moveTo(x - len / 2, y);
          ctx.quadraticCurveTo(x, y - laneH * 0.04, x + len / 2, y);
          ctx.stroke();
        }
      }

      // distance markers
      var m0 = Math.max(0, Math.ceil(camX / 50) * 50), m1 = Math.min(D - 1, camX + viewM);
      ctx.textBaseline = 'top';
      for (var m = m0; m <= m1; m += 50) {
        var major = m % 250 === 0, minor = m % 100 === 0;
        if (!major && !minor) continue;
        var mx = X(m);
        ctx.strokeStyle = major ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.14)';
        ctx.lineWidth = major ? 2 : 1;
        ctx.setLineDash(major ? [] : [6, 6]);
        ctx.beginPath(); ctx.moveTo(mx, c.y); ctx.lineTo(mx, c.y + c.h); ctx.stroke();
        ctx.setLineDash([]);
        if (m > 0) {
          var label = (D - m) + ' m';
          ctx.font = font(major ? fs * 0.85 : fs * 0.65, 700);
          var tw = ctx.measureText(label).width + fs * 0.6;
          ctx.fillStyle = major ? 'rgba(6,18,32,0.75)' : 'rgba(6,18,32,0.5)';
          rrect(ctx, mx - tw / 2, c.y + 4, tw, (major ? fs * 0.85 : fs * 0.65) + fs * 0.35, 5); ctx.fill();
          ctx.fillStyle = major ? '#e8f1f8' : 'rgba(232,241,248,0.7)';
          ctx.textAlign = 'center';
          ctx.fillText(label, mx, c.y + 4 + fs * 0.18);
        }
      }

      // buoy lines
      var bs = 5, b0 = Math.floor(camX / bs), b1 = Math.ceil((camX + viewM) / bs);
      var br = clamp(laneH * 0.045, 1.5, 4.5);
      for (var bl = 0; bl <= n; bl++) {
        var by = c.y + laneH * bl;
        if (bl === 0) by += br + 1; else if (bl === n) by -= br + 1;
        for (var b = b0; b <= b1; b++) {
          var bm = b * bs;
          if (bm < -20 || bm > D + 30) continue;
          ctx.fillStyle = bm >= D - 250 && bm <= D ? '#ff5a4e' : (b % 10 === 0 ? '#ffd166' : 'rgba(236,242,248,0.6)');
          ctx.beginPath(); ctx.arc(X(bm), by, br, 0, Math.PI * 2); ctx.fill();
        }
      }

      // start line
      var xs = X(0);
      if (xs > c.x - 10 && xs < c.x + c.w + 10) {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(xs, c.y); ctx.lineTo(xs, c.y + c.h); ctx.stroke();
        ctx.fillStyle = 'rgba(30,42,56,0.9)';
        ctx.fillRect(xs - Math.max(8, 3 * pxPerM), c.y, Math.max(8, 3 * pxPerM) - 2, c.h); // start pontoon
      }
      // finish line (checkered)
      if (xf > c.x - 40 && xf < c.x + c.w + 40) {
        var sq = Math.max(5, laneH / 6), cols = 2;
        for (var yy = 0, row = 0; yy < c.h; yy += sq, row++) {
          for (var cc = 0; cc < cols; cc++) {
            ctx.fillStyle = (row + cc) % 2 ? '#f4f6f8' : '#151b22';
            ctx.fillRect(xf + cc * sq - sq, c.y + yy, sq, Math.min(sq, c.h - yy));
          }
        }
        ctx.font = font(fs * 0.9, 800);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        var fw = ctx.measureText('FINISH').width + fs * 0.8;
        ctx.fillStyle = '#ffcc33';
        rrect(ctx, xf - fw / 2, c.y + 4, fw, fs * 1.25, 6); ctx.fill();
        ctx.fillStyle = '#1a1300';
        ctx.fillText('FINISH', xf, c.y + 4 + fs * 0.18);
      }

      // puddles
      puddles.forEach(function (p) {
        var age = (now - p.born) / 3200;
        var px = X(p.m), py = laneY(p.lane) + p.yf * laneH;
        if (px < c.x - 30 || px > c.x + c.w + 30) return;
        ctx.strokeStyle = 'rgba(220,240,255,' + (0.35 * (1 - age)) + ')';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(px, py, laneH * (0.05 + 0.12 * age), laneH * (0.03 + 0.06 * age), 0, 0, Math.PI * 2);
        ctx.stroke();
      });

      // boats: opponents first, user on top
      var boatLen = clamp(8.2 * pxPerM, laneH * 1.4, laneH * 3.2);
      opps.forEach(function (o) { drawBoatAt(o, o.disp, now); });
      drawBoatAt(user, user.disp, now);

      function drawBoatAt(b, dm, now) {
        var bx = X(dm) - boatLen / 2; // dm = bow position
        var by = laneY(b.lane);
        var vis = bx > c.x - boatLen && bx < c.x + c.w + boatLen;
        if (vis) {
          var res = drawBoat(bx, by, boatLen, laneH, b.color, b.isUser, b.phase, b.animRate, b.isUser ? user.speed : b.vel);
          // spawn puddles at the end of each drive
          if (res.inWater) b.puddleDone = false;
          else if (!b.puddleDone && b.animRate > 0) {
            b.puddleDone = true;
            puddles.push({ m: dm - boatLen / 2 / pxPerM + res.bladeDx / pxPerM, lane: b.lane, yf: res.bladeDy / laneH, born: now });
            puddles.push({ m: dm - boatLen / 2 / pxPerM + res.bladeDx / pxPerM, lane: b.lane, yf: -res.bladeDy / laneH, born: now });
            if (puddles.length > 240) puddles.splice(0, puddles.length - 240);
          }
          drawTag(b, bx, by, boatLen, laneH);
        } else {
          drawOffscreen(b, bx < c.x ? 'left' : 'right', by, dm);
        }
      }

      function drawTag(b, bx, by, len, laneH) {
        var txt = b.isUser ? 'YOU' : b.name;
        var tfs = clamp(laneH * 0.3, 10, fs * 1.0);
        ctx.font = font(tfs, 700);
        txt = fitText(ctx, txt, Math.max(60, c.w * 0.25));
        var tw = ctx.measureText(txt).width, ph = tfs * 1.35, pw = tw + tfs * 0.8;
        var tx = bx - len / 2 - laneH * 0.12 - pw;
        if (tx < c.x + 4) tx = bx + len / 2 + laneH * 0.12;
        ctx.fillStyle = b.isUser ? 'rgba(255,204,51,0.92)' : 'rgba(5,14,24,0.62)';
        rrect(ctx, tx, by - ph / 2, pw, ph, ph / 2); ctx.fill();
        if (!b.isUser) { ctx.strokeStyle = rgba(b.color, 0.7); ctx.lineWidth = 1.5; ctx.stroke(); }
        ctx.fillStyle = b.isUser ? '#1b1400' : '#eef4fa';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, tx + tfs * 0.4, by + 1);
      }

      function drawOffscreen(b, side, by, dm) {
        var gap = dm - user.disp;
        var txt = (gap >= 0 ? '+' : '−') + fmtInt(Math.abs(gap)) + ' m';
        var tfs = clamp(laneH * 0.32, 10, fs * 1.0);
        ctx.font = font(tfs, 800);
        var tw = ctx.measureText(txt).width, aw = tfs * 0.8, ph = tfs * 1.5, pw = tw + aw + tfs * 0.9;
        var x = side === 'left' ? c.x + 6 : c.x + c.w - 6 - pw;
        ctx.fillStyle = rgba(b.color, 0.9);
        rrect(ctx, x, by - ph / 2, pw, ph, 6); ctx.fill();
        ctx.fillStyle = '#06121f';
        ctx.beginPath();
        if (side === 'left') {
          ctx.moveTo(x + tfs * 0.3, by); ctx.lineTo(x + tfs * 0.3 + aw * 0.7, by - ph * 0.28); ctx.lineTo(x + tfs * 0.3 + aw * 0.7, by + ph * 0.28);
        } else {
          ctx.moveTo(x + pw - tfs * 0.3, by); ctx.lineTo(x + pw - tfs * 0.3 - aw * 0.7, by - ph * 0.28); ctx.lineTo(x + pw - tfs * 0.3 - aw * 0.7, by + ph * 0.28);
        }
        ctx.fill();
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, side === 'left' ? x + aw + tfs * 0.5 : x + tfs * 0.45, by + 1);
        // name under pill if room
        if (laneH > ph * 2.2) {
          ctx.font = font(tfs * 0.72, 600);
          ctx.fillStyle = 'rgba(230,240,250,0.75)';
          ctx.textAlign = side === 'left' ? 'left' : 'right';
          ctx.fillText(fitText(ctx, b.name, c.w * 0.3), side === 'left' ? x : x + pw, by + ph * 0.95);
        }
      }

      ctx.restore();
      // course frame
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      rrect(ctx, c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1, Math.min(14, fs * 0.6)); ctx.stroke();
    }

    // Draws a single scull. (x,y) = hull centre, +x = bow. Returns blade info.
    function drawBoat(x, y, len, laneH, color, isUser, phase, rate, speed) {
      var hw = Math.max(2.5, laneH * 0.085);
      var CATCH = 0.95, FIN = -0.62, DRIVE = 0.38;
      var theta = 0, inWater = false, p = phase % 1;
      if (rate > 0) {
        if (p < DRIVE) { var u = p / DRIVE; theta = CATCH + (FIN - CATCH) * (0.5 - 0.5 * Math.cos(Math.PI * u)); inWater = true; }
        else { var u2 = (p - DRIVE) / (1 - DRIVE); theta = FIN + (CATCH - FIN) * (0.5 - 0.5 * Math.cos(Math.PI * u2)); }
      }
      var pivotX = -len * 0.04, rig = hw * 2.7, outboard = laneH * 0.3, inboard = rig * 0.95;
      var slideK = len * 0.05;
      var seatX = pivotX - len * 0.03 + (rate > 0 ? lerp(-slideK, slideK, (CATCH - theta) / (CATCH - FIN)) : 0);

      ctx.save();
      ctx.translate(x, y);

      // wake
      var sp = clamp(speed / 5, 0, 1.2);
      if (sp > 0.05) {
        var wl = len * (0.5 + 0.6 * sp);
        ctx.strokeStyle = 'rgba(210,235,255,' + (0.12 + 0.12 * sp) + ')';
        ctx.lineWidth = Math.max(1, hw * 0.35);
        ctx.beginPath();
        ctx.moveTo(-len * 0.45, -hw * 0.6); ctx.lineTo(-len * 0.45 - wl, -hw * 0.6 - wl * 0.16);
        ctx.moveTo(-len * 0.45, hw * 0.6); ctx.lineTo(-len * 0.45 - wl, hw * 0.6 + wl * 0.16);
        ctx.stroke();
        ctx.fillStyle = 'rgba(210,235,255,' + (0.08 * sp) + ')';
        ctx.beginPath(); ctx.ellipse(-len * 0.5 - len * 0.12, 0, len * 0.14, hw * 0.7, 0, 0, Math.PI * 2); ctx.fill();
        // bow wave
        ctx.strokeStyle = 'rgba(230,245,255,' + (0.25 * sp) + ')';
        ctx.beginPath();
        ctx.moveTo(len * 0.5 + 1, 0); ctx.quadraticCurveTo(len * 0.42, -hw * 1.6, len * 0.3, -hw * 1.9);
        ctx.moveTo(len * 0.5 + 1, 0); ctx.quadraticCurveTo(len * 0.42, hw * 1.6, len * 0.3, hw * 1.9);
        ctx.stroke();
      }

      // oars + riggers (drawn under the hull)
      var bladeColor = isUser ? '#ffffff' : shade(color, 0.25);
      var handles = [], blade = { dx: 0, dy: 0 };
      [-1, 1].forEach(function (side) {
        var px = pivotX, py = side * rig;
        // rigger
        ctx.strokeStyle = 'rgba(200,210,220,0.75)'; ctx.lineWidth = Math.max(1, hw * 0.28);
        ctx.beginPath(); ctx.moveTo(pivotX - len * 0.05, side * hw * 0.8); ctx.lineTo(px, py); ctx.lineTo(pivotX + len * 0.05, side * hw * 0.8); ctx.stroke();
        var dx = Math.sin(theta), dy = side * Math.cos(theta);
        var hx = px - dx * inboard, hy = py - dy * inboard;
        var ex = px + dx * outboard, ey = py + dy * outboard;
        handles.push([hx, hy]);
        // shaft
        ctx.strokeStyle = isUser ? '#f2f2f2' : '#d9dee4'; ctx.lineWidth = Math.max(1, hw * 0.3);
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.stroke();
        // blade
        var bl = laneH * 0.13, bw = inWater ? hw * 1.15 : hw * 0.45;
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.fillStyle = bladeColor;
        rrect(ctx, -bl * 0.85, -bw / 2, bl, bw, bw / 2); ctx.fill();
        ctx.restore();
        if (inWater && rate > 0) {
          ctx.strokeStyle = 'rgba(235,248,255,0.45)'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(ex, ey, hw * 1.2, 0, Math.PI * 2); ctx.stroke();
        }
        if (side === 1) { blade.dx = ex; blade.dy = ey; }
      });

      // hull
      if (isUser) { ctx.shadowColor = rgba(color, 0.85); ctx.shadowBlur = laneH * 0.35; }
      ctx.beginPath();
      ctx.moveTo(len / 2, 0);
      ctx.quadraticCurveTo(len * 0.15, -hw * 1.25, -len * 0.1, -hw);
      ctx.quadraticCurveTo(-len * 0.38, -hw * 0.85, -len / 2, 0);
      ctx.quadraticCurveTo(-len * 0.38, hw * 0.85, -len * 0.1, hw);
      ctx.quadraticCurveTo(len * 0.15, hw * 1.25, len / 2, 0);
      ctx.closePath();
      var hg = ctx.createLinearGradient(0, -hw, 0, hw);
      hg.addColorStop(0, shade(color, 0.35)); hg.addColorStop(0.5, color); hg.addColorStop(1, shade(color, -0.35));
      ctx.fillStyle = hg; ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      ctx.strokeStyle = shade(color, -0.55); ctx.lineWidth = 1; ctx.stroke();
      // deck line + bow ball
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = Math.max(1, hw * 0.18);
      ctx.beginPath(); ctx.moveTo(len * 0.46, 0); ctx.lineTo(len * 0.1, 0); ctx.moveTo(-len * 0.2, 0); ctx.lineTo(-len * 0.44, 0); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(len / 2 - hw * 0.3, 0, Math.max(1.2, hw * 0.3), 0, Math.PI * 2); ctx.fill();
      // cockpit
      ctx.fillStyle = 'rgba(10,16,24,0.85)';
      ctx.beginPath(); ctx.ellipse(pivotX - len * 0.02, 0, len * 0.11, hw * 0.62, 0, 0, Math.PI * 2); ctx.fill();

      // rower (faces the stern, -x): arms to handles, torso, head
      var shX = seatX + hw * 0.4, shY = hw * 0.75;
      ctx.strokeStyle = isUser ? '#ffe9a8' : '#c9d4df'; ctx.lineWidth = Math.max(1, hw * 0.35); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(shX, -shY); ctx.lineTo(handles[0][0], handles[0][1]);
      ctx.moveTo(shX, shY); ctx.lineTo(handles[1][0], handles[1][1]);
      ctx.stroke();
      ctx.fillStyle = isUser ? '#ffcc33' : shade(color, -0.25);
      ctx.beginPath(); ctx.ellipse(seatX + hw * 0.6, 0, hw * 0.95, hw * 1.05, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = isUser ? '#fff4d0' : '#e9eef3';
      ctx.beginPath(); ctx.arc(seatX + hw * 0.55, 0, hw * 0.55, 0, Math.PI * 2); ctx.fill();

      ctx.restore();
      return { inWater: inWater, bladeDx: blade.dx, bladeDy: blade.dy };
    }

    function drawHud(st) {
      var h = L.hud, fs = L.fs;
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      rrect(ctx, h.x, h.y, h.w, h.h, 10); ctx.fill();
      var me = st.list.filter(function (e) { return e.isUser; })[0];
      var cx = h.x + fs * 0.6;
      var big = Math.min(fs * 2.3, h.h * 0.5);
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      var line1Y = h.y + h.h * 0.12 + big * 0.85;
      if (state === 'idle' || state === 'countdown') {
        ctx.font = font(big * 0.8, 800); ctx.fillStyle = '#e9f1f8';
        ctx.fillText(state === 'idle' ? 'READY' : 'SET', cx, line1Y);
      } else {
        var ord = ordinal(me.pos);
        ctx.font = font(big, 800);
        ctx.fillStyle = me.pos === 1 ? '#ffcc33' : '#f1f6fb';
        ctx.fillText(ord, cx, line1Y);
        var ow = ctx.measureText(ord).width;
        ctx.font = font(big * 0.42, 600); ctx.fillStyle = 'rgba(220,232,244,0.6)';
        ctx.fillText(' / ' + nLanes, cx + ow, line1Y);
      }
      var togo = Math.max(0, D - user.disp);
      var sub = userFinished ? fmtTime(user.finishTime) : fmtInt(togo) + ' m';
      var subF = Math.min(fs * 1.25, h.h * 0.26);
      ctx.font = font(subF, 800);
      ctx.fillStyle = userFinished ? '#5ef0a0' : (final500 ? '#ffcc33' : '#cfe6ff');
      var sy = h.y + h.h - h.h * 0.14;
      ctx.fillText(sub, cx, sy);
      var sw = ctx.measureText(sub).width;
      ctx.font = font(subF * 0.6, 600); ctx.fillStyle = 'rgba(220,232,244,0.6)';
      ctx.fillText(userFinished ? ' finished' : ' to go', cx + sw, sy);
      if (final500 && !userFinished) {
        ctx.font = font(subF * 0.55, 800);
        var t = 'FINAL 500', tw = ctx.measureText(t).width + fs * 0.6, bh = subF * 0.9;
        var bx = h.x + h.w - tw - fs * 0.4, byy = h.y + fs * 0.4;
        ctx.fillStyle = 'rgba(255,204,51,' + (0.65 + 0.35 * Math.sin(performance.now() / 180)) + ')';
        rrect(ctx, bx, byy, tw, bh, bh / 2); ctx.fill();
        ctx.fillStyle = '#1b1400'; ctx.textBaseline = 'middle';
        ctx.fillText(t, bx + fs * 0.3, byy + bh / 2 + 1);
      }
    }

    function drawMini() {
      var m = L.mini, fs = L.fs, n = nLanes;
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      rrect(ctx, m.x, m.y, m.w, m.h, 10); ctx.fill();
      var labelH = fs * 0.95;
      var x0 = m.x + fs * 0.9, x1 = m.x + m.w - fs * 1.2;
      var y0 = m.y + fs * 0.45, y1 = m.y + m.h - labelH - fs * 0.25;
      var rowH = (y1 - y0) / n;
      var X = function (d) { return x0 + (x1 - x0) * clamp(d / D, 0, 1); };
      // final 500 zone
      if (D > 500) { ctx.fillStyle = 'rgba(255,204,51,0.08)'; ctx.fillRect(X(D - 500), y0, x1 - X(D - 500), y1 - y0); }
      // ticks
      var step = D <= 600 ? 100 : D <= 1200 ? 250 : D <= 6000 ? 500 : 1000;
      ctx.font = font(fs * 0.62, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (var d = 0; d <= D + 1e-6; d += step) {
        var x = X(d);
        ctx.strokeStyle = d === 0 || d >= D ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
        ctx.fillStyle = 'rgba(215,228,240,0.55)';
        ctx.fillText(d === 0 ? '0' : (d >= 1000 && d % 1000 === 0 ? (d / 1000) + 'k' : String(d)), x, y1 + fs * 0.15);
      }
      // finish flag
      var fx = X(D) + 2, sq = Math.max(2, Math.min(fs * 0.25, (y1 - y0) / 6));
      for (var r = 0; r * sq < (y1 - y0); r++) {
        for (var cc = 0; cc < 2; cc++) {
          ctx.fillStyle = (r + cc) % 2 ? '#eef2f6' : '#1b222b';
          ctx.fillRect(fx + cc * sq, y0 + r * sq, sq, Math.min(sq, y1 - y0 - r * sq));
        }
      }
      // rows
      var all = opps.concat([user]);
      all.forEach(function (b) {
        var y = y0 + rowH * (b.lane + 0.5);
        ctx.strokeStyle = b.isUser ? 'rgba(255,204,51,0.35)' : 'rgba(255,255,255,0.07)';
        ctx.lineWidth = Math.max(1, rowH * 0.16);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.strokeStyle = rgba(b.color, b.isUser ? 0.9 : 0.55);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(X(b.disp), y); ctx.stroke();
      });
      all.forEach(function (b) {
        var y = y0 + rowH * (b.lane + 0.5);
        var r = clamp(rowH * 0.42, 2.5, fs * 0.42) * (b.isUser ? 1.3 : 1);
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(X(b.disp), y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = b.isUser ? '#ffffff' : 'rgba(0,0,0,0.5)'; ctx.lineWidth = b.isUser ? 2 : 1; ctx.stroke();
      });
    }

    function drawBoard(st) {
      var b = L.board, fs = L.fs, rowH = L.rowH;
      if (b.h < 20) return;
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();
      var px = b.x + fs * 0.6, pr = b.x + b.w - fs * 0.6;
      ctx.textBaseline = 'middle';
      var hy = b.y + L.headH * 0.55;
      ctx.font = font(fs * 0.75, 800); ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(215,228,240,0.6)';
      ctx.fillText('STANDINGS', px, hy);
      ctx.textAlign = 'right'; ctx.font = font(fs * 0.95, 700); ctx.fillStyle = '#e9f1f8';
      ctx.fillText(state === 'racing' ? fmtClock(st.rt) : (state === 'countdown' ? '0:00' : '--:--'), pr, hy);

      var nameF = clamp(rowH * 0.46, 10, fs * 1.1);
      var gapF = nameF * 0.88, secF = nameF * 0.62;
      var stacked = rowH >= gapF * 1.15 + secF * 1.25;
      ctx.font = font(gapF, 800);
      var gapW = Math.max(ctx.measureText('−000.0 m').width, fs * 3);
      var colS = pr;
      var nameMax = colS - gapW - fs * 0.4 - (px + nameF * 2.0);

      st.list.forEach(function (e, i) {
        var ry = b.y + L.headH + i * rowH;
        if (ry + rowH > b.y + b.h + 1) return;
        var cy = ry + rowH / 2;
        if (e.isUser) {
          ctx.fillStyle = 'rgba(255,204,51,0.16)';
          rrect(ctx, b.x + 4, ry + 1, b.w - 8, rowH - 2, 6); ctx.fill();
        }
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right'; ctx.font = font(nameF, 800);
        ctx.fillStyle = e.isUser ? '#ffcc33' : 'rgba(225,236,246,0.75)';
        ctx.fillText(String(e.pos), px + nameF * 1.0, cy);
        ctx.fillStyle = e.color;
        rrect(ctx, px + nameF * 1.35, cy - rowH * 0.28, Math.max(3, nameF * 0.28), rowH * 0.56, 2); ctx.fill();
        ctx.textAlign = 'left'; ctx.font = font(nameF, e.isUser ? 800 : 600);
        ctx.fillStyle = e.isUser ? '#fff3c4' : '#eef4fa';
        ctx.fillText(fitText(ctx, e.isUser ? userName : e.name, Math.max(20, nameMax)), px + nameF * 2.0, cy);

        var top, bottom = null, col;
        if (e.isUser) {
          col = 'rgba(255,230,160,0.9)';
          top = userFinished ? fmtTime(user.finishTime) : fmtInt(e.d) + ' m';
        } else if (e.finished && userFinished) {
          col = 'rgba(200,215,230,0.9)';
          top = fmtTime(e.time);
          var dt = e.time - user.finishTime;
          bottom = (dt > 0 ? '+' : '−') + Math.abs(dt).toFixed(1) + ' s';
        } else {
          var gm = Math.abs(e.gapM), gs = Math.abs(e.gapS);
          var sgn = e.gapM > 0.05 ? '+' : e.gapM < -0.05 ? '−' : '';
          col = sgn === '+' ? '#ff8a80' : sgn ? '#6ff0a8' : 'rgba(225,236,246,0.75)';
          top = sgn + (gm < 100 ? gm.toFixed(1) : fmtInt(gm)) + ' m';
          bottom = sgn + (gs < 100 ? gs.toFixed(1) : fmtInt(gs)) + ' s';
          if (e.finished) bottom = '⚑ ' + fmtTime(e.time);
        }
        ctx.textAlign = 'right'; ctx.fillStyle = col;
        if (stacked && bottom) {
          ctx.font = font(gapF, 800);
          ctx.fillText(top, colS, cy - secF * 0.55);
          ctx.font = font(secF, 700); ctx.globalAlpha = 0.85;
          ctx.fillText(bottom, colS, cy + gapF * 0.55);
          ctx.globalAlpha = 1;
        } else {
          ctx.font = font(gapF, 800);
          ctx.fillText(top, colS, cy);
        }
      });
    }

    function drawOverlays(now) {
      var c = L.course, fs = L.fs;
      // idle hint
      if (state === 'idle') {
        ctx.font = font(fs * 1.1, 700);
        var t = fmtInt(D) + ' m race · waiting for start';
        var tw = ctx.measureText(t).width + fs * 1.6, th = fs * 2.2;
        ctx.fillStyle = 'rgba(4,12,22,0.7)';
        rrect(ctx, c.x + c.w / 2 - tw / 2, c.y + c.h / 2 - th / 2, tw, th, th / 2); ctx.fill();
        ctx.fillStyle = '#e9f1f8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t, c.x + c.w / 2, c.y + c.h / 2 + 1);
      }
      // countdown
      var big = Math.min(c.h * 0.62, c.w * 0.32);
      if (state === 'countdown') {
        var rem = (goAt - now) / 1000, n = Math.max(1, Math.ceil(rem)), frac = n - rem;
        ctx.fillStyle = 'rgba(3,10,18,0.5)'; ctx.fillRect(c.x, c.y, c.w, c.h);
        var sc = 1.25 - 0.25 * easeOut(frac * 3);
        ctx.save();
        ctx.translate(c.x + c.w / 2, c.y + c.h / 2);
        ctx.scale(sc, sc);
        ctx.globalAlpha = 1 - clamp((frac - 0.7) / 0.3, 0, 1) * 0.7;
        ctx.font = font(big, 900); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(3, big * 0.04); ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.strokeText(String(n), 0, big * 0.04);
        ctx.fillStyle = n === 1 ? '#ffcc33' : '#ffffff';
        ctx.fillText(String(n), 0, big * 0.04);
        ctx.restore();
      } else if (state === 'racing' && now - goAt < 1200) {
        var a = 1 - (now - goAt) / 1200;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(c.x + c.w / 2, c.y + c.h / 2);
        var s2 = 1 + 0.3 * (1 - a);
        ctx.scale(s2, s2);
        ctx.font = font(big * 0.8, 900); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(3, big * 0.04); ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.strokeText('GO!', 0, big * 0.03);
        ctx.fillStyle = '#5ef0a0'; ctx.fillText('GO!', 0, big * 0.03);
        ctx.restore();
      }
      // callouts
      if (callouts.length && callouts[0].born != null && !(showResults && results)) {
        var co = callouts[0], age = now - co.born, life = callouts.length > 1 ? 1800 : 2600;
        var sc2 = 0.7 + 0.3 * easeOut(age / 250), alpha = 1 - clamp((age - (life - 400)) / 400, 0, 1);
        var cf = clamp(Math.min(c.w / 18, c.h / 7), 16, fs * 2.1);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(c.x + c.w / 2, c.y + Math.max(cf * 1.6, c.h * 0.2));
        ctx.scale(sc2, sc2);
        ctx.font = font(cf, 800);
        var txt = fitText(ctx, co.text, c.w * 0.85);
        var w2 = ctx.measureText(txt).width + cf * 1.4, h2 = cf * 1.8;
        ctx.fillStyle = 'rgba(4,12,22,0.82)';
        rrect(ctx, -w2 / 2, -h2 / 2, w2, h2, h2 / 2); ctx.fill();
        ctx.strokeStyle = co.color; ctx.lineWidth = 3; ctx.stroke();
        ctx.fillStyle = co.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, 0, 2);
        ctx.restore();
      }
      // results
      if (results && showResults) drawResults(now);
      else if (results) {
        ctx.font = font(fs * 0.8, 700);
        var rt = 'Show results', rw = ctx.measureText(rt).width + fs, rh = fs * 1.7;
        ctx.fillStyle = 'rgba(255,204,51,0.9)';
        rrect(ctx, c.x + c.w - rw - 8, c.y + c.h - rh - 8, rw, rh, rh / 2); ctx.fill();
        ctx.fillStyle = '#1b1400'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(rt, c.x + c.w - rw / 2 - 8, c.y + c.h - rh / 2 - 8 + 1);
      }
    }

    function drawResults(now) {
      var fs = L.fs, a = easeOut((now - resultsAt) / 400);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(2,8,15,0.72)'; ctx.fillRect(0, 0, W, H);
      var n = results.length;
      var pw = Math.min(W * 0.9, Math.max(fs * 22, W * 0.5), 760);
      var rowH = clamp(Math.min(fs * 2, (H * 0.82 - fs * 6.5) / n), 16, 60);
      var ph = fs * 6.5 + rowH * n;
      var px = (W - pw) / 2, py = (H - ph) / 2 + (1 - a) * 20;
      ctx.fillStyle = '#0d1c2c';
      rrect(ctx, px, py, pw, ph, 16); ctx.fill();
      ctx.strokeStyle = 'rgba(255,204,51,0.6)'; ctx.lineWidth = 2; ctx.stroke();
      var pos = results.findIndex(function (r) { return r.isUser; }) + 1;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = font(fs * 1.9, 900);
      ctx.fillStyle = pos === 1 ? '#ffcc33' : '#f1f6fb';
      ctx.fillText(pos === 1 ? 'You won!' : 'You finished ' + ordinal(pos), W / 2, py + fs * 1.9);
      ctx.font = font(fs * 0.85, 600); ctx.fillStyle = 'rgba(215,228,240,0.65)';
      ctx.fillText(fmtInt(D) + ' m  ·  ' + fmtTime(user.finishTime), W / 2, py + fs * 3.6);
      var nf = clamp(rowH * 0.5, 11, fs * 1.2);
      var x0 = px + fs * 1.2, x1 = px + pw - fs * 1.2;
      results.forEach(function (r, i) {
        var ry = py + fs * 5 + i * rowH, cy = ry + rowH / 2;
        if (r.isUser) { ctx.fillStyle = 'rgba(255,204,51,0.16)'; rrect(ctx, x0 - fs * 0.5, ry + 1, x1 - x0 + fs, rowH - 2, 6); ctx.fill(); }
        ctx.font = font(nf, 800); ctx.textAlign = 'right';
        ctx.fillStyle = r.isUser ? '#ffcc33' : 'rgba(225,236,246,0.75)';
        ctx.fillText(String(i + 1), x0 + nf * 1.1, cy);
        ctx.fillStyle = r.isUser ? userColor : (r.color || '#888');
        ctx.beginPath(); ctx.arc(x0 + nf * 1.9, cy, nf * 0.3, 0, Math.PI * 2); ctx.fill();
        ctx.textAlign = 'right'; ctx.font = font(nf, 700);
        var tstr = fmtTime(r.time) + (r.projected ? '*' : '');
        ctx.fillStyle = r.isUser ? '#fff3c4' : (r.projected ? 'rgba(215,228,240,0.6)' : '#eef4fa');
        ctx.fillText(tstr, x1, cy);
        var tw = ctx.measureText('00:00.0*').width;
        ctx.textAlign = 'left'; ctx.font = font(nf, r.isUser ? 800 : 600);
        ctx.fillStyle = r.isUser ? '#fff3c4' : '#eef4fa';
        ctx.fillText(fitText(ctx, r.name, x1 - tw - fs - (x0 + nf * 2.6)), x0 + nf * 2.6, cy);
      });
      ctx.font = font(fs * 0.62, 600); ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(215,228,240,0.5)';
      ctx.fillText((results.some(function (r) { return r.projected; }) ? '* projected finish   ·   ' : '') + 'tap to hide', W / 2, py + ph - fs * 0.8);
      ctx.restore();
    }

    // ------------------------------------------------------------- loop
    function frame(now) {
      if (destroyed) return;
      raf = requestAnimationFrame(frame);
      if ((global.devicePixelRatio || 1) !== dpr) resize();
      var dt = lastFrame ? clamp((now - lastFrame) / 1000, 0, 0.25) : 0;
      lastFrame = now;
      simulate(now, dt);
      draw(now);
    }

    function onClick() { if (results) { showResults = !showResults; resultsAt = performance.now(); } }
    canvas.addEventListener('click', onClick);

    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(root); else global.addEventListener('resize', resize);

    // init
    D = num(options.distance) > 0 ? +options.distance : 2000;
    buildOpponents(options.opponents || presetOpponents(null));
    resetState();
    resize();
    raf = requestAnimationFrame(frame);

    api.update = update;
    api.start = start;
    api.reset = function () { resetState(); };
    api.destroy = function () {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
      canvas.removeEventListener('click', onClick);
      if (root.parentNode) root.parentNode.removeChild(root);
    };
    api.configure = configure;
    api.getStandings = function () {
      return standings(performance.now()).list.map(function (e) {
        return { pos: e.pos, name: e.name, isUser: e.isUser, distance: e.d, gapMeters: e.gapM,
          gapSeconds: e.gapS, finished: e.finished, time: e.time };
      });
    };
    Object.defineProperty(api, 'state', { get: function () { return state; } });
    return api;
  }

  global.SkillRowRace = { create: create, presetOpponents: presetOpponents, version: '1.0' };
})(typeof window !== 'undefined' ? window : this);

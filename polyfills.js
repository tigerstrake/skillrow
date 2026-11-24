/* Loaded first. ES5 only. Polyfills for old Tizen Chromium + an on-screen error box (we can't open devtools on the TV). */
(function (global) {
  'use strict';
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (len, fill) {
      var s = String(this); fill = fill == null ? ' ' : String(fill);
      if (s.length >= len || !fill) return s;
      var pad = ''; while (pad.length < len - s.length) pad += fill;
      return pad.slice(0, len - s.length) + s;
    };
  }
  if (!String.prototype.padEnd) {
    String.prototype.padEnd = function (len, fill) {
      var s = String(this); fill = fill == null ? ' ' : String(fill);
      if (s.length >= len || !fill) return s;
      var pad = ''; while (pad.length < len - s.length) pad += fill;
      return s + pad.slice(0, len - s.length);
    };
  }
  if (!Array.prototype.includes) {
    Array.prototype.includes = function (v) { for (var i = 0; i < this.length; i++) if (this[i] === v || (v !== v && this[i] !== this[i])) return true; return false; };
  }
  if (!Object.values) Object.values = function (o) { return Object.keys(o).map(function (k) { return o[k]; }); };
  if (!Object.entries) Object.entries = function (o) { return Object.keys(o).map(function (k) { return [k, o[k]]; }); };
  if (global.Element && !Element.prototype.matches) Element.prototype.matches = Element.prototype.webkitMatchesSelector;
  if (global.Element && !Element.prototype.closest) {
    Element.prototype.closest = function (sel) { var el = this; while (el && el.nodeType === 1) { if (el.matches(sel)) return el; el = el.parentElement; } return null; };
  }

  // ------------------------------------------------------------ on-screen errors
  var errs = [];
  function box() {
    var b = document.getElementById('err-box');
    if (!b && document.body) {
      b = document.createElement('div'); b.id = 'err-box';
      b.setAttribute('style', 'position:fixed;left:20px;right:20px;bottom:70px;z-index:9999;background:#5a0d12;color:#fff;' +
        'font:22px/1.35 monospace;padding:10px 16px;border:3px solid #ff5c5c;border-radius:10px;max-height:40vh;overflow:auto;white-space:pre-wrap;');
      document.body.appendChild(b);
    }
    return b;
  }
  function show(msg) {
    var t = new Date(), ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
    errs.push(ts + '  ' + msg);
    if (errs.length > 8) errs.shift();
    var b = box();
    if (b) { b.textContent = 'ERROR (this box hides after 30 s; Blue key = Bluetooth log)\n' + errs.join('\n'); b.style.display = 'block'; }
    clearTimeout(show.t);
    show.t = setTimeout(function () { var b2 = document.getElementById('err-box'); if (b2) b2.style.display = 'none'; }, 30000);
  }
  global.SkillRowShowError = show;
  global.addEventListener('error', function (e) {
    show((e.message || 'error') + (e.filename ? ' @ ' + String(e.filename).split('/').pop() + ':' + e.lineno + ':' + e.colno : ''));
  });
  global.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason; show('Unhandled promise: ' + (r && (r.stack || r.message) || r));
  });
  // console.error -> also on screen (app.js reports caught errors this way)
  if (global.console && console.error) {
    var orig = console.error;
    console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; parts.push(a && a.message ? (a.name || 'Error') + ': ' + a.message : String(a)); }
        show(parts.join(' '));
      } catch (e) { /* ignore */ }
      return orig.apply(console, arguments);
    };
  }
})(window);

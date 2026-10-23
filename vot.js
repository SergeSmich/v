(function () {
  'use strict';

  // ======================================================================
  // VOT DIAGNOSTIC BUILD (2026-10-23, rev b1)
  //
  // Loaded as the patched native "userScript" URL inside the live
  // https://www.youtube.com/tv page. Passively probes the environment and
  // prints findings to console (logcat tag "cobalt", every line prefixed
  // with "[VOT]" for grep).
  //
  // Probes:
  //   1. capabilities: MediaSource/AudioContext/WebAssembly/crypto.subtle,
  //      TextEncoder, Worker, Trusted Types state
  //   2. network reachability FROM the page:
  //      - LAN dev server http://192.168.1.186:8013 (ping + vot.js over XHR)
  //      - Cloudflare vot worker (vot.sormat1.workers.dev)
  //      - cdn.jsdelivr.net (control)
  //      each probed first in cors mode, then in no-cors mode, so a CSP
  //      block is distinguishable from a mere CORS mismatch.
  //   3. full Yandex protocol FROM the page: session/create (HMAC signed
  //      with shared secret) -> video-translation/translate -> range fetch
  //      of the translated mp3 (if any).
  //   4. player plumbing: video duration/currentTime/src, googlevideo URLs
  //      visible in performance resource entries (can the page see the
  //      audio track at all?), media element errors.
  //   5. remote key stream (ring buffer of last 10 keycodes).
  //   6. original upstream userScript.js is still loaded in a <script src>
  //      so device-support patches (UA/brand/arch) stay alive.
  // ======================================================================

  var MARK = 'VOTDIAG-2026-10-23-b1';
  var ORIG_URL =
    'https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=' +
    Date.now() + '.' + Math.floor(Math.random() * 1e6);
  var LAN = 'http://192.168.1.186:8013';
  var WORKER = 'https://vot.sormat1.workers.dev';
  var YANDEX = 'https://api.browser.yandex.ru';
  var HMAC_KEY = 'bt8xH3VOlb4mqf0nqAibnDOoiPlXsisf';
  var HBK_VER = '25.12.4.1198';

  var HAVE_WE =
    typeof TextEncoder !== 'undefined' &&
    typeof TextDecoder !== 'undefined' &&
    typeof fetch === 'function';

  var yttvLogged = false;
  var lastKeyStr = '';
  var keyRing = [];
  var pending = {}; // watchId -> {t0, probed, durWarned, noVideoLogged, laterLogged, gvProbed}

  function log(m) { try { console.log('[VOT] ' + m); } catch (e) { } }
  function warn(m) { try { console.warn('[VOT] ' + m); } catch (e) { } }
  function j(x) { try { return JSON.stringify(x); } catch (e) { return String(x); } }

  log(MARK + ' boot href=' + String(location.href).slice(0, 150));
  if (!HAVE_WE) warn('TextEncoder/fetch unavailable - protocol probes will be skipped');

  // ---- Trusted Types pass-through ---------------------------------------
  try {
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      if (!window.trustedTypes.defaultPolicy) {
        window.trustedTypes.createPolicy('default', {
          createHTML: function (s) { return s; },
          createScript: function (s) { return s; },
          createScriptURL: function (s) { return s; }
        });
        log('trusted-types: default policy installed');
      } else {
        log('trusted-types: default policy already present');
      }
    } else {
      log('trusted-types: API absent');
    }
  } catch (e) {
    warn('trusted-types install failed: ' + e);
  }

  // ---- capabilities -------------------------------------------------------
  var caps = {
    ua: String(navigator.userAgent).slice(0, 120),
    lang: navigator.language,
    mediaSource: !!window.MediaSource,
    audioCtx: !!(window.AudioContext || window.webkitAudioContext),
    webAssembly: !!window.WebAssembly,
    cryptoSubtle: !!(window.crypto && window.crypto.subtle && window.crypto.subtle.sign),
    textEncoder: typeof TextEncoder,
    scriptWorker: typeof window.Worker,
    perfMemory: !!(window.performance && window.performance.memory)
  };
  try { caps.mseMpeg = window.MediaSource && window.MediaSource.isTypeSupported('audio/mpeg'); } catch (e) { caps.mseMpeg = 'ERR'; }
  try { caps.mseOpus = window.MediaSource && window.MediaSource.isTypeSupported('audio/webm; codecs="opus"'); } catch (e) { caps.mseOpus = 'ERR'; }
  try { caps.mseAac = window.MediaSource && window.MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'); } catch (e) { caps.mseAac = 'ERR'; }
  try { caps.canPlayMpeg = String(document.createElement('video').canPlayType('audio/mpeg')); } catch (e) { caps.canPlayMpeg = 'ERR'; }
  try { caps.canPlayAac = String(document.createElement('video').canPlayType('audio/aac')); } catch (e) { caps.canPlayAac = 'ERR'; }
  log('caps ' + j(caps));

  // ---- original upstream userScript (preserves device support) -----------
  (function () {
    var sc = document.createElement('script');
    sc.src = ORIG_URL;
    sc.onload = function () { log('origuserscript loaded'); };
    sc.onerror = function () { warn('origuserscript FAILED (CSP/network?)'); };
    (document.head || document.documentElement || document).appendChild(sc);
  })();

  // ---- remote key watcher --------------------------------------------------
  try {
    document.addEventListener('keydown', function (e) {
      keyRing.push(e.keyCode);
      if (keyRing.length > 10) keyRing.shift();
    }, true);
  } catch (e) { }

  // ---- protobuf encoder/decoder --------------------------------------------
  function wvarint(a, v) {
    v = v >>> 0;
    while (v > 127) { a.push((v & 127) | 128); v = v >>> 7; }
    a.push(v);
  }
  function wtag(a, f, t) { wvarint(a, (f << 3) | t); }
  function wstr(a, f, s) {
    var b = new TextEncoder().encode(s);
    wtag(a, f, 2);
    wvarint(a, b.length);
    for (var i = 0; i < b.length; i++) a.push(b[i]);
  }
  function wbool(a, f, v) { wtag(a, f, 0); wvarint(a, v ? 1 : 0); }
  function wint(a, f, v) { wtag(a, f, 0); wvarint(a, v); }
  function wdbl(a, f, v) {
    var dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    wtag(a, f, 1);
    for (var i = 0; i < 8; i++) a.push(dv.getUint8(i));
  }

  function buildTranslate(url, dur) {
    // Correct per April-2025 protocol: firstRequest=true, duration>0,
    // language auto + forceSourceLang, configVersion=2, responseLanguage ru.
    var a = [];
    wstr(a, 3, url);
    wbool(a, 5, true);      // firstRequest
    wdbl(a, 6, dur || 0);   // duration
    wbool(a, 7, true);      // unknown0
    wstr(a, 8, 'auto');     // source language
    wbool(a, 9, true);      // forceSourceLang
    wstr(a, 14, 'ru');      // response language
    wbool(a, 15, true);     // unknown2
    wint(a, 16, 2);         // configVersion (2 since 2025-04)
    return new Uint8Array(a);
  }

  function buildSession(uuid) {
    var a = [];
    wstr(a, 1, uuid);
    wstr(a, 2, 'video-translation');
    return new Uint8Array(a);
  }

  function readProto(u8) {
    var r = {};
    var p = 0;
    function lvarint() {
      var v = 0, s = 0, b;
      do { b = u8[p++]; v |= (b & 127) << s; s += 7; } while (b & 128);
      return v >>> 0;
    }
    while (p < u8.length) {
      var t = lvarint();
      var f = t >>> 3;
      var w = t & 7;
      if (w === 0) { r[f] = lvarint(); }
      else if (w === 2) {
        var l = lvarint();
        var sb = u8.slice(p, p + l);
        p += l;
        try { r[f] = new TextDecoder().decode(sb); } catch (e3) { r[f] = sb; }
      }
      else if (w === 1) { r['d' + f] = 'double'; p += 8; }
      else if (w === 5) { p += 4; }
      else break;
    }
    return r;
  }

  function toHex(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) {
      var h = u8[i].toString(16);
      s += h.length < 2 ? '0' + h : h;
    }
    return s;
  }

  function hmacHex(u8) {
    if (!(window.crypto && window.crypto.subtle && window.crypto.subtle.sign)) return Promise.resolve(null);
    var keyBytes = new TextEncoder().encode(HMAC_KEY);
    return window.crypto.subtle
      .importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (k) { return window.crypto.subtle.sign('HMAC', k, u8); })
      .then(function (buf) { return toHex(new Uint8Array(buf)); },
            function (e) { warn('hmac failed: ' + (e && e.message)); return null; });
  }

  function keysOf(o) {
    var r = [];
    for (var k in o) { if (o.hasOwnProperty(k)) r.push(k); }
    return r.sort();
  }

  // ---- generic reachability probe (cors, then opaque) -----------------------
  function probeUrl(label, url) {
    return fetch(url, { cache: 'no-store' })
      .then(function (r) {
        return r.text().then(function (t) {
          log(label + ' cors http=' + r.status + ' body=' + t.slice(0, 24));
        });
      }, function (e1) {
        // retry opaque: opaque success + cors TypeError means CSP allows but
        // response lacks CORS headers; both failing means CSP/network block.
        return fetch(url, { cache: 'no-store', mode: 'no-cors' })
          .then(function (r) {
            log(label + ' cors FAILED (' + e1.name + '), opaque http=' + r.status +
                ' => CONNECT-SRC ALLOWS it; cors-only mismatch');
          }, function (e2) {
            warn(label + ' BLOCKED: ' + e1.name + ': ' + e1.message + ' | no-cors: ' + e2.name + ': ' + e2.message);
          });
      });
  }

  // ---- Yandex protocol from inside the page ---------------------------------
  function yandexSession() {
    var CH = '0123456789ABCDEF';
    var uuid = '';
    for (var i = 0; i < 32; i++) uuid += CH.charAt(Math.floor(Math.random() * 16));
    var body = buildSession(uuid);
    return hmacHex(body).then(function (sig) {
      var hd = { 'Content-Type': 'application/x-protobuf' };
      if (sig) hd['Vtrans-Signature'] = sig;
      return fetch(YANDEX + '/session/create', { method: 'POST', headers: hd, cache: 'no-store', body: body })
        .then(function (r) {
          if (r.status !== 200) {
            return r.text().catch(function () { return ''; }).then(function (t) {
              warn('yandex session/create http=' + r.status + ' body=' + t.slice(0, 80));
              return null;
            });
          }
          return r.arrayBuffer().then(function (ab) {
            var o = readProto(new Uint8Array(ab));
            var sk = typeof o[1] === 'string' ? o[1] : '';
            log('yandex session/create ok exp=' + o[2] + ' sk=' + sk.slice(0, 12) + '...');
            return { uuid: uuid, sk: sk };
          });
        }, function (e) {
          warn('yandex session/create FETCH-ERR ' + e.name + ': ' + e.message);
          return null;
        });
    });
  }

  function yandexTranslate(sess, videoId, dur) {
    if (!sess) return Promise.resolve(null);
    var body = buildTranslate('https://www.youtube.com/watch?v=' + videoId, dur);
    var tok = sess.uuid + ':' + toHex(body) + ':' + HBK_VER;
    return Promise.all([hmacHex(body), hmacHex(new TextEncoder().encode(tok))]).then(function (res) {
      var hd = { 'Content-Type': 'application/x-protobuf' };
      if (res[0]) hd['Vtrans-Signature'] = res[0];
      if (sess.sk) {
        hd['Sec-Vtrans-Sk'] = sess.sk;
        hd['Sec-Vtrans-Token'] = (res[1] || '') + ':' + tok;
      }
      return fetch(YANDEX + '/video-translation/translate', { method: 'POST', headers: hd, cache: 'no-store', body: body })
        .then(function (r) {
          if (r.status !== 200) {
            return r.text().catch(function () { return ''; }).then(function (t) {
              warn('yandex translate http=' + r.status + ' body=' + t.slice(0, 120));
            });
          }
          return r.arrayBuffer().then(function (ab) {
            var o = readProto(new Uint8Array(ab));
            log('yandex translate resp status=' + o[4] + ' remaining=' + o[5] +
                ' tid=' + o[7] + ' msg=' + (o[9] || '') +
                ' url=' + String(o[1] || '').slice(0, 70));
            if (o[1]) mp3RangeProbe(o[1]);
          });
        }, function (e) {
          warn('yandex translate FETCH-ERR ' + e.name + ': ' + e.message);
        });
    });
  }

  function mp3RangeProbe(u) {
    fetch(u, { headers: { 'Range': 'bytes=0-255' } })
      .then(function (r) {
        log('mp3 range http=' + r.status + ' ct=' + r.headers.get('content-type') +
            ' cr=' + r.headers.get('content-range'));
      }, function (e) { warn('mp3 range ERR ' + e.name + ': ' + e.message); });
  }

  // Sessionless baseline through the worker (what the production vot.js does).
  function workerTranslateProbe(videoId, dur) {
    var body = buildTranslate('https://www.youtube.com/watch?v=' + videoId, dur);
    return fetch(WORKER + '/video-translation/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      cache: 'no-store',
      body: body
    }).then(function (r) {
      return r.arrayBuffer().catch(function () { return new ArrayBuffer(0); }).then(function (ab) {
        var o = readProto(new Uint8Array(ab));
        log('worker translate http=' + r.status + ' status=' + o[4] + ' remaining=' + o[5]);
      });
    }, function (e) {
      warn('worker translate FETCH-ERR ' + e.name + ': ' + e.message + ' (TypeError usually == CSP connect-src)');
    });
  }

  // ---- player plumbing -------------------------------------------------------
  function findVideo() {
    var vs = document.querySelectorAll('video');
    var best = null;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      var d = v.duration > 0 ? v.duration : 0;
      if (!best || d > (best.duration > 0 ? best.duration : 0)) best = v;
    }
    return best || (vs.length ? vs[0] : null);
  }

  function gvProbes() {
    if (!window.performance || !performance.getEntriesByType) { log('perf: getEntriesByType absent'); return; }
    var list = performance.getEntriesByType('resource');
    if (!list || !list.length) { log('perf: 0 resource entries'); return; }
    var n = list.length;
    var gv = [];
    for (var i = 0; i < n; i++) {
      var nm = String(list[i].name || '');
      if (nm.indexOf('googlevideo') !== -1) gv.push(nm);
    }
    log('perf: entries=' + n + ' googlevideo=' + gv.length);
    for (var k = 0; k < gv.length && k < 8; k++) {
      log('gvurl[' + k + '] itag=' + (qparam(gv[k], 'itag') || qparam(gv[k], 'itags') || '?') +
          ' mime=' + (qparam(gv[k], 'mime') || '?') + ' len=' + gv[k].length + ' ' + gv[k].slice(0, 80));
    }
  }

  function qparam(s, key) {
    var m = new RegExp('[?&]' + key + '=([^&#]*)').exec(s);
    if (!m) return null;
    var v = m[1];
    return v.length > 60 ? v.slice(0, 60) : v;
  }

  function videoIdFromHref() {
    var m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(String(location.href));
    return m ? m[1] : null;
  }

  function tick() {
    if (!ytvvLogged && typeof window._yttv !== 'undefined') {
      yttvLogged = true;
      log('_yttv present type=' + typeof window._yttv);
    }
    var ks = keyRing.join(',');
    if (ks && ks !== lastKeyStr) { lastKeyStr = ks; log('keys ' + ks); }
    var id = videoIdFromHref();
    if (!id) return;
    if (!pending[id]) {
      pending[id] = { t0: Date.now(), probed: false, durWarned: false, noVideoLogged: false, laterLogged: false, gvProbed: false };
      log('watch detected id=' + id + ' href=' + String(location.href).slice(0, 130));
    }
    var st = pending[id];
    var v = findVideo();
    if (v) onVideoFound(v, id, st);
    else if (!st.noVideoLogged && Date.now() - st.t0 > 25000) {
      st.noVideoLogged = true;
      warn('no usable <video> found for 25s id=' + id);
    }
  }

  function onVideoFound(v, id, st) {
    if (st.probed) return;
    var d = Number(v.duration) || 0;
    if (d <= 0 || !isFinite(d)) {
      // duration often 0 until metadata arrives; tick re-checks every 2.5 s
      if (Date.now() - st.t0 > 60000 && !st.durWarned) {
        st.durWarned = true;
        warn('duration unavailable after 60s id=' + id + ' readyState=' + v.readyState +
             ' src=' + String(v.currentSrc || v.src || '').slice(0, 100));
      }
      return;
    }
    st.probed = true;
    log('video id=' + id + ' duration=' + d.toFixed(1) + ' readyState=' + v.readyState +
        ' src=' + String(v.currentSrc || v.src || '').slice(0, 110) +
        ' videoCount=' + document.querySelectorAll('video').length);
    yandexSession().then(function (sess) { return yandexTranslate(sess, id, d); });
    workerTranslateProbe(id, d);
    setTimeout(function () { st.gvProbed = true; gvProbes(); }, 15000);
    setTimeout(function () {
      var v2 = findVideo();
      if (v2 && !st.laterLogged) {
        st.laterLogged = true;
        log('video+6s rs=' + v2.readyState +
            ' t=' + Number(v2.currentTime || 0).toFixed(1) +
            ' paused=' + v2.paused +
            ' src=' + String(v2.currentSrc || v2.src || '').slice(0, 120));
      }
    }, 6000);
  }

  // ---- boot -------------------------------------------------------------------
  probeUrl('lan /ping', LAN + '/ping');
  probeUrl('lan /vot.js', LAN + '/vot.js');
  probeUrl('worker /', WORKER + '/');
  probeUrl('jsdelivr', 'https://cdn.jsdelivr.net/gh/SergeSmich/v@main/vot.js');

  setInterval(tick, 2500);
  tick();
})();

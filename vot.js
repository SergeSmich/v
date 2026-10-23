(function () {
  'use strict';

  // ======================================================================
  // VOT overlay v1 — Yandex voice-over translation for TizenTubeCobalt.
  //
  // This file is served from jsdelivr (the patched native userScript URL)
  // and runs inside the live https://www.youtube.com/tv page.
  //
  // The page's CSP blocks everything except Google hosts + localhost, so all
  // Yandex traffic and mp3 playback go through the in-app Java bridge at
  // http://127.0.0.1:8013 (see vot_bridge/). This overlay only:
  //   * detects the watch page + video id/duration
  //   * drives /translate + /poll on the bridge
  //   * mutes the original video and starts native /play
  //   * keeps the translation in sync with the video via /position
  // ======================================================================

  var BRIDGE = 'http://127.0.0.1:8013';
  var SYNC_THRESHOLD = 1.0;       // seconds of drift before a resync
  var SYNC_INTERVAL = 1000;       // ms
  var POLL_BASE = 3000;

  var state = {
    curId: null,
    busy: false,
    playing: false,
    curUrl: null,
    title: ''
  };

  function log(m) { try { console.log('[VOT] ' + m); } catch (e) { } }

  function http(method, path, body, cb, err) {
    var x = new XMLHttpRequest();
    x.open(method, BRIDGE + path, true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status === 200) {
        try { cb(JSON.parse(x.responseText)); } catch (e) { (err || function () {})(e); }
      } else {
        (err || function () {})(new Error('http ' + x.status));
      }
    };
    x.onerror = function () { (err || function () {})(new Error('network')); };
    x.send(body ? JSON.stringify(body) : null);
  }

  function getVideoId() {
    var m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(String(location.href));
    return m ? m[1] : null;
  }

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

  function currentVideoTime() {
    var v = findVideo();
    return v ? (Number(v.currentTime) || 0) : 0;
  }

  function watchUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

  function startTranslation(id, dur) {
    if (state.busy) return;
    state.busy = true;
    state.title = (typeof document.title === 'string') ? document.title : '';
    log('translate start id=' + id + ' dur=' + dur.toFixed(1));
    http('POST', '/translate',
      { videoUrl: watchUrl(id), duration: dur, firstRequest: true, lang: 'auto', targetLang: 'ru', title: state.title },
      function (r) {
        log('resp status=' + r.status + ' tid=' + r.translationId + (r.remaining != null ? ' rem=' + r.remaining : ''));
        if (r.status === 1 && r.audioUrl) { onReady(r.audioUrl); }
        else if (r.status === 0) { state.busy = false; log('FAILED ' + (r.message || '')); }
        else { poll(id, dur, r.remaining != null ? r.remaining : 30); }
      },
      function (e) { state.busy = false; log('translate ERR ' + e); });
  }

  function poll(id, dur, remaining) {
    if (remaining <= 0) { state.busy = false; log('give up, no translation'); return; }
    var delay = Math.max(POLL_BASE, remaining * 1000);
    log('poll in ' + (delay / 1000).toFixed(0) + 's rem=' + remaining);
    setTimeout(function () {
      http('POST', '/translate',
        { videoUrl: watchUrl(id), duration: dur, firstRequest: false, lang: 'auto', targetLang: 'ru' },
        function (r) {
          log('poll status=' + r.status + (r.remaining != null ? ' rem=' + r.remaining : ''));
          if (r.status === 1 && r.audioUrl) { onReady(r.audioUrl); }
          else if (r.status === 0) { state.busy = false; log('FAILED ' + (r.message || '')); }
          else { poll(id, dur, r.remaining != null ? r.remaining : Math.max(3, remaining - 1)); }
        },
        function (e) { state.busy = false; log('poll ERR ' + e); });
    }, delay);
  }

  function onReady(url) {
    state.curUrl = url;
    var v = findVideo();
    if (v) {
      try { v.muted = true; } catch (e) { }
      try { v.volume = 0; } catch (e) { }
    }
    log('play ' + String(url).slice(0, 48));
    http('POST', '/play', { url: url, offsetSec: currentVideoTime() },
      function () { state.playing = true; state.busy = false; syncLoop(); },
      function (e) { state.busy = false; log('play ERR ' + e); });
  }

  function syncLoop() {
    if (!state.playing) return;
    http('GET', '/position', null, function (p) {
      var av = (Number(p.positionMs) || 0) / 1000;
      var vv = currentVideoTime();
      if (state.playing && av >= 0 && Math.abs(av - vv) > SYNC_THRESHOLD) {
        log('resync av=' + av.toFixed(1) + ' vv=' + vv.toFixed(1));
        http('POST', '/play', { url: state.curUrl, offsetSec: vv }, function () {}, function () {});
      }
      setTimeout(syncLoop, SYNC_INTERVAL);
    }, function () { setTimeout(syncLoop, 2000); });
  }

  // ---- boot -----------------------------------------------------------
  log('vot overlay v1 loaded href=' + String(location.href).slice(0, 110));

  http('GET', '/ping', null, function (r) {
    log('bridge reachable: ' + JSON.stringify(r));
  }, function (e) {
    log('bridge NOT reachable: ' + e + ' (bridge APK missing?)');
  });

  // ---- watch page watcher ----------------------------------------------
  setInterval(function () {
    var id = getVideoId();
    if (!id || id === state.curId) return;
    state.curId = id;
    state.playing = false;
    state.busy = false;
    state.curUrl = null;
    log('watch detected id=' + id);
    var tries = 0;
    (function wait() {
      var v = findVideo();
      if (v && v.duration > 0) {
        log('video ready id=' + id + ' dur=' + v.duration.toFixed(1));
        startTranslation(id, v.duration);
      } else if (tries++ < 60) {
        setTimeout(wait, 1000);
      } else {
        log('no video element for id=' + id);
        state.curId = null;
      }
    })();
  }, 1500);
})();

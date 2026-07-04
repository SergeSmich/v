(function() {
  'use strict';

  var VOT_WORKER = 'https://vot-worker.kload.workers.dev';
  var POLL_INTERVAL_MS = 3000;
  var SYNC_THRESHOLD = 0.8;

  // This file REPLACES the native "userScript" URL that io.gh.reisxd's
  // TizenTube patch fetches on every page load (splash + main YouTube TV
  // page). That native fetch mechanism is the ONLY proven way to run custom
  // JS in the live youtube.com/tv page context (Cobalt's cobalt_shell.pak is
  // a native UI resource bundle, unrelated to the network-loaded page, and
  // injecting into it has zero effect on the live page).
  //
  // To preserve 100% of the original functionality (device-support patches:
  // SetUserAgent/GetArchitecture/GetBrandAndModel via h5vcc_tizentube, i18n,
  // etc.) we load the REAL upstream userScript.js via a normal <script src>
  // element (NOT eval/XHR+eval: the page enforces Trusted Types, which
  // blocks eval() of fetched text with "requires 'TrustedScript' assignment").
  // A <script src="..."> element is not subject to that eval/text sink and
  // mirrors exactly what the native fetch+inject mechanism itself does.
  var ORIGINAL_USERSCRIPT_URL =
    'https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=' +
    Date.now() + '.' + Math.floor(Math.random() * 1e6);

  (function loadOriginalUserScript() {
    try {
      var s = document.createElement('script');
      s.src = ORIGINAL_USERSCRIPT_URL;
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn('[VOT] failed to load original userScript', e);
    }
  })();

  // Protobuf utils (port of VotProtoUtils.java)
  function writeVarint(buf, val) {
    var v = val >>> 0;
    while (v > 127) {
      buf.push((v & 127) | 128);
      v = v >>> 7;
    }
    buf.push(v);
  }

  function writeTag(buf, field, type) {
    writeVarint(buf, (field << 3) | type);
  }

  function writeString(buf, field, str) {
    var bytes = unescape(encodeURIComponent(str));
    var arr = [];
    for (var i = 0; i < bytes.length; i++) {
      arr.push(bytes.charCodeAt(i));
    }
    writeTag(buf, field, 2);
    writeVarint(buf, arr.length);
    for (var j = 0; j < arr.length; j++) {
      buf.push(arr[j]);
    }
  }

  function writeBool(buf, field, val) {
    writeTag(buf, field, 0);
    writeVarint(buf, val ? 1 : 0);
  }

  function writeDouble(buf, field, val) {
    writeTag(buf, field, 1);
    var tmp = new ArrayBuffer(8);
    new DataView(tmp).setFloat64(0, val, true);
    var arr = new Uint8Array(tmp);
    for (var i = 0; i < 8; i++) {
      buf.push(arr[i]);
    }
  }

  function writeInt32(buf, field, val) {
    writeTag(buf, field, 0);
    writeVarint(buf, val);
  }

  function buildTranslateProto(videoUrl, duration, fromLang, toLang) {
    var buf = [];
    writeString(buf, 3, videoUrl);
    writeBool(buf, 5, false);
    writeDouble(buf, 6, duration || 0);
    writeInt32(buf, 7, 1);
    writeString(buf, 8, fromLang || 'auto');
    writeString(buf, 14, toLang || 'ru');
    writeInt32(buf, 15, 1);
    writeInt32(buf, 16, 2);
    writeBool(buf, 18, false);
    return new Uint8Array(buf);
  }

  function readProto(arrayBuf) {
    var data = new Uint8Array(arrayBuf);
    var pos = 0;
    var result = {};
    while (pos < data.length) {
      var tag = 0, shift = 0, b;
      do {
        b = data[pos++];
        tag |= (b & 127) << shift;
        shift += 7;
      } while (b & 128);
      var field = tag >>> 3;
      var wire = tag & 7;
      if (wire === 0) {
        var v = 0; shift = 0;
        do {
          b = data[pos++];
          v |= (b & 127) << shift;
          shift += 7;
        } while (b & 128);
        result[field] = v;
      } else if (wire === 2) {
        var len = 0; shift = 0;
        do {
          b = data[pos++];
          len |= (b & 127) << shift;
          shift += 7;
        } while (b & 128);
        var strBytes = data.slice(pos, pos + len);
        try {
          var str = '';
          for (var i = 0; i < strBytes.length; i++) {
            str += String.fromCharCode(strBytes[i]);
          }
          result[field] = decodeURIComponent(escape(str));
        } catch(e) {
          result[field] = strBytes;
        }
        pos += len;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      }
    }
    return result;
  }

  // API requests
  function requestTranslation(videoUrl, duration) {
    var body = buildTranslateProto(videoUrl, duration, 'auto', 'ru');
    return fetch(VOT_WORKER + '/video-translation/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf'
      },
      body: body
    }).then(function(resp) {
      if (!resp.ok) throw new Error('translate error: ' + resp.status);
      return resp.arrayBuffer();
    }).then(function(buf) {
      return readProto(buf);
    });
  }

  function requestAudio(translationId) {
    var buf = [];
    writeString(buf, 1, translationId);
    return fetch(VOT_WORKER + '/video-translation/audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: new Uint8Array(buf)
    }).then(function(resp) {
      if (!resp.ok) throw new Error('audio error: ' + resp.status);
      return resp.arrayBuffer();
    }).then(function(buf) {
      return readProto(buf);
    });
  }

  // State
  var S = {
    on: false,
    videoId: null,
    translationId: null,
    audioEl: null,
    pollTimer: null,
    syncTimer: null
  };

  function getVideoEl() {
    return document.querySelector('video');
  }

  function getVideoId() {
    try {
      var u = new URL(location.href);
      var v = u.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      if (u.hostname.indexOf('youtu.be') !== -1) {
        var shortId = u.pathname.replace(/^\/+/, '').split('/')[0];
        if (/^[a-zA-Z0-9_-]{11}$/.test(shortId)) return shortId;
      }

      var pathMatch = u.pathname.match(/\/(shorts|live|watch)\/([a-zA-Z0-9_-]{11})/);
      if (pathMatch) return pathMatch[2];
    } catch (e) {}

    var m = location.href.match(/(?:[?&]v=|\/(?:shorts|live)\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  // Audio sync
  function syncAudio() {
    var video = getVideoEl();
    if (!video || !S.audioEl || !S.on) return;
    if (Math.abs(S.audioEl.currentTime - video.currentTime) > SYNC_THRESHOLD) {
      S.audioEl.currentTime = video.currentTime;
    }
    if (video.paused) {
      S.audioEl.pause();
    } else {
      S.audioEl.play().catch(function() {});
    }
    video.volume = 0.10;
  }

  function attachAudio(url) {
    if (S.audioEl) {
      S.audioEl.pause();
      S.audioEl.remove();
    }
    var a = document.createElement('audio');
    a.src = url;
    a.volume = 1.0;
    a.style.display = 'none';
    document.body.appendChild(a);
    S.audioEl = a;
    var video = getVideoEl();
    if (video && !video.paused) {
      a.play().catch(function() {});
    }
    clearInterval(S.syncTimer);
    S.syncTimer = setInterval(syncAudio, 300);
  }

  function setStatus(text) {
    var el = document.getElementById('vot-status');
    if (el) el.textContent = text;
  }

  // Poll for translation
  function pollTranslation(videoUrl, duration) {
    setStatus('запрос перевода...');
    requestTranslation(videoUrl, duration).then(function(resp) {
      var status = resp[4];
      var tid = resp[7];
      var url = resp[1];

      // status 1 = FINISHED, 6 = AUDIO_REQUESTED, 2/3 = WAITING
      if (status === 1 && url) {
        setStatus('перевод готов');
        attachAudio(url);
        return;
      }
      if (status === 6 && tid) {
        S.translationId = tid;
        return requestAudio(tid).then(function(aResp) {
          if (aResp[1]) {
            setStatus('перевод готов');
            attachAudio(aResp[1]);
          } else {
            setStatus('ожидание аудио...');
            S.pollTimer = setTimeout(function() {
              pollTranslation(videoUrl, duration);
            }, POLL_INTERVAL_MS);
          }
        });
      }
      if (tid) S.translationId = tid;
      var remaining = resp[5] || 0;
      setStatus('ожидание: ' + remaining + 'с');
      S.pollTimer = setTimeout(function() {
        pollTranslation(videoUrl, duration);
      }, POLL_INTERVAL_MS);
    }).catch(function(e) {
      setStatus('ошибка: ' + e.message);
      console.error('[VOT]', e);
    });
  }

  function startVOT() {
    var vid = getVideoId();
    if (!vid) { setStatus('нет видео'); return; }
    var video = getVideoEl();
    var duration = video ? (video.duration || 0) : 0;
    var videoUrl = 'https://www.youtube.com/watch?v=' + vid;
    S.videoId = vid;
    pollTranslation(videoUrl, duration);
  }

  function stopVOT() {
    clearTimeout(S.pollTimer);
    clearInterval(S.syncTimer);
    if (S.audioEl) {
      S.audioEl.pause();
      S.audioEl.remove();
      S.audioEl = null;
    }
    var video = getVideoEl();
    if (video) video.volume = 1.0;
    S.videoId = null;
    S.translationId = null;
  }

  // CSP forbids setAttribute('style', ...) / style.cssText assignment
  // (style-src requires a nonce we don't have), but individual
  // CSSStyleDeclaration longhand property assignment (el.style.prop = val)
  // is NOT gated by CSP style-src, so we apply styles that way instead.
  function applyStyle(el, decl) {
    for (var prop in decl) {
      if (Object.prototype.hasOwnProperty.call(decl, prop)) {
        el.style[prop] = decl[prop];
      }
    }
  }

  var BTN_STYLE_OFF = {
    padding: '10px 20px', fontSize: '17px', fontWeight: 'bold',
    background: 'rgba(0,0,0,0.85)', color: '#fff',
    border: '2px solid #f90', borderRadius: '10px',
    cursor: 'pointer', outline: 'none'
  };
  var BTN_STYLE_ON = {
    padding: '10px 20px', fontSize: '17px', fontWeight: 'bold',
    background: 'rgba(0,0,0,0.85)', color: '#fff',
    border: '2px solid #0f0', borderRadius: '10px',
    cursor: 'pointer', outline: 'none'
  };

  // UI
  function buildUI() {
    if (document.getElementById('vot-btn')) return;
    if (!document.body) return;

    var wrap = document.createElement('div');
    wrap.id = 'vot-wrap';
    applyStyle(wrap, {
      position: 'fixed', bottom: '70px', right: '16px', zIndex: '99999',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px'
    });

    var status = document.createElement('div');
    status.id = 'vot-status';
    applyStyle(status, {
      fontSize: '14px', color: '#fff', background: 'rgba(0,0,0,0.75)',
      padding: '4px 12px', borderRadius: '6px', display: 'none'
    });

    var btn = document.createElement('button');
    btn.id = 'vot-btn';
    btn.textContent = 'Перевод ВЫКЛ';
    applyStyle(btn, BTN_STYLE_OFF);

    btn.addEventListener('click', function() {
      S.on = !S.on;
      if (S.on) {
        btn.textContent = 'Перевод ВКЛ';
        applyStyle(btn, BTN_STYLE_ON);
        status.style.display = 'block';
        startVOT();
      } else {
        btn.textContent = 'Перевод ВЫКЛ';
        applyStyle(btn, BTN_STYLE_OFF);
        status.style.display = 'none';
        stopVOT();
      }
    });

    wrap.appendChild(status);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  // Watch for URL changes (video switch)
  var lastUrl = location.href;
  setInterval(function() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    // Cobalt/TV apps can rebuild layout during SPA navigation.
    ensureUI();

    if (S.on) {
      stopVOT();
      setTimeout(startVOT, 1500);
    }
  }, 1500);

  function ensureUI() {
    if (document.getElementById('vot-btn')) return true;
    if (!document.body) return false;
    buildUI();
    return !!document.getElementById('vot-btn');
  }

  // Init: retry for apps where body/overlay root appears after DOMContentLoaded.
  var initTry = 0;
  var initTimer = setInterval(function() {
    if (ensureUI() || initTry++ > 20) {
      clearInterval(initTimer);
    }
  }, 500);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    ensureUI();
  }


})();

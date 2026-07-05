(function() {
  'use strict';

  var VOT_WORKER = 'https://vot.sormat1.workers.dev';
  var POLL_INTERVAL_MS = 3000;
  var SYNC_THRESHOLD = 0.8;

  // This file REPLACES the native "userScript" URL that io.gh.reisxd's
  // TizenTube patch fetches on every page load (splash + main YouTube TV
  // page). That native fetch mechanism is the ONLY proven way to run custom
  // JS in the live youtube.com/tv page context.
  //
  // To preserve 100% of the original functionality (device-support patches:
  // SetUserAgent/GetArchitecture/GetBrandAndModel via h5vcc_tizentube, i18n,
  // SponsorBlock, adblock, PIP, the native settings menu, etc.) we load the
  // REAL upstream userScript.js via a normal <script src> element. That is
  // what registers window._yttv + the patched resolveCommand we hook below.
  var ORIGINAL_USERSCRIPT_URL =
    'https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=' +
    Date.now() + '.' + Math.floor(Math.random() * 1e6);

  // Cobalt/Starboard's WebView enforces Trusted Types
  // (require-trusted-types-for 'script'). Register a permissive pass-through
  // 'default' policy so plain-string assignment to script src keeps working.
  var ttPolicy = null;
  if (typeof window !== 'undefined' && window.trustedTypes && trustedTypes.createPolicy) {
    try {
      ttPolicy = trustedTypes.createPolicy('default', {
        createScriptURL: function(u) { return u; },
        createScript: function(s) { return s; },
        createHTML: function(h) { return h; }
      });
    } catch (e) {
      ttPolicy = null;
    }
  }

  function ttScriptURL(url) {
    if (ttPolicy && ttPolicy.createScriptURL) {
      try { return ttPolicy.createScriptURL(url); } catch (e) { /* fall through */ }
    }
    return url;
  }

  (function loadOriginalUserScript() {
    try {
      var s = document.createElement('script');
      s.src = ttScriptURL(ORIGINAL_USERSCRIPT_URL);
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn('[VOT] failed to load original userScript', e);
    }
  })();

  // ========================================================================
  // mpg123-decoder (WASM mp3 -> PCM), loaded IN-PAGE.
  //
  // Cobalt's only built-in AudioContext.decodeAudioData codec is WAV -- it
  // logs "Cobalt WAV decoder initializing" and throws a DOMException on mp3
  // (IsSupportedMediaMimeType(audio/mpeg) -> false). So we can't rely on the
  // browser to decode Yandex's mp3.
  //
  // Instead we decode the mp3 ourselves with the mpg123-decoder WASM bundle
  // (Cobalt has experimental WebAssembly on android-arm), producing raw
  // Float32 PCM that we drop straight into a Web Audio AudioBuffer. This also
  // avoids doing the (CPU-heavy) decode server-side, which would blow the
  // Cloudflare Workers free-plan 10ms CPU limit.
  //
  // jsDelivr /npm is already trusted by script-src (the original userScript
  // above loads from cdn.jsdelivr.net/npm), so we can <script src> it too.
  var MPG_DECODER_URL =
    'https://cdn.jsdelivr.net/npm/mpg123-decoder@1.0.3/dist/mpg123-decoder.min.js';
  var mpgLoadPromise = null;

  function loadMpgDecoder() {
    if (mpgLoadPromise) return mpgLoadPromise;
    mpgLoadPromise = new Promise(function(resolve, reject) {
      try {
        if (window['mpg123-decoder'] && window['mpg123-decoder'].MPEGDecoder) {
          resolve(window['mpg123-decoder']);
          return;
        }
        // The UMD bundle evaluates `class ... extends globalThis.Worker` at
        // load time. If Cobalt has no Worker, that throws and the whole script
        // fails to load. We only ever use the MAIN-THREAD MPEGDecoder (which
        // never touches Worker), so a harmless stub is enough to let the
        // bundle define its (unused) worker subclass.
        if (typeof window.Worker === 'undefined') {
          try { window.Worker = function VotNoopWorker() {}; } catch (e) {}
        }
        var s = document.createElement('script');
        s.src = ttScriptURL(MPG_DECODER_URL);
        s.async = true;
        s.onload = function() {
          var lib = window['mpg123-decoder'];
          if (lib && lib.MPEGDecoder) resolve(lib);
          else reject(new Error('mpg123-decoder loaded but no MPEGDecoder'));
        };
        s.onerror = function() {
          reject(new Error('failed to load mpg123-decoder'));
        };
        (document.head || document.documentElement).appendChild(s);
      } catch (e) {
        reject(e);
      }
    });
    return mpgLoadPromise;
  }

  // Decode an mp3 ArrayBuffer to a Web Audio AudioBuffer using the WASM
  // decoder. Returns a Promise<AudioBuffer>.
  function decodeMp3ToAudioBuffer(arrayBuf, ctx) {
    return loadMpgDecoder().then(function(lib) {
      var decoder = new lib.MPEGDecoder();
      return decoder.ready.then(function() {
        var mp3 = new Uint8Array(arrayBuf);
        var out;
        try {
          out = decoder.decode(mp3);
        } finally {
          try { decoder.free(); } catch (e) {}
        }
        var channelData = out.channelData;      // Float32Array[]
        var samples = out.samplesDecoded;
        var rate = out.sampleRate;
        if (!channelData || !channelData.length || !samples) {
          throw new Error('mp3 decoded to 0 samples');
        }
        // Build the AudioBuffer at the decoder's native sample rate; the
        // AudioContext resamples on playback if it differs from ctx.sampleRate.
        var buf = ctx.createBuffer(channelData.length, samples, rate);
        for (var ch = 0; ch < channelData.length; ch++) {
          var src = channelData[ch];
          if (src.length > samples) src = src.subarray(0, samples);
          buf.getChannelData(ch).set(src);
        }
        return buf;
      });
    });
  }

  // ========================================================================
  // Protobuf utils (port of VotProtoUtils.java)
  // ========================================================================
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

  // ========================================================================
  // API requests
  //
  // We talk to OUR signing worker (see vot-signing-worker.js), which does the
  // Yandex session + HMAC signing SERVER-SIDE and returns permissive CORS
  // (Access-Control-Allow-Headers: *). So the in-page request stays a PLAIN
  // POST with only Content-Type — no custom headers, hence no CORS preflight
  // rejection. Set VOT_WORKER to your deployed worker URL.
  // ========================================================================
  function requestTranslation(videoUrl, duration) {
    var body = buildTranslateProto(videoUrl, duration, 'auto', 'ru');
    return fetch(VOT_WORKER + '/video-translation/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
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

  // ========================================================================
  // State
  // ========================================================================
  var S = {
    on: false,
    videoId: null,
    translationId: null,
    // Web Audio playback state (Cobalt can't play a progressive mp3 via
    // <audio>.src -- "Progressive streams are unsupported" -- so we decode the
    // whole file with AudioContext.decodeAudioData and play the PCM buffer).
    audioCtx: null,
    audioBuffer: null,
    srcNode: null,
    gainNode: null,
    startedAtCtxTime: 0,   // audioCtx.currentTime when current srcNode started
    startedAtOffset: 0,    // buffer offset (s) the current srcNode started from
    playing: false,
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

  // ========================================================================
  // Web Audio playback + sync
  //
  // Cobalt's media pipeline rejects a progressive mp3 played through an
  // <audio> element ("Progressive streams are unsupported" /
  // IsSupportedMediaMimeType(audio/mpeg) -> false). So instead we decode the
  // ENTIRE downloaded mp3 into a PCM AudioBuffer via the Web Audio API and
  // schedule it on an AudioContext -- a completely separate code path that
  // does NOT go through the "progressive" demuxer. We keep the translation in
  // sync with the video by (re)starting the buffer at the right offset
  // whenever it drifts more than SYNC_THRESHOLD seconds.
  // ========================================================================
  function ensureCtx() {
    if (!S.audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('no AudioContext');
      S.audioCtx = new Ctx();
      S.gainNode = S.audioCtx.createGain();
      S.gainNode.gain.value = 1.0;
      S.gainNode.connect(S.audioCtx.destination);
    }
    if (S.audioCtx.state === 'suspended') {
      try { S.audioCtx.resume(); } catch (e) {}
    }
    return S.audioCtx;
  }

  // Where in the translation buffer we currently are (seconds).
  function currentAudioOffset() {
    if (!S.audioCtx || !S.playing) return S.startedAtOffset;
    return S.startedAtOffset + (S.audioCtx.currentTime - S.startedAtCtxTime);
  }

  function stopSrcNode() {
    if (S.srcNode) {
      try { S.srcNode.onended = null; S.srcNode.stop(); } catch (e) {}
      try { S.srcNode.disconnect(); } catch (e) {}
      S.srcNode = null;
    }
    S.playing = false;
  }

  // Start playing the decoded buffer from `offset` seconds.
  function playFromOffset(offset) {
    if (!S.audioBuffer) return;
    stopSrcNode();
    if (offset < 0) offset = 0;
    if (offset >= S.audioBuffer.duration) return; // past the end
    var node = S.audioCtx.createBufferSource();
    node.buffer = S.audioBuffer;
    node.connect(S.gainNode);
    node.start(0, offset);
    S.srcNode = node;
    S.startedAtCtxTime = S.audioCtx.currentTime;
    S.startedAtOffset = offset;
    S.playing = true;
  }

  function syncAudio() {
    var video = getVideoEl();
    if (!video || !S.audioBuffer || !S.on) return;

    // Mirror the video's play/pause state.
    if (video.paused) {
      if (S.playing) {
        // Freeze: remember where we are and stop the node.
        S.startedAtOffset = currentAudioOffset();
        stopSrcNode();
      }
      video.volume = 0.10;
      return;
    }

    var target = video.currentTime;
    var drift = Math.abs(currentAudioOffset() - target);
    if (!S.playing || drift > SYNC_THRESHOLD) {
      playFromOffset(target);
    }
    video.volume = 0.10;
  }

  // The translated mp3 lives on vtrans.s3-private.mds.yandex.net, which is in
  // neither the page's CSP connect-src NOR media-src. We fetch it THROUGH the
  // worker's audio-proxy (connect-src allows the worker), then decode the raw
  // bytes with Web Audio (bypasses Cobalt's progressive-stream limitation).
  function attachAudio(url) {
    var proxied = VOT_WORKER + '/video-translation/audio-proxy?u=' +
                  encodeURIComponent(url);
    notify('загрузка озвучки...');
    fetch(proxied, { method: 'GET' }).then(function(resp) {
      if (!resp.ok) throw new Error('audio-proxy ' + resp.status);
      return resp.arrayBuffer();
    }).then(function(arrayBuf) {
      if (!S.on) return; // turned off during download
      var ctx = ensureCtx();
      notify('декодирование...');
      LOG('mp3 downloaded, bytes =', arrayBuf.byteLength, '-> WASM decode');
      // Cobalt's decodeAudioData only handles WAV and throws a DOMException on
      // mp3, so decode the mp3 ourselves with the mpg123-decoder WASM bundle
      // and hand the resulting PCM AudioBuffer to onDecoded().
      return decodeMp3ToAudioBuffer(arrayBuf, ctx).then(function(buf) {
        if (!S.on) return;
        onDecoded(buf);
      });
    }).catch(function(e) {
      notify('ошибка аудио: ' + (e && e.message));
      console.error('[VOT] attachAudio', e);
    });
  }

  function onDecoded(buf) {
    if (!S.on || !buf) return;
    S.audioBuffer = buf;
    LOG('audio decoded, duration =', buf.duration.toFixed(1), 's');
    notify('озвучка запущена');
    var video = getVideoEl();
    if (video && !video.paused) {
      playFromOffset(video.currentTime || 0);
    } else {
      S.startedAtOffset = video ? (video.currentTime || 0) : 0;
    }
    if (video) video.volume = 0.10;
    clearInterval(S.syncTimer);
    S.syncTimer = setInterval(syncAudio, 300);
  }

  // ========================================================================
  // Status reporting: prefer the native TizenTube toast (D-pad friendly,
  // matches the app UI), fall back to the floating overlay status div.
  // ========================================================================
  function notify(text) {
    setOverlayStatus(text);
    try {
      var rc = getResolveCommand();
      if (rc) {
        rc({
          openPopupAction: {
            popupType: 'TOAST',
            popup: {
              overlayToastRenderer: {
                title: { simpleText: 'VOT' },
                subtitle: { simpleText: text }
              }
            }
          }
        });
      }
    } catch (e) { /* toast is best-effort */ }
  }

  function setOverlayStatus(text) {
    var el = document.getElementById('vot-status');
    if (el) el.textContent = text;
  }

  // ========================================================================
  // Poll for translation
  // ========================================================================
  function pollTranslation(videoUrl, duration) {
    notify('запрос перевода...');
    LOG('poll translate url=', videoUrl, 'dur=', duration);
    requestTranslation(videoUrl, duration).then(function(resp) {
      if (!S.on) return; // user turned it off while waiting
      var status = resp[4];
      var tid = resp[7];
      var url = resp[1];
      var remaining = resp[5] || 0;
      // Mirror the translation status into logcat so it's visible over adb
      // (TOAST alone doesn't show up there). Statuses: 0=FAILED, 1=FINISHED,
      // 2=WAITING, 3=LONG_WAITING, 5=PART_CONTENT, 6=AUDIO_REQUESTED.
      LOG('translate resp: status=', status, 'remaining=', remaining,
          'hasUrl=', !!url, 'tid=', tid);

      if (status === 1 && url) {
        notify('перевод готов');
        attachAudio(url);
        return;
      }
      if (status === 6 && tid) {
        S.translationId = tid;
        return requestAudio(tid).then(function(aResp) {
          if (!S.on) return;
          LOG('audio resp: hasUrl=', !!aResp[1]);
          if (aResp[1]) {
            notify('перевод готов');
            attachAudio(aResp[1]);
          } else {
            setOverlayStatus('ожидание аудио...');
            S.pollTimer = setTimeout(function() {
              pollTranslation(videoUrl, duration);
            }, POLL_INTERVAL_MS);
          }
        });
      }
      if (tid) S.translationId = tid;
      notify('ожидание перевода (' + status + '): ' + remaining + 'с');
      setOverlayStatus('ожидание: ' + remaining + 'с');
      S.pollTimer = setTimeout(function() {
        pollTranslation(videoUrl, duration);
      }, POLL_INTERVAL_MS);
    }).catch(function(e) {
      notify('ошибка: ' + e.message);
      LOG('poll error', e && e.message);
      console.error('[VOT]', e);
    });
  }

  function startVOT() {
    var vid = getVideoId();
    if (!vid) { notify('нет видео'); return; }
    var video = getVideoEl();
    var duration = video ? (video.duration || 0) : 0;
    var videoUrl = 'https://www.youtube.com/watch?v=' + vid;
    S.videoId = vid;
    pollTranslation(videoUrl, duration);
  }

  function stopVOT() {
    clearTimeout(S.pollTimer);
    clearInterval(S.syncTimer);
    stopSrcNode();
    S.audioBuffer = null;
    S.startedAtOffset = 0;
    var video = getVideoEl();
    if (video) video.volume = 1.0;
    S.videoId = null;
    S.translationId = null;
  }

  function toggleVOT() {
    S.on = !S.on;
    syncOverlayButton();
    if (S.on) {
      notify('Перевод ВКЛ');
      startVOT();
    } else {
      notify('Перевод ВЫКЛ');
      stopVOT();
    }
    return S.on;
  }

  // ========================================================================
  // NATIVE MENU INTEGRATION
  //
  // TizenTube wraps window._yttv[...].instance.resolveCommand and injects
  // its own buttons ("Mini Player", "Picture in Picture") into the player's
  // "playback-settings" popup. Those buttons are real, D-pad-navigable YouTube
  // TV renderers, and clicking one fires a customAction that TizenTube's own
  // resolveCommand wrapper routes. We reuse EXACTLY that mechanism.
  //
  // IMPORTANT: there are MANY _yttv entries (bundle patches ~12). The active
  // instance that actually receives the playback-settings popup is not
  // necessarily the first one, so we must wrap EVERY instance that exposes
  // resolveCommand (exactly what TizenTube's patchResolveCommand does).
  // ========================================================================

  function LOG() {
    try {
      var a = ['[VOT]'];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      console.info.apply(console, a);
    } catch (e) {}
  }

  function getResolveCommand() {
    if (!window._yttv) return null;
    for (var key in window._yttv) {
      var e = window._yttv[key];
      if (e && e.instance && typeof e.instance.resolveCommand === 'function') {
        return e.instance.resolveCommand.bind(e.instance);
      }
    }
    return null;
  }

  // A YouTube-TV compactLinkRenderer button that toggles VOT.
  //
  // IMPORTANT: we use signalAction.signal (NOT customAction). TizenTube's own
  // resolveCommand wrapper swallows EVERY customAction (it does
  // `if (cmd.customAction) { ...; return true; }`), so if its wrapper sits
  // outside ours, our customAction never reaches us. It only touches
  // signalAction when there's a nested customAction — a plain signal passes
  // straight through to the inner (our) wrapper regardless of wrapper order.
  function votButtonItem() {
    return {
      compactLinkRenderer: {
        title: { simpleText: 'Yandex перевод (VOT)' },
        subtitle: { simpleText: S.on ? 'ВКЛ' : 'ВЫКЛ' },
        icon: { iconType: 'TRANSLATE' },
        serviceEndpoint: {
          commandExecutorCommand: {
            commands: [
              { signalAction: { signal: 'VOT_TOGGLE' } },
              { signalAction: { signal: 'POPUP_BACK' } }
            ]
          }
        }
      }
    };
  }

  // Recursively search a popup object for ANY array named "items" that looks
  // like a menu list, so we don't depend on the exact renderer nesting path
  // (which differs between YouTube TV builds).
  function findItemArrays(obj, depth, out) {
    if (!obj || typeof obj !== 'object' || depth > 8) return out;
    if (Array.isArray(obj.items)) out.push(obj);
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v && typeof v === 'object') findItemArrays(v, depth + 1, out);
    }
    return out;
  }

  function injectVotIntoPopup(cmd) {
    var containers = findItemArrays(cmd.openPopupAction.popup, 0, []);
    if (!containers.length) { LOG('popup has no items[] array'); return false; }
    // Prefer the largest items array (the main option list of the popup).
    containers.sort(function(a, b) { return b.items.length - a.items.length; });
    var list = containers[0];

    for (var i = 0; i < list.items.length; i++) {
      var it = list.items[i];
      if (it && it.compactLinkRenderer && it.compactLinkRenderer.title &&
          it.compactLinkRenderer.title.simpleText &&
          it.compactLinkRenderer.title.simpleText.indexOf('VOT') !== -1) {
        it.compactLinkRenderer.subtitle = { simpleText: S.on ? 'ВКЛ' : 'ВЫКЛ' };
        LOG('VOT item already present, refreshed label');
        return true;
      }
    }
    list.items.splice(list.items.length, 0, votButtonItem());
    LOG('injected VOT item into popup, items now =', list.items.length);
    return true;
  }

  // Recursively check whether a command (or any nested command inside a
  // commandExecutorCommand) carries our VOT_TOGGLE marker, in any of the
  // forms YouTube TV might route it through.
  function isVotToggle(cmd, depth) {
    if (!cmd || typeof cmd !== 'object' || depth > 6) return false;
    if (cmd.signalAction && cmd.signalAction.signal === 'VOT_TOGGLE') return true;
    if (cmd.customAction && cmd.customAction.action === 'VOT_TOGGLE') return true;
    if (cmd.signalAction && cmd.signalAction.customAction &&
        cmd.signalAction.customAction.action === 'VOT_TOGGLE') return true;
    if (cmd.commandExecutorCommand && cmd.commandExecutorCommand.commands) {
      var cs = cmd.commandExecutorCommand.commands;
      for (var i = 0; i < cs.length; i++) {
        if (isVotToggle(cs[i], depth + 1)) return true;
      }
    }
    return false;
  }

  function makeWrapped(orig) {
    var wrapped = function(cmd, arg) {
      try {
        if (isVotToggle(cmd, 0)) {
          LOG('VOT_TOGGLE received -> toggle');
          toggleVOT();
          return true;
        }
        // Diagnostic: log action-like commands (not plain navigation/popups)
        // so we can see exactly what a menu click routes through.
        if (cmd && typeof cmd === 'object' && !cmd.openPopupAction) {
          if (cmd.signalAction || cmd.customAction || cmd.commandExecutorCommand) {
            var sig = cmd.signalAction && cmd.signalAction.signal;
            var act = cmd.customAction && cmd.customAction.action;
            var nExec = cmd.commandExecutorCommand && cmd.commandExecutorCommand.commands &&
                        cmd.commandExecutorCommand.commands.length;
            LOG('cmd keys=', Object.keys(cmd).join(','),
                '| signal=', sig, '| action=', act, '| execN=', nExec);
          }
        }
        if (cmd && cmd.openPopupAction) {
          var uid = cmd.openPopupAction.uniqueId;
          var ptype = cmd.openPopupAction.popupType;
          // Log every popup so we can identify the real player-settings id
          // via `adb logcat | grep VOT`.
          LOG('openPopupAction uniqueId=', uid, 'popupType=', ptype);
          // Inject into the player settings popup. Match by known id OR by the
          // MODAL popup type that carries an overlayPanelItemListRenderer.
          if (uid === 'playback-settings' ||
              (uid && String(uid).indexOf('settings') !== -1) ||
              ptype === 'MODAL') {
            injectVotIntoPopup(cmd);
          }
        }
      } catch (err) {
        LOG('menu hook error', err && err.message);
      }
      return orig.apply(this, arguments);
    };
    wrapped.__votWrapped = true;
    return wrapped;
  }

  var votHookCount = 0;
  function installMenuHook() {
    if (!window._yttv) return false;
    var newly = 0;
    for (var key in window._yttv) {
      var e = window._yttv[key];
      if (e && e.instance && typeof e.instance.resolveCommand === 'function') {
        var orig = e.instance.resolveCommand;
        if (orig.__votWrapped) continue;
        e.instance.resolveCommand = makeWrapped(orig);
        newly++;
      }
    }
    if (newly) {
      votHookCount += newly;
      LOG('wrapped', newly, 'resolveCommand instance(s); total =', votHookCount);
    }
    return votHookCount > 0;
  }

  // Keep (re)installing: instances can appear/rebuild over time (boot, reload,
  // SPA nav). We never stop fully — just slow down after it's installed.
  var hookTries = 0;
  var hookTimer = setInterval(function() {
    installMenuHook();
    hookTries++;
    if (votHookCount > 0 && hookTries > 40) {
      // switch to a slower steady-state re-check
      clearInterval(hookTimer);
      setInterval(installMenuHook, 4000);
    }
    if (hookTries > 600) clearInterval(hookTimer);
  }, 500);

  // The floating overlay button was removed: the native player-menu item is
  // the intended control. syncOverlayButton is kept as a no-op so callers
  // (toggleVOT) don't need to change.
  function syncOverlayButton() { /* no overlay */ }

  // ========================================================================
  // GUARANTEED remote control: the YELLOW colour button (keyCode 405) is NOT
  // used by TizenTube (403=red, 404=green are), so we bind it to toggle VOT.
  // This works everywhere, independent of the player menu structure.
  //
  // Debounced: a single physical press emits several keydown/keyup/repeat
  // events; we act on keydown only and ignore anything within 800ms so one
  // press = one toggle.
  // ========================================================================
  var lastToggleAt = 0;
  function onKey(evt) {
    if (evt.keyCode === 405) { // YELLOW
      evt.preventDefault();
      evt.stopPropagation();
      if (evt.type === 'keydown') {
        var now = Date.now();
        if (now - lastToggleAt < 800) return false; // debounce repeats
        lastToggleAt = now;
        LOG('YELLOW key -> toggle VOT');
        toggleVOT();
      }
      return false;
    }
    return true;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

  // ========================================================================
  // Watch for URL changes (video switch)
  // ========================================================================
  var lastUrl = location.href;
  setInterval(function() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    // Re-arm the menu hook in case the client rebuilt _yttv during nav.
    installMenuHook();

    if (S.on) {
      stopVOT();
      setTimeout(function() { if (S.on) startVOT(); }, 1500);
    }
  }, 1500);

})();

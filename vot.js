(function () {
  'use strict';
  var BRIDGE = 'http://127.0.0.1:8013';
  function log(m) { try { console.log('[VOT-boot] ' + m); } catch (e) { } }

  // Trusted Types pass-through (harmless if TT not enforced; needed for eval
  // when require-trusted-types-for 'script' is active).
  try {
    if (window.trustedTypes && window.trustedTypes.createPolicy && !window.trustedTypes.defaultPolicy) {
      window.trustedTypes.createPolicy('default', { createScript: function (s) { return s; } });
    }
  } catch (e) { }

  function load() {
    try {
      fetch(BRIDGE + '/vot.js?b=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
        .then(function (t) { (0, eval)(t); })
        .catch(function (e) { log('bridge fetch failed: ' + e + '; retry in 3s'); setTimeout(load, 3000); });
    } catch (e) { setTimeout(load, 3000); }
  }

  log('bootstrap loaded, pulling overlay from bridge');
  load();
})();

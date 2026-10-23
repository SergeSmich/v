(function () {
  'use strict';
  var BRIDGE = 'http://127.0.0.1:8013';
  var ORIG = 'https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=' +
             Date.now() + '.' + Math.floor(Math.random() * 1e6);

  function report(m) {
    try { var x = new XMLHttpRequest(); x.open('POST', BRIDGE + '/log', true); x.send(m); } catch (e) { }
  }

  // Trusted Types pass-through (harmless if TT not enforced; needed for eval
  // when require-trusted-types-for 'script' is active).
  try {
    if (window.trustedTypes && window.trustedTypes.createPolicy && !window.trustedTypes.defaultPolicy) {
      window.trustedTypes.createPolicy('default', { createScript: function (s) { return s; } });
    }
  } catch (e) { }

  // 1. Load the ORIGINAL TizenTube userScript FIRST. This is what spoofs the
  //    device (UA / brand / model via h5vcc_tizentube) so YouTube TV accepts
  //    the device. Without it YouTube shows "device not supported".
  try {
    var s = document.createElement('script');
    s.src = ORIG;
    (document.head || document.documentElement).appendChild(s);
    report('[VOT-boot] original userScript requested');
  } catch (e) {
    report('[VOT-boot] original userScript load failed: ' + e);
  }

  // 2. Pull the VOT overlay from the in-app bridge and eval it.
  function load() {
    try {
      fetch(BRIDGE + '/vot.js?b=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
        .then(function (t) {
          try { (0, eval)(t); }
          catch (e) { report('[VOT-boot] eval failed: ' + e); }
        })
        .catch(function (e) { report('[VOT-boot] bridge fetch failed: ' + e + '; retry in 3s'); setTimeout(load, 3000); });
    } catch (e) { setTimeout(load, 3000); }
  }
  load();
})();

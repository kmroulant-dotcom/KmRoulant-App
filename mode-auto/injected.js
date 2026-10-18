// Script injecté dans la page AVANT son chargement : il crée window.KmrNative.
//
// MODULE PUR, testé sous Node (jsdom).
//
// Chaque méthode renvoie une promesse, résolue quand l'application répond
// (window.__kmrNativeReply). Délai par méthode : la demande de permission
// attend que l'utilisateur réponde au système, le reste répond tout de suite.
//
// La page (ui_explorer/auto-ride.js) détecte le pont par sa présence : rien à
// configurer côté explorateur.

export function bridgeScript(platform) {
  return `(function () {
  if (window.KmrNative) return;
  var pending = {};
  var nextId = 1;
  var TIMEOUTS = { requestPermission: 180000, startRecording: 60000, startGuidance: 60000 };
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      // Lu À L'APPEL : selon la plateforme, l'objet de messagerie de la
      // WebView peut arriver après ce script.
      if (!window.ReactNativeWebView) { reject(new Error('KmrNative : pont indisponible')); return; }
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      window.ReactNativeWebView.postMessage(JSON.stringify({ kmr: 1, id: id, method: method, args: args || {} }));
      setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        reject(new Error('KmrNative : pas de réponse à ' + method));
      }, TIMEOUTS[method] || 15000);
    });
  }
  window.__kmrNativeReply = function (msg) {
    var p = msg && pending[msg.id];
    if (!p) return;
    delete pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };
  window.KmrNative = {
    // 2 : guidage vocal (startGuidance, stopGuidance, guidanceStatus)
    version: 2,
    platform: ${JSON.stringify(platform)},
    permissionStatus: function () { return call('permissionStatus'); },
    requestPermission: function () { return call('requestPermission'); },
    startRecording: function (o) { return call('startRecording', o); },
    stopRecording: function () { return call('stopRecording'); },
    isRecording: function () { return call('isRecording'); },
    readPoints: function (o) { return call('readPoints', o); },
    ackPoints: function (o) { return call('ackPoints', o); },
    clearRide: function (o) { return call('clearRide', o); },
    startGuidance: function (o) { return call('startGuidance', o); },
    stopGuidance: function () { return call('stopGuidance'); },
    guidanceStatus: function () { return call('guidanceStatus'); }
  };
})();
true;`;
}

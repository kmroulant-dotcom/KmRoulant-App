// Pont page ↔ application : répond aux appels de window.KmrNative.
//
// MODULE PUR (dépendances injectées), testé sous Node.
//
// PROTOCOLE. La page envoie `{ kmr: 1, id, method, args }` par
// ReactNativeWebView.postMessage ; on répond `{ id, result }` ou
// `{ id, error }`, que l'application réinjecte dans la page
// (window.__kmrNativeReply, voir injected.js).
//
// SEULES LES PAGES DE L'APPLICATION ONT LE PONT : l'adresse d'où vient le
// message est vérifiée à chaque appel. Une page tierce ouverte par erreur
// dans la WebView ne peut ni lire les positions ni démarrer le service.

export const BRIDGE_METHODS = [
  'permissionStatus', 'requestPermission',
  'startRecording', 'stopRecording', 'isRecording',
  'readPoints', 'ackPoints', 'clearRide',
  'startGuidance', 'stopGuidance', 'guidanceStatus'
];

/**
 * @param {{recorder: object, store: object, guidance?: object,
 *          isAppUrl: (url: string) => boolean}} deps
 *   guidance : facultatif (guidance.js) ; sans lui, les méthodes de guidage
 *   répondent par une erreur.
 * @returns {(raw: string, url: string) => Promise<object|null>} null : message
 *   qui n'est pas pour le pont (la page peut en envoyer d'autres).
 */
export function createBridge({ recorder, store, guidance = null, isAppUrl }) {
  const guide = (name) => (a) => {
    if (!guidance || typeof guidance[name] !== 'function') throw new Error('Guidage indisponible');
    return guidance[name](a);
  };
  const impl = {
    permissionStatus: () => recorder.permissionStatus(),
    requestPermission: () => recorder.requestPermission(),
    startRecording: (a) => recorder.startRecording(a),
    stopRecording: () => recorder.stopRecording(),
    isRecording: () => recorder.isRecording(),
    readPoints: (a) => store.readPoints(a),
    ackPoints: (a) => store.ackPoints(a),
    clearRide: (a) => store.clearRide(a),
    startGuidance: guide('startGuidance'),
    stopGuidance: guide('stopGuidance'),
    guidanceStatus: guide('guidanceStatus')
  };

  return async function handle(raw, url) {
    let msg;
    try { msg = JSON.parse(raw); } catch (err) { return null; }
    if (!msg || msg.kmr !== 1 || !Number.isInteger(msg.id)) return null;

    if (!isAppUrl(url)) return { id: msg.id, error: 'Origine non autorisée' };
    const fn = BRIDGE_METHODS.includes(msg.method) ? impl[msg.method] : null;
    if (!fn) return { id: msg.id, error: `Méthode inconnue : ${msg.method}` };

    try {
      const result = await fn(msg.args && typeof msg.args === 'object' ? msg.args : {});
      return { id: msg.id, result: result === undefined ? null : result };
    } catch (err) {
      return { id: msg.id, error: String((err && err.message) || err) };
    }
  };
}

/**
 * Code à injecter pour remettre une réponse à la page.
 *
 * U+2028 ET U+2029 SONT ÉCHAPPÉS : valides en JSON, ils terminent une ligne
 * en JavaScript (avant ES2019 dans certains moteurs) et casseraient le script.
 */
export function replyScript(reply) {
  const json = JSON.stringify(reply).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `window.__kmrNativeReply && window.__kmrNativeReply(${json}); true;`;
}

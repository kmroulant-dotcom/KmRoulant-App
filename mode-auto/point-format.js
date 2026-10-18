// Position du service → point enregistré. MODULE PUR (aucun import), testé
// sous Node : c'est le contrat entre ce service et la page
// (fromBridgePoint, ui_explorer/auto-ride.js).
//
// Mêmes champs que les points de la page : `[lng, lat]`, altitude, précisions,
// vitesse et cap TELS QUE LE GPS LES DONNE. Rien n'est interprété ici : c'est
// le travail du serveur, qui voit la trace entière.

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {object} location - élément de `data.locations` (expo-location).
 * @returns {object|null} null pour une position inexploitable ou SIMULÉE
 *   (`mocked`, Android) : une évaluation déduite d'une trace inventée n'a
 *   aucune valeur.
 */
export function toPoint(location) {
  if (!location || location.mocked === true) return null;
  const c = location.coords || {};
  if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
  const t = Number.isFinite(location.timestamp) ? Math.round(location.timestamp) : Date.now();
  // Vitesse et cap négatifs : « inconnu » sur iOS.
  const speed = finiteOrNull(c.speed);
  const heading = finiteOrNull(c.heading);
  return {
    t,
    lng: c.longitude,
    lat: c.latitude,
    alt: finiteOrNull(c.altitude),
    acc: finiteOrNull(c.accuracy),
    altAcc: finiteOrNull(c.altitudeAccuracy),
    speed: speed !== null && speed >= 0 ? speed : null,
    heading: heading !== null && heading >= 0 ? heading : null
  };
}

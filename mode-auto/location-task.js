// Tâche de localisation en arrière-plan.
//
// DÉFINIE AU NIVEAU DU MODULE, ET CE MODULE IMPORTÉ EN PREMIER (index.js) :
// le système peut relancer le JavaScript de l'application pour lui livrer des
// positions, sans qu'aucun écran ne soit monté. La tâche doit alors exister
// avant tout le reste.
//
// DEUX USAGES DES MÊMES POSITIONS :
//   - guidage vocal (guidance.js) : annonce la prochaine manœuvre, tout de
//     suite, écran éteint compris ;
//   - mode Éclaireur : chaque position part dans le dépôt pour la sortie en
//     cours, sans interprétation. C'est la page qui la reprendra, puis le
//     serveur qui la lira.

import * as TaskManager from 'expo-task-manager';
import { getActiveRide, insertPoints } from './point-store';
import { toPoint } from './point-format';
import { onGuidanceLocations } from './guidance';
import { LOCATION_TASK } from './config';

// Gardé ici aussi pour les imports existants
export { LOCATION_TASK };

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    // Signal perdu, permission retirée : on n'écrit rien, on n'arrête rien.
    // La page verra le trou dans les horodatages.
    console.warn('[kmroulant] localisation :', error.message);
    return;
  }
  const locations = (data && data.locations) || [];
  if (!locations.length) return;

  // Guidage d'abord : l'annonce n'attend pas l'écriture des points.
  try {
    await onGuidanceLocations(locations);
  } catch (err) {
    console.error('[kmroulant] guidage :', err);
  }

  const rideId = await getActiveRide();
  if (!rideId) return;   // aucune sortie : guidage seul, ou livraison tardive après l'arrêt

  const points = locations.map(toPoint).filter(Boolean);
  try {
    await insertPoints(rideId, points);
  } catch (err) {
    console.error('[kmroulant] positions non écrites :', err);
  }
});

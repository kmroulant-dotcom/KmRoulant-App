// Démarrage et arrêt du service de localisation.
//
// UN SEUL SERVICE POUR DEUX USAGES : l'enregistrement du mode Éclaireur
// (startRecording) et le guidage vocal (guidance.js). Il tourne tant que l'un
// des deux en a besoin, et sa notification dit lequel.
//
// ANDROID : un service de premier plan de type `location`, avec sa
// notification. Démarré PENDANT QUE L'APPLICATION EST AU PREMIER PLAN (un
// appui dans la page), il n'exige que la permission « pendant l'utilisation »
// — pas ACCESS_BACKGROUND_LOCATION, donc pas le formulaire de justification
// du Play Store.
//
// iOS : le mode d'arrière-plan `location` (Info.plist, UIBackgroundModes),
// l'indicateur bleu affiché, et pas de pause automatique. Si le système exige
// malgré tout l'autorisation « Toujours », on la demande une fois, puis on
// réessaie.

import { Platform } from 'react-native';
import * as Location from 'expo-location';
import {
  LOCATION_TASK, SERVICE_NOTIFICATION, GUIDANCE_NOTIFICATION, BOTH_NOTIFICATION
} from './config';
import { setActiveRide, getActiveRide, hasActiveGuidance } from './point-store';

// Notification avec laquelle le service a été lancé dans ce JavaScript. Après
// une relance par le système, inconnue : le premier appel relance le service
// une fois, sans conséquence.
let currentNotification = null;

function notificationFor(ride, guidance) {
  if (ride && guidance) return BOTH_NOTIFICATION;
  if (guidance) return GUIDANCE_NOTIFICATION;
  return SERVICE_NOTIFICATION;
}

function updateOptions(n) {
  return {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 1000,          // Android : une position par seconde
    distanceInterval: 0,
    // iOS : ne jamais suspendre (un arrêt photo n'est pas une fin de sortie),
    // profil « fitness » (hors route), indicateur visible.
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Fitness,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: n.title,
      notificationBody: n.body,
      notificationColor: n.color,
      // L'enregistrement survit à la fermeture de l'écran de l'application.
      killServiceOnDestroy: false
    }
  };
}

export async function permissionStatus() {
  const fg = await Location.getForegroundPermissionsAsync();
  let bg = { status: 'undetermined' };
  try { bg = await Location.getBackgroundPermissionsAsync(); } catch (err) { /* non déclarée */ }
  return { foreground: fg.status, background: bg.status, canAskAgain: fg.canAskAgain };
}

/** Demande « pendant l'utilisation » — la seule nécessaire au départ. */
export async function requestPermission() {
  const fg = await Location.requestForegroundPermissionsAsync();
  return { foreground: fg.status, canAskAgain: fg.canAskAgain };
}

/**
 * Lance le service s'il ne tourne pas, ou met sa notification à jour.
 * À appeler APRÈS avoir noté ce qui en a besoin (sortie active, guidage).
 *
 * Relancer startLocationUpdatesAsync sur une tâche déjà lancée remplace ses
 * réglages (et la notification Android) sans interrompre les positions.
 */
export async function ensureService() {
  const perm = await Location.getForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('NOT_AUTHORIZED');

  const n = notificationFor(!!(await getActiveRide()), await hasActiveGuidance());
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  if (started && currentNotification === n) return { ok: true, already: true };

  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, updateOptions(n));
  } catch (err) {
    if (Platform.OS !== 'ios' || started) throw err;
    // iOS refuse sans « Toujours » : on la demande, une fois, et on réessaie.
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') throw new Error('NOT_AUTHORIZED');
    await Location.startLocationUpdatesAsync(LOCATION_TASK, updateOptions(n));
  }
  currentNotification = n;
  return { ok: true, already: started };
}

/**
 * Arrête le service si plus rien n'en a besoin ; sinon met sa notification
 * à jour (fin du guidage alors que le mode Éclaireur continue, par exemple).
 */
export async function releaseServiceIfIdle() {
  if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK))) {
    currentNotification = null;
    return { ok: true };
  }
  const ride = !!(await getActiveRide());
  const guidance = await hasActiveGuidance();
  if (!ride && !guidance) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    currentNotification = null;
    return { ok: true, stopped: true };
  }
  const n = notificationFor(ride, guidance);
  if (n !== currentNotification) {
    try {
      await Location.startLocationUpdatesAsync(LOCATION_TASK, updateOptions(n));
      currentNotification = n;
    } catch (err) {
      console.warn('[kmroulant] notification non mise à jour :', err);
    }
  }
  return { ok: true };
}

/**
 * Démarre l'enregistrement de la sortie `rideId`.
 *
 * IDEMPOTENT : appelé de nouveau pour la même sortie (page rechargée), il ne
 * redémarre rien. Pour une autre sortie, il bascule le dépôt sur elle.
 */
export async function startRecording({ rideId } = {}) {
  if (!rideId) throw new Error('rideId requis');
  const perm = await Location.getForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('NOT_AUTHORIZED');

  const previous = await getActiveRide();
  await setActiveRide(rideId);
  try {
    return await ensureService();
  } catch (err) {
    await setActiveRide(previous);
    throw err;
  }
}

/** Fin de la sortie. Le service continue si un guidage tourne encore. */
export async function stopRecording() {
  await setActiveRide(null);
  await releaseServiceIfIdle();
  return { ok: true };
}

/**
 * `recording` : une sortie est enregistrée. Le service peut tourner sans
 * sortie (guidage seul) : ce n'est pas un enregistrement.
 */
export async function isRecording() {
  const rideId = await getActiveRide();
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  return { recording: started && !!rideId, rideId };
}

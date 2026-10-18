// Guidage vocal écran éteint : la partie application.
//
// La page confie le guidage (KmrNative.startGuidance : trace + instructions
// GraphHopper). Le service de localisation — le même que le mode Éclaireur —
// livre chaque position à location-task.js, qui appelle
// onGuidanceLocations() : on avance sur la trace (guidance-core.js) et on dit
// les annonces avec react-native-tts.
//
// ÉCRAN ALLUMÉ OU ÉTEINT, L'ANNONCE PART D'ICI. Pendant un guidage confié, la
// page ne doit plus annoncer les manœuvres elle-même (sinon chaque annonce
// serait dite deux fois). Elle reste libre de parler pour autre chose.
//
// TOUT EST GARDÉ DANS SQLITE (point-store.js) : iOS peut relancer le
// JavaScript de l'application pour livrer des positions sans qu'aucun écran
// ne soit monté. La mémoire n'est qu'un cache.

import { Platform } from 'react-native';
import Tts from 'react-native-tts';
import { buildPlan, initialState, step } from './guidance-core';
import * as store from './point-store';
import * as recorder from './recorder';

const STATE_SAVE_EVERY = 15000;   // ms entre deux sauvegardes de l'avancement
const MAX_FIX_AGE = 30000;        // position plus vieille : livrée en retard, ignorée

let cache = null;                 // { plan, state, savedAt, savedKey }
let chain = Promise.resolve();

// Un appel à la fois : deux livraisons de positions rapprochées ne doivent
// pas lire le même état et annoncer deux fois la même manœuvre.
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// Ce qui, s'il change, doit être sauvegardé tout de suite
const keyOf = (s) => [s.next, s.far, s.near, s.farDoneFor, s.off, s.done, s.synced].join('|');

async function load() {
  if (cache) return cache;
  const saved = await store.getGuidance();
  if (!saved) return null;
  try {
    const plan = buildPlan(saved.input);
    const state = saved.state || initialState();
    cache = { plan, state, savedAt: Date.now(), savedKey: keyOf(state) };
  } catch (err) {
    console.warn('[kmroulant] guidage illisible, abandonné :', err);
    await store.clearGuidance();
    return null;
  }
  return cache;
}

// ─── Voix ──────────────────────────────────────────────────────────────
// Réglée ICI et pas seulement dans MapScreen : relancé par le système,
// le JavaScript n'a monté aucun écran.

const quiet = (fn) => Promise.resolve().then(fn).catch(() => {});
let voiceInit = null;

function initVoice() {
  if (!voiceInit) {
    voiceInit = (async () => {
      try {
        await Tts.getInitStatus();
      } catch (err) {
        console.warn('[kmroulant] synthèse vocale indisponible :', err && err.code);
      }
      // Baisse la musique pendant l'annonce au lieu de la couper
      await quiet(() => Tts.setDucking(true));
      // iOS : parle même bouton silencieux activé
      if (Platform.OS === 'ios') await quiet(() => Tts.setIgnoreSilentSwitch('ignore'));
    })();
  }
  return voiceInit;
}

async function prepareVoice(plan) {
  await initVoice();
  // À chaque annonce : la page a pu changer langue ou vitesse entre-temps
  await quiet(() => Tts.setDefaultLanguage(plan.lang));
  if (plan.rate) {
    if (Platform.OS === 'android') {
      await quiet(() => Tts.setDefaultRate(plan.rate, true));      // 1 = normal
    } else {
      await quiet(() => Tts.setDefaultRate(Math.min(Math.max(plan.rate * 0.5, 0.1), 1)));  // 0,5 = normal
    }
  }
}

async function speak(plan, text) {
  try {
    await prepareVoice(plan);
    await quiet(() => Tts.stop());   // une annonce plus récente remplace l'ancienne
    await Tts.speak(text);
  } catch (err) {
    console.warn('[kmroulant] annonce non dite :', err);
  }
}

// Attend la fin de l'annonce en cours (ou le délai, au cas où l'événement ne
// viendrait pas)
function spoken(timeoutMs) {
  return new Promise((resolve) => {
    let sub = null;
    const done = () => {
      clearTimeout(timer);
      try { if (sub && sub.remove) sub.remove(); } catch (e) { /* déjà retiré */ }
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      sub = Tts.addEventListener('tts-finish', done);
    } catch (e) {
      // pas d'événements : le délai suffira
    }
  });
}

// Position expo-location → position du guidage
function toFix(loc, now) {
  const c = loc && loc.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
  const t = Number.isFinite(loc.timestamp) ? loc.timestamp : now;
  if (now - t > MAX_FIX_AGE) return null;
  return {
    lng: c.longitude,
    lat: c.latitude,
    t,
    acc: Number.isFinite(c.accuracy) ? c.accuracy : null,
    speed: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null   // négative : inconnue (iOS)
  };
}

// ─── Appels de la page (pont) ──────────────────────────────────────────

/**
 * La page confie le guidage. Remplace un guidage en cours (nouvel itinéraire
 * après un recalcul, par exemple). Lance le service de localisation si besoin.
 * La permission « pendant l'utilisation » doit déjà être accordée
 * (KmrNative.requestPermission) ; sinon : erreur NOT_AUTHORIZED.
 */
export function startGuidance(args) {
  return serial(async () => {
    const plan = buildPlan(args);    // erreur lisible si la page envoie n'importe quoi
    const state = initialState();
    await store.setGuidance(plan.input, state);
    cache = { plan, state, savedAt: Date.now(), savedKey: keyOf(state) };
    try {
      await recorder.ensureService();
    } catch (err) {
      cache = null;
      await store.clearGuidance();
      throw err;
    }
    prepareVoice(plan).catch(() => {});
    return { ok: true, steps: plan.steps.length, length: Math.round(plan.total) };
  });
}

/** Fin du guidage. Le service continue si le mode Éclaireur enregistre. */
export function stopGuidance() {
  return serial(async () => {
    cache = null;
    await store.clearGuidance();
    await quiet(() => Tts.stop());
    await recorder.releaseServiceIfIdle();
    return { ok: true };
  });
}

/** Où en est le guidage (la page s'en sert en se réveillant). */
export function guidanceStatus() {
  return serial(async () => {
    const c = await load();
    if (!c) return { active: false };
    const s = c.state;
    return {
      active: !s.done,
      done: s.done,
      next: s.next,                    // index de la prochaine instruction
      steps: c.plan.steps.length,
      distance: Math.round(s.s),       // m parcourus sur la trace
      remaining: Math.max(0, Math.round(c.plan.total - s.s)),
      offRoute: s.off
    };
  });
}

// ─── Positions (location-task.js) ──────────────────────────────────────

export function onGuidanceLocations(locations) {
  return serial(async () => {
    const c = await load();
    if (!c || c.state.done) return;

    const now = Date.now();
    let state = c.state;
    let last = null;
    for (const loc of locations || []) {
      const fix = toFix(loc, now);
      if (!fix) continue;
      const r = step(c.plan, state, fix);
      state = r.state;
      // Plusieurs positions livrées d'un coup (iOS les regroupe parfois) :
      // seule la dernière annonce compte encore.
      if (r.say.length) last = r.say.join(' ');
    }
    c.state = state;

    if (last) await speak(c.plan, last);

    const key = keyOf(state);
    if (key !== c.savedKey || now - c.savedAt >= STATE_SAVE_EVERY) {
      await store.saveGuidanceState(state);
      c.savedKey = key;
      c.savedAt = now;
    }

    // Arrivée annoncée : le service s'arrête, sauf si le mode Éclaireur
    // enregistre encore. La page lira guidanceStatus() en se réveillant.
    // On laisse d'abord finir « Vous êtes arrivé » : sans service, le
    // système peut suspendre l'application au milieu de la phrase.
    if (state.done) {
      if (last) await spoken(8000);
      await recorder.releaseServiceIfIdle();
    }
  });
}

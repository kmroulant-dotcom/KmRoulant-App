// Dépôt des positions du mode automatique, dans le téléphone (SQLite).
//
// LE SERVICE Y ÉCRIT, LA PAGE Y LIT. Écran éteint, la WebView est en pause :
// les positions ne peuvent pas lui être remises au fil de l'eau. Elles
// attendent ici, et la page les reprend quand elle tourne
// (readPoints → enregistrement → ackPoints).
//
// CLÉ (ride_id, t) : une position livrée deux fois par le système ne double
// pas, et l'acquittement se fait « jusqu'à tel instant ».
//
// LE GUIDAGE VOCAL Y EST GARDÉ AUSSI (table meta) : la trace et les
// instructions confiées par la page, et l'avancement. iOS peut relancer le
// JavaScript de l'application pour livrer des positions, sans écran : le
// guidage doit alors se retrouver ici, pas dans une variable.

import * as SQLite from 'expo-sqlite';

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('kmr-auto-ride.db').then(async (d) => {
      await d.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS points (
          ride_id TEXT    NOT NULL,
          t       INTEGER NOT NULL,
          lng     REAL    NOT NULL,
          lat     REAL    NOT NULL,
          alt     REAL,
          acc     REAL,
          alt_acc REAL,
          speed   REAL,
          heading REAL,
          PRIMARY KEY (ride_id, t)
        );
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      `);
      return d;
    });
  }
  return dbPromise;
}

/** Sortie en cours d'enregistrement (UUID de la page), ou null. */
export async function getActiveRide() {
  const d = await db();
  const row = await d.getFirstAsync('SELECT v FROM meta WHERE k = ?', ['activeRide']);
  return row ? row.v : null;
}

export async function setActiveRide(rideId) {
  const d = await db();
  if (rideId) await d.runAsync('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', ['activeRide', rideId]);
  else await d.runAsync('DELETE FROM meta WHERE k = ?', ['activeRide']);
}

/**
 * Ajoute des positions. UNE SEULE REQUÊTE, sans transaction explicite : la
 * tâche de localisation et le pont peuvent écrire en même temps, et une
 * instruction unique est atomique par elle-même.
 */
export async function insertPoints(rideId, points) {
  if (!rideId || !points.length) return 0;
  const d = await db();
  const cols = 9;
  const values = points.map(() => `(${new Array(cols).fill('?').join(',')})`).join(',');
  const params = [];
  for (const p of points) {
    params.push(rideId, p.t, p.lng, p.lat, p.alt, p.acc, p.altAcc, p.speed, p.heading);
  }
  const r = await d.runAsync(
    `INSERT OR IGNORE INTO points (ride_id, t, lng, lat, alt, acc, alt_acc, speed, heading) VALUES ${values}`,
    params
  );
  return r.changes;
}

/** Les plus anciennes positions d'une sortie, dans l'ordre. */
export async function readPoints({ rideId, limit = 500 } = {}) {
  if (!rideId) return [];
  const d = await db();
  const rows = await d.getAllAsync(
    `SELECT t, lng, lat, alt, acc, alt_acc, speed, heading
       FROM points WHERE ride_id = ? ORDER BY t LIMIT ?`,
    [rideId, Math.max(1, Math.min(2000, limit | 0))]
  );
  return rows.map(r => ({
    t: r.t, lng: r.lng, lat: r.lat, alt: r.alt, acc: r.acc, altAcc: r.alt_acc,
    speed: r.speed, heading: r.heading, src: 'native'
  }));
}

/** La page a enregistré jusqu'à `upToT` inclus : on libère. */
export async function ackPoints({ rideId, upToT } = {}) {
  if (!rideId || !Number.isFinite(upToT)) return 0;
  const d = await db();
  const r = await d.runAsync('DELETE FROM points WHERE ride_id = ? AND t <= ?', [rideId, upToT]);
  return r.changes;
}

/** Sortie abandonnée par la page : tout disparaît. */
export async function clearRide({ rideId } = {}) {
  if (!rideId) return 0;
  const d = await db();
  const r = await d.runAsync('DELETE FROM points WHERE ride_id = ?', [rideId]);
  if ((await getActiveRide()) === rideId) await setActiveRide(null);
  return r.changes;
}

// ─── Guidage vocal ────────────────────────────────────────────────────
// Deux clés : le plan (gros, écrit une fois) et l'état (petit, réécrit au
// fil de la sortie). Le plan s'écrit avant l'état et s'efface après lui :
// un état présent veut toujours dire un plan présent.

async function metaGet(k) {
  const d = await db();
  const row = await d.getFirstAsync('SELECT v FROM meta WHERE k = ?', [k]);
  return row ? row.v : null;
}

async function metaSet(k, v) {
  const d = await db();
  await d.runAsync('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', [k, v]);
}

async function metaDel(k) {
  const d = await db();
  await d.runAsync('DELETE FROM meta WHERE k = ?', [k]);
}

/** Guidage confié par la page : { input, state }, ou null. */
export async function getGuidance() {
  const plan = await metaGet('guidancePlan');
  if (!plan) return null;
  const state = await metaGet('guidanceState');
  return { input: JSON.parse(plan), state: state ? JSON.parse(state) : null };
}

export async function setGuidance(input, state) {
  await metaSet('guidancePlan', JSON.stringify(input));
  await metaSet('guidanceState', JSON.stringify(state));
}

export async function saveGuidanceState(state) {
  await metaSet('guidanceState', JSON.stringify(state));
}

export async function clearGuidance() {
  await metaDel('guidanceState');
  await metaDel('guidancePlan');
}

/** Un guidage tourne-t-il encore (confié, et arrivée pas encore annoncée) ? */
export async function hasActiveGuidance() {
  const v = await metaGet('guidanceState');
  if (!v) return false;
  try { return !JSON.parse(v).done; } catch (err) { return false; }
}

export async function countPoints({ rideId } = {}) {
  const d = await db();
  const row = await d.getFirstAsync('SELECT count(*) AS n FROM points WHERE ride_id = ?', [rideId]);
  return row ? row.n : 0;
}

// Guidage vocal écran éteint : la logique d'annonce.
//
// MODULE PUR (aucun import), testé sous Node. Rien ici ne parle ni n'écrit :
// step() rend les phrases à dire, guidance.js les dit et garde l'état.
//
// LA PAGE PRÉPARE, L'APPLICATION ANNONCE. La page envoie la trace et les
// instructions GraphHopper (KmrNative.startGuidance) ; à chaque position
// livrée par le service de localisation, on avance sur la trace et on
// annonce la prochaine manœuvre à l'approche.
//
// POSITION SUR LA TRACE PAR ABSCISSE CURVILIGNE. Chaque instruction est
// placée à sa distance depuis le départ (cumul de la trace jusqu'à son point
// GraphHopper `interval[0]`). La position courante est projetée sur la trace
// DANS UNE FENÊTRE autour de la dernière abscisse connue : une boucle ou un
// aller-retour repasse au même endroit, et sans fenêtre la projection
// sauterait sur l'autre passage.

const R = 6371008.8;              // rayon terrestre moyen (m)
const DEG = Math.PI / 180;

const MAX_TRACK = 60000;          // points de trace acceptés
const MAX_STEPS = 3000;           // instructions acceptées

/** Réglages (m, s, ms). La page peut en surcharger dans `options`. */
export const DEFAULTS = {
  farTime: 25, farMin: 100, farMax: 300,   // annonce « Dans 150 mètres… »
  nearTime: 6, nearMin: 20, nearMax: 50,   // annonce de la manœuvre elle-même
  passMargin: 15,       // manœuvre dépassée de tant : on passe à la suivante
  thenGap: 60,          // deux manœuvres plus proches : « …, puis … »
  offMin: 35, offMax: 80, offCount: 3,     // hors parcours : distance, positions
  backDist: 25, backCount: 2,              // retour sur le parcours
  offRepeat: 90000,     // rappel « hors parcours » (ms)
  maxAcc: 50,           // position moins précise : ignorée
  windowBack: 50, windowAhead: 1000,       // fenêtre de projection
  rejoinDist: 30,       // recalage ailleurs sur la trace
  defaultSpeed: 4       // m/s tant que le GPS ne donne pas de vitesse
};

const PHRASES = {
  fr: {
    inDistance: 'Dans {d} mètres, ',
    then: 'puis ',
    offRoute: 'Vous avez quitté le parcours.',
    backOnRoute: 'Vous êtes de retour sur le parcours.'
  },
  en: {
    inDistance: 'In {d} meters, ',
    then: 'then ',
    offRoute: 'You have left the route.',
    backOnRoute: 'You are back on the route.'
  }
};
const PHRASE_KEYS = Object.keys(PHRASES.fr);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Distance en mètres entre deux points (lng, lat). */
export function distance(lng1, lat1, lng2, lat2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Projection de p sur le segment ab, en mètres dans un repère local
// (largement assez précis à l'échelle d'un segment de trace).
function project(p, a, b) {
  const kx = Math.cos(((a[1] + b[1]) / 2) * DEG) * DEG * R;
  const ky = DEG * R;
  const bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * ky;
  const px = (p.lng - a[0]) * kx, py = (p.lat - a[1]) * ky;
  const len2 = bx * bx + by * by;
  const t = len2 > 0 ? clamp((px * bx + py * by) / len2, 0, 1) : 0;
  const dx = px - t * bx, dy = py - t * by;
  return { t, d: Math.sqrt(dx * dx + dy * dy) };
}

function normTrack(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    let lng, lat;
    if (Array.isArray(p)) { lng = p[0]; lat = p[1]; }
    else if (p && typeof p === 'object') { lng = isNum(p.lng) ? p.lng : p.lon; lat = p.lat; }
    if (!isNum(lng) || !isNum(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new Error('Point de trace invalide');
    }
    out.push([lng, lat]);
  }
  return out;
}

function cumulate(track) {
  const cum = new Array(track.length);
  cum[0] = 0;
  for (let i = 1; i < track.length; i++) {
    cum[i] = cum[i - 1] + distance(track[i - 1][0], track[i - 1][1], track[i][0], track[i][1]);
  }
  return cum;
}

// Instruction donnée par sa position seulement : point de trace le plus
// proche, À PARTIR de la précédente (l'ordre de la trace est respecté).
function nearestIndex(track, from, lng, lat) {
  let best = from, bestD = Infinity;
  for (let i = from; i < track.length; i++) {
    const d = distance(lng, lat, track[i][0], track[i][1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function pickPhrases(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const k of PHRASE_KEYS) if (typeof raw[k] === 'string') out[k] = raw[k];
  }
  return out;
}

function pickOptions(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULTS)) if (isNum(raw[k]) && raw[k] >= 0) out[k] = raw[k];
  }
  return out;
}

/**
 * Prépare le guidage à partir de ce que la page envoie.
 *
 * @param {object} args
 *   track:        [[lng, lat], …] — la trace GraphHopper (`points`)
 *   instructions: [{ at, text }, …] — `at` : index dans `track` (GraphHopper
 *                 `interval[0]`). À défaut, { lat, lng, text }.
 *   lang:         'fr-FR' (défaut), rate: vitesse de voix (1 = normale)
 *   phrases:      textes à remplacer (inDistance avec {d}, then, offRoute,
 *                 backOnRoute) ; options : réglages de DEFAULTS
 * @returns {object} plan. `plan.input` est la forme normalisée à garder :
 *   buildPlan(plan.input) redonne le même plan.
 */
export function buildPlan(args) {
  const a = args && typeof args === 'object' ? args : {};
  const track = normTrack(a.track);
  if (track.length < 2) throw new Error('Trace manquante ou trop courte');
  if (track.length > MAX_TRACK) throw new Error('Trace trop longue');

  const raw = Array.isArray(a.instructions) ? a.instructions : [];
  if (raw.length > MAX_STEPS) throw new Error('Trop d’instructions');

  const cum = cumulate(track);
  const instructions = [];
  const steps = [];
  let from = 0;
  for (const ins of raw) {
    const text = ins && typeof ins.text === 'string' ? ins.text.trim() : '';
    if (!text) continue;
    let at;
    if (Number.isInteger(ins.at) && ins.at >= 0 && ins.at < track.length) at = ins.at;
    else if (isNum(ins.lng) && isNum(ins.lat)) at = nearestIndex(track, from, ins.lng, ins.lat);
    else throw new Error('Instruction sans position : ' + text);
    if (at < from) at = from;
    from = at;
    instructions.push({ at, text });
    steps.push({ s: cum[at], text });
  }
  if (!steps.length) throw new Error('Aucune instruction');

  const lang = typeof a.lang === 'string' && a.lang ? a.lang : 'fr-FR';
  const rate = isNum(a.rate) && a.rate > 0 ? a.rate : null;
  const phraseOverrides = pickPhrases(a.phrases);
  const options = pickOptions(a.options);
  const base = PHRASES[lang.slice(0, 2).toLowerCase()] || PHRASES.fr;

  return {
    input: { track, instructions, lang, rate, phrases: phraseOverrides, options },
    track, cum, steps,
    total: cum[cum.length - 1],
    lang, rate,
    phrases: Object.assign({}, base, phraseOverrides),
    options: Object.assign({}, DEFAULTS, options)
  };
}

export function initialState() {
  return {
    synced: false,    // position déjà calée sur la trace
    seg: 0,           // segment de la dernière projection
    s: 0,             // abscisse curviligne (m depuis le départ)
    next: 0,          // prochaine instruction
    far: false,       // « Dans … mètres » dit pour `next`
    near: false,      // manœuvre dite pour `next`
    farDoneFor: -1,   // instruction déjà annoncée par un « puis … »
    off: false, offCount: 0, onCount: 0, offSaidT: 0,
    speed: null,      // vitesse lissée (m/s)
    lastT: 0,
    done: false       // arrivée annoncée
  };
}

// Projection dans la fenêtre [s - windowBack, s + windowAhead].
function locate(plan, st, fix, o) {
  const { track, cum } = plan;
  const n = track.length;
  let i = Math.min(st.seg, n - 2);
  while (i > 0 && cum[i] > st.s - o.windowBack) i--;
  let best = null;
  for (; i < n - 1 && cum[i] <= st.s + o.windowAhead; i++) {
    const r = project(fix, track[i], track[i + 1]);
    if (!best || r.d < best.d) best = { seg: i, s: cum[i] + r.t * (cum[i + 1] - cum[i]), d: r.d };
  }
  return best;
}

// Recalage sur toute la trace : parmi les passages à moins de `maxD`, le
// premier devant soi (raccourci, saut du GPS) ; sinon le plus proche.
function rejoin(plan, st, fix, o, maxD) {
  const { track, cum } = plan;
  let ahead = null, nearest = null;
  for (let i = 0; i < track.length - 1; i++) {
    const r = project(fix, track[i], track[i + 1]);
    if (r.d > maxD) continue;
    const c = { seg: i, s: cum[i] + r.t * (cum[i + 1] - cum[i]), d: r.d };
    if (!nearest || c.d < nearest.d) nearest = c;
    if (c.s >= st.s - o.windowBack && (!ahead || c.s < ahead.s)) ahead = c;
  }
  return ahead || nearest;
}

// « Tournez à gauche » → « tournez à gauche », mais pas « GR 65 ».
function lcfirst(t) {
  const c0 = t.charAt(0), c1 = t.charAt(1);
  const upperThenLower = c0 !== c0.toLowerCase() && c1 === c1.toLowerCase() && c1 !== c1.toUpperCase();
  return upperThenLower ? c0.toLowerCase() + t.slice(1) : t;
}

function roundDistance(d) {
  return d < 100 ? Math.max(10, Math.round(d / 10) * 10) : Math.round(d / 50) * 50;
}

/**
 * Une position de plus.
 *
 * @param {object} plan  - buildPlan()
 * @param {object} prev  - état précédent (initialState() au départ)
 * @param {{lng:number, lat:number, t?:number, acc?:number|null, speed?:number|null}} fix
 * @returns {{state: object, say: string[]}} nouvel état (prev n'est pas
 *   modifié) et phrases à dire, dans l'ordre.
 */
export function step(plan, prev, fix) {
  const o = plan.options || DEFAULTS;
  const st = Object.assign({}, prev);
  const say = [];
  if (st.done || !fix || !isNum(fix.lng) || !isNum(fix.lat)) return { state: st, say };
  if (isNum(fix.acc) && fix.acc > o.maxAcc) return { state: st, say };
  if (isNum(fix.t)) {
    if (st.lastT && fix.t <= st.lastT) return { state: st, say };
    st.lastT = fix.t;
  }
  if (isNum(fix.speed) && fix.speed >= 0) {
    st.speed = st.speed === null ? fix.speed : st.speed * 0.6 + fix.speed * 0.4;
  }

  // ── Où est-on sur la trace ? ──
  const offLimit = clamp((isNum(fix.acc) ? fix.acc : 10) * 1.5, o.offMin, o.offMax);
  let m = st.synced ? locate(plan, st, fix, o) : null;
  if (!m || m.d > offLimit) {
    // Premier calage : n'importe où à portée ; ensuite, seulement tout près
    const g = rejoin(plan, st, fix, o, st.synced ? o.rejoinDist : offLimit);
    if (g) m = g;
  }
  const d = m ? m.d : Infinity;

  // ── Sortie de parcours ──
  if (d > offLimit) { st.offCount++; st.onCount = 0; }
  else if (d <= o.backDist) { st.onCount++; st.offCount = 0; }
  else st.offCount = 0;

  if (!st.off && st.offCount >= o.offCount) {
    st.off = true; st.offSaidT = st.lastT; say.push(plan.phrases.offRoute);
  } else if (st.off && st.onCount >= o.backCount) {
    st.off = false; say.push(plan.phrases.backOnRoute);
  } else if (st.off && st.lastT - st.offSaidT >= o.offRepeat) {
    st.offSaidT = st.lastT; say.push(plan.phrases.offRoute);
  }
  if (st.off || d > offLimit) return { state: st, say };

  st.seg = m.seg; st.s = m.s; st.synced = true;

  // ── Manœuvres dépassées (sans les annoncer) ──
  const steps = plan.steps;
  while (st.next < steps.length && st.s > steps[st.next].s + o.passMargin) {
    st.next++;
    st.far = st.farDoneFor === st.next;
    st.near = false;
  }
  if (st.next >= steps.length) { st.done = true; return { state: st, say }; }

  // ── Annonces ──
  const cur = steps[st.next];
  const remaining = cur.s - st.s;
  const v = st.speed === null ? o.defaultSpeed : Math.max(st.speed, 1);
  const nearD = clamp(v * o.nearTime, o.nearMin, o.nearMax);
  const farD = clamp(v * o.farTime, o.farMin, o.farMax);

  if (!st.near && remaining <= nearD) {
    let text = cur.text;
    const nxt = steps[st.next + 1];
    if (nxt && nxt.s - cur.s <= o.thenGap) {
      text = text.replace(/[\s.!]+$/, '') + ', ' + plan.phrases.then + lcfirst(nxt.text);
      st.farDoneFor = st.next + 1;
    }
    say.push(text);
    st.near = true; st.far = true;
    if (st.next === steps.length - 1) st.done = true;   // arrivée
  } else if (!st.far && remaining <= farD) {
    st.far = true;
    // Trop près de la manœuvre : l'annonce « maintenant » suffit. Et pas de
    // « Dans 150 mètres, vous êtes arrivé » : l'arrivée s'annonce une fois.
    const isArrival = st.next === steps.length - 1;
    if (!isArrival && remaining > nearD + 30) {
      say.push(plan.phrases.inDistance.replace('{d}', String(roundDistance(remaining))) + lcfirst(cur.text));
    }
  }
  return { state: st, say };
}

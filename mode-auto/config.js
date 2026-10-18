// Réglages du mode automatique. ⚠ À ADAPTER si l'explorateur est servi
// depuis une autre adresse.

// Origines dont les pages peuvent parler au pont (window.KmrNative). Une page
// d'une autre adresse, ouverte dans la même WebView, n'y a pas accès : elle ne
// peut ni lire les positions ni démarrer le service.
export const APP_ORIGINS = [
  'https://kmroulant.com',
  'https://www.kmroulant.com'
];

// Nom de la tâche de localisation. Ici plutôt que dans location-task.js :
// recorder.js en a besoin, et location-task.js importe le guidage, qui
// importe recorder.js (sinon import circulaire).
export const LOCATION_TASK = 'kmroulant-auto-ride';

// Notification persistante qu'Android impose tant que le service tourne.
// Elle doit dire ce qui se passe, et pourquoi : son texte suit ce qui tourne
// (mode Éclaireur, guidage vocal, ou les deux).
export const SERVICE_NOTIFICATION = {
  title: 'KmRoulant enregistre votre sortie',
  body: 'Mode automatique : les chemins empruntés seront évalués à l’arrivée.',
  color: '#E8590C'   // --color-auto de l'explorateur
};

export const GUIDANCE_NOTIFICATION = {
  title: 'KmRoulant vous guide',
  body: 'Guidage vocal en cours, même écran éteint.',
  color: '#00372C'
};

export const BOTH_NOTIFICATION = {
  title: 'KmRoulant vous guide',
  body: 'Guidage vocal en cours. Votre sortie est aussi enregistrée en mode automatique.',
  color: '#00372C'
};

/** L'adresse appartient-elle à l'explorateur ? */
export function isAppUrl(url) {
  if (typeof url !== 'string') return false;
  return APP_ORIGINS.some(origin => url === origin || url.startsWith(origin + '/'));
}

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  BackHandler,
  Linking,
  PermissionsAndroid,
  Platform,
  StatusBar,
  StyleSheet,
} from 'react-native';
import { WebView } from 'react-native-webview';
import RNFS from 'react-native-fs';
import FileViewer from 'react-native-file-viewer';
import notifee from '@notifee/react-native';
import Tts from 'react-native-tts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// mode-auto/ est à la racine du projet, ce fichier dans src/screens/
import { useAutoModeBridge } from '../../mode-auto/useAutoModeBridge';
// Abonnements iOS (RevenueCat)
import { useIapBridge, PLATFORM_SHIM } from '../iap/useIapBridge';

const HOME_URL = 'https://www.kmroulant.com';
const PLANNER_URL = 'https://www.kmroulant.com/planificateur/';
const BRAND = '#00372c';

// Extrait le nom d'hôte d'une URL (l'objet URL de React Native est incomplet)
const hostOf = (url) => {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : null;
};

// Pages du site
const isKmRoulant = (host) =>
  !!host && (host === 'kmroulant.com' || host.endsWith('.kmroulant.com'));

// Domaines de la connexion Google : ils doivent rester dans la WebView
const isGoogleAuth = (host) =>
  !!host &&
  (/(^|\.)google\.[a-z.]+$/.test(host) ||
    /(^|\.)(gstatic|googleusercontent)\.com$/.test(host));

// Shim injecté dans la page : le site appelle window.KmRoulantTTS.speak(...)
// comme avec une interface Android native, et le message part vers React Native.
const TTS_SHIM = `
  (function () {
    if (window.KmRoulantTTS) return;
    window.KmRoulantTTS = {
      speak: function (text, lang, rate) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'tts',
          payload: { text: text, lang: lang, rate: rate }
        }));
      },
      stop: function () {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tts-stop' }));
      }
    };
  })();
  true;
`;

// Scripts injectés dans chaque page : TTS + plateforme (window.KMR_PLATFORM)
// Les deux ne s'installent qu'une fois, on peut les réinjecter sans risque.
const PAGE_SHIMS = TTS_SHIM + PLATFORM_SHIM;

// Page du planificateur (avec ou sans paramètres)
const isPlanner = (url) =>
  isKmRoulant(hostOf(url)) && /^https?:\/\/[^/]+\/planificateur\/?(?:[?#]|$)/i.test(url || '');

// Un fichier ouvert avec l'appli : content:// (Android) ou file:// (iOS, Android ancien)
const isFileUrl = (url) => /^(content|file):\/\//i.test(url || '');

// Au-delà, le planificateur refuserait de toute façon (12 Mo) : inutile de
// faire transiter le fichier en base64 jusqu'à la page.
const IMPORT_MAX_BYTES = 12 * 1024 * 1024;

// Nom du fichier d'après son adresse. Un content:// n'en porte pas toujours :
// le planificateur reconnaît alors le format au contenu.
const fileNameOf = (url) => {
  let s = String(url || '').split(/[?#]/)[0];
  try { s = decodeURIComponent(s); } catch (e) { /* adresse mal encodée */ }
  const last = s.split(/[/:]/).pop() || '';
  return /\.(gpx|kml|geojson|json)$/i.test(last) ? last : '';
};

// Chemin lisible par RNFS : content:// tel quel (Android), file:// sans préfixe
const fsPathOf = (url) => {
  if (!/^file:\/\//i.test(url)) return url;
  const p = url.replace(/^file:\/\//i, '');
  try { return decodeURIComponent(p); } catch (e) { return p; }
};

// Écran pendant le premier chargement
const LoadingView = () => (
  <View style={styles.overlay}>
    <ActivityIndicator size="large" color="#ffffff" />
  </View>
);

// Écran si le site ne se charge pas (pas de réseau, serveur injoignable…)
const ErrorView = ({ onRetry }) => (
  <View style={styles.overlay}>
    <Text style={styles.title}>Impossible de charger KmRoulant</Text>
    <Text style={styles.text}>
      Vérifiez votre connexion internet, puis réessayez.
    </Text>
    <Pressable style={styles.button} onPress={onRetry}>
      <Text style={styles.buttonText}>Réessayer</Text>
    </Pressable>
  </View>
);

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const topBar = insets.top;
  const bottomBar = insets.bottom;

  const webRef = useRef(null);
  const canGoBackRef = useRef(false);

  // Adresse chargée par la WebView. Elle ne change que pour mener au
  // planificateur un fichier ouvert avec l'appli — voir deliverImport.
  const [sourceUri, setSourceUri] = useState(HOME_URL);

  // ─── Fichier GPX ouvert avec l'appli ───────────────────────────────
  // Le fichier lu attend ici que le planificateur soit prêt : la page
  // annonce { type:'kmr:planner-ready' } à chaque chargement.
  const currentUrlRef = useRef(HOME_URL);
  const plannerReadyRef = useRef(false);
  const pendingImportRef = useRef(null);
  const lastFileUrlRef = useRef(null);

  // Abonnements iOS : configure RevenueCat et traite les messages iap-*
  const iap = useIapBridge(webRef);

  // Permissions géolocalisation + notification
  useEffect(() => {
    requestPermissions();
  }, []);

  // Obligatoire pour Android : créer le canal de notification
  useEffect(() => {
    if (Platform.OS === 'android') {
      notifee.createChannel({
        id: 'gpx',
        name: 'GPX Notifications',
      });
    }
  }, []);

  // Bouton retour Android : remonte l'historique de la WebView,
  // et ne quitte l'appli que s'il n'y a plus de page précédente
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current && webRef.current) {
        webRef.current.goBack();
        return true;
      }
      return false; // comportement par défaut : quitte l'appli
    });
    return () => sub.remove();
  }, []);

  // Fichier ouvert avec l'appli : au lancement à froid (URL initiale) et
  // quand l'appli tourne déjà (événement 'url', grâce au singleTask Android).
  useEffect(() => {
    Linking.getInitialURL()
      .then((url) => { if (isFileUrl(url)) receiveFile(url); })
      .catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (isFileUrl(url)) receiveFile(url);
    });
    return () => sub.remove();
  }, []);

  // Lit le fichier et l'envoie au planificateur
  const receiveFile = async (url) => {
    // getInitialURL rend la même adresse après un rechargement : une seule fois
    if (lastFileUrlRef.current === url) return;
    lastFileUrlRef.current = url;

    const path = fsPathOf(url);
    try {
      try {
        const st = await RNFS.stat(path);
        if (Number(st.size) > IMPORT_MAX_BYTES) {
          deliverImport({ name: fileNameOf(url), error: 'too_big' });
          return;
        }
      } catch (e) {
        // stat échoue sur certains content:// : on tente la lecture quand même
      }
      const base64 = await RNFS.readFile(path, 'base64');
      deliverImport({ name: fileNameOf(url), base64 });
    } catch (err) {
      console.log('Lecture du fichier impossible :', url, err);
      // Le planificateur affichera « Import impossible »
      deliverImport({ name: fileNameOf(url), error: 'unreadable' });
    } finally {
      // iOS copie le fichier dans Documents/Inbox : on ne le garde pas
      if (Platform.OS === 'ios' && /\/Inbox\//.test(path)) {
        RNFS.unlink(path).catch(() => {});
      }
    }
  };

  // Planificateur prêt et affiché : on envoie tout de suite. Sinon on y va,
  // et c'est son message « prêt » qui déclenchera l'envoi. On y va en
  // changeant la source de la WebView plutôt qu'en injectant un script :
  // au lancement à froid, la page d'accueil n'est peut-être pas encore là
  // pour l'exécuter. Le paramètre ajouté rend chaque adresse différente
  // (sinon une source identique ne recharge rien) ; le planificateur
  // l'ignore.
  const deliverImport = (payload) => {
    pendingImportRef.current = payload;
    if (plannerReadyRef.current && isPlanner(currentUrlRef.current)) {
      flushImport();
    } else {
      plannerReadyRef.current = false;
      setSourceUri(`${PLANNER_URL}?ouverture=${Date.now()}`);
    }
  };

  const flushImport = () => {
    const p = pendingImportRef.current;
    if (!p || !webRef.current) return;
    pendingImportRef.current = null;
    webRef.current.postMessage(JSON.stringify({ type: 'kmr:import-track', ...p }));
  };

  // Initialisation TTS
  useEffect(() => {
    const initTts = async () => {
      try {
        await Tts.getInitStatus();
        // Baisse le volume de la musique pendant les annonces (Android et iOS)
        Tts.setDucking(true);
        if (Platform.OS === 'ios') {
          // Parle même si le bouton silencieux de l'iPhone est activé
          Tts.setIgnoreSilentSwitch('ignore');
        }
      } catch (err) {
        // Android : aucun moteur TTS installé
        if (err.code === 'no_engine') {
          Tts.requestInstallEngine();
        }
        console.log('Erreur init TTS :', err);
      }
    };
    initTts();

    return () => {
      Tts.stop();
    };
  }, []);

  const requestPermissions = async () => {
    try {
      // Notifications (Android + iOS)
      await notifee.requestPermission();

      // Localisation Android (iOS : géré via Info.plist par la WebView).
      // Depuis Android 12, FINE et COARSE doivent être demandées ensemble.
      if (Platform.OS === 'android') {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ]);
      }
    } catch (err) {
      console.warn('Permission error :', err);
    }
  };

  // Enregistre et ouvre le GPX
  const openGPX = async (gpxContent, filename) => {
    try {
      const path = `${RNFS.DocumentDirectoryPath}/${filename}.gpx`;
      await RNFS.writeFile(path, gpxContent, 'utf8');

      // 🔔 Notification quand c'est bon
      await notifee.displayNotification({
        title: 'GPX exporté',
        body: 'Votre parcours GPX est prêt à être ouvert.',
        android: {
          channelId: 'gpx',
          pressAction: { id: 'default' },
        },
      });

      // Ouvre le fichier
      await FileViewer.open(path, { showOpenWithDialog: true });
    } catch (err) {
      console.log('Erreur en ouvrant le GPX :', err);
    }
  };

  // Synthèse vocale
  const speak = async ({ text, lang, rate }) => {
    try {
      await Tts.stop(); // équivalent de QUEUE_FLUSH : coupe l'annonce en cours

      if (lang) {
        try {
          await Tts.setDefaultLanguage(lang);
        } catch (e) {
          console.log('Langue TTS indisponible :', lang);
        }
      }

      if (rate) {
        if (Platform.OS === 'android') {
          // Android : 1.0 = vitesse normale (skipTransform = true)
          await Tts.setDefaultRate(rate, true);
        } else {
          // iOS : 0.5 = vitesse normale, plage 0 à 1
          await Tts.setDefaultRate(Math.min(Math.max(rate * 0.5, 0.1), 1));
        }
      }

      Tts.speak(text);
    } catch (err) {
      console.log('Erreur TTS :', err);
    }
  };

  // Liens : le site et la connexion Google restent dans l'appli,
  // tout le reste (Instagram, mailto:, tel:, geo:…) part vers l'appli
  // ou le navigateur du téléphone
  const handleShouldStartLoad = (request) => {
    const { url } = request;

    // Sous-cadres (iframes, ex. bouton Google) : toujours autorisés (iOS)
    if (request.isTopFrame === false) return true;

    // Schémas internes au navigateur
    if (/^(about|data|blob|javascript):/i.test(url)) return true;

    const host = hostOf(url);
    if (isKmRoulant(host) || isGoogleAuth(host)) return true;

    console.log('Ouverture externe :', url);
    Linking.openURL(url).catch((err) =>
      console.log('Impossible d\'ouvrir :', url, err)
    );
    return false;
  };

  // Messages envoyés depuis la WebView
  const handleMessage = (event) => {
    // N'écoute que les pages du site (pas une page tierce chargée par erreur)
    const origin = event.nativeEvent.url;
    if (!isKmRoulant(hostOf(origin))) {
      console.log('Message ignoré, origine :', origin);
      return;
    }

    let message;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch (e) {
      console.log('Message non JSON:', event.nativeEvent.data);
      return;
    }

    // Abonnements iOS : tous les messages iap-* partent vers le pont RevenueCat
    if (typeof message.type === 'string' && message.type.startsWith('iap-')) {
      iap.handleMessage(message);
      return;
    }

    switch (message.type) {
      case 'kmr:planner-ready':
        plannerReadyRef.current = true;
        currentUrlRef.current = origin;
        flushImport();
        break;

      case 'gpx':
        if (!message.payload || message.payload.length < 10) {
          console.log('GPX vide ou invalide :', message.payload);
          return;
        }
        openGPX(message.payload, message.meta.filename);
        break;

      case 'tts':
        if (message.payload && message.payload.text) {
          speak(message.payload);
        }
        break;

      case 'tts-stop':
        Tts.stop();
        break;

      default:
        console.log('Type inconnu:', message);
    }
  };

  // Si le moteur de la WebView plante (mémoire saturée par la carte WebGL…),
  // on recharge au lieu de laisser l'appli se fermer
  const reload = () => webRef.current?.reload();

  // Mode automatique : enveloppe notre onMessage et notre script injecté.
  // Appelé ici, après la définition de handleMessage (sinon ReferenceError).
  const autoMode = useAutoModeBridge(webRef, {
    onMessage: handleMessage,
    injectedJavaScriptBeforeContentLoaded: PAGE_SHIMS,
  });

  return (
    <View style={{ flex: 1, backgroundColor: BRAND }}>
      <StatusBar barStyle="light-content" backgroundColor={BRAND} />

      {/* Barre du haut */}
      <View style={{ height: topBar }} />

      <WebView
        ref={webRef}
        style={{ flex: 1, backgroundColor: BRAND }}
        source={{ uri: sourceUri }}
        javaScriptEnabled
        geolocationEnabled={true}
        // Scripts injectés avant le chargement : shims TTS + plateforme
        // + pont mode auto (le hook combine le tout)
        injectedJavaScriptBeforeContentLoaded={
          autoMode.injectedJavaScriptBeforeContentLoaded
        }
        // Shims réinjectés après le chargement en filet de sécurité
        // (ils ne s'installent qu'une fois grâce au test en tête)
        injectedJavaScript={PAGE_SHIMS}
        // Messages : le hook traite les siens et transmet le reste à handleMessage
        onMessage={autoMode.onMessage}
        // Navigation
        onNavigationStateChange={(nav) => {
          canGoBackRef.current = nav.canGoBack;
          // Une page qui se charge : le planificateur devra redire qu'il est prêt
          if (nav.loading) plannerReadyRef.current = false;
          currentUrlRef.current = nav.url;
        }}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        allowsBackForwardNavigationGestures // iOS : balayage depuis le bord
        // Chargement et erreurs
        startInLoadingState
        renderLoading={() => <LoadingView />}
        renderError={() => <ErrorView onRetry={reload} />}
        // Reprise après plantage du moteur web
        onRenderProcessGone={reload} // Android
        onContentProcessDidTerminate={reload} // iOS
        // Confort
        textZoom={100} // Android : ignore la taille de police système
        overScrollMode="never" // Android : pas d'effet de rebond sur la carte
        bounces={false} // iOS : idem
      />

      {/* Barre du bas */}
      <View style={{ height: bottomBar }} />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  text: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonText: {
    color: BRAND,
    fontSize: 16,
    fontWeight: '600',
  },
});
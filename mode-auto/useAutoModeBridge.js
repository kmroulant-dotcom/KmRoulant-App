// Branchement du mode automatique sur la WebView EXISTANTE.
//
// UN SEUL APPEL DANS TON COMPOSANT, deux propriétés à poser sur la WebView :
//
//   const webviewRef = useRef(null);
//   const autoMode = useAutoModeBridge(webviewRef, {
//     onMessage: tonOnMessageExistant,                          // facultatif
//     injectedJavaScriptBeforeContentLoaded: tonScriptExistant  // facultatif
//   });
//
//   <WebView
//     ref={webviewRef}
//     {...tesPropriétésHabituelles}
//     injectedJavaScriptBeforeContentLoaded={autoMode.injectedJavaScriptBeforeContentLoaded}
//     onMessage={autoMode.onMessage}
//   />
//
// CE QUE ÇA FAIT :
//   - injecte `window.KmrNative` dans la page AVANT son chargement. L'explorateur
//     le détecte tout seul (ui_explorer/auto-ride.js) : en mode automatique, il
//     confie l'enregistrement au service natif, qui continue écran éteint ;
//     la navigation y confie aussi le guidage vocal (startGuidance) ;
//   - répond aux appels du pont, et réinjecte la réponse dans la page.
//
// TES MESSAGES À TOI NE SONT PAS TOUCHÉS. Tout message qui n'est pas un appel
// du pont (`{ kmr: 1, … }`) est passé tel quel à ton `onMessage`, et ton script
// injecté est conservé, placé après celui du pont.

import { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { bridgeScript } from './injected';
import { createBridge, replyScript } from './bridge';
import * as recorder from './recorder';
import * as store from './point-store';
import * as guidance from './guidance';
import { isAppUrl } from './config';

export function useAutoModeBridge(webviewRef, {
  onMessage = null,
  injectedJavaScriptBeforeContentLoaded = ''
} = {}) {
  const handle = useMemo(() => createBridge({ recorder, store, guidance, isAppUrl }), []);

  const injected = useMemo(
    () => bridgeScript(Platform.OS) + '\n' + (injectedJavaScriptBeforeContentLoaded || ''),
    [injectedJavaScriptBeforeContentLoaded]
  );

  const handleMessage = useCallback(async (event) => {
    const data = event.nativeEvent.data;
    const url = event.nativeEvent.url;
    const reply = await handle(data, url);
    if (reply === null) {
      if (typeof onMessage === 'function') onMessage(event);
      return;
    }
    if (webviewRef.current) webviewRef.current.injectJavaScript(replyScript(reply));
  }, [handle, onMessage, webviewRef]);

  return { injectedJavaScriptBeforeContentLoaded: injected, onMessage: handleMessage };
}

/**
 * Même chose SANS HOOK, pour un composant de classe.
 *
 *   this.webview = null;
 *   this.autoMode = createAutoModeHandlers(() => this.webview, {
 *     onMessage: (e) => this.tonOnMessageExistant(e)
 *   });
 *   <WebView ref={r => (this.webview = r)}
 *            injectedJavaScriptBeforeContentLoaded={this.autoMode.injectedJavaScriptBeforeContentLoaded}
 *            onMessage={this.autoMode.onMessage} … />
 */
export function createAutoModeHandlers(getWebview, {
  onMessage = null,
  injectedJavaScriptBeforeContentLoaded = ''
} = {}) {
  const handle = createBridge({ recorder, store, guidance, isAppUrl });
  return {
    injectedJavaScriptBeforeContentLoaded:
      bridgeScript(Platform.OS) + '\n' + (injectedJavaScriptBeforeContentLoaded || ''),
    onMessage: async (event) => {
      const reply = await handle(event.nativeEvent.data, event.nativeEvent.url);
      if (reply === null) {
        if (typeof onMessage === 'function') onMessage(event);
        return;
      }
      const webview = getWebview();
      if (webview) webview.injectJavaScript(replyScript(reply));
    }
  };
}

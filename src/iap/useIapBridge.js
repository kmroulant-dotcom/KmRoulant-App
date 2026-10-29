// src/iap/useIapBridge.js
// Pont entre la page web (WebView) et les achats intégrés iOS via RevenueCat.
// Android : désactivé, le site garde Stripe.
//
// Messages page → appli :
//   { type: 'iap-login', memberId }   identifiant SWPM du membre connecté
//   { type: 'iap-logout' }
//   { type: 'iap-offerings' }
//   { type: 'iap-purchase', packageId }
//   { type: 'iap-restore' }
// Réponses appli → page : événement window 'kmr-iap' (event.detail)
//   { type: 'customer' | 'offerings' | 'purchase-result' | 'restore-result', ... }

import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL } from 'react-native-purchases';

// Clé publique iOS RevenueCat (Project settings → API keys, commence par appl_)
const RC_IOS_API_KEY = 'test_pnHIMvngodotZqsDhmXlRBBATZq';
// Identifiant de l'entitlement créé dans RevenueCat
const ENTITLEMENT_ID = 'premium';

export const IAP_ENABLED = Platform.OS === 'ios';

// Injecté avant le chargement : indique à la page qu'elle tourne dans l'appli
// (window.KMR_PLATFORM + classes kmr-app / kmr-app-ios sur <html>)
export const PLATFORM_SHIM = `
  (function () {
    if (window.KMR_PLATFORM) return;
    window.KMR_PLATFORM = '${Platform.OS}';
    var mark = function () {
      if (document.documentElement) {
        document.documentElement.classList.add('kmr-app', 'kmr-app-${Platform.OS}');
      }
    };
    mark();
    document.addEventListener('DOMContentLoaded', mark);
  })();
  true;
`;

// Type de réponse attendu par la page pour chaque demande
const REPLY = {
  'iap-login': 'customer',
  'iap-offerings': 'offerings',
  'iap-purchase': 'purchase-result',
  'iap-restore': 'restore-result',
};

// État d'abonnement réduit à ce dont la page a besoin
const summarize = (info) => {
  const ent = info?.entitlements?.active?.[ENTITLEMENT_ID];
  return {
    active: !!ent,
    productId: ent ? ent.productIdentifier : null,
    expiresAt: ent ? ent.expirationDate : null,
    willRenew: ent ? ent.willRenew : false,
  };
};

// Description d'une offre (prix déjà formaté dans la devise de l'utilisateur)
const describePackage = (pkg) => {
  const p = pkg.product;
  return {
    id: pkg.identifier,
    type: pkg.packageType, // MONTHLY, ANNUAL…
    productId: p.identifier,
    title: p.title,
    description: p.description,
    price: p.priceString,
    period: p.subscriptionPeriod, // ex. P1M, P1Y
    introPrice: p.introPrice ? p.introPrice.priceString : null,
    introPriceAmount: p.introPrice ? p.introPrice.price : null,
    introPeriod: p.introPrice ? p.introPrice.period : null,
  };
};

export function useIapBridge(webRef) {
  const configured = useRef(false);

  // Envoie un événement 'kmr-iap' à la page
  const send = useCallback(
    (detail) => {
      const js = `window.dispatchEvent(new CustomEvent('kmr-iap', { detail: ${JSON.stringify(
        detail
      )} })); true;`;
      webRef.current?.injectJavaScript(js);
    },
    [webRef]
  );

  // Configuration RevenueCat (utilisateur anonyme jusqu'au message iap-login)
  useEffect(() => {
    if (!IAP_ENABLED) return undefined;
    if (!configured.current) {
      if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
      Purchases.configure({ apiKey: RC_IOS_API_KEY });
      configured.current = true;
    }
    // Renouvellement, expiration… pendant que l'appli est ouverte
    const onUpdate = (info) => send({ type: 'customer', ...summarize(info) });
    Purchases.addCustomerInfoUpdateListener(onUpdate);
    return () => Purchases.removeCustomerInfoUpdateListener(onUpdate);
  }, [send]);

  const handleMessage = useCallback(
    async (message) => {
      const replyType = REPLY[message.type] || 'error';

      if (!IAP_ENABLED) {
        send({ type: replyType, ok: false, error: 'iap-unavailable' });
        return;
      }

      try {
        switch (message.type) {
          case 'iap-login': {
            // L'identifiant RevenueCat = identifiant du membre SWPM
            const id = String(message.memberId || '');
            if (!/^\d+$/.test(id)) return;
            const current = await Purchases.getAppUserID();
            if (current === id) {
              const info = await Purchases.getCustomerInfo();
              send({ type: 'customer', ...summarize(info) });
              return;
            }
            const { customerInfo } = await Purchases.logIn(id);
            send({ type: 'customer', ...summarize(customerInfo) });
            return;
          }

          case 'iap-logout': {
            if (!(await Purchases.isAnonymous())) await Purchases.logOut();
            return;
          }

          case 'iap-offerings': {
            const offerings = await Purchases.getOfferings();
            const packages = offerings.current
              ? offerings.current.availablePackages.map(describePackage)
              : [];
            send({ type: 'offerings', ok: true, packages });
            return;
          }

          case 'iap-purchase': {
            // Pas d'achat sans compte KmRoulant : l'abonnement doit être rattaché au membre
            if (await Purchases.isAnonymous()) {
              send({ type: 'purchase-result', ok: false, error: 'not-logged-in' });
              return;
            }
            const offerings = await Purchases.getOfferings();
            const pkg = offerings.current?.availablePackages.find(
              (p) => p.identifier === message.packageId
            );
            if (!pkg) {
              send({ type: 'purchase-result', ok: false, error: 'unknown-package' });
              return;
            }
            try {
              const { customerInfo } = await Purchases.purchasePackage(pkg);
              send({ type: 'purchase-result', ok: true, ...summarize(customerInfo) });
            } catch (e) {
              send({
                type: 'purchase-result',
                ok: false,
                cancelled: !!e.userCancelled,
                error: e.userCancelled ? null : e.message || 'purchase-failed',
              });
            }
            return;
          }

          case 'iap-restore': {
            if (await Purchases.isAnonymous()) {
              send({ type: 'restore-result', ok: false, error: 'not-logged-in' });
              return;
            }
            const info = await Purchases.restorePurchases();
            send({ type: 'restore-result', ok: true, ...summarize(info) });
            return;
          }

          default:
            console.log('Message IAP inconnu :', message.type);
        }
      } catch (err) {
        console.log('Erreur IAP :', err);
        send({ type: replyType, ok: false, error: err?.message || String(err) });
      }
    },
    [send]
  );

  return { handleMessage };
}

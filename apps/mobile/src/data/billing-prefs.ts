import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCompanyMe } from './hooks';
import {
  DEFAULT_BILLING_PREFS,
  parsePrefs,
  serializePrefs,
  storageKey,
  type BillingPrefs,
  type PaymentTermsPreset,
  type PdfAccentColor,
} from './billing-prefs-codec';

export {
  DEFAULT_BILLING_PREFS,
  parsePrefs,
  serializePrefs,
  storageKey,
  type BillingPrefs,
  type PaymentTermsPreset,
  type PdfAccentColor,
};

/**
 * Réglages facturation §Aperçu/§RIB/§Assurance/§Valeurs par défaut — préférences LOCALES
 * (AsyncStorage, scopées par société), pour les champs qui n'ont PAS de champ ni d'endpoint
 * serveur aujourd'hui (contrairement à l'identité/iban/bic — ceux-là sont la fiche société
 * RÉELLE, cf. `useCompanyMe`/`useUpdateCompanyBilling`). Doctrine du fichier
 * `reglages-facturation.tsx` : « pas de formulaire fantôme » — donc CHAQUE préférence ici a un
 * effet RÉEL et documenté :
 *  · `pdfAccentColor` anime l'aperçu de facture EN DIRECT sur cet écran (rendu client, honnête) ;
 *    le branchement dans le PDF serveur généré (apps/api/src/documents/pdf-renderer.ts, littéraux
 *    rgb() figés) reste un TODO explicite — non fait ici (hors périmètre mobile+UI de cette passe).
 *  · `showRibOnInvoices` / `showInsuranceOnInvoices` pilotent l'aperçu en direct ; même TODO PDF
 *    que ci-dessus (le renderer ne prend aucun paramètre RIB/assurance aujourd'hui).
 *  · `defaultDepositPercent` est LU par le flow devis (devis/new.tsx) au démarrage d'un nouveau
 *    devis — effet réel sur le prochain devis créé.
 *  · `defaultQuoteValidityDays` est LU par devis/new.tsx pour poser `validUntil` à la création du
 *    devis (CreateQuoteInput.validUntil existe déjà côté core/API — jamais branché avant) — effet
 *    réel, contrairement à l'accent/RIB/assurance.
 *  · `defaultPaymentTerms` : AUCUN consommateur aujourd'hui (l'émission de facture fixe ses
 *    conditions de paiement côté serveur, packages/core/src/application/billing/issue-invoice.ts,
 *    sans paramètre client) — stockée pour une prochaine passe, TODO tracé explicitement.
 *  · `logoUri` alimente l'aperçu en direct (copie locale persistante, expo-file-system). Aucun
 *    champ `logoUrl` n'existe sur CompanyProps ni d'endpoint d'upload dédié — TODO tracé.
 *
 * Le codec pur (types + parse/serialize/storageKey, sans import React/React Native) vit dans
 * `billing-prefs-codec.ts`, testé isolément — ce fichier n'ajoute que le hook React.
 */
export function useBillingPrefs(): {
  prefs: BillingPrefs;
  ready: boolean;
  update: (patch: Partial<BillingPrefs>) => void;
} {
  const companyId = useCompanyMe().data?.id ?? null;
  const [prefs, setPrefs] = useState<BillingPrefs>(DEFAULT_BILLING_PREFS);
  const [ready, setReady] = useState(false);
  const companyIdRef = useRef(companyId);
  companyIdRef.current = companyId;

  useEffect(() => {
    if (companyId === null) {
      setReady(false);
      return;
    }
    let active = true;
    setReady(false);
    AsyncStorage.getItem(storageKey(companyId))
      .then((raw) => {
        if (active) {
          setPrefs(parsePrefs(raw));
          setReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setPrefs(DEFAULT_BILLING_PREFS);
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [companyId]);

  const update = useCallback((patch: Partial<BillingPrefs>) => {
    const targetCompanyId = companyIdRef.current;
    if (targetCompanyId === null) return;
    setPrefs((current) => {
      const next = { ...current, ...patch };
      void AsyncStorage.setItem(storageKey(targetCompanyId), serializePrefs(next)).catch(() => undefined);
      return next;
    });
  }, []);

  return { prefs, ready, update };
}

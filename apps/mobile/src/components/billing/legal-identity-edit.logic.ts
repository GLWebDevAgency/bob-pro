/**
 * Logique PURE de la feuille « Identité légale » (Réglages facturation §Identité) — testable en
 * node, aucun import React Native. La feuille ne fait que rendre ces décisions.
 *
 * Elle règle les exigences d'IDENTITÉ de `Company.assertCanIssue()` (@bob/core), au nombre de
 * QUATRE depuis le durcissement Factur-X du domaine :
 *  · n° d'immatriculation RCS/RM (art. R123-237 c. com.) ;
 *  · adresse COMPLÈTE du siège — rue, code postal ET ville (le domaine exige les trois) ;
 *  · capital social pour une société EURL/SASU/SARL/SAS (art. R123-238 c. com.) —
 *    `capitalRequired` est décidé par le DOMAINE (`Company.isSociete()`), jamais déduit ici ;
 *  · n° de TVA intracommunautaire réellement attribué hors franchise.
 * Ce fichier a longtemps affirmé « deux exigences, code postal non exigé » : c'était devenu
 * FAUX après le durcissement, et une SAS sans capital restait bloquée sans aucun éditeur
 * (bug terrain FLY SERVICES 30/07). Le miroir est désormais complet — et verrouillé par le
 * test anti-récidive de document-gates.logic.test.ts.
 *
 * FAIL-CLOSED : `buildLegalIdentityPatch` n'émet que les champs RÉELLEMENT modifiés — une
 * suggestion affichée mais non touchée par l'utilisateur n'est jamais écrite (doctrine
 * « hypothèse de Bob, à confirmer » : Bob propose, l'utilisateur confirme).
 */
import { validateFrenchVatId } from '@bob/core';
import { parseEuroAmountToCents } from '../../finance/parse-euro-amount';

export interface LegalIdentityValues {
  readonly rcsOrRm: string;
  readonly tvaIntracom: string;
  /** Saisie BRUTE en euros (« 10 000 », « 10000,50 ») — convertie en centimes par
   *  `parseCapitalSocialEurosToCents`, jamais stockée telle quelle. */
  readonly capitalSocialEuros: string;
  readonly line1: string;
  readonly zip: string;
  readonly city: string;
}

export interface LegalIdentityErrors {
  readonly rcsOrRm: boolean;
  readonly tvaIntracom: boolean;
  readonly capitalSocial: boolean;
  readonly line1: boolean;
  readonly zip: boolean;
  readonly city: boolean;
}

export interface LegalIdentityPatch {
  readonly rcsOrRm?: string;
  readonly tvaIntracom?: string | null;
  readonly capitalSocialCents?: number | null;
  readonly address?: { line1: string; zip: string; city: string };
}

/** Longueurs miroir des gardes serveur (PATCH /company/legal) — refus AVANT le réseau. */
const MAX = { rcsOrRm: 100, tvaIntracom: 32, line1: 200, zip: 20, city: 100 } as const;

export interface LegalIdentityContext {
  readonly siren: string;
  readonly vatRequired: boolean;
  /** Décidé par le DOMAINE (`Company.of(company)` → `isSociete()`) — l'écran ne connaît pas
   *  les formes juridiques et n'a pas à les connaître. */
  readonly capitalRequired: boolean;
}

const clean = (v: string): string => v.trim();

/**
 * Euros saisis → centimes par ARITHMÉTIQUE ENTIÈRE (`parseEuroAmountToCents`, BigInt) — jamais
 * `parseFloat(raw) * 100`, qui rend 114.999… pour « 1,15 ». Accepte espaces (fines/insécables
 * comprises), virgule OU point, 2 décimales max. `null` = saisie inexploitable OU montant
 * qu'aucune société ne peut déclarer : zéro et négatif refusés — la même garde « strictement
 * positif » que le serveur (PATCH /company/legal) et le domaine (`Company.of`).
 */
export function parseCapitalSocialEurosToCents(raw: string): number | null {
  const cents = parseEuroAmountToCents(raw);
  return cents === null || cents <= 0 ? null : cents;
}

/**
 * Affichage français d'un capital en centimes — « 10 000 € », « 1 500,50 € » — par arithmétique
 * entière et groupement de milliers écrit en dur (espace fine insécable U+202F) : déterministe
 * quel que soit l'ICU embarqué (Hermes sur device ≠ node des tests), aucun flottant.
 * Précondition domaine : `cents` > 0 (`Company.of` refuse tout capital ⩽ 0).
 */
export function formatCapitalSocialEuros(cents: number): string {
  const euros = Math.trunc(cents / 100);
  const rest = cents % 100;
  const grouped = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return rest === 0
    ? `${grouped}\u202f€`
    : `${grouped},${String(rest).padStart(2, '0')}\u202f€`;
}

/** Champs en défaut — un champ vide, trop long ou inconvertible est en erreur (le serveur ou le
 *  domaine les rejetterait). */
export function legalIdentityErrors(
  values: LegalIdentityValues,
  context: LegalIdentityContext,
): LegalIdentityErrors {
  const rcs = clean(values.rcsOrRm);
  const tvaIntracom = clean(values.tvaIntracom);
  const capital = clean(values.capitalSocialEuros);
  const line1 = clean(values.line1);
  const zip = clean(values.zip);
  const city = clean(values.city);
  return {
    rcsOrRm: rcs.length === 0 || rcs.length > MAX.rcsOrRm,
    tvaIntracom:
      tvaIntracom.length > MAX.tvaIntracom ||
      (context.vatRequired && tvaIntracom.length === 0) ||
      (tvaIntracom.length > 0 && !validateFrenchVatId(tvaIntracom, context.siren).ok),
    // Vide : bloquant seulement quand le domaine exige un capital (société). Saisi : il doit se
    // convertir en centimes STRICTEMENT positifs — « 0 » n'est jamais un capital déclarable,
    // société ou pas (même refus que le serveur, mais AVANT le réseau).
    capitalSocial:
      capital.length === 0
        ? context.capitalRequired
        : parseCapitalSocialEurosToCents(capital) === null,
    line1: line1.length === 0 || line1.length > MAX.line1,
    // Le code postal est exigé par `assertCanIssue` (adresse complète) : le laisser passer vide
    // ferait enregistrer une adresse qui bloque ENCORE l'émission — cul-de-sac différé.
    zip: zip.length === 0 || zip.length > MAX.zip,
    city: city.length === 0 || city.length > MAX.city,
  };
}

/** Enregistrable = aucun champ en défaut. */
export function canSaveLegalIdentity(
  values: LegalIdentityValues,
  context: LegalIdentityContext,
): boolean {
  const errors = legalIdentityErrors(values, context);
  return (
    !errors.rcsOrRm &&
    !errors.tvaIntracom &&
    !errors.capitalSocial &&
    !errors.line1 &&
    !errors.zip &&
    !errors.city
  );
}

/**
 * Patch minimal à envoyer, ou `null` quand rien n'a changé (aucun appel réseau inutile, et
 * surtout aucune écriture d'une valeur seulement SUGGÉRÉE). L'adresse part en bloc dès qu'un de
 * ses sous-champs bouge : le serveur n'accepte qu'un objet complet. Le capital est comparé en
 * CENTIMES (pas en texte) : retaper « 10 000 » sur un « 10000,00 » initial n'est pas une
 * modification.
 */
export function buildLegalIdentityPatch(
  current: LegalIdentityValues,
  next: LegalIdentityValues,
  context: LegalIdentityContext,
): LegalIdentityPatch | null {
  if (!canSaveLegalIdentity(next, context)) return null;
  const patch: {
    rcsOrRm?: string;
    tvaIntracom?: string | null;
    capitalSocialCents?: number | null;
    address?: { line1: string; zip: string; city: string };
  } = {};
  if (clean(next.rcsOrRm) !== clean(current.rcsOrRm)) patch.rcsOrRm = clean(next.rcsOrRm);
  if (clean(next.tvaIntracom) !== clean(current.tvaIntracom)) {
    const nextVat = clean(next.tvaIntracom);
    if (nextVat.length === 0) {
      patch.tvaIntracom = null;
    } else {
      const normalized = validateFrenchVatId(nextVat, context.siren);
      if (!normalized.ok) return null;
      patch.tvaIntracom = normalized.value;
    }
  }
  const currentCapital = parseCapitalSocialEurosToCents(clean(current.capitalSocialEuros));
  const nextCapital = parseCapitalSocialEurosToCents(clean(next.capitalSocialEuros));
  if (nextCapital !== currentCapital) {
    // `null` ne peut arriver ici que champ VIDÉ hors exigence (canSave a déjà refusé le reste) :
    // effacement explicite côté serveur, même sémantique que `tvaIntracom`.
    patch.capitalSocialCents = nextCapital;
  }
  if (
    clean(next.line1) !== clean(current.line1) ||
    clean(next.zip) !== clean(current.zip) ||
    clean(next.city) !== clean(current.city)
  ) {
    patch.address = { line1: clean(next.line1), zip: clean(next.zip), city: clean(next.city) };
  }
  return patch.rcsOrRm === undefined &&
    patch.tvaIntracom === undefined &&
    patch.capitalSocialCents === undefined &&
    patch.address === undefined
    ? null
    : patch;
}

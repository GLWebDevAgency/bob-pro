/**
 * Logique PURE de la feuille « Identité légale » (Réglages facturation §Identité) — testable en
 * node, aucun import React Native. La feuille ne fait que rendre ces décisions.
 *
 * Elle règle les DEUX exigences de `Company.assertCanIssue()` (@bob/core) : n° d'immatriculation
 * RCS/RM (art. R123-237 c. com.) et adresse du siège (line1 + city). Le code postal n'est PAS
 * exigé par le domaine : il reste saisissable mais ne bloque jamais l'enregistrement.
 *
 * FAIL-CLOSED : `buildLegalIdentityPatch` n'émet que les champs RÉELLEMENT modifiés — une
 * suggestion affichée mais non touchée par l'utilisateur n'est jamais écrite (doctrine
 * « hypothèse de Bob, à confirmer » : Bob propose, l'utilisateur confirme).
 */

export interface LegalIdentityValues {
  readonly rcsOrRm: string;
  readonly line1: string;
  readonly zip: string;
  readonly city: string;
}

export interface LegalIdentityErrors {
  readonly rcsOrRm: boolean;
  readonly line1: boolean;
  readonly city: boolean;
}

export interface LegalIdentityPatch {
  readonly rcsOrRm?: string;
  readonly address?: { line1: string; zip: string; city: string };
}

/** Longueurs miroir des gardes serveur (PATCH /company/legal) — refus AVANT le réseau. */
const MAX = { rcsOrRm: 100, line1: 200, zip: 20, city: 100 } as const;

const clean = (v: string): string => v.trim();

/** Champs en défaut — un champ vide ou trop long est en erreur (le serveur les rejetterait). */
export function legalIdentityErrors(values: LegalIdentityValues): LegalIdentityErrors {
  const rcs = clean(values.rcsOrRm);
  const line1 = clean(values.line1);
  const city = clean(values.city);
  return {
    rcsOrRm: rcs.length === 0 || rcs.length > MAX.rcsOrRm,
    line1: line1.length === 0 || line1.length > MAX.line1,
    city: city.length === 0 || city.length > MAX.city,
  };
}

/** Enregistrable = aucun champ en défaut ET code postal dans les bornes serveur. */
export function canSaveLegalIdentity(values: LegalIdentityValues): boolean {
  const errors = legalIdentityErrors(values);
  return (
    !errors.rcsOrRm &&
    !errors.line1 &&
    !errors.city &&
    clean(values.zip).length <= MAX.zip
  );
}

/**
 * Patch minimal à envoyer, ou `null` quand rien n'a changé (aucun appel réseau inutile, et
 * surtout aucune écriture d'une valeur seulement SUGGÉRÉE). L'adresse part en bloc dès qu'un de
 * ses sous-champs bouge : le serveur n'accepte qu'un objet complet.
 */
export function buildLegalIdentityPatch(
  current: LegalIdentityValues,
  next: LegalIdentityValues,
): LegalIdentityPatch | null {
  if (!canSaveLegalIdentity(next)) return null;
  const patch: { rcsOrRm?: string; address?: { line1: string; zip: string; city: string } } = {};
  if (clean(next.rcsOrRm) !== clean(current.rcsOrRm)) patch.rcsOrRm = clean(next.rcsOrRm);
  if (
    clean(next.line1) !== clean(current.line1) ||
    clean(next.zip) !== clean(current.zip) ||
    clean(next.city) !== clean(current.city)
  ) {
    patch.address = { line1: clean(next.line1), zip: clean(next.zip), city: clean(next.city) };
  }
  return patch.rcsOrRm === undefined && patch.address === undefined ? null : patch;
}

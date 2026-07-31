/**
 * Gate « entreprise complète » — la RÈGLE PRODUIT du chantier compte/facturation : Bob Pro reste
 * UTILISABLE sans fiche entreprise complète (brouillons, catalogue, clients…) ; le gate apparaît
 * uniquement aux actes qui l'exigent LÉGALEMENT (émettre/envoyer un devis ou une facture
 * officielle — DocumentActions.tsx).
 *
 * Réutilise `Company.assertCanIssue()` (@bob/core, déjà testé, déjà LA référence de complétude
 * utilisée pour l'e-invoicing dans `einvoice-for.ts`) — zéro logique de complétude dupliquée.
 * `name`/`siret`/`legalForm`/`trade`/`vatRegime` sont non-optionnels sur `CompanyProps` (posés
 * une fois pour toutes à l'inscription, cf. `POST /onboarding/company`). `assertCanIssue`
 * vérifie l'immatriculation, l'adresse complète (rue + CP + ville), le capital social d'une
 * société et, hors franchise, le numéro de TVA réellement attribué.
 */
import { Company, type CompanyProps } from '@bob/core';

/** DÉCISION de bloquer (fail-closed : fiche absente ou invalide = pas d'émission). */
export function companyCanIssue(company: CompanyProps | null | undefined): boolean {
  if (!company) return false;
  const built = Company.of(company);
  return built.ok && built.value.assertCanIssue().ok;
}

/**
 * Champ d'identité NOMMABLE qui bloque l'émission — le vocabulaire partagé des gates
 * (`FIELD_EDITOR_ROUTE` et le corps par champ dans document-gates.logic.ts). Le champ domaine
 * `capitalSocialCents` y devient `capitalSocial` : les gates parlent produit, pas persistance.
 */
export type CompanyIssueBlocker = 'rcsOrRm' | 'address' | 'capitalSocial' | 'tvaIntracom';

/** Champ (DomainError VALIDATION d'`assertCanIssue`) → champ nommable du gate. Une exigence
 *  domaine ABSENTE d'ici rend `companyIssueBlocker` muet (null) : le verrou anti-récidive de
 *  document-gates.logic.test.ts existe précisément pour que ça ne survive pas à la CI. */
const DOMAIN_FIELD_BLOCKER: Readonly<Record<string, CompanyIssueBlocker>> = {
  rcsOrRm: 'rcsOrRm',
  address: 'address',
  capitalSocialCents: 'capitalSocial',
  tvaIntracom: 'tvaIntracom',
};

/**
 * NOMME le champ qui bloque l'émission, pour que le gate le dise (bug FLY SERVICES 30/07 :
 * « Complète ta fiche entreprise » sans dire QUOI — le capital social manquait, invisible à
 * l'écran et éditable nulle part ; le fondateur a re-vérifié un par un des champs déjà remplis).
 *
 * `null` = émissible OU blocage non nommable (fiche absente, `Company.of` en échec, exigence
 * domaine non cartographiée). `null` ne signifie donc JAMAIS « laisse passer » : la décision de
 * bloquer reste `companyCanIssue`, fail-closed — cette fonction ne fait que nommer.
 */
export function companyIssueBlocker(
  company: CompanyProps | null | undefined,
): CompanyIssueBlocker | null {
  if (!company) return null;
  const built = Company.of(company);
  if (!built.ok) return null;
  const refusal = built.value.assertCanIssue();
  if (refusal.ok) return null;
  return refusal.error.code === 'VALIDATION'
    ? (DOMAIN_FIELD_BLOCKER[refusal.error.field] ?? null)
    : null;
}

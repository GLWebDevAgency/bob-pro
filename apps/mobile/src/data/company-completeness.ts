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
 * vérifie l'immatriculation, l'adresse et, hors franchise, le numéro de TVA réellement attribué.
 */
import { Company, type CompanyProps } from '@bob/core';

export function companyCanIssue(company: CompanyProps | null | undefined): boolean {
  if (!company) return false;
  const built = Company.of(company);
  return built.ok && built.value.assertCanIssue().ok;
}

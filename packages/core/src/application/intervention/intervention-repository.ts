import { type Intervention } from '../../domain/intervention/intervention';

/**
 * Port de la fiche de passage (Bloc C §3.5). Lectures tenant-scopées PAR CONTRAT ; la
 * persistance ajoute FK composites + RLS + triggers en défense en profondeur.
 */
export interface InterventionRepository {
  findById(companyId: string, id: string): Promise<Intervention | null>;
  /** Verrouille la ligne (SELECT … FOR UPDATE) dans la transaction courante — sérialise les
   * mutations concurrentes (deux appareils, voix + UI, rejeu offline). */
  lockById?(companyId: string, id: string): Promise<Intervention | null>;
  /**
   * Création STRICTE (jamais un upsert) — l'id vient du CLIENT (offline-first §3.6) :
   * une collision de clé primaire (bug ou client hostile, y compris AUTRE tenant) est
   * remontée `id_collision` SANS révéler l'existence ni le tenant ([Revue P15] — jamais un
   * oracle inter-tenant) ; l'appelant répond 409 générique « régénère ».
   */
  create(intervention: Intervention): Promise<{ outcome: 'created' | 'id_collision' }>;
  save(intervention: Intervention): Promise<void>;
  listByChantier(companyId: string, chantierId: string): Promise<Intervention[]>;
  listByCompany(companyId: string): Promise<Intervention[]>;
  /**
   * PR-16 — détache les fiches qui référencent un brouillon de facture supprimé
   * (`billedInvoiceId` → null) : le droit de « Facturer ce passage » se rallume par l'ÉTAT RÉEL,
   * jamais par un statut inventé. Appelé par `DeleteDraftInvoice` (port étroit
   * `InterventionBillingDetachPort`) DANS la transaction de suppression.
   */
  detachByInvoice(companyId: string, invoiceId: string): Promise<void>;
}

/**
 * Réglages de fiche par société (§3.2) : titre de PDF PARAMÉTRABLE (un libellé, pas un
 * modèle — « Certificat sanitaire ») + templates de checklist par `kind` (JSON libre).
 * [Amélioration 10] UNIQUE par société — le titre par kind est un non-but V1 documenté.
 */
export interface CompanyInterventionSettings {
  companyId: string;
  /** null = défaut produit (« Fiche de passage »). */
  reportTitle: string | null;
  /** kind (clé libre, comparée après trim/minuscules) → libellés d'items proposés. */
  checklistTemplates: Record<string, string[]>;
  revision: number;
}

export const DEFAULT_INTERVENTION_REPORT_TITLE = 'Fiche de passage';

export interface CompanyInterventionSettingsRepository {
  find(companyId: string): Promise<CompanyInterventionSettings | null>;
  save(settings: CompanyInterventionSettings): Promise<void>;
}

/** Template applicable à un `kind` donné (comparaison trim + minuscules — libellé libre). */
export function checklistTemplateForKind(
  settings: CompanyInterventionSettings | null,
  kind: string,
): string[] | null {
  if (settings === null) return null;
  const wanted = kind.trim().toLowerCase();
  for (const [key, labels] of Object.entries(settings.checklistTemplates)) {
    if (key.trim().toLowerCase() === wanted && Array.isArray(labels) && labels.length > 0) {
      return labels;
    }
  }
  return null;
}

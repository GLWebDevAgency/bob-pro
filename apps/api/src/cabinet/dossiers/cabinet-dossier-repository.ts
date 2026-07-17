import type {
  CabinetDossier,
  CabinetDossierFinancialSummary,
  CabinetDossierFiscalProfile,
  CabinetDossierPeriod,
  CabinetDossierReviewSummary,
  CabinetDossierSummary,
  StoredFecAnalysis,
} from './cabinet-dossier-contract';

export interface CabinetDossierPage {
  items: CabinetDossierSummary[];
  nextCursor: string | null;
}

export interface CabinetDossierMutationData {
  siren: string;
  clientName: string;
  sourceFileName: string;
  entryCount: number;
  rowCount: number;
  period: CabinetDossierPeriod;
  financial: CabinetDossierFinancialSummary;
  analysis: StoredFecAnalysis;
  analysisSha256: string;
  review: CabinetDossierReviewSummary | null;
  fiscal: CabinetDossierFiscalProfile;
  lastImportedAt: string;
}

export type CabinetDossierMutationOutcome =
  | { kind: 'saved'; dossier: CabinetDossier }
  | { kind: 'not_found' }
  | { kind: 'conflict' };

export type CabinetDossierDeleteOutcome = 'deleted' | 'not_found' | 'conflict';

/**
 * Toutes les méthodes sont appelées dans une transaction avec les GUC user+cabinet déjà posés.
 * L'implémentation PostgreSQL doit néanmoins filtrer explicitement cabinetId sur chaque requête.
 */
export interface CabinetDossierRepository {
  listSummaries(input: {
    cabinetId: string;
    cursor?: string;
    limit: number;
  }): Promise<CabinetDossierPage>;
  findBySiren(cabinetId: string, siren: string): Promise<CabinetDossier | null>;
  create(input: {
    id: string;
    cabinetId: string;
    actorUserId: string;
    data: CabinetDossierMutationData;
    now: string;
  }): Promise<CabinetDossierMutationOutcome>;
  replace(input: {
    cabinetId: string;
    actorUserId: string;
    expectedRevision: number;
    data: CabinetDossierMutationData;
    now: string;
  }): Promise<CabinetDossierMutationOutcome>;
  delete(input: {
    cabinetId: string;
    siren: string;
    actorUserId: string;
    expectedRevision: number;
    now: string;
  }): Promise<CabinetDossierDeleteOutcome>;
}

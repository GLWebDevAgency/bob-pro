import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { parisDateOnly } from '../../shared-kernel/time';
import {
  type ChecklistItem,
  type InterventionPhotoPhase,
} from '../../domain/intervention/intervention';
import { type ChantierRepository, type ChantierNoteRepository, type CompanyRepository, type CustomerRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type WorksiteMediaStorage } from '../ports/worksite-media';
import { type DocumentRepository } from '../ports/document-repository';
import { type DocumentFolderRepository } from '../ports/document-folder-repository';
import { type DocumentLinkTargetPort } from '../ports/document-link-target';
import { type DocumentStoragePort } from '../ports/document-storage';
import { type ClockPort } from '../ports/services';
import { StoreDocument } from '../documents/store-document';
import { buildDocumentStorageKey } from '../documents/storage-key';
import {
  DEFAULT_INTERVENTION_REPORT_TITLE,
  type CompanyInterventionSettingsRepository,
  type InterventionRepository,
} from './intervention-repository';

/** État de fiche matérialisé par une version d'archive : `completed` puis, au plus, `signed`. */
export type InterventionReportState = 'completed' | 'signed';

/** Données de rendu — assemblées par le use case, JAMAIS par le renderer (domaine pur). */
export interface InterventionReportData {
  /** Titre PARAMÉTRABLE par société (« Certificat sanitaire ») — un libellé, pas un modèle. */
  title: string;
  companyName: string;
  customerName: string;
  chantierName: string;
  chantierAddress: string | null;
  equipmentLabel: string | null;
  kind: string;
  technicianLabel: string | null;
  plannedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  checklist: ChecklistItem[];
  summary: string | null;
  photos: { filename: string; phase: InterventionPhotoPhase | null; createdAt: string }[];
  notes: { text: string; authorLabel: string; createdAt: string }[];
  /**
   * Convention §3.4 (P12) : « Signée sur site le {capturedAtDevice} (horloge de l'appareil),
   * synchronisée le {capturedAt} » quand la capture fut hors-ligne ; null = fiche NON signée
   * (client absent) — le renderer imprime la mention HONNÊTE, jamais une signature fabriquée.
   */
  signature: {
    signerName: string;
    capturedAt: string;
    capturedAtDevice: string | null;
  } | null;
}

export interface InterventionReportRendererPort {
  renderInterventionReport(data: InterventionReportData): Promise<Uint8Array>;
}

/** Ids DÉTERMINISTES d'archive (patron generatedInvoiceDocumentId) — l'archivage est idempotent. */
export interface InterventionReportDocumentIds {
  documentId(companyId: string, interventionId: string, state: InterventionReportState): string;
  versionId(companyId: string, interventionId: string, state: InterventionReportState): string;
}

/** Hachage d'octets à la frontière (node:crypto côté API) — le core reste sans dépendance. */
export interface BytesHashPort {
  sha256HexOfBytes(bytes: Uint8Array): string;
}

export interface GenerateInterventionReportInput {
  companyId: string;
  interventionId: string;
}

export interface GenerateInterventionReportOutput {
  documentId: string;
  filename: string;
  /** true = latch : l'archive existait déjà pour CET état, rien n'a été re-rendu (A8). */
  alreadyArchived: boolean;
  state: InterventionReportState;
}

export interface GenerateInterventionReportDeps {
  interventions: InterventionRepository;
  companies: Pick<CompanyRepository, 'findById'>;
  customers: Pick<CustomerRepository, 'findById'>;
  chantiers: ChantierRepository;
  notes: Pick<ChantierNoteRepository, 'listByChantier'>;
  media: WorksiteMediaStorage;
  equipments?: EquipmentRepository;
  interventionSettings?: CompanyInterventionSettingsRepository;
  renderer: InterventionReportRendererPort;
  documents: Pick<DocumentRepository, 'insertInitialOrConfirmExact' | 'findById'>;
  folders: Pick<DocumentFolderRepository, 'findById'>;
  linkTargets: DocumentLinkTargetPort;
  storage: DocumentStoragePort;
  documentIds: InterventionReportDocumentIds;
  hash: BytesHashPort;
  clock: ClockPort;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'fiche-de-passage';
}

/**
 * PR-16 — fiche de passage PDF : rendue PUIS ARCHIVÉE IMMUABLE (StoredDocument kind
 * `intervention_report`, origin generated, version 1 append-only — patron A8), JAMAIS
 * re-rendue pour un même état. Latch + versions : la fiche `completed` a son archive ; si le
 * client signe ensuite, une NOUVELLE version (état `signed`) est archivée — l'ancienne reste
 * intacte et liée. `linkedEntity` = équipement du passage quand il existe, sinon le site :
 * l'historique parc/site montre la fiche (deriveEquipmentHistory).
 */
export class GenerateInterventionReport {
  constructor(private readonly deps: GenerateInterventionReportDeps) {}

  async execute(
    input: GenerateInterventionReportInput,
  ): Promise<Result<GenerateInterventionReportOutput, AppError>> {
    const intervention = await this.deps.interventions.findById(input.companyId, input.interventionId);
    if (!intervention || intervention.companyId !== input.companyId)
      return err(appNotFound('intervention', input.interventionId));
    if (intervention.status !== 'completed' && intervention.status !== 'signed')
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'status',
          message: 'La fiche de passage ne se génère qu’une fois le passage terminé.',
        }),
      );
    const state: InterventionReportState = intervention.status;
    const documentId = this.deps.documentIds.documentId(input.companyId, intervention.id, state);

    // LATCH A8 — l'archive de CET état existe déjà : on la sert, on ne re-rend JAMAIS.
    const existing = await this.deps.documents.findById(input.companyId, documentId);
    if (existing && existing.toProps().status === 'active') {
      if (intervention.reportDocumentId !== documentId) {
        // Réparation d'un latch interrompu (archive écrite, référence non posée) : idempotent.
        const attached = intervention.attachReportDocument(documentId);
        if (!attached.ok) return err(appDomain(attached.error));
        await this.deps.interventions.save(intervention);
      }
      return ok({
        documentId,
        filename: existing.toProps().filename,
        alreadyArchived: true,
        state,
      });
    }

    const [company, customer, chantier] = await Promise.all([
      this.deps.companies.findById(input.companyId),
      this.deps.customers.findById(intervention.customerId),
      this.deps.chantiers.findById(intervention.chantierId),
    ]);
    if (!company) return err(appNotFound('company', input.companyId));
    if (!customer || customer.companyId !== input.companyId)
      return err(appNotFound('customer', intervention.customerId));
    if (!chantier || chantier.companyId !== input.companyId)
      return err(appNotFound('chantier', intervention.chantierId));

    let equipmentLabel: string | null = null;
    if (intervention.equipmentId !== null && this.deps.equipments) {
      const equipment = await this.deps.equipments.findById(input.companyId, intervention.equipmentId);
      equipmentLabel = equipment?.label ?? null;
    }

    const settings = (await this.deps.interventionSettings?.find(input.companyId)) ?? null;
    const title = settings?.reportTitle?.trim() || DEFAULT_INTERVENTION_REPORT_TITLE;

    const [photos, notes] = await Promise.all([
      this.deps.media.listByChantier(input.companyId, intervention.chantierId),
      this.deps.notes.listByChantier(input.companyId, intervention.chantierId),
    ]);
    const interventionPhotos = photos
      .filter((photo) => (photo.interventionId ?? null) === intervention.id)
      .map((photo) => ({
        filename: photo.filename,
        phase: photo.phase ?? null,
        createdAt: photo.createdAt,
      }));
    const interventionNotes = notes
      .filter((note) => note.interventionId === intervention.id)
      .map((note) => ({ text: note.text, authorLabel: note.authorLabel, createdAt: note.createdAt }));

    const signature = intervention.signature;
    const data: InterventionReportData = {
      title,
      companyName: company.name,
      customerName: customer.name,
      chantierName: chantier.name,
      chantierAddress: chantier.address,
      equipmentLabel,
      kind: intervention.kind,
      technicianLabel: intervention.technicianLabel,
      plannedAt: intervention.plannedAt,
      startedAt: intervention.startedAt,
      finishedAt: intervention.finishedAt,
      checklist: intervention.checklist,
      summary: intervention.summary,
      photos: interventionPhotos,
      notes: interventionNotes,
      signature:
        signature === null
          ? null
          : {
              signerName: signature.signerName,
              capturedAt: signature.capturedAt,
              capturedAtDevice: signature.capturedAtDevice ?? null,
            },
    };

    const bytes = await this.deps.renderer.renderInterventionReport(data);
    if (bytes.byteLength === 0)
      return err({ kind: 'dependency', port: 'intervention-report-renderer', cause: 'Rendu vide.' });

    const sha256 = this.deps.hash.sha256HexOfBytes(bytes);
    const anchor = intervention.finishedAt ?? this.deps.clock.now();
    const filename = `${slugify(title)}-${parisDateOnly(anchor)}${state === 'signed' ? '-signee' : ''}.pdf`;
    const versionId = this.deps.documentIds.versionId(input.companyId, intervention.id, state);
    const storageKey = buildDocumentStorageKey({
      companyId: input.companyId,
      documentId,
      version: 1,
      sha256,
      filename,
      mimeType: 'application/pdf',
    });

    const stored = await new StoreDocument({
      documents: this.deps.documents,
      folders: this.deps.folders,
      linkTargets: this.deps.linkTargets,
      storage: this.deps.storage,
      clock: this.deps.clock,
    }).execute({
      id: documentId,
      versionId,
      companyId: input.companyId,
      kind: 'intervention_report',
      origin: 'generated',
      filename,
      mimeType: 'application/pdf',
      bytes,
      sha256,
      storageKey,
      // Historique parc/site : la fiche suit l'ÉQUIPEMENT quand le passage en vise un.
      linkedEntityType: intervention.equipmentId !== null ? 'equipment' : 'chantier',
      linkedEntityId: intervention.equipmentId ?? intervention.chantierId,
      documentDate: parisDateOnly(anchor),
      reason: state === 'signed' ? 'intervention-signed' : 'intervention-completed',
    });
    if (!stored.ok) return stored;

    const attached = intervention.attachReportDocument(documentId);
    if (!attached.ok) return err(appDomain(attached.error));
    await this.deps.interventions.save(intervention);

    return ok({ documentId, filename, alreadyArchived: false, state });
  }
}

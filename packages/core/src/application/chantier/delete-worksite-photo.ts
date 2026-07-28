import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type WorksiteMediaStorage } from '../ports/worksite-media';
import { type DocumentStoragePort } from '../ports/document-storage';
import { type ChantierNoteRepository } from '../ports/repositories';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type InterventionRepository } from '../intervention/intervention-repository';
import { interventionFieldTraceRefusal } from '../../domain/intervention/intervention';
import { ChantierNote } from '../../domain/chantier/chantier-note';

export interface DeleteWorksitePhotoInput {
  companyId: string;
  id: string;
  /**
   * ERRATUM 6 (annexe re-revue 27/07) — note automatique de RÉSOLUTION portée par la
   * mutation de retrait elle-même : quand la photo retirée appartient à une fiche de
   * passage, la note (« 1 photo n'a pas pu être jointe ») est enregistrée DANS le même
   * geste, taguée à la même fiche — AVANT le sign, jamais rejouée après lui.
   */
  resolutionNote?: { text: string; authorLabel: string };
}

export interface DeleteWorksitePhotoDeps {
  media: WorksiteMediaStorage;
  storage: DocumentStoragePort;
  /** PR-15 — REQUIS pour retirer une photo TAGUÉE à une fiche (fail-closed sinon) : le
   * verrou post-signature (§3.4) doit être prouvé avant de toucher la fiche. */
  interventions?: InterventionRepository;
  /** ERRATUM 6 — requis si `resolutionNote` est fournie. */
  notes?: ChantierNoteRepository;
  ids?: IdGeneratorPort;
  clock?: ClockPort;
}

/** Suppression d'une photo de chantier (ConfirmSheet côté app) — octets ET métadonnée retirés. */
export class DeleteWorksitePhoto {
  constructor(private readonly deps: DeleteWorksitePhotoDeps) {}

  async execute(input: DeleteWorksitePhotoInput): Promise<Result<void, AppError>> {
    const item = await this.deps.media.findById(input.companyId, input.id);
    if (!item) return err(appNotFound('worksite_photo', input.id));

    // PR-15 §3.4 — photo d'une fiche qui n'accepte plus de traces : retrait ET note de
    // résolution refusés (use case ET trigger). [Revue adversariale 28/07 — finding 9b] on
    // appelle le MÊME prédicat `acceptsFieldTraces()` qu'AddChantierNote/UploadWorksitePhoto :
    // une fiche `cancelled` refusait la note ici et l'acceptait là — deux chemins, deux règles.
    const interventionId = item.interventionId ?? null;
    if (interventionId !== null) {
      if (!this.deps.interventions) {
        return err({
          kind: 'dependency',
          port: 'InterventionRepository',
          cause: 'photo taguée à une fiche sans port de vérification (interventions) : retrait refusé.',
        });
      }
      const intervention = await this.deps.interventions.findById(input.companyId, interventionId);
      if (!intervention || intervention.companyId !== input.companyId)
        return err(appNotFound('intervention', interventionId));
      if (!intervention.acceptsFieldTraces())
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'interventionId',
            message: interventionFieldTraceRefusal(intervention.status),
          }),
        );
    }

    await this.deps.storage.remove(input.companyId, item.storageKey);
    await this.deps.media.remove(input.companyId, input.id);

    // ERRATUM 6 — la note de résolution prend la PLACE de la photo retirée : enregistrée par
    // CE geste (donc AVANT tout sign encore en file), taguée à la même fiche. Fail-closed :
    // sans les ports, la note est refusée (la suppression, elle, a eu lieu — dit tel quel).
    if (input.resolutionNote !== undefined) {
      if (!this.deps.notes || !this.deps.ids || !this.deps.clock) {
        return err({
          kind: 'dependency',
          port: 'ChantierNoteRepository',
          cause: 'resolutionNote fournie sans ports notes/ids/clock : photo retirée, note NON tracée.',
        });
      }
      const note = ChantierNote.record({
        id: this.deps.ids.newId(),
        companyId: input.companyId,
        chantierId: item.chantierId,
        text: input.resolutionNote.text,
        authorLabel: input.resolutionNote.authorLabel,
        createdAt: this.deps.clock.now(),
        equipmentId: item.equipmentId ?? null,
        interventionId,
      });
      if (!note.ok) return err(appDomain(note.error));
      await this.deps.notes.save(note.value);
    }
    return ok(undefined);
  }
}

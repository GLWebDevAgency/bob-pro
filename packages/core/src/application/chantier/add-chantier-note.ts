import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ChantierRepository, type ChantierNoteRepository } from '../ports/repositories';
import { ChantierNote } from '../../domain/chantier/chantier-note';

export interface AddChantierNoteInput {
  companyId: string;
  chantierId: string;
  text: string;
  authorLabel: string;
}

export interface AddChantierNoteDeps {
  chantiers: ChantierRepository;
  notes: ChantierNoteRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

/**
 * Journal d'activité d'un chantier/projet — création manuelle (fiche chantier) ET vocale
 * (« ajoute une note au chantier Lefèvre : … ») : les deux passent par ce MÊME use case.
 */
export class AddChantierNote {
  constructor(private readonly deps: AddChantierNoteDeps) {}

  async execute(input: AddChantierNoteInput): Promise<Result<{ id: string }, AppError>> {
    const chantier = await this.deps.chantiers.findById(input.chantierId);
    if (!chantier || chantier.companyId !== input.companyId)
      return err(appNotFound('chantier', input.chantierId));

    const id = this.deps.ids.newId();
    const r = ChantierNote.record({
      id,
      companyId: input.companyId,
      chantierId: input.chantierId,
      text: input.text,
      authorLabel: input.authorLabel,
      createdAt: this.deps.clock.now(),
    });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.notes.save(r.value);
    return ok({ id });
  }
}

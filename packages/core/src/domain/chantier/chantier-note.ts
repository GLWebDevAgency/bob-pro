import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';

export interface ChantierNoteProps {
  id: string;
  companyId: string;
  chantierId: string;
  text: string;
  /** Attribution — aujourd'hui toujours le nom de l'entreprise (produit mono-utilisateur) ; le
   * champ est déjà prêt pour un futur multi-utilisateur (cabinet, salariés) sans migration. */
  authorLabel: string;
  createdAt: Instant;
}

/**
 * Note libre horodatée sur un chantier/projet — journal d'activité (« fuite réparée, reste le
 * joint du ballon »), distinct de la description de création (Chantier.notes). Immutable une fois
 * créée : append-only, jamais éditée ni supprimée (V1).
 */
export class ChantierNote {
  private constructor(private readonly p: ChantierNoteProps) {}

  static record(props: ChantierNoteProps): DomainResult<ChantierNote> {
    const text = props.text.trim();
    if (!text) return err({ code: 'VALIDATION', field: 'text', message: 'Note vide.' });
    if (text.length > 2000)
      return err({ code: 'VALIDATION', field: 'text', message: 'Note limitée à 2000 caractères.' });
    const authorLabel = props.authorLabel.trim();
    if (!authorLabel)
      return err({ code: 'VALIDATION', field: 'authorLabel', message: 'Auteur requis.' });
    return ok(new ChantierNote({ ...props, text, authorLabel }));
  }

  static rehydrate(props: ChantierNoteProps): ChantierNote {
    return new ChantierNote({ ...props });
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get chantierId(): string {
    return this.p.chantierId;
  }
  get text(): string {
    return this.p.text;
  }
  get authorLabel(): string {
    return this.p.authorLabel;
  }
  get createdAt(): Instant {
    return this.p.createdAt;
  }

  toProps(): ChantierNoteProps {
    return { ...this.p };
  }
}

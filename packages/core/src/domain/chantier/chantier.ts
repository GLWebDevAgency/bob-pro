import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';

export type ChantierStatus = 'open' | 'closed';

export interface ChantierProps {
  id: string;
  companyId: string;
  name: string;
  customerId: string | null;
  address: string | null;
  /** Note libre (contexte, accès, consignes) — jamais affichée comme une pièce, purement informative. */
  notes: string | null;
  status: ChantierStatus;
  openedAt: DateOnly;
}

/**
 * Agrégat Chantier — module vertical BTP (regroupe devis/factures d'un même chantier).
 * Pertinent pour les métiers du bâtiment (cf. TradeProfile) ; débloqué dès le palier Solo (métiers BTP),
 * ou via le Pack BTP (qui ouvre aussi les modules chantier lourds).
 */
export class Chantier {
  private constructor(private readonly p: ChantierProps) {}

  static record(props: ChantierProps): DomainResult<Chantier> {
    const name = props.name.trim();
    if (!name) return err({ code: 'VALIDATION', field: 'name', message: 'Nom de chantier requis.' });
    const notes = props.notes?.trim() || null;
    if (notes && notes.length > 2000)
      return err({ code: 'VALIDATION', field: 'notes', message: 'Note limitée à 2000 caractères.' });
    return ok(new Chantier({ ...props, name, notes }));
  }

  /** Réhydratation depuis le stockage (données déjà validées). */
  static rehydrate(props: ChantierProps): Chantier {
    return new Chantier({ ...props });
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get name(): string {
    return this.p.name;
  }
  get status(): ChantierStatus {
    return this.p.status;
  }
  get address(): string | null {
    return this.p.address;
  }
  get customerId(): string | null {
    return this.p.customerId;
  }
  get notes(): string | null {
    return this.p.notes;
  }

  close(): void {
    this.p.status = 'closed';
  }

  /**
   * PR-11a [revue A12] — symétrie de `close()` : un site clôturé se ROUVRE (le parc, les
   * passages et les contrats exigent un site `open` — le refus actionnable « rouvre-le pour
   * ajouter » propose exactement cette transition).
   */
  reopen(): void {
    this.p.status = 'open';
  }

  toProps(): ChantierProps {
    return { ...this.p };
  }
}

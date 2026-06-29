import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly } from '../../shared-kernel/time';

export type ChantierStatus = 'open' | 'closed';

export interface ChantierProps {
  id: string;
  companyId: string;
  name: string;
  customerId: string | null;
  address: string | null;
  status: ChantierStatus;
  openedAt: DateOnly;
}

/**
 * Agrégat Chantier — module vertical BTP (regroupe devis/factures d'un même chantier).
 * Pertinent pour les métiers du bâtiment (cf. TradeProfile) ; débloqué par palier Pro ou Pack BTP.
 */
export class Chantier {
  private constructor(private readonly p: ChantierProps) {}

  static record(props: ChantierProps): DomainResult<Chantier> {
    const name = props.name.trim();
    if (!name) return err({ code: 'VALIDATION', field: 'name', message: 'Nom de chantier requis.' });
    return ok(new Chantier({ ...props, name }));
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

  close(): void {
    this.p.status = 'closed';
  }

  toProps(): ChantierProps {
    return { ...this.p };
  }
}

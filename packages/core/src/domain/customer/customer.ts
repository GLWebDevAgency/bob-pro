import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Address } from '../../shared-kernel/contact';

export type CustomerType = 'b2c' | 'b2b' | 'b2g';

export interface CustomerProps {
  id: string;
  companyId: string;
  type: CustomerType;
  name: string;
  siren?: string;
  address: Address;
  email?: string;
  phone?: string;
  /** Contact chez le client entreprise/public (raison sociale ≠ personne physique jointe). */
  contactName?: string;
  paymentTermsLabel?: string;
  isInternational?: boolean;
  isSubcontractingBtp?: boolean;
}

export class Customer {
  private constructor(private readonly p: CustomerProps) {}

  static of(p: CustomerProps): DomainResult<Customer> {
    if (typeof p.id !== 'string' || p.id.trim().length === 0)
      return err({ code: 'VALIDATION', field: 'id', message: 'Identifiant client requis.' });
    if (typeof p.companyId !== 'string' || p.companyId.trim().length === 0)
      return err({ code: 'VALIDATION', field: 'companyId', message: 'Entreprise requise.' });
    if (!['b2c', 'b2b', 'b2g'].includes(p.type))
      return err({ code: 'VALIDATION', field: 'type', message: 'Type de client invalide.' });
    if (typeof p.name !== 'string' || p.name.trim().length === 0 || p.name.trim().length > 200)
      return err({ code: 'VALIDATION', field: 'name', message: 'Nom client requis (200 caractères maximum).' });
    if (
      p.address === null
      || typeof p.address !== 'object'
      || typeof p.address.line1 !== 'string'
      || typeof p.address.zip !== 'string'
      || typeof p.address.city !== 'string'
    )
      return err({ code: 'VALIDATION', field: 'address', message: 'Adresse client invalide.' });
    if (p.siren !== undefined && !/^\d{9}$/.test(p.siren))
      return err({ code: 'VALIDATION', field: 'siren', message: 'SIREN invalide : 9 chiffres requis.' });
    if (p.contactName !== undefined && p.contactName.trim().length > 200)
      return err({ code: 'VALIDATION', field: 'contactName', message: 'Nom du contact limité à 200 caractères.' });

    // Projection exacte : même si un appelant JavaScript injecte d'anciens champs
    // `score`/`avgDelayDays`/`outstanding`, ils ne deviennent jamais un état métier.
    const contactName = p.contactName?.trim();
    const props: CustomerProps = {
      id: p.id,
      companyId: p.companyId,
      type: p.type,
      name: p.name.trim(),
      address: { ...p.address },
      ...(p.siren !== undefined ? { siren: p.siren } : {}),
      ...(p.email !== undefined ? { email: p.email } : {}),
      ...(p.phone !== undefined ? { phone: p.phone } : {}),
      ...(contactName ? { contactName } : {}),
      ...(p.paymentTermsLabel !== undefined ? { paymentTermsLabel: p.paymentTermsLabel } : {}),
      ...(p.isInternational !== undefined ? { isInternational: p.isInternational } : {}),
      ...(p.isSubcontractingBtp !== undefined ? { isSubcontractingBtp: p.isSubcontractingBtp } : {}),
    };
    return ok(new Customer(props));
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get type(): CustomerType {
    return this.p.type;
  }
  get name(): string {
    return this.p.name;
  }
  get siren(): string | undefined {
    return this.p.siren;
  }
  get email(): string | undefined {
    return this.p.email;
  }
  get phone(): string | undefined {
    return this.p.phone;
  }
  get contactName(): string | undefined {
    return this.p.contactName;
  }
  get address(): Address {
    return { ...this.p.address };
  }
  get isSubcontractingBtp(): boolean {
    return this.p.isSubcontractingBtp === true;
  }
  isInternational(): boolean {
    return this.p.isInternational === true;
  }
  requiresSirenForEinvoice(): boolean {
    return this.p.type === 'b2b' || this.p.type === 'b2g';
  }
  /** Débiteur professionnel (b2b/b2g) — gate des régimes L441-9/L441-10 et CCP (P01/P12/P14) :
   *  ni indemnité 40 € ni pénalités BCE+10 pour un particulier (b2c). */
  isProfessional(): boolean {
    return this.p.type === 'b2b' || this.p.type === 'b2g';
  }
  /** Snapshot de persistance (réhydratation via Customer.of). */
  toProps(): CustomerProps {
    return { ...this.p, address: { ...this.p.address } };
  }
}

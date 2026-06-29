import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Address } from '../../shared-kernel/contact';
import { Siren, Siret } from '../../shared-kernel/identifiers';
import { type DateOnly } from '../../shared-kernel/time';

export type LegalForm = 'EI' | 'EURL' | 'SASU' | 'SARL' | 'SAS' | 'micro';
export type VatRegime = 'franchise' | 'reel_simpl' | 'reel_normal';
export type Trade =
  | 'plombier'
  | 'electricien'
  | 'macon'
  | 'peintre'
  | 'paysagiste'
  | 'consultant'
  | 'photographe'
  | 'coach'
  | 'autre';

export interface InsurancePolicy {
  insurer: string;
  policyNo: string;
  coverage: string;
  expiresAt: DateOnly;
}

const BTP_TRADES: ReadonlySet<Trade> = new Set([
  'plombier',
  'electricien',
  'macon',
  'peintre',
  'paysagiste',
]);

export interface CompanyProps {
  id: string;
  name: string;
  legalForm: LegalForm;
  siren: string;
  siret: string;
  apeCode?: string;
  trade: Trade;
  vatRegime: VatRegime;
  rcsOrRm?: string;
  address: Address;
  iban?: string;
  bic?: string;
  decennale?: InsurancePolicy;
}

export class Company {
  private constructor(private readonly p: CompanyProps) {}

  static of(p: CompanyProps): DomainResult<Company> {
    const siren = Siren.of(p.siren);
    if (!siren.ok) return siren;
    const siret = Siret.of(p.siret);
    if (!siret.ok) return siret;
    if (siret.value.siren().value !== siren.value.value)
      return err({ code: 'VALIDATION', field: 'siret', message: 'SIRET incoherent avec le SIREN.' });
    return ok(new Company(p));
  }

  get id(): string {
    return this.p.id;
  }
  get name(): string {
    return this.p.name;
  }
  get trade(): Trade {
    return this.p.trade;
  }
  get vatRegime(): VatRegime {
    return this.p.vatRegime;
  }
  get address(): Address {
    return this.p.address;
  }
  get rcsOrRm(): string | undefined {
    return this.p.rcsOrRm;
  }
  get decennale(): InsurancePolicy | undefined {
    return this.p.decennale;
  }

  isBtp(): boolean {
    return BTP_TRADES.has(this.p.trade);
  }
  isVatFranchise(): boolean {
    return this.p.vatRegime === 'franchise';
  }
  requiresAutoliquidation(customer: { type: 'b2c' | 'b2b' | 'b2g'; isSubcontractingBtp: boolean }): boolean {
    return this.isBtp() && customer.type === 'b2b' && customer.isSubcontractingBtp;
  }
  hasValidDecennale(asOf: DateOnly): boolean {
    return !!this.p.decennale && this.p.decennale.expiresAt >= asOf;
  }
  assertCanIssue(): DomainResult<void> {
    if (!this.p.rcsOrRm)
      return err({ code: 'VALIDATION', field: 'rcsOrRm', message: 'RCS ou RM requis pour emettre.' });
    if (!this.p.address.line1 || !this.p.address.city)
      return err({ code: 'VALIDATION', field: 'address', message: 'Adresse complete requise.' });
    return ok(undefined);
  }
}

import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Address } from '../../shared-kernel/contact';
import { Siren, Siret } from '../../shared-kernel/identifiers';
import { type DateOnly, type Instant } from '../../shared-kernel/time';

export type LegalForm = 'EI' | 'EURL' | 'SASU' | 'SARL' | 'SAS' | 'micro';
export type VatRegime = 'franchise' | 'reel_simpl' | 'reel_normal';
/** Clientèle principale explicitement confirmée par le propriétaire pendant l'onboarding. */
export type CustomerPortfolio = 'b2c' | 'b2b' | 'b2g' | 'mixte';
export type Trade =
  | 'plombier'
  | 'electricien'
  | 'macon'
  | 'peintre'
  | 'paysagiste'
  | 'consultant'
  | 'freelance_it'
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
  /** Absent tant que l'utilisateur ne l'a pas confirmé — aucune valeur par défaut implicite. */
  customerPortfolio?: CustomerPortfolio;
  rcsOrRm?: string;
  address: Address;
  /** N° TVA intracom (fiche annuaire à l'inscription — C24b « fiche société complète »). */
  tvaIntracom?: string;
  /** Date de création de l'entreprise (fiche annuaire, ISO yyyy-mm-dd). */
  dateCreation?: DateOnly;
  iban?: string;
  bic?: string;
  decennale?: InsurancePolicy;
  /**
   * Clôture de compte (Apple 5.1.1(v), CloseAccount @bob/core) — marqueur additif, JAMAIS un
   * cascade delete : présent = la company est clôturée, le tenant n'est plus accessible (guard
   * API), mais TOUT le reste de cet objet (name, siret, address, iban…) reste INTACT. C'est le
   * point : ces champs sont la source live lue à chaque régénération d'une pièce comptable déjà
   * émise (ex. renderInvoicePdf relit company.name/address/rcsOrRm), donc les MODIFIER après coup
   * falsifierait rétroactivement des factures/devis déjà émis — l'exact inverse de la rétention
   * légale de 10 ans (Code de commerce). L'anonymisation du compte porte donc UNIQUEMENT sur
   * l'identité personnelle de l'utilisateur (prénom, email, téléphone) : elle vit entièrement
   * dans Supabase Auth (user_metadata), jamais ici — supprimée via l'admin API Supabase, en
   * dehors de cet agrégat.
   */
  closedAt?: Instant;
  /** Motif optionnel saisi par l'utilisateur à la clôture — jamais requis, jamais affiché ailleurs. */
  closureReason?: string;
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
    if (
      p.customerPortfolio !== undefined
      && !(['b2c', 'b2b', 'b2g', 'mixte'] as const).includes(p.customerPortfolio)
    ) {
      return err({
        code: 'VALIDATION',
        field: 'customerPortfolio',
        message: 'Clientele principale invalide.',
      });
    }
    return ok(new Company(p));
  }

  get id(): string {
    return this.p.id;
  }
  get name(): string {
    return this.p.name;
  }
  get siren(): string {
    return this.p.siren;
  }
  get siret(): string {
    return this.p.siret;
  }
  get legalForm(): LegalForm {
    return this.p.legalForm;
  }
  get trade(): Trade {
    return this.p.trade;
  }
  get vatRegime(): VatRegime {
    return this.p.vatRegime;
  }
  get customerPortfolio(): CustomerPortfolio | undefined {
    return this.p.customerPortfolio;
  }
  get address(): Address {
    return this.p.address;
  }
  get rcsOrRm(): string | undefined {
    return this.p.rcsOrRm;
  }
  get tvaIntracom(): string | undefined {
    return this.p.tvaIntracom;
  }
  get dateCreation(): DateOnly | undefined {
    return this.p.dateCreation;
  }
  get decennale(): InsurancePolicy | undefined {
    return this.p.decennale;
  }
  get closedAt(): Instant | undefined {
    return this.p.closedAt;
  }
  get closureReason(): string | undefined {
    return this.p.closureReason;
  }

  /** Compte clôturé (CloseAccount) — le guard tenant API doit refuser toute requête au-delà. */
  isClosed(): boolean {
    return this.p.closedAt !== undefined;
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

  /** Snapshot de persistance (réhydratation via Company.of). */
  toProps(): CompanyProps {
    return { ...this.p, address: { ...this.p.address } };
  }
}

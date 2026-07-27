import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Address } from '../../shared-kernel/contact';
import { Siren, Siret } from '../../shared-kernel/identifiers';
import { type DateOnly, type Instant } from '../../shared-kernel/time';
import { validateFrenchVatId } from '../../shared-kernel/french-vat-id';

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
  // PR-10 « Le métier » — métiers de la MAINTENANCE (bêta Fly Services) : le module chantiers
  // leur est pertinent avec le vocabulaire « site » (un frigoriste parle de sites, pas de
  // chantiers) — le même écran sert les deux mondes via tradeToWorksiteTerminology.
  | 'frigoriste'
  | 'mainteneur'
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

/**
 * A2 — Médiateur de la consommation de l'entreprise.
 * Adhésion obligatoire à un dispositif de médiation pour tout professionnel vendant à des
 * consommateurs (art. L612-1 code de la consommation) ; communication du nom et des coordonnées
 * du médiateur sur les documents commerciaux (art. L616-1 code de la consommation — sanction :
 * amende administrative jusqu'à 3 000 € pers. physique / 15 000 € pers. morale, art. L641-1).
 * Absent = jamais saisi par le propriétaire (nudge d'onboarding, jamais un défaut inventé).
 */
export interface MediateurConso {
  /** Nom du médiateur ou de l'entité de médiation (ex. « CM2C », « Medicys »). */
  nom: string;
  /** Coordonnées de saisine : adresse postale et/ou site internet (art. R616-1 code conso). */
  coordonnees: string;
}

/** Formes juridiques à capital social — une EI/micro-entreprise n'a pas de capital
 *  (art. R123-238 code de commerce : la mention forme + capital ne vise que les sociétés). */
const CAPITAL_LEGAL_FORMS: ReadonlySet<LegalForm> = new Set(['EURL', 'SASU', 'SARL', 'SAS']);

const MEDIATEUR_NOM_MAX = 200;
const MEDIATEUR_COORDONNEES_MAX = 500;

const BTP_TRADES: ReadonlySet<Trade> = new Set([
  'plombier',
  'electricien',
  'macon',
  'peintre',
  'paysagiste',
  // PR-10 — le frigoriste INSTALLE des équipements du bâtiment (froid/climatisation) : travaux
  // d'équipement au sens de l'autoliquidation sous-traitance BTP (art. 283, 2 nonies CGI) et
  // décennale pertinente sur les installations indissociables. Le MAINTENEUR (entretien
  // multitechnique) reste HORS du set — fail-closed : on n'applique jamais un régime de TVA
  // bâtiment à une activité principalement de service sans certitude.
  'frigoriste',
]);

/**
 * PR-10 — appartenance bâtiment d'un métier, SOURCE UNIQUE partagée avec l'onboarding
 * (deriveTradeProfile) : depuis les métiers de maintenance, le module `chantiers` n'est PLUS
 * un marqueur BTP (un mainteneur a des sites sans être un métier du bâtiment).
 */
export function isBtpTrade(trade: Trade): boolean {
  return BTP_TRADES.has(trade);
}

/**
 * Contrat positif d'inscription d'une entreprise.
 *
 * Il est volontairement défini champ par champ au lieu d'être dérivé de `CompanyProps` avec un
 * `Omit` : une future propriété interne (identifiant, cycle de vie, marqueur de conformité…) ne
 * peut ainsi jamais devenir silencieusement écrivable par `/onboarding/company`.
 */
export interface CompanyRegistrationInput {
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
  /** Code catégorie juridique INSEE brut (fiche annuaire, ex. « 5710 ») — traçabilité de la
   *  forme juridique déduite. Absent = jamais fourni par la source, aucune valeur inventée. */
  natureJuridiqueCode?: string;
  /** Qualification RGE à l'annuaire au moment du provisioning (Pack BTP). Absent = source
   *  jamais interrogée (fiches antérieures à la colonne) — jamais rétro-rempli. */
  estRge?: boolean;
  iban?: string;
  bic?: string;
  decennale?: InsurancePolicy;
}

export interface CompanyProps extends CompanyRegistrationInput {
  id: string;
  /**
   * A6 — Capital social en CENTIMES (entier), sociétés uniquement (art. R123-238 code de
   * commerce : forme juridique + capital social sur les factures et documents des sociétés
   * commerciales). Absent = jamais saisi — aucune valeur déduite de l'annuaire ni inventée.
   * Saisi après l'onboarding via les réglages entreprise (PATCH /company/legal), jamais par
   * /onboarding/company (contrat d'inscription volontairement fermé, cf. CompanyRegistrationInput).
   */
  capitalSocialCents?: number;
  /** A2 — Médiateur de la consommation (cf. MediateurConso). Absent = jamais saisi. */
  mediateurConso?: MediateurConso;
  /**
   * A3 — adresse électronique DE L'ENTREPRISE (pas celle du compte utilisateur) : requise par
   * les modèles types de rétractation EN VIGUEUR (formulaire annexe R221-1 ET avis annexe
   * R221-3, décret n° 2022-424 du 25/03/2022 — « son adresse électronique », sans réserve).
   * Absente = jamais saisie (réglages entreprise) : les textes impriment le connu, jamais
   * l'inventé, et l'incomplétude est signalée (retractationContactGaps).
   */
  email?: string;
  /** A3 — numéro de téléphone de l'entreprise : requis par l'avis type R221-3 (instruction (2),
   *  décret n° 2022-424). Absent = jamais saisi, même doctrine que `email`. */
  phone?: string;
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
    let tvaIntracom: string | undefined;
    if (p.tvaIntracom !== undefined) {
      const vat = validateFrenchVatId(p.tvaIntracom, siren.value.value);
      if (!vat.ok) return vat;
      tvaIntracom = vat.value;
    }
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
    if (p.capitalSocialCents !== undefined) {
      if (!Number.isSafeInteger(p.capitalSocialCents) || p.capitalSocialCents <= 0) {
        return err({
          code: 'VALIDATION',
          field: 'capitalSocialCents',
          message: 'Capital social invalide (centimes entiers > 0 requis).',
        });
      }
      // A6 : le capital social n'existe que pour une société — une EI/micro n'en a pas
      // (art. R123-238 c. com. ne vise que les sociétés ; l'EI porte la mention « EI »,
      // décret n° 2022-725 du 28/04/2022).
      if (!CAPITAL_LEGAL_FORMS.has(p.legalForm)) {
        return err({
          code: 'VALIDATION',
          field: 'capitalSocialCents',
          message: 'Le capital social est réservé aux sociétés (EURL, SASU, SARL, SAS).',
        });
      }
    }
    if (p.email !== undefined) {
      const email = p.email.trim();
      if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return err({ code: 'VALIDATION', field: 'email', message: 'Adresse électronique invalide.' });
      }
    }
    if (p.phone !== undefined) {
      const phone = p.phone.trim();
      if (phone.length === 0 || phone.length > 30 || !/^[0-9+()./\s-]+$/.test(phone)) {
        return err({ code: 'VALIDATION', field: 'phone', message: 'Numéro de téléphone invalide.' });
      }
    }
    if (p.mediateurConso !== undefined) {
      const nom = p.mediateurConso.nom;
      const coordonnees = p.mediateurConso.coordonnees;
      if (typeof nom !== 'string' || nom.trim().length === 0 || nom.length > MEDIATEUR_NOM_MAX) {
        return err({
          code: 'VALIDATION',
          field: 'mediateurConso',
          message: 'Nom du médiateur de la consommation requis (200 caractères max).',
        });
      }
      if (
        typeof coordonnees !== 'string'
        || coordonnees.trim().length === 0
        || coordonnees.length > MEDIATEUR_COORDONNEES_MAX
      ) {
        return err({
          code: 'VALIDATION',
          field: 'mediateurConso',
          message: 'Coordonnées du médiateur requises (adresse et/ou site, 500 caractères max).',
        });
      }
    }
    return ok(new Company({ ...p, ...(tvaIntracom === undefined ? {} : { tvaIntracom }) }));
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
  /** Code NAF/APE INSEE (fiche annuaire) — affine la dérivation du profil fiscal. */
  get apeCode(): string | undefined {
    return this.p.apeCode;
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
  /** Code catégorie juridique INSEE brut (fiche annuaire, ex. « 5710 »). */
  get natureJuridiqueCode(): string | undefined {
    return this.p.natureJuridiqueCode;
  }
  /** Qualification RGE à l'annuaire au provisioning — undefined = jamais interrogée. */
  get estRge(): boolean | undefined {
    return this.p.estRge;
  }
  get decennale(): InsurancePolicy | undefined {
    return this.p.decennale;
  }
  /** A6 — capital social en centimes (sociétés uniquement) ; undefined = jamais saisi. */
  get capitalSocialCents(): number | undefined {
    return this.p.capitalSocialCents;
  }
  /** A2 — médiateur de la consommation ; undefined = jamais saisi (nudge d'onboarding). */
  get mediateurConso(): MediateurConso | undefined {
    return this.p.mediateurConso ? { ...this.p.mediateurConso } : undefined;
  }
  /** A3 — adresse électronique de l'entreprise (modèles R221-1/R221-3) ; undefined = jamais saisie. */
  get email(): string | undefined {
    return this.p.email;
  }
  /** A3 — téléphone de l'entreprise (avis type R221-3) ; undefined = jamais saisi. */
  get phone(): string | undefined {
    return this.p.phone;
  }
  /** Société commerciale à capital (EURL/SASU/SARL/SAS) — pilote le bloc émetteur A6
   *  (forme + capital pour les sociétés, suffixe « EI » pour l'entrepreneur individuel). */
  isSociete(): boolean {
    return CAPITAL_LEGAL_FORMS.has(this.p.legalForm);
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
    return isBtpTrade(this.p.trade);
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
    if (
      this.p.address.line1.trim().length === 0
      || this.p.address.zip.trim().length === 0
      || this.p.address.city.trim().length === 0
    )
      return err({ code: 'VALIDATION', field: 'address', message: 'Adresse complete requise.' });
    if (this.isSociete() && this.p.capitalSocialCents === undefined)
      return err({
        code: 'VALIDATION',
        field: 'capitalSocialCents',
        message: 'Capital social requis pour émettre au nom de cette société.',
      });
    if (!this.isVatFranchise() && !this.p.tvaIntracom)
      return err({
        code: 'VALIDATION',
        field: 'tvaIntracom',
        message: 'Numéro de TVA intracommunautaire réel requis pour émettre avec TVA.',
      });
    return ok(undefined);
  }

  /** Snapshot de persistance (réhydratation via Company.of). */
  toProps(): CompanyProps {
    return {
      ...this.p,
      address: { ...this.p.address },
      ...(this.p.mediateurConso ? { mediateurConso: { ...this.p.mediateurConso } } : {}),
    };
  }
}

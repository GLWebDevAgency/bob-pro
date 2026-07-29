import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Address } from '../../shared-kernel/contact';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { validateProPaymentTermsCeiling } from '../services/payment-terms-legal';
import { validateFrenchVatId } from '../../shared-kernel/french-vat-id';
import { Siren, Siret } from '../../shared-kernel/identifiers';
import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';

const UNICODE_CONTROL_CHARACTER = /\p{Cc}/u;

export type CustomerType = 'b2c' | 'b2b' | 'b2g';

/**
 * B4 — conditions de paiement PROPRES au client (mêmes champs que PaymentTerms) : `days` +
 * `endOfMonth` (« 45 jours fin de mois ») + `label` imprimable. Nullable/absent = le client
 * suit le défaut des réglages société — `paymentTermsLabel` historique reste purement
 * décoratif, seul CE champ pilote l'échéance dérivée à l'émission (IssueInvoice).
 */
export interface CustomerPaymentTerms {
  days: number;
  endOfMonth: boolean;
  label: string;
}

/**
 * Canal de FACTURATION du client (validé fondateur) : comment la facture émise lui parvient.
 *  • `email`  : envoi direct (défaut de tout client sans canal déclaré) ;
 *  • `chorus` : dépôt sur Chorus Pro (obligatoire pour la sphère publique, ordonnance
 *    n° 2014-697 du 26/06/2014 et art. L2192-1 s. code de la commande publique) —
 *    `chorusServiceCode` = code service exigé par certaines entités ;
 *  • `portail` : portail fournisseur privé du donneur d'ordre (grands comptes) —
 *    `portailNom`/`portailUrl` = mémo de dépôt affiché à l'artisan.
 * Nullable/absent = email (défaut honnête, jamais un canal inventé).
 */
export type CustomerBillingChannelType = 'email' | 'chorus' | 'portail';

export interface CustomerBillingChannel {
  type: CustomerBillingChannelType;
  /** Chorus Pro uniquement : code service du destinataire (exigé par certaines entités). */
  chorusServiceCode?: string;
  /** Portail privé uniquement : nom du portail (mémo de dépôt). */
  portailNom?: string;
  /** Portail privé uniquement : URL du portail (mémo de dépôt). */
  portailUrl?: string;
}

const BILLING_CHANNEL_TYPES: readonly CustomerBillingChannelType[] = ['email', 'chorus', 'portail'];

/**
 * Validation STRUCTURELLE du canal de facturation : les champs annexes n'existent que pour LEUR
 * type (un code service sur un canal email serait un état sans sens, refusé fail-closed).
 * Retourne la forme normalisée (trims, champs annexes seulement quand pertinents).
 */
export function validateBillingChannel(
  channel: CustomerBillingChannel,
): DomainResult<CustomerBillingChannel> {
  if (channel === null || typeof channel !== 'object')
    return err({ code: 'VALIDATION', field: 'billingChannel', message: 'Canal de facturation invalide.' });
  if (!BILLING_CHANNEL_TYPES.includes(channel.type))
    return err({
      code: 'VALIDATION',
      field: 'billingChannel.type',
      message: 'Canal de facturation inconnu (email | chorus | portail).',
    });
  const chorusServiceCode = channel.chorusServiceCode?.trim();
  const portailNom = channel.portailNom?.trim();
  const portailUrl = channel.portailUrl?.trim();
  if (channel.type !== 'chorus' && chorusServiceCode !== undefined)
    return err({
      code: 'VALIDATION',
      field: 'billingChannel.chorusServiceCode',
      message: 'Le code service ne concerne que le canal Chorus Pro.',
    });
  if (channel.type !== 'portail' && (portailNom !== undefined || portailUrl !== undefined))
    return err({
      code: 'VALIDATION',
      field: 'billingChannel.portailNom',
      message: 'Le nom et l’URL de portail ne concernent que le canal portail.',
    });
  if (chorusServiceCode !== undefined && (chorusServiceCode.length === 0 || chorusServiceCode.length > 100))
    return err({
      code: 'VALIDATION',
      field: 'billingChannel.chorusServiceCode',
      message: 'Code service Chorus invalide (1 à 100 caractères).',
    });
  if (portailNom !== undefined && (portailNom.length === 0 || portailNom.length > 200))
    return err({
      code: 'VALIDATION',
      field: 'billingChannel.portailNom',
      message: 'Nom de portail invalide (1 à 200 caractères).',
    });
  if (portailUrl !== undefined) {
    if (portailUrl.length === 0 || portailUrl.length > 500 || !/^https?:\/\//i.test(portailUrl))
      return err({
        code: 'VALIDATION',
        field: 'billingChannel.portailUrl',
        message: 'URL de portail invalide (http(s)://…, 500 caractères max).',
      });
  }
  return ok({
    type: channel.type,
    ...(chorusServiceCode !== undefined ? { chorusServiceCode } : {}),
    ...(portailNom !== undefined ? { portailNom } : {}),
    ...(portailUrl !== undefined ? { portailUrl } : {}),
  });
}

export interface CustomerProps {
  id: string;
  companyId: string;
  type: CustomerType;
  name: string;
  siren?: string;
  /**
   * Établissement facturé (SIRET, 14 chiffres). Absent = inconnu ; jamais dérivé du SIREN.
   * Lorsqu'il est fourni seul, son préfixe arithmétique permet d'extraire le SIREN.
   */
  siret?: string;
  /** N° TVA français réellement fourni par le client/annuaire. Jamais dérivé du SIREN. */
  tvaIntracom?: string;
  address: Address;
  email?: string;
  phone?: string;
  /** Contact chez le client entreprise/public (raison sociale ≠ personne physique jointe). */
  contactName?: string;
  paymentTermsLabel?: string;
  /** B4 — conditions de paiement du client ; undefined = défaut société à l'émission. */
  paymentTerms?: CustomerPaymentTerms;
  /** Canal de facturation du client ; undefined = email (défaut, jamais un canal inventé). */
  billingChannel?: CustomerBillingChannel;
  /**
   * PR-04 — garde « BC obligatoire » PAR CLIENT (amendement fondateur : désactivée par défaut).
   * undefined/absent = non exigé (comportement historique) ; true = l'émission d'une facture
   * sans n° de bon de commande est refusée (IssueInvoice, override confirmé journalisé).
   */
  requiresPurchaseOrder?: boolean;
  isInternational?: boolean;
  isSubcontractingBtp?: boolean;
}

/**
 * Forme canonique commune des noms client.
 *
 * Les données historiques et les saisies vocales peuvent contenir plusieurs espaces, tabulations
 * ou retours à la ligne. Ils ne portent aucune sémantique métier : on les réduit avant la borne,
 * afin que PostgreSQL, le domaine, l'API de reprise et le mobile parlent exactement le même nom.
 */
export function normalizeCustomerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return normalized.length >= 1
    && normalized.length <= 200
    && !hasAsciiControlCharacter(normalized)
    && !UNICODE_CONTROL_CHARACTER.test(normalized)
    ? normalized
    : null;
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
    const name = normalizeCustomerName(p.name);
    if (name === null)
      return err({ code: 'VALIDATION', field: 'name', message: 'Nom client requis (200 caractères maximum).' });
    if (
      p.address === null
      || typeof p.address !== 'object'
      || typeof p.address.line1 !== 'string'
      || typeof p.address.zip !== 'string'
      || typeof p.address.city !== 'string'
    )
      return err({ code: 'VALIDATION', field: 'address', message: 'Adresse client invalide.' });
    let siren: string | undefined;
    if (p.siren !== undefined) {
      const parsedSiren = Siren.of(p.siren);
      if (!parsedSiren.ok) return parsedSiren;
      siren = parsedSiren.value.value;
    }
    let siret: string | undefined;
    if (p.siret !== undefined) {
      const parsedSiret = Siret.of(p.siret);
      if (!parsedSiret.ok) return parsedSiret;
      siret = parsedSiret.value.value;
      if (siren !== undefined && !siret.startsWith(siren)) {
        return err({
          code: 'VALIDATION',
          field: 'siret',
          message: 'Le SIRET et le SIREN de ce client ne concordent pas.',
        });
      }
      // Le SIREN est la partie arithmétique de 9 chiffres du SIRET : extraction, pas déduction
      // depuis une adresse ou un libellé.
      siren ??= parsedSiret.value.siren().value;
    }
    let tvaIntracom: string | undefined;
    if (p.tvaIntracom !== undefined) {
      if (siren === undefined) {
        return err({ code: 'VALIDATION', field: 'tvaIntracom', message: 'Un SIREN est requis avec le numéro de TVA français.' });
      }
      const vat = validateFrenchVatId(p.tvaIntracom, siren);
      if (!vat.ok) return vat;
      tvaIntracom = vat.value;
    }
    const email = p.email?.trim().toLowerCase();
    if (
      email !== undefined
      && (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    ) {
      return err({ code: 'VALIDATION', field: 'email', message: 'Adresse électronique invalide.' });
    }
    if (p.contactName !== undefined && p.contactName.trim().length > 200)
      return err({ code: 'VALIDATION', field: 'contactName', message: 'Nom du contact limité à 200 caractères.' });
    // B4 — conditions de paiement du client : structure (PaymentTerms) + plafond légal L441-10
    // pour un débiteur professionnel (60 j / 45 j fin de mois) validés À L'ENREGISTREMENT — une
    // échéance illégale fausserait les relances et pénalités dès le premier cycle.
    if (p.paymentTerms !== undefined) {
      const structural = PaymentTerms.of(p.paymentTerms);
      if (!structural.ok) return structural;
      const ceiling = validateProPaymentTermsCeiling(p.type, p.paymentTerms);
      if (!ceiling.ok) return ceiling;
      // Bornes PROPRES à la fiche client (miroir exact du CHECK SQL customers_payment_terms_shape) :
      // un délai > 365 j ou un libellé > 120 caractères n'est pas une condition de paiement réelle.
      if (p.paymentTerms.days > 365)
        return err({ code: 'VALIDATION', field: 'paymentTerms.days', message: 'Délai de paiement client invalide (365 jours maximum).' });
      if (p.paymentTerms.label.trim().length > 120)
        return err({ code: 'VALIDATION', field: 'paymentTerms.label', message: 'Libellé des conditions limité à 120 caractères.' });
    }
    // Canal de facturation : forme validée et NORMALISÉE (champs annexes liés à leur type).
    let billingChannel: CustomerBillingChannel | undefined;
    if (p.billingChannel !== undefined) {
      const channel = validateBillingChannel(p.billingChannel);
      if (!channel.ok) return channel;
      billingChannel = channel.value;
    }

    // Projection exacte : même si un appelant JavaScript injecte d'anciens champs
    // `score`/`avgDelayDays`/`outstanding`, ils ne deviennent jamais un état métier.
    const contactName = p.contactName?.trim();
    const props: CustomerProps = {
      id: p.id,
      companyId: p.companyId,
      type: p.type,
      name,
      address: { ...p.address },
      ...(siren !== undefined ? { siren } : {}),
      ...(siret !== undefined ? { siret } : {}),
      ...(tvaIntracom !== undefined ? { tvaIntracom } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(p.phone !== undefined ? { phone: p.phone } : {}),
      ...(contactName ? { contactName } : {}),
      ...(p.paymentTermsLabel !== undefined ? { paymentTermsLabel: p.paymentTermsLabel } : {}),
      ...(p.paymentTerms !== undefined ? { paymentTerms: { ...p.paymentTerms, label: p.paymentTerms.label.trim() } } : {}),
      ...(billingChannel !== undefined ? { billingChannel } : {}),
      ...(p.requiresPurchaseOrder !== undefined
        ? { requiresPurchaseOrder: p.requiresPurchaseOrder === true }
        : {}),
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
  get siret(): string | undefined {
    return this.p.siret;
  }
  get tvaIntracom(): string | undefined {
    return this.p.tvaIntracom;
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
  /** B4 — conditions de paiement du client (copie défensive) ; undefined = défaut société. */
  get paymentTerms(): CustomerPaymentTerms | undefined {
    return this.p.paymentTerms ? { ...this.p.paymentTerms } : undefined;
  }
  /** Canal de facturation du client (copie défensive) ; undefined = email par défaut. */
  get billingChannel(): CustomerBillingChannel | undefined {
    return this.p.billingChannel ? { ...this.p.billingChannel } : undefined;
  }
  /** PR-04 — ce client exige un n° de bon de commande AVANT émission (false = défaut). */
  get requiresPurchaseOrder(): boolean {
    return this.p.requiresPurchaseOrder === true;
  }
  get address(): Address {
    return { ...this.p.address };
  }

  /**
   * Une fiche client peut volontairement être créée avec une identité minimale afin de ne pas
   * bloquer la prospection. En revanche, une facture numérotée doit porter une adresse de
   * facturation réelle et complète. Cette garde est donc appelée par l'émission, pas par `of` :
   * elle bloque avant le compteur sans inventer ni compléter silencieusement une adresse.
   */
  assertBillingAddressComplete(): DomainResult<void> {
    if (
      this.p.address.line1.trim().length === 0
      || this.p.address.zip.trim().length === 0
      || this.p.address.city.trim().length === 0
    ) {
      return err({
        code: 'VALIDATION',
        field: 'customer.address',
        message: 'Adresse de facturation complète du client requise avant émission.',
      });
    }
    return ok(undefined);
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
    return {
      ...this.p,
      address: { ...this.p.address },
      ...(this.p.paymentTerms ? { paymentTerms: { ...this.p.paymentTerms } } : {}),
      ...(this.p.billingChannel ? { billingChannel: { ...this.p.billingChannel } } : {}),
    };
  }
}

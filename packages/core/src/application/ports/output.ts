// Ports de sortie : génération de document & notification. Adapters côté infra (apps/api).

import { type Discount } from '../../domain/billing/shared/discount';

export interface InvoicePdfData {
  number: string;
  companyName: string;
  companyAddress: string;
  companyRcsOrRm: string | null;
  customerName: string;
  customerAddress: string;
  issuedAt: string | null;
  dueAt: string | null;
  kind: string;
  /**
   * B3 — `discount` optionnel par ligne (compat ascendante) : le renderer imprime la remise à
   * côté de la ligne (« rabais, remises, ristournes » détaillés, art. L441-9 c. com.).
   * `lineTotalCents` — total HT BRUT de la ligne (qty × unitPriceHT), CALCULÉ PAR LE DOMAINE
   * (computeLineBases) dans le mapping : l'adapter n'a aucune formule d'arrondi, il imprime.
   * Optionnel ADDITIF (compat ascendante des adapters/fixtures antérieurs).
   */
  lines: { label: string; qty: number; unit?: string | null; unitPriceHT: number; vatRate: number; discount?: Discount | null; lineTotalCents?: number }[];
  /**
   * B3/B5 — compléments optionnels PRÉSENTS uniquement quand le fait existe (mêmes clés que
   * Totals) : HT brut + total remisé (récapitulatif L441-9), retenue de garantie déduite du
   * net à payer (loi 71-584 — la mention de restitution voyage dans `mentions`).
   * 242 nonies A annexe II CGI :
   *  • `vatByRate` — ventilation base + taxe PAR TAUX (imprimée dès ≥ 2 taux) ; les montants
   *    (base nette, taxe) sont RÉSOLUS PAR LE DOMAINE dans le mapping, l'adapter n'agrège rien.
   *  • `depositDeductionCents` — total déjà facturé sur le marché (acompte + situations) déduit
   *    de la finale ; `situationDeductionCents` — la part provenant des situations émises
   *    (≤ depositDeductionCents) : rangées de réconciliation avant le net à payer.
   * Tous optionnels ADDITIFS : absents = pièce antérieure imprimée au centime près.
   */
  totals: {
    ht: number;
    vat: number;
    ttc: number;
    netToPay: number;
    grossHt?: number;
    discountCents?: number;
    retenueGarantieCents?: number;
    vatByRate?: { rate: number; base: number; tax: number }[];
    depositDeductionCents?: number;
    situationDeductionCents?: number;
  };
  mentions: string[];
  /**
   * B2 — situation de travaux : n° d'ordre sur son devis + avancement facturé en % du marché
   * HT NET (dérivé par l'appelant depuis le devis parent ; null = marché non résolvable,
   * l'avancement n'est alors pas imprimé — jamais inventé). Optionnel (compat ascendante) ;
   * absent ou null = pièce ordinaire.
   */
  situation?: { order: number; advancementPct: number | null } | null;
  /** B5 — taux de retenue de garantie imprimé sur la ligne dédiée ; absent/null = aucune. */
  retenueGarantiePct?: number | null;
  /**
   * Sémantique de règlement de la pièce (Invoice.settlementSemanticsVersion). En V2, les
   * lignes d'une FINALE sont déjà RÉSIDUELLES (les situations sont retirées des lignes) :
   * seule la part acompte (`depositDeductionCents − situationDeductionCents`) est déduite du
   * TTC imprimé ; les situations n'apparaissent qu'en rangée contextuelle, jamais en
   * déduction — sinon l'arithmétique visible de la pièce ne se recoupe plus (L441-9).
   * Optionnel ADDITIF : absent = 1 (pièces antérieures imprimées à l'identique).
   */
  settlementSemanticsVersion?: 1 | 2;
  /**
   * B8 — bon de commande client (numéro d'engagement grands comptes/Chorus Pro) : imprimé dans
   * la zone références quand présent. Optionnel (compat ascendante des adapters existants) ;
   * absent ou null = aucune mention. `receivedAt` = date de réception (ISO), null si inconnue.
   */
  purchaseOrder?: { number: string; receivedAt: string | null } | null;
  /**
   * A5 — identité de la facture annulée par cet AVOIR TOTAL (CreditNoteSourceSnapshot figé par
   * le domaine) : le renderer titre « Avoir » et imprime la référence à la pièce initiale
   * (art. 242 nonies A, I de l'annexe II au CGI ; récupération de la TVA, art. 272 du CGI).
   * E3 : `invoiceId` fait partie de la projection — la navigation croisée (écran avoir →
   * facture d'origine) repose sur l'identité figée, jamais sur le seul devis parent.
   * Optionnel (compat ascendante) ; absent ou null = pièce ordinaire.
   */
  creditNoteSource?: { invoiceId: string; kind: string; number: string; issuedAt: string } | null;
  /**
   * A7 — date/période de la prestation figée à l'émission (art. L441-9 code de commerce ;
   * art. 242 nonies A, I-8° annexe II CGI). `end` null = prestation d'un seul jour.
   * Optionnel (compat ascendante) ; absent ou null = non renseignée — rien d'imprimé.
   */
  servicePeriod?: { start: string; end: string | null } | null;
  /**
   * A7 — adresse de chantier/livraison figée à l'émission, si DISTINCTE de l'adresse de
   * facturation. Optionnel (compat ascendante) ; absent ou null = adresse de facturation.
   */
  deliveryAddress?: string | null;
  /** Présentation et coordonnées déjà résolues depuis la configuration PostgreSQL du tenant. */
  billingPresentation: {
    accentColor: import('../billing/company-billing-settings').InvoicePdfAccentColor;
    rib: { iban: string; bic: string | null } | null;
    insurance: {
      insurer: string;
      policyNo: string;
      coverage: string;
      expiresAt: string;
    } | null;
  };
  /**
   * Logo de l'entreprise (PNG/JPEG, octets résolus par l'appelant depuis le stockage documentaire).
   * Optionnel ADDITIF : absent/null = monogramme élégant (initiales) — jamais un trou. Le champ
   * serveur n'existe pas encore (chaîne logo à créer) ; le slot de rendu est prêt, fail-safe.
   */
  logoBytes?: Uint8Array | null;
}

/**
 * Devis — pas de RIB/assurance/Factur-X (ce n'est pas une pièce comptable probante), mais la
 * date de validité et l'état de signature comptent : le PDF partagé par lien public doit rester
 * honnête sur ce qu'il représente (proposition datée, éventuellement déjà signée).
 */
export interface QuotePdfData {
  number: string;
  companyName: string;
  companyAddress: string;
  companyRcsOrRm: string | null;
  customerName: string;
  customerAddress: string;
  validUntil: string | null;
  /** B3 — `discount` optionnel par ligne (compat ascendante) : remise imprimée à côté de la ligne.
   *  `lineTotalCents` — total HT brut de la ligne résolu par le domaine (mêmes garanties que la
   *  facture) ; optionnel ADDITIF. */
  lines: { label: string; qty: number; unit?: string | null; unitPriceHT: number; vatRate: number; discount?: Discount | null; lineTotalCents?: number }[];
  /** B3 — compléments optionnels (HT brut + total remisé) présents uniquement quand une remise existe.
   *  `vatByRate` — ventilation base + taxe par taux (imprimée dès ≥ 2 taux), montants du domaine. */
  totals: { ht: number; vat: number; ttc: number; netToPay: number; grossHt?: number; discountCents?: number; vatByRate?: { rate: number; base: number; tax: number }[] };
  depositPct: number | null;
  signedBy: string | null;
  /**
   * A1 — mentions légales du devis (buildMentions kind 'quote') : bloc émetteur A6, décennale
   * L243-2 (ou rappel honnête), franchise 293 B, médiateur conso B2C (A2), date d'établissement
   * et caractère gratuit (arrêté du 24/01/2017), durée de validité, « Bon pour accord ».
   * Calculées AU RENDU depuis l'état courant : un devis n'est pas une pièce comptable figée.
   */
  mentions: string[];
  /**
   * A3 — rétractation 14 jours du CONSOMMATEUR (devis B2C uniquement) : bloc d'information
   * (avis type, annexe art. R221-3 c. conso) imprimé avec la pièce + FORMULAIRE DÉTACHABLE de
   * rétractation (modèle type, annexe art. R221-1 — page dédiée du PDF, art. L221-5/L221-9).
   * Optionnel (compat ascendante des adapters) ; absent ou null = client professionnel, rien
   * d'imprimé. A8 : à la signature, ce rendu est figé dans l'original archivé — jamais re-rendu.
   */
  retractation?: { noticeLines: string[]; formLines: string[] } | null;
  /**
   * Accent tenant du devis — MÊMES billing settings que la facture (pdfAccentColor), résolu par
   * l'appelant. Optionnel ADDITIF (compat des adapters existants) ; absent ou null = navy.
   * Forward-only : le devis signé est servi depuis l'archive A8, jamais re-rendu.
   */
  accentColor?: import('../billing/company-billing-settings').InvoicePdfAccentColor | null;
  /**
   * Date de signature (Instant ISO) — imprimée à côté de « Signe par … » quand présente.
   * Optionnel ADDITIF ; absent ou null = pas de date imprimée.
   */
  signedAt?: string | null;
  /**
   * Tracé de signature (data-URL SVG du pad) — dessiné VECTORIELLEMENT dans la carte signature
   * UNIQUEMENT quand l'image existe (fail-closed : jamais de placeholder). V1 : le serveur ne
   * persiste que le hash du tracé — ce champ reste absent tant que l'archivage de l'image
   * (évolution prévue à signQuote) n'existe pas.
   */
  signatureSvg?: string | null;
  /** Logo de l'entreprise — même contrat additif fail-safe que sur InvoicePdfData. */
  logoBytes?: Uint8Array | null;
}

export interface PdfRendererPort {
  /**
   * Rend une facture conforme en PDF (octets). Si `facturX` est fourni, le XML CII est embarqué
   * comme pièce jointe associée (AFRelationship Data) + métadonnées XMP Factur-X (hybride e-invoicing).
   */
  renderInvoice(data: InvoicePdfData, facturX?: { xml: string }): Promise<Uint8Array>;
  /** Rend un devis (octets) — lien public de visualisation (document_view). */
  renderQuote(data: QuotePdfData): Promise<Uint8Array>;
}

export type NotificationChannel = 'email' | 'sms';

export interface Notification {
  channel: NotificationChannel;
  to: string;
  subject: string;
  body: string;
  /**
   * UUID stable pour une même intention d'envoi. Les adapters qui le supportent
   * l'utilisent pour rendre un retry idempotent après un accusé provider perdu.
   */
  idempotencyKey?: string;
}

export interface NotificationPort {
  send(notification: Notification): Promise<void>;
}

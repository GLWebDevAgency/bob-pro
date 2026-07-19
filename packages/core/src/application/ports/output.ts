// Ports de sortie : génération de document & notification. Adapters côté infra (apps/api).

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
  lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
  totals: { ht: number; vat: number; ttc: number; netToPay: number };
  mentions: string[];
  /**
   * B8 — bon de commande client (numéro d'engagement grands comptes/Chorus Pro) : imprimé dans
   * la zone références quand présent. Optionnel (compat ascendante des adapters existants) ;
   * absent ou null = aucune mention. `receivedAt` = date de réception (ISO), null si inconnue.
   */
  purchaseOrder?: { number: string; receivedAt: string | null } | null;
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
  lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
  totals: { ht: number; vat: number; ttc: number; netToPay: number };
  depositPct: number | null;
  signedBy: string | null;
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

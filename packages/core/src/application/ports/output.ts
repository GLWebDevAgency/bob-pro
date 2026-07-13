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
}

export interface PdfRendererPort {
  /**
   * Rend une facture conforme en PDF (octets). Si `facturX` est fourni, le XML CII est embarqué
   * comme pièce jointe associée (AFRelationship Data) + métadonnées XMP Factur-X (hybride e-invoicing).
   */
  renderInvoice(data: InvoicePdfData, facturX?: { xml: string }): Promise<Uint8Array>;
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

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
  /** Rend une facture conforme en PDF (octets). Factur-X = incrément suivant (PDF/A-3 + XML embarqué). */
  renderInvoice(data: InvoicePdfData): Promise<Uint8Array>;
}

export type NotificationChannel = 'email' | 'sms';

export interface Notification {
  channel: NotificationChannel;
  to: string;
  subject: string;
  body: string;
}

export interface NotificationPort {
  send(notification: Notification): Promise<void>;
}

import { type Result, ok, err } from '../../shared-kernel/result';
import { sha256Hex } from '../../shared-kernel/sha256';
import { type AppError, appNotFound } from '../result';
import {
  type CompanyRepository,
  type CustomerRepository,
  type InvoiceRepository,
  type QuoteRepository,
} from '../ports/repositories';
import { type PublicAccessTokenRepository } from '../ports/public-access-token';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { type Notification, type NotificationEmailAttachment } from '../ports/output';
import { CreateDocumentViewLink } from '../public-access/create-document-view-link';

/**
 * PR-01 « Encaisser » — envoi EMAIL RÉEL d'une facture ÉMISE (le trou n° 1 de l'encaissement :
 * la pièce émise n'était jamais livrée par le serveur). Use case PUR : gardes fail-closed
 * (pièce émise uniquement, destinataire résolu — refus actionnable sinon), composition du
 * message (lien public de consultation + PDF archivé joint), déduplication par lien, puis
 * remise à l'outbox transactionnelle via un port étroit. AUCUN réseau tiers ici : l'envoi
 * effectif reste au worker de livraison — et il n'a lieu QUE sur ce geste explicite, jamais
 * comme effet de bord de l'émission.
 *
 * Amendement fondateur (26/07) : l'expéditeur PERÇU est la société utilisatrice — display
 * name = nom de la société, Reply-To = e-mail de la société (jamais un `From` sur un domaine
 * non vérifié) ; copie (Cc) à la société pour que l'artisan garde trace de ce qui est parti.
 */

// ── Clé de déduplication — SOURCE UNIQUE (même doctrine que embargoScheduledPaymentDedupeKey) ──

/** Un envoi = un lien de consultation : la clé suit le jeton (hash — jamais le secret en clair).
 *  Renvoyer la facture prépare un nouveau lien, donc une nouvelle clé ; un retry réseau du même
 *  geste retombe sur la même clé et se déduplique. */
export function invoiceDeliveryDedupeKey(invoiceId: string, viewToken: string): string {
  return `invoice:${invoiceId}:delivery:${sha256Hex(viewToken)}`;
}

/** Inverse exacte (préfixe) de invoiceDeliveryDedupeKey — null pour toute autre clé (fail-closed). */
export function invoiceIdOfInvoiceDeliveryDedupeKey(dedupeKey: string): string | null {
  const match = /^invoice:(.+):delivery:[0-9a-f]{64}$/.exec(dedupeKey);
  return match?.[1] ?? null;
}

// ── Copy de l'e-mail (pure, testable — le ton reste sobre : c'est la société qui parle) ──

export interface InvoiceDeliveryEmailInput {
  companyName: string;
  customerName: string;
  number: string;
  viewUrl: string;
}

export function buildInvoiceDeliveryEmail(input: InvoiceDeliveryEmailInput): {
  subject: string;
  body: string;
} {
  return {
    subject: `Facture ${input.number} — ${input.companyName}`,
    body: [
      `Bonjour ${input.customerName},`,
      '',
      `Veuillez trouver ci-joint la facture ${input.number} de ${input.companyName}.`,
      'Vous pouvez aussi la consulter et la télécharger ici :',
      input.viewUrl,
      '',
      'Pour toute question, répondez directement à cet e-mail.',
    ].join('\n'),
  };
}

// ── Ports étroits (l'outbox et l'archive PDF restent des détails d'infrastructure) ──

export interface InvoiceDeliveryOutboxPort {
  /** Enfile l'ordre d'envoi dans l'outbox durable. `done` = clé déjà livrée (dédup). */
  enqueue(order: {
    companyId: string;
    kind: 'invoice-delivery';
    dedupeKey: string;
    notification: Notification;
  }): Promise<{ jobId: string; status: 'pending' | 'done' | 'failed' }>;
}

export interface InvoiceArchivePdfPort {
  /** Octets ARCHIVÉS (immuables) de la pièce émise, en base64 — une archive absente/corrompue
   *  est une indisponibilité à réparer, jamais une autorisation de régénérer. */
  loadIssuedInvoicePdf(
    companyId: string,
    invoiceId: string,
  ): Promise<Result<NotificationEmailAttachment, AppError>>;
}

// ── Use case ──

export interface SendInvoiceInput {
  invoiceId: string;
  /** Destinataire choisi explicitement (contact) — absent : e-mail de la fiche client. */
  recipientEmail?: string;
}

export interface SendInvoiceOutput {
  number: string;
  recipient: string;
  /** `sent` = clé déjà livrée (dédup d'un retry) ; `queued` = job durable, worker à suivre. */
  deliveryStatus: 'queued' | 'sent';
  jobId: string;
}

export interface SendInvoiceDeps {
  invoices: InvoiceRepository;
  customers: CustomerRepository;
  companies: CompanyRepository;
  quotes: QuoteRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  uow: UnitOfWorkPort;
  clock: ClockPort;
  outbox: InvoiceDeliveryOutboxPort;
  archivePdf: InvoiceArchivePdfPort;
  /** Construction de l'URL publique depuis le jeton — la base (domaine) vit à la frontière. */
  viewUrlOf: (token: string) => string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validationError(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

/**
 * Destinataire EXPLICITE normalisé — SOURCE UNIQUE de tous les adaptateurs (parité) :
 * une adresse fournie mais vide ou mal formée est refusée du MÊME motif partout, jamais
 * silencieusement remplacée par l'e-mail de la fiche client. `ok(null)` = rien d'explicite
 * (l'appelant applique alors son repli fiche client).
 */
export function resolveExplicitRecipientEmail(
  recipientEmail: string | undefined,
): Result<string | null, AppError> {
  if (recipientEmail === undefined) return ok(null);
  const explicit = recipientEmail.trim().toLowerCase();
  if (explicit.length === 0 || !EMAIL_PATTERN.test(explicit)) {
    return err(validationError('recipientEmail', 'Adresse e-mail du destinataire invalide.'));
  }
  return ok(explicit);
}

export class SendInvoice {
  constructor(private readonly deps: SendInvoiceDeps) {}

  async execute(input: SendInvoiceInput): Promise<Result<SendInvoiceOutput, AppError>> {
    const invoice = await this.deps.invoices.findById(input.invoiceId);
    if (!invoice) return err(appNotFound('invoice', input.invoiceId));

    // Garde fail-closed : pièce ÉMISE uniquement (numéro + date d'émission). Un brouillon n'est
    // pas une pièce légale ; une annulée ne se « livre » pas — refus actionnables, jamais un
    // envoi fabriqué.
    if (invoice.number === null || invoice.issuedAt === null) {
      return err(
        validationError(
          'invoice',
          'Cette facture est un brouillon : émets-la d’abord, puis envoie-la.',
        ),
      );
    }
    if (invoice.status === 'cancelled') {
      return err(validationError('invoice', 'Facture annulée : rien à envoyer.'));
    }

    const [company, customer] = await Promise.all([
      this.deps.companies.findById(invoice.companyId),
      this.deps.customers.findById(invoice.customerId),
    ]);
    if (!company || company.isClosed()) {
      return err(validationError('company', 'Société introuvable ou clôturée.'));
    }
    if (!customer || customer.companyId !== company.id) {
      return err(appNotFound('customer', invoice.customerId));
    }

    // Destinataire résolu : contact choisi (prioritaire) sinon e-mail de la fiche client.
    // Aucune adresse → refus ACTIONNABLE (compléter la fiche), jamais un envoi dans le vide.
    const explicit = resolveExplicitRecipientEmail(input.recipientEmail);
    if (!explicit.ok) return explicit;
    const recipient = explicit.value ?? customer.email ?? null;
    if (recipient === null) {
      return err(
        validationError(
          'customer.email',
          `Aucune adresse e-mail pour ${customer.name}. Complète sa fiche client, puis renvoie la facture — ou partage le lien de consultation.`,
        ),
      );
    }

    // Lien public de consultation (rotation) — mêmes gardes transactionnelles que le bouton
    // « Partager le lien » (CreateDocumentViewLink : company vivante, pièce émise).
    const link = await new CreateDocumentViewLink({
      companies: this.deps.companies,
      quotes: this.deps.quotes,
      invoices: this.deps.invoices,
      publicAccessTokens: this.deps.publicAccessTokens,
      uow: this.deps.uow,
      clock: this.deps.clock,
    }).execute({ kind: 'invoice', id: invoice.id });
    if (!link.ok) return link;

    // PDF ARCHIVÉ joint (l'original immuable de l'émission) — fail-closed : archive absente =
    // indisponibilité honnête, l'e-mail ne part pas avec une pièce régénérée ou sans pièce.
    const attachment = await this.deps.archivePdf.loadIssuedInvoicePdf(
      invoice.companyId,
      invoice.id,
    );
    if (!attachment.ok) return attachment;

    const message = buildInvoiceDeliveryEmail({
      companyName: company.name,
      customerName: customer.name,
      number: invoice.number,
      viewUrl: this.deps.viewUrlOf(link.value.token),
    });
    const companyEmail = company.email ?? null;
    const notification: Notification = {
      channel: 'email',
      to: recipient,
      subject: message.subject,
      body: message.body,
      // Amendement fondateur : expéditeur PERÇU = la société (display name), réponses = société.
      senderName: company.name,
      ...(companyEmail !== null ? { replyTo: companyEmail } : {}),
      // Copie à la société — sauf si elle est déjà destinataire (auto-facturation de test).
      ...(companyEmail !== null && companyEmail.toLowerCase() !== recipient
        ? { cc: [companyEmail] }
        : {}),
      attachments: [attachment.value],
    };

    const job = await this.deps.outbox.enqueue({
      companyId: invoice.companyId,
      kind: 'invoice-delivery',
      dedupeKey: invoiceDeliveryDedupeKey(invoice.id, link.value.token),
      notification,
    });

    return ok({
      number: invoice.number,
      recipient,
      deliveryStatus: job.status === 'done' ? 'sent' : 'queued',
      jobId: job.jobId,
    });
  }
}

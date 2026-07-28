import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type CompanyRepository, type CustomerRepository, type ChantierRepository } from '../ports/repositories';
import { type Notification, type NotificationEmailAttachment } from '../ports/output';
import { resolveExplicitRecipientEmail } from '../billing/send-invoice';
import {
  DEFAULT_INTERVENTION_REPORT_TITLE,
  type CompanyInterventionSettingsRepository,
  type InterventionRepository,
} from './intervention-repository';

/**
 * PR-16 — envoi email de la fiche de passage ARCHIVÉE : geste CONFIRMÉ (jamais un effet de
 * bord — « annuler = rien n'est parti »), outbox durable kind `intervention-report` (patron
 * transmission PR-01). Le PDF joint est l'ORIGINAL archivé relu et vérifié (octets + sha256) —
 * une archive absente est une indisponibilité à réparer, JAMAIS une autorisation de re-rendre.
 */

// ── Clé de déduplication — un envoi par VERSION d'archive (retry du même geste dédupliqué) ──

export function interventionReportDedupeKey(interventionId: string, documentSha256: string): string {
  return `intervention:${interventionId}:report:${documentSha256}`;
}

// ── Copy de l'e-mail (pure, testable — la société parle, ton sobre) ──

export interface InterventionReportEmailInput {
  title: string;
  companyName: string;
  customerName: string;
  chantierName: string;
  /** Jour métier du passage (Europe/Paris), affiché JJ/MM/AAAA. */
  visitDate: string;
  signed: boolean;
}

export function buildInterventionReportEmail(input: InterventionReportEmailInput): {
  subject: string;
  body: string;
} {
  return {
    subject: `${input.title} du ${input.visitDate} — ${input.companyName}`,
    body: [
      `Bonjour ${input.customerName},`,
      '',
      `Veuillez trouver ci-joint la ${input.title.toLowerCase()} du ${input.visitDate}` +
        ` (site : ${input.chantierName}).`,
      // Mention HONNÊTE : une fiche non signée le dit, jamais une signature suggérée.
      input.signed
        ? 'Elle a été signée sur place.'
        : 'Le passage a été réalisé sans signature sur place (client absent).',
      '',
      'Pour toute question, répondez directement à cet e-mail.',
    ].join('\n'),
  };
}

// ── Ports étroits (outbox + archive : l'infrastructure reste dehors, patron SendInvoice) ──

export interface InterventionReportOutboxPort {
  enqueue(order: {
    companyId: string;
    kind: 'intervention-report';
    dedupeKey: string;
    notification: Notification;
  }): Promise<{ jobId: string; status: 'pending' | 'done' | 'failed' }>;
}

export interface InterventionReportArchivePort {
  /** Octets ARCHIVÉS (immuables, vérifiés octets + sha256) de la fiche — fail-closed :
   *  archive absente/corrompue = indisponibilité honnête, jamais un re-rendu. */
  loadArchivedReportPdf(
    companyId: string,
    documentId: string,
  ): Promise<Result<{ attachment: NotificationEmailAttachment; sha256: string }, AppError>>;
}

// ── Use case ──

export interface SendInterventionReportInput {
  companyId: string;
  interventionId: string;
  /** Destinataire choisi explicitement (contact PR-09) — absent : e-mail de la fiche client. */
  recipientEmail?: string;
}

export interface SendInterventionReportOutput {
  recipient: string;
  deliveryStatus: 'queued' | 'sent';
  jobId: string;
}

export interface SendInterventionReportDeps {
  interventions: InterventionRepository;
  companies: Pick<CompanyRepository, 'findById'>;
  customers: Pick<CustomerRepository, 'findById'>;
  chantiers: ChantierRepository;
  archive: InterventionReportArchivePort;
  outbox: InterventionReportOutboxPort;
  interventionSettings?: CompanyInterventionSettingsRepository;
}

function validationError(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

export class SendInterventionReport {
  constructor(private readonly deps: SendInterventionReportDeps) {}

  async execute(
    input: SendInterventionReportInput,
  ): Promise<Result<SendInterventionReportOutput, AppError>> {
    const intervention = await this.deps.interventions.findById(input.companyId, input.interventionId);
    if (!intervention || intervention.companyId !== input.companyId)
      return err(appNotFound('intervention', input.interventionId));
    if (intervention.status !== 'completed' && intervention.status !== 'signed')
      return err(validationError('status', 'Termine le passage avant d’envoyer sa fiche.'));
    if (intervention.reportDocumentId === null)
      return err(
        validationError(
          'reportDocumentId',
          'La fiche de passage n’est pas encore générée : génère l’aperçu, puis envoie.',
        ),
      );

    const [company, customer, chantier] = await Promise.all([
      this.deps.companies.findById(input.companyId),
      this.deps.customers.findById(intervention.customerId),
      this.deps.chantiers.findById(intervention.chantierId),
    ]);
    if (!company || company.isClosed())
      return err(validationError('company', 'Société introuvable ou clôturée.'));
    if (!customer || customer.companyId !== input.companyId)
      return err(appNotFound('customer', intervention.customerId));
    if (!chantier || chantier.companyId !== input.companyId)
      return err(appNotFound('chantier', intervention.chantierId));

    // Destinataire : contact choisi (PR-09) prioritaire, sinon fiche client — refus ACTIONNABLE.
    const explicit = resolveExplicitRecipientEmail(input.recipientEmail);
    if (!explicit.ok) return explicit;
    const recipient = explicit.value ?? customer.email ?? null;
    if (recipient === null) {
      return err(
        validationError(
          'customer.email',
          `Aucune adresse e-mail pour ${customer.name}. Ajoute un contact ou complète sa fiche client, puis renvoie la fiche.`,
        ),
      );
    }

    // Archive RELUE et VÉRIFIÉE — fail-closed, jamais re-rendue ici (patron SendInvoice).
    const archived = await this.deps.archive.loadArchivedReportPdf(
      input.companyId,
      intervention.reportDocumentId,
    );
    if (!archived.ok) return archived;

    const settings = (await this.deps.interventionSettings?.find(input.companyId)) ?? null;
    const title = settings?.reportTitle?.trim() || DEFAULT_INTERVENTION_REPORT_TITLE;
    // Invariant §3.4 : une fiche completed/signed porte TOUJOURS finishedAt.
    const visitAnchor = intervention.finishedAt;
    if (visitAnchor === null)
      return err(validationError('finishedAt', 'Fiche terminée sans date de fin : donnée corrompue.'));
    const visitDateOnly = parisDateOnly(visitAnchor);
    const visitDate = `${visitDateOnly.slice(8, 10)}/${visitDateOnly.slice(5, 7)}/${visitDateOnly.slice(0, 4)}`;

    const message = buildInterventionReportEmail({
      title,
      companyName: company.name,
      customerName: customer.name,
      chantierName: chantier.name,
      visitDate,
      signed: intervention.status === 'signed',
    });

    const companyEmail = company.email ?? null;
    const notification: Notification = {
      channel: 'email',
      to: recipient,
      subject: message.subject,
      body: message.body,
      // Expéditeur PERÇU = la société (amendement fondateur) ; réponses → société.
      senderName: company.name,
      ...(companyEmail !== undefined && companyEmail !== null ? { replyTo: companyEmail } : {}),
      ...(companyEmail !== undefined &&
      companyEmail !== null &&
      companyEmail.toLowerCase() !== recipient
        ? { cc: [companyEmail] }
        : {}),
      attachments: [archived.value.attachment],
    };

    const job = await this.deps.outbox.enqueue({
      companyId: input.companyId,
      kind: 'intervention-report',
      dedupeKey: interventionReportDedupeKey(intervention.id, archived.value.sha256),
      notification,
    });

    return ok({
      recipient,
      deliveryStatus: job.status === 'done' ? 'sent' : 'queued',
      jobId: job.jobId,
    });
  }
}

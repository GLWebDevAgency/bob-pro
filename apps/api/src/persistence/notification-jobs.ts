import { createHash } from 'node:crypto';
import { type Notification } from '@bob/core';

/** `cancelled` : intention métier révoquée AVANT livraison (rétractation du client, paiement déjà
 *  reçu…) — le job ne sera JAMAIS livré ni relivré, et ne compte plus dans le fil/les non-lus. */
export type NotificationJobStatus = 'pending' | 'done' | 'failed' | 'cancelled';

/** Quarantaine durable : le payload reste représenté par son job/audit mais ne peut plus être
 * repris automatiquement. Release A refuse toute extension non scellée par l'empreinte V1. */
export const NOTIFICATION_PAYLOAD_QUARANTINE_AT = '9999-12-31T23:59:59.999Z';
export const NOTIFICATION_PAYLOAD_INTEGRITY_ERROR =
  '[manual-review:payload-integrity-invalid] Payload notification inconnu, étendu ou altéré.';
export const NOTIFICATION_DUE_SCAN_MAX_PAGES = 4;
export const LEGACY_NOTIFICATION_PAYLOAD_FIELDS = [
  'channel',
  'to',
  'subject',
  'body',
  'idempotencyKey',
] as const;
const legacyNotificationPayloadFieldSet = new Set<string>(LEGACY_NOTIFICATION_PAYLOAD_FIELDS);
const PROVIDER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LegacyNotificationPayloadAuthority {
  jobId: string;
  channel: Notification['channel'];
  recipient: string;
  subject: string;
}

/** Clé de déduplication du job « encaissement programmé » (embargo L221-10) — SOURCE UNIQUE
 *  partagée entre la programmation (scheduleEmbargoPayment), l'annulation (rétractation) et la
 *  garde de livraison : jamais trois recettes qui dérivent. */
export function embargoScheduledPaymentDedupeKey(quoteId: string): string {
  return `quote:${quoteId}:embargo-scheduled-payment:v1`;
}

/** Inverse exacte de embargoScheduledPaymentDedupeKey — null pour toute autre clé (fail-closed). */
export function quoteIdOfEmbargoScheduledPaymentDedupeKey(dedupeKey: string): string | null {
  const match = /^quote:(.+):embargo-scheduled-payment:v1$/.exec(dedupeKey);
  return match?.[1] ?? null;
}

export interface NotificationJob {
  id: string;
  companyId: string;
  /** `retractation-acknowledgment` : accusé de réception de la rétractation en ligne, sur
   *  support durable (courriel choisi par le consommateur — art. D221-5, IV c. conso).
   *  `embargo-scheduled-payment` : encaissement PROGRAMMÉ à l'expiration de l'embargo L221-10
   *  (défaut légal du flow « encaisser » pendant la fenêtre) — job planifié via notBefore,
   *  livré SEUL à J+7 avec un message honnête au client.
   *  `invoice-delivery` : envoi EMAIL de la facture ÉMISE au client (PR-01 « Encaisser ») —
   *  geste explicite de l'artisan, jamais un effet de bord de l'émission ; payload = lien
   *  public + PDF archivé joint, expéditeur perçu = la société (amendement fondateur).
   *  `invoice-transmission-reminder` : rappel INTERNE de dépôt portail/Chorus J+2 (PR-03) —
   *  un seul rappel par facture (clé stable), annulé à la livraison si le dépôt est déclaré.
   *  `quote-relance-reminder` : rappel INTERNE de relance devis J+15/J+30 (PR-05) — dédupliqué
   *  PAR PALIER, annulé à la livraison si le devis a quitté sent/viewed (extinction réelle).
   *  `contract-renewal-reminder` : alerte INTERNE de renouvellement de contrat J-60/J-30
   *  (PR-13) — dédupliquée par (anniversaire calculé, palier) : la fenêtre revit chaque
   *  année ; annulée à la livraison si le contrat est résilié (extinction réelle). JAMAIS un
   *  envoi client.
   *  `contract-annual-invoice-reminder` : rappel INTERNE « facture annuelle à émettre »
   *  (PR-13) — dédupliqué par (contrat, début de période) ; annulé à la livraison si la
   *  période n'est plus due (facture émise entre-temps, contrat résilié). JAMAIS un envoi
   *  client.
   *  `intervention-report` : envoi EMAIL de la FICHE DE PASSAGE archivée (PR-16) — geste
   *  CONFIRMÉ de l'artisan, jamais un effet de bord de la génération ; dédupliqué par VERSION
   *  d'archive (`intervention:{id}:report:{sha256}`) : rejouer le même geste n'envoie pas deux
   *  fois, mais une fiche re-générée après signature est un envoi NOUVEAU et légitime. */
  kind:
    | 'quote-signature'
    | 'quote-relance-reminder'
    | 'invoice-relance'
    | 'invoice-delivery'
    | 'invoice-transmission-reminder'
    | 'contract-renewal-reminder'
    | 'contract-annual-invoice-reminder'
    | 'intervention-report'
    | 'weekly-digest'
    | 'retractation-acknowledgment'
    | 'embargo-scheduled-payment';
  dedupeKey: string;
  channel: Notification['channel'];
  recipient: string;
  subject: string;
  notification: Notification | null;
  /** Empreinte immuable de channel/to/subject/body, hors clé provider. */
  payloadFingerprint: string | null;
  status: NotificationJobStatus;
  attempts: number;
  nextAttemptAt: string;
  /** Fence générationnel du worker courant ; null hors livraison active. */
  leaseToken: string | null;
  /** Horloge autoritaire de la toute première tentative provider ; ne peut jamais glisser. */
  providerAttemptedAt: string | null;
  lastError: string | null;
  /** Lu par l'utilisateur (fil de notifications C25) — null tant que non lu. */
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableNotificationJob extends Omit<NotificationJob, 'notification'> {
  notification: Notification;
}

export interface EnqueueNotificationJobInput {
  id: string;
  companyId: string;
  kind: NotificationJob['kind'];
  dedupeKey: string;
  notification: Notification;
  now: string;
  /**
   * Livraison PLANIFIÉE : première tentative à cet instant, jamais avant (le worker ne réclame
   * que les jobs dus). Absent = livrable immédiatement. Sert l'encaissement programmé à J+7
   * (embargo L221-10) — le job est durable dès l'intention, il part seul à l'échéance.
   */
  notBefore?: string;
}

export function notificationPayloadFingerprint(notification: Notification): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([
      notification.channel,
      notification.to,
      notification.subject,
      notification.body,
    ]))
    .digest('hex')}`;
}

/** Contrat transitoire de release A : les workers V1 ne livrent que leur forme minimale exacte.
 * Un champ moderne serait sinon silencieusement supprimé par le décodeur avant le provider. */
export function sealedLegacyNotificationFromUnknown(
  value: unknown,
  persistedFingerprint: string | null,
  authority?: LegacyNotificationPayloadAuthority,
): Notification | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const hasUnsupportedExtension = Object.keys(candidate).some(
    (field) => !legacyNotificationPayloadFieldSet.has(field),
  );
  if (hasUnsupportedExtension) return null;
  const { channel, to, subject, body, idempotencyKey } = candidate;
  if (
    (channel !== 'email' && channel !== 'sms')
    || typeof to !== 'string'
    || typeof subject !== 'string'
    || typeof body !== 'string'
    || (idempotencyKey !== undefined && typeof idempotencyKey !== 'string')
  ) {
    return null;
  }
  if (
    authority !== undefined
    && (
      channel !== authority.channel
      || to !== authority.recipient
      || subject !== authority.subject
      || (
        channel === 'email'
        && (
          idempotencyKey !== authority.jobId
          || !PROVIDER_UUID_PATTERN.test(authority.jobId)
        )
      )
    )
  ) {
    return null;
  }
  const notification: Notification = {
    channel,
    to,
    subject,
    body,
    ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
  };
  return persistedFingerprint === notificationPayloadFingerprint(notification)
    ? notification
    : null;
}

export function isLegacyNotificationPayloadSealed(
  notification: unknown,
  persistedFingerprint: string | null,
  authority?: LegacyNotificationPayloadAuthority,
): boolean {
  return sealedLegacyNotificationFromUnknown(notification, persistedFingerprint, authority) !== null;
}

/** Le repository possède l'invariant provider : un appel direct au port reçoit la même clé
 * immuable que le service d'outbox. Une clé explicite divergente ou mal typée reste refusée. */
export function normalizeLegacyNotificationForEnqueue(
  notification: Notification,
  authority: LegacyNotificationPayloadAuthority,
): Notification {
  const normalized: Notification =
    notification.channel === 'email' && notification.idempotencyKey === undefined
      ? { ...notification, idempotencyKey: authority.jobId }
      : { ...notification };
  const sealed = sealedLegacyNotificationFromUnknown(
    normalized,
    notificationPayloadFingerprint(normalized),
    authority,
  );
  if (sealed === null) throw new NotificationPayloadContractUnavailableError();
  return sealed;
}

export class NotificationPayloadContractUnavailableError extends Error {
  constructor() {
    super('Le contrat de livraison étendu est temporairement fermé pendant son déploiement sûr.');
    this.name = 'NotificationPayloadContractUnavailableError';
  }
}

export class NotificationDedupeConflictError extends Error {
  constructor(readonly dedupeKey: string) {
    super(`La clé de déduplication notification « ${dedupeKey} » désigne déjà un autre contenu.`);
    this.name = 'NotificationDedupeConflictError';
  }
}

export type NotificationDeliveryClaim =
  | { outcome: 'claimed'; job: DeliverableNotificationJob }
  | { outcome: 'quarantined'; reason: 'provider-window-expired' | 'channel-without-idempotency' }
  | { outcome: 'skipped' };

export interface NotificationUnreadPreview {
  unreadCount: number;
  /** Borne exclusive autoritaire ; PostgreSQL la produit avec la même horloge que createdAt. */
  throughCreatedAt: string;
}

export interface NotificationReadThroughResult {
  updatedCount: number;
  readAt: string;
  /** Faux si le cutoff ne peut pas provenir d'un aperçu antérieur selon l'horloge autoritaire. */
  cutoffAccepted: boolean;
}

export interface NotificationJobRepository {
  /** Une dedupeKey identifie une requête immuable : un ré-enqueue ne remplace jamais son payload. */
  enqueue(input: EnqueueNotificationJobInput): Promise<NotificationJob>;
  /** Lecture exacte et tenant-scoped pour Bob/notifications ; null masque aussi l'autre tenant. */
  findById(companyId: string, id: string): Promise<NotificationJob | null>;
  listDue(companyId: string, now: string, limit: number): Promise<DeliverableNotificationJob[]>;
  /**
   * Lease atomique avant I/O : true pour un seul worker si le job est encore dû.
   * `leaseUntil` rend le job récupérable après crash, sans nouveau statut ni lock long.
   */
  claimForDelivery(
    id: string,
    companyId: string,
    expectedUpdatedAt: string,
    now: string,
    leaseUntil: string,
    leaseToken: string,
  ): Promise<NotificationDeliveryClaim>;
  /**
   * Dernière validation juste avant l'I/O externe. Elle réduit la fenêtre d'un worker suspendu :
   * le token, le lease et la fenêtre provider doivent encore être valides selon l'horloge DB.
   */
  authorizeDeliveryAttempt(
    id: string,
    companyId: string,
    leaseToken: string,
    observedAt: string,
  ): Promise<boolean>;
  /** Transition atomique pending|failed -> done, clôturée uniquement par le détenteur du lease. */
  markDone(id: string, companyId: string, leaseToken: string, at: string): Promise<boolean>;
  /** Un worker dont le lease a expiré ne peut jamais écraser l'état de son successeur. */
  markFailed(
    id: string,
    companyId: string,
    leaseToken: string,
    observedAt: string,
    retryDelayMs: number,
    error: string,
  ): Promise<boolean>;
  /**
   * ANNULATION par intention métier (ex. rétractation du client AVANT l'échéance du job J+7,
   * L221-25 : plus rien n'est dû) : pending|failed -> cancelled, payload PURGÉ (plus jamais
   * livrable), même si un lease est posé (le worker en vol perd alors markDone/markFailed —
   * fenêtre de course provider inhérente, mais l'état final reste `cancelled`). Un job `done`
   * n'est JAMAIS réécrit. true si un job a effectivement été annulé.
   */
  cancelByDedupeKey(
    companyId: string,
    kind: NotificationJob['kind'],
    dedupeKey: string,
    at: string,
  ): Promise<boolean>;
  /**
   * ANNULATION par le DÉTENTEUR du lease, à la revalidation juste avant l'I/O provider (garde
   * par kind du worker : devis rétracté, paiement déjà reçu…) : pending|failed -> cancelled,
   * payload purgé. Même discipline de fence que markDone/markFailed.
   */
  cancelClaimed(id: string, companyId: string, leaseToken: string, at: string): Promise<boolean>;
  // —— Fil de notifications (C25) : le mobile lit ce que les jobs produisent ——
  /** Dernières notifications du tenant (tous statuts), les plus récentes d'abord. */
  listRecent(companyId: string, limit: number): Promise<NotificationJob[]>;
  /**
   * PR-02 — livraisons RÉUSSIES d'un kind : matière de l'état dérivé « pièce transmise »
   * (jamais un statut inventé). Projection minimale : la clé métier + l'instant de la première
   * tentative provider gagnante (providerAttemptedAt, horloge autoritaire ; repli updatedAt).
   */
  listDoneByKind(
    companyId: string,
    kind: NotificationJob['kind'],
  ): Promise<Array<{ dedupeKey: string; deliveredAt: string }>>;
  /**
   * PR-06 — lecture EXACTE par clé métier (dédup AVANT effet de bord) : le cron vérifie si un
   * palier est déjà enfilé AVANT de préparer un lien public (sinon la rotation quotidienne
   * invaliderait le lien déjà livré ET violerait l'immutabilité du payload sous la clé).
   */
  findByDedupeKey(
    companyId: string,
    kind: NotificationJob['kind'],
    dedupeKey: string,
  ): Promise<NotificationJob | null>;
  /** Snapshot temporel non paginé. `observedAt` sert seulement aux adaptateurs sans horloge DB. */
  previewUnread(companyId: string, observedAt: string): Promise<NotificationUnreadPreview>;
  /** Marque lue (idempotent). null si le job n'existe pas dans le tenant courant. */
  markRead(id: string, companyId: string, at: string): Promise<NotificationJob | null>;
  /**
   * Marque atomiquement les notifications non lues du tenant strictement antérieures au cutoff.
   * Les notifications créées après l'aperçu restent non lues ; un rejeu retourne zéro.
   */
  markReadThrough(
    companyId: string,
    throughCreatedAt: string,
    observedAt: string,
  ): Promise<NotificationReadThroughResult>;
}

import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { assertTransition } from '../billing/shared/state-machines';

/**
 * Bloc C « Le métier » (C3, exigences 5-6) — machine à états de la fiche de passage (§3.3) :
 *
 *   scheduled ──démarrer(startedAt)──▶ in_progress ──terminer(finishedAt, checklist figée)──▶ completed
 *       │                                   │                                                    │
 *       └────────────── annuler ──▶ cancelled ◀── annuler ─┘                     └──signer──▶ signed (verrouillée)
 *
 * `completed` est un terminal LÉGITIME (client absent — mention honnête sur le PDF) ;
 * l'annulation est impossible après `completed`. SOURCE du CHECK SQL
 * `interventions_status_check` (généré depuis cette union, leçon 25/07).
 */
export type InterventionStatus = 'scheduled' | 'in_progress' | 'completed' | 'signed' | 'cancelled';

export const INTERVENTION_TRANSITIONS: Record<InterventionStatus, readonly InterventionStatus[]> = {
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['signed'],
  signed: [],
  cancelled: [],
};

/** Phase d'une photo de passage (avant/après) — SOURCE du CHECK SQL `chantier_photos_phase_check`. */
export type InterventionPhotoPhase = 'before' | 'after';
export const INTERVENTION_PHOTO_PHASES: readonly InterventionPhotoPhase[] = ['before', 'after'];

/**
 * §3.4 — item de checklist LIBRE (template JSON par société, aucun moteur par métier) :
 * pré-rempli par le template du `kind`, reste modifiable jusqu'à `completed` (figé ensuite).
 */
export interface ChecklistItem {
  label: string;
  done: boolean;
  note?: string;
}

/**
 * §3.4 — preuve de signature de la fiche, convention UNIQUE des deux documents (P12 clos) :
 *  • `sha256` est calculé CÔTÉ SERVEUR sur les octets du tracé RÉELLEMENT reçus — le client
 *    ne fournit jamais le hash (doctrine sign-quote, P0 R4) ;
 *  • `capturedAt` = horodatage SERVEUR de réception (en ligne : réception immédiate ;
 *    hors-ligne : réception au rejeu) ;
 *  • `capturedAtDevice` = heure du GESTE déclarée par l'appareil — jamais confondue avec la
 *    réception ; le PDF les affiche toutes deux honnêtement ;
 *  • `syncedAt` = trace de synchronisation d'une capture hors-ligne (absent en ligne).
 * Valeur probante : « signature simple » eIDAS, dite telle quelle (LegalHint).
 */
export interface InterventionSignature {
  signerName: string;
  method: 'onsite_draw';
  sha256: string;
  capturedAt: Instant;
  capturedAtDevice?: Instant;
  syncedAt?: Instant;
}

export interface InterventionProps {
  /** Généré CÔTÉ CLIENT (offline-first §3.6) — uuid v4 STRICTEMENT validé par le serveur. */
  id: string;
  companyId: string;
  /** Le SITE (Chantier générique) — FK composite en persistance. */
  chantierId: string;
  customerId: string;
  /**
   * [Direction 6] SEUL discriminant d'une visite contractuelle — `kind` est purement
   * descriptif. TOUJOURS null dans ce train : le lien vers `maintenance_contracts` (FK
   * composite + PlanContractVisits) appartient au raccord des trains Contrats/Planning ;
   * CreateIntervention ne l'accepte jamais (aucun lien non vérifié).
   */
  contractId: string | null;
  /** Équipement du site visé (parc PR-11) — null = passage du site sans équipement ciblé. */
  equipmentId: string | null;
  /** Libellé LIBRE (« Visite contractuelle », « Dépannage fontaine ») — JAMAIS une machine. */
  kind: string;
  status: InterventionStatus;
  /** Planning minimal (exigence 6) — la replanification tracée vit en PR-18. */
  plannedAt: Instant | null;
  /** Duo père/fils sur UN compte en bêta : texte libre (« Papa », « Fils »), jamais un user. */
  technicianLabel: string | null;
  startedAt: Instant | null;
  finishedAt: Instant | null;
  checklist: ChecklistItem[];
  summary: string | null;
  signature: InterventionSignature | null;
  /** StoredDocument kind `intervention_report` ARCHIVÉ (PR-16) — latch, jamais re-rendu. */
  reportDocumentId: string | null;
  /** Facture (brouillon) créée par « Facturer ce passage » — détachée si le brouillon meurt. */
  billedInvoiceId: string | null;
  /** Révision optimiste (CAS) — chaînée par l'outbox offline (amélioration 7). */
  revision: number;
}

const MAX_KIND_LENGTH = 200;
const MAX_TECHNICIAN_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_CHECKLIST_ITEMS = 50;
const MAX_CHECKLIST_LABEL_LENGTH = 200;
const MAX_CHECKLIST_NOTE_LENGTH = 500;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Champ MONO-LIGNE : tous les caractères de contrôle Unicode interdits (miroir SQL cntrl). */
function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

/** Texte LIBRE de terrain (résumé, note d'item) : \n et \t admis, le reste refusé. */
function hasForbiddenFieldTextCharacter(value: string): boolean {
  return /(?![\n\t])\p{Cc}/u.test(value);
}

function isInstant(value: unknown): value is Instant {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function canonicalSingleLine(
  field: string,
  value: string | null,
  maxLength: number,
): DomainResult<string | null> {
  if (value === null) return ok(null);
  const trimmed = value.trim();
  if (trimmed.length === 0) return ok(null);
  if (trimmed.length > maxLength)
    return err({ code: 'VALIDATION', field, message: `Champ limité à ${maxLength} caractères.` });
  if (hasControlCharacter(trimmed))
    return err({ code: 'VALIDATION', field, message: 'Caractères de contrôle interdits.' });
  return ok(trimmed);
}

function validateChecklist(checklist: ChecklistItem[]): DomainResult<ChecklistItem[]> {
  if (!Array.isArray(checklist))
    return err({ code: 'VALIDATION', field: 'checklist', message: 'Checklist invalide.' });
  if (checklist.length > MAX_CHECKLIST_ITEMS)
    return err({
      code: 'VALIDATION',
      field: 'checklist',
      message: `Checklist limitée à ${MAX_CHECKLIST_ITEMS} items.`,
    });
  const canonical: ChecklistItem[] = [];
  for (const item of checklist) {
    if (typeof item !== 'object' || item === null || typeof item.label !== 'string' || typeof item.done !== 'boolean')
      return err({ code: 'VALIDATION', field: 'checklist', message: 'Item de checklist invalide.' });
    const label = item.label.trim();
    if (label.length === 0 || label.length > MAX_CHECKLIST_LABEL_LENGTH || hasControlCharacter(label))
      return err({
        code: 'VALIDATION',
        field: 'checklist',
        message: `Libellé d'item requis (${MAX_CHECKLIST_LABEL_LENGTH} caractères maximum, sans contrôle).`,
      });
    if (item.note !== undefined) {
      if (
        typeof item.note !== 'string' ||
        item.note.trim().length === 0 ||
        item.note.length > MAX_CHECKLIST_NOTE_LENGTH ||
        hasForbiddenFieldTextCharacter(item.note)
      )
        return err({
          code: 'VALIDATION',
          field: 'checklist',
          message: `Note d'item invalide (${MAX_CHECKLIST_NOTE_LENGTH} caractères maximum).`,
        });
    }
    canonical.push({
      label,
      done: item.done,
      ...(item.note !== undefined ? { note: item.note.trim() } : {}),
    });
  }
  return ok(canonical);
}

function validateSignature(signature: InterventionSignature): DomainResult<InterventionSignature> {
  const signerName = signature.signerName.trim().replace(/\s+/g, ' ');
  if (signerName.length < 2 || signerName.length > 120 || hasControlCharacter(signerName))
    return err({ code: 'VALIDATION', field: 'signerName', message: 'Nom du signataire invalide.' });
  if (signature.method !== 'onsite_draw')
    return err({ code: 'VALIDATION', field: 'signature', message: 'Méthode de signature invalide.' });
  if (!SHA256_HEX.test(signature.sha256))
    return err({
      code: 'VALIDATION',
      field: 'signature',
      message: 'Empreinte de tracé invalide (sha256 hexadécimal attendu).',
    });
  if (!isInstant(signature.capturedAt))
    return err({ code: 'VALIDATION', field: 'signature', message: 'Horodatage de signature invalide.' });
  if (signature.capturedAtDevice !== undefined && !isInstant(signature.capturedAtDevice))
    return err({ code: 'VALIDATION', field: 'signature', message: 'Horodatage appareil invalide.' });
  if (signature.syncedAt !== undefined && !isInstant(signature.syncedAt))
    return err({ code: 'VALIDATION', field: 'signature', message: 'Horodatage de synchronisation invalide.' });
  return ok({
    signerName,
    method: 'onsite_draw',
    sha256: signature.sha256,
    capturedAt: signature.capturedAt,
    ...(signature.capturedAtDevice !== undefined ? { capturedAtDevice: signature.capturedAtDevice } : {}),
    ...(signature.syncedAt !== undefined ? { syncedAt: signature.syncedAt } : {}),
  });
}

/** Champs modifiables AVANT la complétion (checklist figée à `completed`, §3.4). */
export interface InterventionPatch {
  kind?: string;
  technicianLabel?: string | null;
  equipmentId?: string | null;
  checklist?: ChecklistItem[];
  summary?: string | null;
}

/** Message UNIQUE du verrou post-signature (écran ET voix — jamais reformulé). */
export const INTERVENTION_SIGNED_LOCKED_MESSAGE =
  'Fiche signée — verrouillée : plus aucune modification (doctrine de la preuve, comme un devis signé).';

/** Message UNIQUE du refus de trace sur une fiche ANNULÉE (le passage n'a pas eu lieu). */
export const INTERVENTION_CANCELLED_NO_TRACE_MESSAGE =
  'Fiche annulée : plus aucune trace ne s’y ajoute — reprends sur la fiche du passage réel.';

/**
 * [Revue adversariale 28/07 — finding 9b] Message UNIQUE du refus de trace de terrain, DÉRIVÉ
 * de l'état réel : signée → verrou de preuve, annulée → passage sans objet. Tous les chemins
 * médias (note, photo, retrait + note de résolution) appellent CE message : deux chemins ne
 * peuvent plus donner deux règles ni deux explications pour la même trace.
 */
export function interventionFieldTraceRefusal(status: InterventionStatus): string {
  return status === 'cancelled'
    ? INTERVENTION_CANCELLED_NO_TRACE_MESSAGE
    : INTERVENTION_SIGNED_LOCKED_MESSAGE;
}

/**
 * [Revue adversariale 28/07 — finding 6] Message UNIQUE du refus de PHASE incohérente avec la
 * machine à états, DÉRIVÉ de l'état réel comme `interventionFieldTraceRefusal`. La phase n'est
 * pas une étiquette libre : c'est une AFFIRMATION datée sur une pièce de preuve (« voici l'état
 * AVANT mon travail »). Le refus dit toujours le chemin qui ne perd rien — la photo reste
 * joignable à la fiche SANS phase.
 *
 * TOTALE par construction : sur une fiche signée ou annulée, c'est le VERROU DE PREUVE qui
 * parle — une seule règle, un seul message, jamais un second vocabulaire pour la même chose.
 */
export function interventionPhotoPhaseRefusal(
  phase: InterventionPhotoPhase,
  status: InterventionStatus,
): string {
  if (status === 'signed' || status === 'cancelled') return interventionFieldTraceRefusal(status);
  return phase === 'before'
    ? 'Le passage est déjà terminé : une photo « avant » ne s’ajoute plus après coup — elle montrerait un état que le travail a effacé. Joins-la sans phase, ou en « après ».'
    : 'Le passage n’a pas encore démarré : une photo « après » n’aurait rien à montrer. Démarre le passage, puis prends-la — ou joins-la sans phase.';
}

/**
 * Agrégat Intervention — fiche de passage générique tous métiers (§3.1) : site + client +
 * type libre + checklist LIBRE + photos avant/après + signature + PDF au titre paramétrable.
 * Zéro framework, zéro I/O : les gardes cross-agrégat (site ouvert, équipement du même site,
 * médias) vivent dans les use cases ; la persistance re-vérifie (CHECK/RLS/triggers).
 */
export class Intervention {
  private constructor(private readonly p: InterventionProps) {}

  static record(props: InterventionProps): DomainResult<Intervention> {
    const chantierId = props.chantierId.trim();
    if (!chantierId)
      return err({ code: 'VALIDATION', field: 'chantierId', message: 'Site du passage requis.' });
    const customerId = props.customerId.trim();
    if (!customerId)
      return err({ code: 'VALIDATION', field: 'customerId', message: 'Client du passage requis.' });

    const kindRaw = props.kind.trim();
    if (!kindRaw)
      return err({ code: 'VALIDATION', field: 'kind', message: 'Type de passage requis (libellé libre).' });
    const kind = canonicalSingleLine('kind', kindRaw, MAX_KIND_LENGTH);
    if (!kind.ok) return kind;

    const technicianLabel = canonicalSingleLine(
      'technicianLabel',
      props.technicianLabel,
      MAX_TECHNICIAN_LENGTH,
    );
    if (!technicianLabel.ok) return technicianLabel;

    let summary: string | null = null;
    if (props.summary !== null) {
      const trimmed = props.summary.trim();
      if (trimmed.length > 0) {
        if (trimmed.length > MAX_SUMMARY_LENGTH)
          return err({
            code: 'VALIDATION',
            field: 'summary',
            message: `Résumé limité à ${MAX_SUMMARY_LENGTH} caractères.`,
          });
        if (hasForbiddenFieldTextCharacter(trimmed))
          return err({ code: 'VALIDATION', field: 'summary', message: 'Caractères de contrôle interdits.' });
        summary = trimmed;
      }
    }

    const checklist = validateChecklist(props.checklist);
    if (!checklist.ok) return checklist;

    if (props.plannedAt !== null && !isInstant(props.plannedAt))
      return err({ code: 'VALIDATION', field: 'plannedAt', message: 'Date de planification invalide.' });
    if (props.startedAt !== null && !isInstant(props.startedAt))
      return err({ code: 'VALIDATION', field: 'startedAt', message: 'Horodatage de démarrage invalide.' });
    if (props.finishedAt !== null && !isInstant(props.finishedAt))
      return err({ code: 'VALIDATION', field: 'finishedAt', message: 'Horodatage de fin invalide.' });

    // §3.4 — un passage ne finit jamais avant d'avoir commencé (miroir CHECK SQL).
    if (props.startedAt !== null && props.finishedAt !== null && props.finishedAt < props.startedAt)
      return err({
        code: 'VALIDATION',
        field: 'finishedAt',
        message: 'La fin du passage ne peut pas précéder son démarrage.',
      });

    // Cohérence statut ↔ faits (miroir des CHECK SQL) : jamais un demi-état.
    if (
      (props.status === 'in_progress' || props.status === 'completed' || props.status === 'signed') &&
      props.startedAt === null
    )
      return err({ code: 'VALIDATION', field: 'startedAt', message: 'Statut et démarrage incohérents.' });
    if ((props.status === 'completed' || props.status === 'signed') && props.finishedAt === null)
      return err({ code: 'VALIDATION', field: 'finishedAt', message: 'Statut et fin incohérents.' });

    // Cohérence TRIPLE signature (même doctrine que retiredAt, revue P11) : signé ⟺ preuve.
    if ((props.status === 'signed') !== (props.signature !== null))
      return err({
        code: 'VALIDATION',
        field: 'signature',
        message: 'Statut et preuve de signature incohérents.',
      });

    let signature: InterventionSignature | null = null;
    if (props.signature !== null) {
      const validated = validateSignature(props.signature);
      if (!validated.ok) return validated;
      signature = validated.value;
    }

    return ok(
      new Intervention({
        ...props,
        chantierId,
        customerId,
        contractId: props.contractId?.trim() || null,
        equipmentId: props.equipmentId?.trim() || null,
        kind: kind.value as string,
        technicianLabel: technicianLabel.value,
        summary,
        checklist: checklist.value,
        signature,
        reportDocumentId: props.reportDocumentId?.trim() || null,
        billedInvoiceId: props.billedInvoiceId?.trim() || null,
      }),
    );
  }

  /** Réhydratation depuis le stockage (données déjà validées par record + CHECK SQL). */
  static rehydrate(props: InterventionProps): Intervention {
    return new Intervention({ ...props });
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get chantierId(): string {
    return this.p.chantierId;
  }
  get customerId(): string {
    return this.p.customerId;
  }
  get contractId(): string | null {
    return this.p.contractId;
  }
  get equipmentId(): string | null {
    return this.p.equipmentId;
  }
  get kind(): string {
    return this.p.kind;
  }
  get status(): InterventionStatus {
    return this.p.status;
  }
  get plannedAt(): Instant | null {
    return this.p.plannedAt;
  }
  get startedAt(): Instant | null {
    return this.p.startedAt;
  }
  get finishedAt(): Instant | null {
    return this.p.finishedAt;
  }
  get checklist(): ChecklistItem[] {
    return this.p.checklist.map((item) => ({ ...item }));
  }
  get summary(): string | null {
    return this.p.summary;
  }
  get signature(): InterventionSignature | null {
    return this.p.signature === null ? null : { ...this.p.signature };
  }
  get reportDocumentId(): string | null {
    return this.p.reportDocumentId;
  }
  get billedInvoiceId(): string | null {
    return this.p.billedInvoiceId;
  }
  get technicianLabel(): string | null {
    return this.p.technicianLabel;
  }
  get revision(): number {
    return this.p.revision;
  }

  /**
   * §3.4 — la fiche accepte-t-elle encore des traces de terrain (photos taguées, notes,
   * retrait de photo — séquence erratum 6 comprise) ? OUI jusqu'à `signed` exclu ; une fiche
   * annulée n'accumule plus rien non plus. Les use cases médias appellent CE prédicat.
   */
  acceptsFieldTraces(): boolean {
    return this.p.status !== 'signed' && this.p.status !== 'cancelled';
  }

  /**
   * [finding 6] §3.3 — la phase avant/après est DATÉE par la machine à états, jamais déclarative :
   *  • « avant » n'a de sens que TANT QUE le passage n'est pas terminé (après, l'état initial
   *    n'existe plus : la photo affirmerait ce qu'elle ne peut plus montrer) ;
   *  • « après » n'a de sens qu'une fois le passage DÉMARRÉ (avant, il n'y a pas de travail à
   *    montrer) — et reste légitime sur une fiche `completed` : la séquence terrain §3.6
   *    (photos, puis complete, puis sign) n'est jamais punie, dans un sens comme dans l'autre.
   * Le verrou de preuve (`signed`) et la fiche annulée sont déjà tenus par `acceptsFieldTraces`.
   */
  acceptsPhotoPhase(phase: InterventionPhotoPhase): boolean {
    if (!this.acceptsFieldTraces()) return false;
    return phase === 'before' ? this.p.status !== 'completed' : this.p.status !== 'scheduled';
  }

  /** Démarrer le passage — `at` = heure RÉELLE du geste (appareil au rejeu, serveur en ligne). */
  start(at: Instant): DomainResult<void> {
    const t = assertTransition(INTERVENTION_TRANSITIONS, this.p.status, 'in_progress');
    if (!t.ok) return t;
    if (!isInstant(at))
      return err({ code: 'VALIDATION', field: 'startedAt', message: 'Horodatage de démarrage invalide.' });
    this.p.status = 'in_progress';
    this.p.startedAt = at;
    this.p.revision += 1;
    return ok(undefined);
  }

  /**
   * Terminer le passage — la checklist fournie est FIGÉE (§3.4 : plus modifiable après
   * `completed`), le résumé peut être posé dans le même geste (« confirmation groupée »).
   */
  complete(
    at: Instant,
    closing?: { checklist?: ChecklistItem[]; summary?: string | null },
  ): DomainResult<void> {
    const t = assertTransition(INTERVENTION_TRANSITIONS, this.p.status, 'completed');
    if (!t.ok) return t;
    if (!isInstant(at))
      return err({ code: 'VALIDATION', field: 'finishedAt', message: 'Horodatage de fin invalide.' });
    const candidate: InterventionProps = {
      ...this.p,
      status: 'completed',
      finishedAt: at,
      ...(closing?.checklist !== undefined ? { checklist: closing.checklist } : {}),
      ...(closing?.summary !== undefined ? { summary: closing.summary } : {}),
    };
    const validated = Intervention.record(candidate);
    if (!validated.ok) return validated;
    Object.assign(this.p, validated.value.toProps(), { revision: this.p.revision + 1 });
    return ok(undefined);
  }

  /**
   * Signer la fiche — possible UNIQUEMENT depuis `completed` (§3.4) ; après quoi TOUT est
   * immuable (checklist, photos liées, horodatages, résumé — refus agrégat + refus médias).
   */
  sign(signature: InterventionSignature): DomainResult<void> {
    const t = assertTransition(INTERVENTION_TRANSITIONS, this.p.status, 'signed');
    if (!t.ok) return t;
    const validated = validateSignature(signature);
    if (!validated.ok) return validated;
    this.p.status = 'signed';
    this.p.signature = validated.value;
    this.p.revision += 1;
    return ok(undefined);
  }

  /** Annuler — impossible après `completed` (le passage a eu lieu : il se facture ou s'archive). */
  cancel(): DomainResult<void> {
    const t = assertTransition(INTERVENTION_TRANSITIONS, this.p.status, 'cancelled');
    if (!t.ok) return t;
    this.p.status = 'cancelled';
    this.p.revision += 1;
    return ok(undefined);
  }

  /**
   * Édition de terrain (checklist, résumé, type, technicien, équipement) — UNIQUEMENT avant
   * la complétion : la checklist est figée à `completed`, tout est verrouillé à `signed`.
   */
  update(patch: InterventionPatch): DomainResult<void> {
    if (this.p.status === 'signed')
      return err({ code: 'VALIDATION', field: 'status', message: INTERVENTION_SIGNED_LOCKED_MESSAGE });
    if (this.p.status !== 'scheduled' && this.p.status !== 'in_progress')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message:
          this.p.status === 'completed'
            ? 'Passage terminé : la checklist et le résumé sont figés (fais signer ou envoie la fiche).'
            : 'Fiche annulée : plus aucune modification.',
      });
    const allowed = new Set(['kind', 'technicianLabel', 'equipmentId', 'checklist', 'summary']);
    const keys = Object.keys(patch);
    if (keys.length === 0 || keys.some((key) => !allowed.has(key)))
      return err({ code: 'VALIDATION', field: 'patch', message: 'Modification de fiche invalide.' });
    const candidate: InterventionProps = {
      ...this.p,
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.technicianLabel !== undefined ? { technicianLabel: patch.technicianLabel } : {}),
      ...(patch.equipmentId !== undefined ? { equipmentId: patch.equipmentId } : {}),
      ...(patch.checklist !== undefined ? { checklist: patch.checklist } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    };
    const validated = Intervention.record(candidate);
    if (!validated.ok) return validated;
    Object.assign(this.p, validated.value.toProps(), { revision: this.p.revision + 1 });
    return ok(undefined);
  }

  /** PR-16 — latch d'archive : pose la référence du PDF ARCHIVÉ (fait système, jamais figé). */
  attachReportDocument(documentId: string): DomainResult<void> {
    if (this.p.status !== 'completed' && this.p.status !== 'signed')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message: 'La fiche de passage ne se génère qu’une fois le passage terminé.',
      });
    const trimmed = documentId.trim();
    if (!trimmed)
      return err({ code: 'VALIDATION', field: 'reportDocumentId', message: 'Document requis.' });
    this.p.reportDocumentId = trimmed;
    this.p.revision += 1;
    return ok(undefined);
  }

  /** PR-16 — CTA « Facturer ce passage » : lie le brouillon créé (fait système, détachable). */
  attachBilledInvoice(invoiceId: string): DomainResult<void> {
    if (this.p.status !== 'completed' && this.p.status !== 'signed')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message: 'Un passage se facture une fois terminé.',
      });
    const trimmed = invoiceId.trim();
    if (!trimmed)
      return err({ code: 'VALIDATION', field: 'billedInvoiceId', message: 'Facture requise.' });
    this.p.billedInvoiceId = trimmed;
    this.p.revision += 1;
    return ok(undefined);
  }

  /** Suppression du brouillon lié (DeleteDraftInvoice étendu §3.5) — le lien est détaché. */
  detachBilledInvoice(): void {
    if (this.p.billedInvoiceId === null) return;
    this.p.billedInvoiceId = null;
    this.p.revision += 1;
  }

  toProps(): InterventionProps {
    return {
      ...this.p,
      checklist: this.p.checklist.map((item) => ({ ...item })),
      signature: this.p.signature === null ? null : { ...this.p.signature },
    };
  }
}

/**
 * Jarvis U1-c — worker de dispatch des work items (spec Jarvis §5.3,
 * SPEC_U1C_ADMISSION_DISPATCH_20260818 §3).
 *
 * Calque STRUCTUREL de `notification-delivery.service.ts` : @Cron, boucle par tenant via
 * `ScheduledTenantDirectory`, collaborateurs injectés par tokens, aucune transaction longue —
 * chaque étape est un CAS court du repository (`jarvis-work-items.persistence.ts`), conditionné
 * par le couple (leaseToken, leaseFence).
 *
 * Pipeline par work item : claim → revalidation (2ᵉ transaction, LISTE FERMÉE SPEC_U1C §3) →
 * authorize (point de non-retour) → exécution via le registre statique `JarvisEffectExecutor`
 * (`actionId@version`) → résultat immuable (`storeResult`) → signal au run par la voie canonique
 * (`runJarvisSystemAdmission`, commande `record_effect_receipt`, `commandId` DÉTERMINISTE
 * `deriveJarvisSystemCommandId`) → `markSignalApplied`. Les résultats dont le signal n'est pas
 * appliqué sont redélivrés au DÉBUT de chaque tick (`listPendingSignals`, level-triggered),
 * puis les lignes `authorized` à lease expirée (worker mort après le point de non-retour) sont
 * reprises (`reclaimExpiredAuthorized`) et réglées par la réconciliation — ces deux étapes ne
 * sont JAMAIS coupées par le kill switch, qui ne gate que les nouveaux claims (§5.3).
 *
 * Fail-closed U1-c documenté : AUCUNE action du catalogue n'a d'exécuteur réel — le registre
 * statique est VIDE. Un nouvel item sans exécuteur est annulé sous fence AVANT `authorize`
 * (aucune I/O possible). Une reprise déjà `authorized` sans arbitre reste au contraire
 * `outcome_unknown`, durablement non signalée : l'ancienne image a pu appeler un provider.
 * `NotificationJobEffectExecutor` (greffe : l'UNIQUE
 * exécuteur prévu, au-dessus de l'outbox canonique `notification_jobs`) est livré prêt mais
 * NON enregistré ; U1-d le branche action par action.
 *
 * RÉCONCILIATION CÂBLÉE (U1-d, revue C9) : dès qu'un exécuteur RÉEL est enregistré, une reprise
 * `authorized` n'est plus laissée en suspens — le worker lui demande de LIRE son effet par
 * `effectId` (`reconcileEffect`) et route le verdict : reçu trouvé ⇒ résultat persisté et
 * signalé ; absence prouvée ou action idempotente ⇒ rejeu du MÊME effectId ; indécidable ⇒
 * `outcome_unknown` motivé et quarantiné sans reçu terminal. Sans cette lecture, une ligne
 * `authorized` voyait sa lease
 * renouvelée à chaque tick, indéfiniment : un run bloqué à vie par un worker mort.
 *
 * Horloge : les échéances (`executeBy`) sont jugées contre l'horloge BASE (`readAt` de la
 * lecture stateless RepeatableRead), jamais contre l'horloge ambiante du worker.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  CLOSED_JARVIS_ACTION_RELEASE_POLICY,
  SystemClock,
  deriveJarvisSystemCommandId,
  evaluateJarvisActionPublication,
  parseJarvisAuthorizationSource,
  resolveJarvisDefinition,
  sha256Hex,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisActionReleasePolicy,
  type JarvisRunEnvelope,
  type JarvisSystemAdmissionEnvelope,
  type Notification,
} from '@bob/core';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { JARVIS_ACTION_RELEASE_POLICY } from '../jarvis/jarvis.tokens';
import type { NotificationJob } from '../persistence/notification-jobs';
import type {
  JarvisWorkItemCoordinates,
  JarvisWorkItemLease,
  JarvisWorkItemPendingSignal,
  JarvisWorkItemResultStatus,
  JarvisWorkItemStatus,
  JarvisWorkItemsDispatchRepository,
} from '../persistence/prisma/jarvis-work-items.persistence';
import { AppLogger } from '../observability/logger';
import {
  JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE,
  JARVIS_DISPATCH_DIRECTORY_RUNTIME_PAGE_SIZE,
  type JarvisDispatchDirectoryClaimedCoordinate,
  type JarvisDispatchRunDirectoryPort,
} from './jarvis-dispatch-directory';
import { ScheduledTenantDirectory } from './tenant-directory';

// ---------------------------------------------------------------------------
// Kill switch dispatch (SPEC_U1C §3 — distinct du kill switch d'admission)
// ---------------------------------------------------------------------------

/**
 * Kill switch OPÉRATIONNEL du worker : `BOB_JARVIS_DISPATCH_ENABLED=false` arrête tout
 * NOUVEAU claim (et toute autorisation) au tick suivant. Lu à chaque tick — jamais figé au
 * boot. Un switch coupé n'ANNULE aucun work item : les lignes restent dues et repartent à
 * la réactivation. Il ne coupe JAMAIS la redelivery des signaux ni la réconciliation des
 * effets déjà autorisés (§5.3, revue C11) — aucun kill switch n'est opposé à l'observation
 * d'un effet parti.
 */
export function jarvisDispatchEnabled(): boolean {
  return process.env.BOB_JARVIS_DISPATCH_ENABLED === 'true';
}

// ---------------------------------------------------------------------------
// Tokens d'injection (les implémentations PostgreSQL réelles arrivent avec les
// callers U1-d — annuaire SECURITY DEFINER + liaison du UoW unique + deps HMAC)
// ---------------------------------------------------------------------------

/** `JarvisWorkItemsDispatchRepository` (jarvis-work-items.persistence.ts). */
export const JARVIS_WORK_ITEMS_DISPATCH = Symbol('JARVIS_WORK_ITEMS_DISPATCH');
/** `JarvisDispatchRunDirectoryPort` — annuaire serveur v2 des coordonnées à traiter. */
export const JARVIS_DISPATCH_RUN_DIRECTORY = Symbol('JARVIS_DISPATCH_RUN_DIRECTORY');
/** `JarvisAdmissionUnitOfWorkPort` (port core) — adapter liant le UoW unique et ses deps HMAC. */
export const JARVIS_DISPATCH_ADMISSION = Symbol('JARVIS_DISPATCH_ADMISSION');
/** Override de registre d'exécuteurs (tests/U1-d) — défaut : registre statique (VIDE en U1-c). */
export const JARVIS_EFFECT_EXECUTORS = Symbol('JARVIS_EFFECT_EXECUTORS');
// ---------------------------------------------------------------------------
// Registre statique des exécuteurs d'effets (greffe SPEC_U1C §3)
// ---------------------------------------------------------------------------

export interface JarvisEffectExecutionInput {
  readonly coordinates: JarvisWorkItemCoordinates;
  readonly lease: JarvisWorkItemLease;
}

/**
 * Question posée à l'exécuteur pour DÉCRIRE un effet déjà réussi (U1-f). Volontairement plus
 * pauvre qu'une exécution : au moment du signal, le worker ne DÉTIENT AUCUNE LEASE — la
 * description doit être reconstructible depuis les seules coordonnées, l'`effectId` de la ligne
 * et l'état réel en base. C'est ce qui rend la redelivery level-triggered possible après un
 * redémarrage, sans mémoire d'aucune sorte.
 */
export interface JarvisSucceededEffectQuery {
  readonly coordinates: JarvisWorkItemCoordinates;
  readonly effectId: string;
}

/**
 * Issue d'exécution — mêmes statuts que le résultat persistable du repository. Un exécuteur qui
 * LÈVE après `authorized` est réglé `outcome_unknown` par le worker : l'issue externe est
 * indécidable, jamais rejouée aveuglément (§5.3).
 */
export interface JarvisEffectExecutionOutcome {
  readonly status: JarvisWorkItemResultStatus;
  readonly resultDigest: string;
}

/**
 * Verdict de RÉCONCILIATION d'un effet déjà autorisé dont le résultat n'a jamais été persisté
 * (worker mort entre `authorized` et `storeResult`). L'exécuteur est la SEULE autorité capable
 * de le rendre : lui seul connaît le namespace d'idempotence de son action (§5.3, §9.1).
 *  · `landed` — l'autorité métier montre le reçu : l'issue est DÉCIDÉE, on la persiste ;
 *  · `not_landed` — l'autorité PROUVE l'absence d'effet : rien n'est parti ;
 *  · `safe_to_replay` — l'action est idempotente par construction : rejouer ne peut pas doubler ;
 *  · `undecidable` — l'autorité ne répond pas : aucune issue ne peut être inventée.
 */
export type JarvisEffectReconciliation =
  | { readonly kind: 'landed'; readonly outcome: JarvisEffectExecutionOutcome }
  | { readonly kind: 'not_landed' }
  | { readonly kind: 'safe_to_replay' }
  | { readonly kind: 'undecidable' };

/**
 * Exécuteur d'effet enregistré par `actionId@version`. L'exécution soumet UNE commande
 * idempotente à une outbox métier canonique puis l'observe — jamais une seconde outbox (§5.3).
 * `recalculateTargetDigest` sert la revalidation ciblée (axe `targetDigest` de la liste fermée).
 *
 * `reconcileEffect` est la LECTURE par `effectId` exigée avant tout rejeu (§5.3 : « il réconcilie
 * d'abord l'autorité métier/provider avec le même effectId »). Elle est optionnelle par
 * compatibilité de l'interface, jamais par tolérance : un exécuteur qui ne l'expose pas laisse
 * ses reprises `authorized` sans arbitre, et le worker refuse alors de clore quoi que ce soit.
 */
export interface JarvisEffectExecutor {
  execute(input: JarvisEffectExecutionInput): Promise<JarvisEffectExecutionOutcome>;
  recalculateTargetDigest?(input: JarvisEffectExecutionInput): Promise<string | null>;
  reconcileEffect?(input: JarvisEffectExecutionInput): Promise<JarvisEffectReconciliation>;
  /**
   * U1-f — DÉCRIT L'EFFET RÉUSSI pour que le run puisse être refermé sur la VÉRITÉ écrite.
   *
   * Certaines définitions exigent un reçu de succès RICHE : `customer_contact` veut l'identité et
   * la révision de la fiche réellement écrite (§5.3), qu'un `resultDigest` opaque ne porte pas.
   * Le worker ne peut pas les inventer — seul l'exécuteur connaît sa cible et son autorité.
   *
   * Reste RECONSTRUCTIBLE depuis la ligne persistée (condition de la redelivery level-triggered) :
   * l'implémentation dérive sa cible du run et de l'`effectId`, puis RELIT l'état réel. Rendre
   * `null` laisse le signal inconstructible, donc le work item DÛ — jamais un reçu inventé.
   */
  describeSucceededEffect?(input: JarvisSucceededEffectQuery): Promise<unknown | null>;
}

export function jarvisEffectExecutorKey(actionId: string, actionVersion: number): string {
  return `${actionId}@${actionVersion}`;
}

export interface JarvisEffectExecutorDeps {
  readonly persistence: Persistence;
  readonly now: () => string;
}

type JarvisEffectExecutorFactory = (deps: JarvisEffectExecutorDeps) => JarvisEffectExecutor;

/**
 * Registre STATIQUE U1-c : VIDE, volontairement. Aucune action du catalogue n'a d'exécuteur
 * réel dans cette tranche — un nouvel item est annulé no-effect avant `authorize`, tandis
 * qu'une reprise historiquement autorisée reste indécidable. U1-d enregistre ici, action par action,
 * des `NotificationJobEffectExecutor` paramétrés — jamais un exécuteur générique fourre-tout.
 */
const JARVIS_EFFECT_EXECUTOR_FACTORIES_V1: ReadonlyMap<string, JarvisEffectExecutorFactory> =
  new Map();

export function buildJarvisEffectExecutorRegistry(
  deps: JarvisEffectExecutorDeps,
): ReadonlyMap<string, JarvisEffectExecutor> {
  const registry = new Map<string, JarvisEffectExecutor>();
  for (const [key, factory] of JARVIS_EFFECT_EXECUTOR_FACTORIES_V1) {
    registry.set(key, factory(deps));
  }
  return registry;
}

// ---------------------------------------------------------------------------
// NotificationJobEffectExecutor — l'UNIQUE exécuteur prévu par U1-c (greffe)
// ---------------------------------------------------------------------------

/** dedupeKey outbox d'un effet Jarvis : même effectId ⇒ même job `notification_jobs`, toujours. */
export function jarvisNotificationEffectDedupeKey(effectId: string): string {
  return `jarvis:${effectId}:v1`;
}

export interface NotificationJobEffectTranslation {
  readonly kind: NotificationJob['kind'];
  readonly notification: Notification;
  readonly notBefore?: string;
}

/**
 * Exécuteur au-dessus de l'outbox CANONIQUE `notification_jobs` : il enfile une entrée déduplo-
 * quée `jarvis:{effectId}:v1` — la vérité externe (livraison, retries, quarantaine) reste dans
 * l'outbox et son worker existant, jamais dupliquée ici. La traduction work item → notification
 * est fournie PAR ACTION à l'enregistrement (U1-d) : une traduction impossible est un échec
 * terminal AVANT toute écriture, jamais un envoi deviné.
 */
export class NotificationJobEffectExecutor implements JarvisEffectExecutor {
  constructor(
    private readonly deps: JarvisEffectExecutorDeps,
    private readonly translate: (
      input: JarvisEffectExecutionInput,
    ) => NotificationJobEffectTranslation | null,
  ) {}

  async execute(input: JarvisEffectExecutionInput): Promise<JarvisEffectExecutionOutcome> {
    const { coordinates, lease } = input;
    const translation = this.translate(input);
    if (translation === null) {
      return {
        status: 'failed_terminal',
        resultDigest: canonicalDigest([
          'bob.jarvis.dispatch.notification-effect-failure.v1',
          lease.effectId,
          'effect_payload_untranslatable',
        ]),
      };
    }
    // Ré-exécution du même effet ⇒ même dedupeKey ⇒ le repository rend le job EXISTANT
    // (une dedupeKey identifie une requête immuable) : même effectId ⇒ même job outbox.
    const job = await this.deps.persistence.runWithTenant(coordinates.companyId, () =>
      this.deps.persistence.notificationJobs.enqueue({
        id: randomUUID(),
        companyId: coordinates.companyId,
        kind: translation.kind,
        dedupeKey: jarvisNotificationEffectDedupeKey(lease.effectId),
        notification: translation.notification,
        now: this.deps.now(),
        ...(translation.notBefore !== undefined ? { notBefore: translation.notBefore } : {}),
      }),
    );
    return {
      status: 'succeeded',
      resultDigest: canonicalDigest([
        'bob.jarvis.dispatch.notification-effect.v1',
        lease.effectId,
        job.id,
      ]),
    };
  }
}

// ---------------------------------------------------------------------------
// Bornes et dérivations pures
// ---------------------------------------------------------------------------

/** Lease courte (< plafond repository 30 min) : le fence arbitre toute reprise. */
const LEASE_DURATION_MS = 5 * 60_000;
const PENDING_SIGNAL_LIMIT = 25;
const DIRECTORY_HEARTBEAT_INTERVAL_MS = 10_000;
const DIRECTORY_SHUTDOWN_GRACE_MS = 1_000;
const DIRECTORY_RESERVATION = Symbol('jarvis-dispatch-directory-reservation');

/** Backoff exponentiel BORNÉ (même loi que notification-delivery, plafond = repository). */
export function jarvisDispatchRetryDelayMs(attempts: number): number {
  const delayMinutes = Math.min(120, Math.max(1, 2 ** attempts));
  return delayMinutes * 60_000;
}

function canonicalDigest(parts: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(parts));
}

function noEffectResultDigest(effectId: string, reason: string): string {
  return canonicalDigest(['bob.jarvis.dispatch.no-effect.v1', effectId, reason]);
}

function unknownOutcomeResultDigest(effectId: string, reason: string): string {
  return canonicalDigest(['bob.jarvis.dispatch.outcome-unknown.v1', effectId, reason]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Preuve durable du reçu de confirmation (liste fermée : `receiptId` = un événement existant
 * du run). Le state du run est écrit dans la MÊME transaction que l'événement d'admission dont
 * le `commandId` est ce `receiptId` (unicité du reçu §5.2) : retrouver ce reçu scellé dans le
 * state EST la lecture qui prouve l'événement. Extraction structurelle stricte, fail-closed —
 * single_business_action scelle `effect.authorizationReceiptId`, customer_contact scelle
 * `confirmation.consumedByCommandId` (+ l'unique `effectId` du run).
 */
function confirmationReceiptEvidenced(
  state: unknown,
  effectId: string,
  receiptId: string,
): boolean {
  if (!isPlainRecord(state)) return false;
  const effect = state['effect'];
  if (
    isPlainRecord(effect) &&
    effect['effectId'] === effectId &&
    effect['authorizationReceiptId'] === receiptId
  ) {
    return true;
  }
  const confirmation = state['confirmation'];
  if (
    state['effectId'] === effectId &&
    isPlainRecord(confirmation) &&
    confirmation['consumedByCommandId'] === receiptId
  ) {
    return true;
  }
  return false;
}

type JarvisDispatchRunEnvelope = Extract<
  JarvisRunEnvelope,
  { readonly kind: 'single_business_action' | 'customer_contact' }
>;

/**
 * Motifs fermés customer_contact (grammaire `reasonCode` de la définition). Reconstructibles
 * depuis la seule ligne persistée (status) — condition de la redelivery level-triggered.
 */
const CC_FAILURE_REASON_BY_STATUS: Readonly<
  Record<'cancelled' | 'failed_terminal', string>
> = Object.freeze({
  cancelled: 'dispatch_cancelled_no_effect',
  failed_terminal: 'dispatch_failed_terminal',
});

/**
 * Commande `record_effect_receipt` par kind. `null` = signal non constructible depuis la ligne
 * persistée : un succès customer_contact porte `customerId`/`customerRevision` que seul
 * l'exécuteur réel connaît — U1-d (qui enregistre cet exécuteur) devra signaler ce succès par
 * sa propre voie durable avant d'enregistrer l'action. Fail-closed : jamais un reçu inventé.
 */
function buildReceiptCommand(
  kind: JarvisDispatchRunEnvelope['kind'],
  status: JarvisWorkItemStatus,
  effectId: string,
  resultDigest: string,
  describedOutcome: unknown | null,
): unknown | null {
  // Une issue indécidable n'est ni un échec terminal ni une preuve de non-effet. Elle reste
  // durablement non acquittée jusqu'à une réconciliation purpose-specific ; aucun reducer
  // ne doit libérer le run sur une supposition.
  if (status === 'outcome_unknown') return null;
  if (status === 'succeeded') {
    if (kind === 'single_business_action') {
      return {
        type: 'record_effect_receipt',
        effectId,
        receipt: { kind: 'succeeded', resultDigest },
      };
    }
    // `customer_contact` veut l'identité ET la révision écrites (§5.3) : un digest opaque ne
    // referme pas honnêtement le run. L'exécuteur les a DÉCRITES ; sans description, le signal
    // reste inconstructible et le work item DÛ — c'est le fail-closed, jamais un reçu inventé.
    if (describedOutcome === null) return null;
    return { type: 'record_effect_receipt', effectId, outcome: describedOutcome };
  }
  if (status !== 'cancelled' && status !== 'failed_terminal') return null;
  // Uniquement cancelled / failed_terminal : issue décidée ou non-effet prouvé.
  if (kind === 'single_business_action') {
    return {
      type: 'record_effect_receipt',
      effectId,
      receipt: { kind: 'failed_terminal', failureDigest: resultDigest },
    };
  }
  return {
    type: 'record_effect_receipt',
    effectId,
    outcome: {
      kind: 'failed_terminal',
      reasonCode: CC_FAILURE_REASON_BY_STATUS[status] ?? 'dispatch_failure',
    },
  };
}

/** Kind d'observation (grammaire fermée de `deriveJarvisSystemCommandId`). */
const EFFECT_RESULT_OBSERVATION_KIND = 'effect_result';

type RevalidationVerdict =
  | { readonly kind: 'proceed'; readonly readAt: string; readonly receiptId: string }
  | { readonly kind: 'cancel'; readonly reason: string }
  | { readonly kind: 'retry'; readonly cause: string };

type LeaseOutcome = 'executed' | 'unknown' | 'cancelled' | 'retried' | 'skipped' | 'failed';

export interface JarvisDispatchCompanySummary {
  busy: number;
  claimed: number;
  executed: number;
  unknown: number;
  cancelled: number;
  retried: number;
  signalled: number;
  failures: number;
}

export interface JarvisDispatchSummary extends JarvisDispatchCompanySummary {
  companies: number;
  skipped: 'kill_switch' | 'dependencies_absent' | 'shutdown' | null;
}

function emptyCompanySummary(): JarvisDispatchCompanySummary {
  return {
    busy: 0,
    claimed: 0,
    executed: 0,
    unknown: 0,
    cancelled: 0,
    retried: 0,
    signalled: 0,
    failures: 0,
  };
}

function mergeCompanySummary(
  target: JarvisDispatchCompanySummary,
  delta: JarvisDispatchCompanySummary,
): void {
  target.busy += delta.busy;
  target.claimed += delta.claimed;
  target.executed += delta.executed;
  target.unknown += delta.unknown;
  target.cancelled += delta.cancelled;
  target.retried += delta.retried;
  target.signalled += delta.signalled;
  target.failures += delta.failures;
}

interface DirectoryHeartbeat {
  readonly lost: Promise<void>;
  /** Attend le renew éventuellement en vol et restitue toute perte observée avant son arrêt. */
  stop(): Promise<boolean>;
}

type DirectoryCoordinateControl =
  | { readonly kind: 'completed'; readonly summary: JarvisDispatchCompanySummary }
  | { readonly kind: 'claim_lost' | 'deadline' | 'shutdown' };

async function raceDirectoryCoordinate(
  tracked: Promise<JarvisDispatchCompanySummary>,
  claimLost: Promise<void>,
  hardDeadline: number,
  shutdownSignal: AbortSignal,
): Promise<DirectoryCoordinateControl> {
  let watchdog: NodeJS.Timeout | null = null;
  let onShutdown: (() => void) | null = null;
  const deadline = new Promise<DirectoryCoordinateControl>((resolve) => {
    watchdog = setTimeout(
      () => resolve({ kind: 'deadline' }),
      Math.max(0, hardDeadline - performance.now()),
    );
    watchdog.unref();
  });
  const shutdown = new Promise<DirectoryCoordinateControl>((resolve) => {
    if (shutdownSignal.aborted) {
      resolve({ kind: 'shutdown' });
      return;
    }
    onShutdown = () => resolve({ kind: 'shutdown' });
    shutdownSignal.addEventListener('abort', onShutdown, { once: true });
  });

  try {
    return await Promise.race([
      tracked.then<DirectoryCoordinateControl, DirectoryCoordinateControl>(
        (summary) => ({ kind: 'completed', summary }),
        () => {
          const summary = emptyCompanySummary();
          summary.failures = 1;
          return { kind: 'completed', summary };
        },
      ),
      claimLost.then<DirectoryCoordinateControl>(() => ({ kind: 'claim_lost' })),
      deadline,
      shutdown,
    ]);
  } finally {
    if (watchdog !== null) clearTimeout(watchdog);
    if (onShutdown !== null) shutdownSignal.removeEventListener('abort', onShutdown);
  }
}

// ---------------------------------------------------------------------------
// Le worker
// ---------------------------------------------------------------------------

@Injectable()
export class JarvisWorkItemDispatchService implements OnApplicationShutdown {
  private readonly clock = new SystemClock();
  private readonly executors: ReadonlyMap<string, JarvisEffectExecutor>;
  private readonly actionReleasePolicy: JarvisActionReleasePolicy;
  private dependenciesWarned = false;
  private stopping = false;
  private readonly activePageControllers = new Set<AbortController>();
  private readonly activePageTasks = new Set<Promise<unknown>>();
  private readonly inFlightCoordinates = new Map<
    string,
    typeof DIRECTORY_RESERVATION | Promise<JarvisDispatchCompanySummary>
  >();

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly tenants: ScheduledTenantDirectory,
    private readonly logger: AppLogger,
    // Les trois autorités Jarvis sont optionnelles en U1-c : les liaisons réelles (annuaire
    // SECURITY DEFINER, repository sous GUC, UoW unique + deps HMAC) arrivent avec les callers
    // U1-d. Absentes, le tick est un no-op fail-closed AUDITÉ — rien n'est perdu : les work
    // items restent dus (level-triggered) et repartent dès le câblage.
    @Optional()
    @Inject(JARVIS_WORK_ITEMS_DISPATCH)
    private readonly repository: JarvisWorkItemsDispatchRepository | null = null,
    @Optional()
    @Inject(JARVIS_DISPATCH_RUN_DIRECTORY)
    private readonly directory: JarvisDispatchRunDirectoryPort | null = null,
    @Optional()
    @Inject(JARVIS_DISPATCH_ADMISSION)
    private readonly admission: JarvisAdmissionUnitOfWorkPort | null = null,
    @Optional()
    @Inject(JARVIS_EFFECT_EXECUTORS)
    executors: ReadonlyMap<string, JarvisEffectExecutor> | null = null,
    @Optional()
    @Inject(JARVIS_ACTION_RELEASE_POLICY)
    actionReleasePolicy: JarvisActionReleasePolicy | null = null,
  ) {
    this.executors =
      executors ??
      buildJarvisEffectExecutorRegistry({ persistence: p, now: () => this.clock.now() });
    this.actionReleasePolicy = actionReleasePolicy ?? CLOSED_JARVIS_ACTION_RELEASE_POLICY;
  }

  /** Cadence courte : l'effet d'une confirmation ne doit jamais attendre un long cron. */
  @Cron('* * * * *')
  scheduled(): void {
    void this.runAllCompanies()
      .then((summary) => {
        if (
          summary.busy > 0
          || summary.claimed > 0
          || summary.signalled > 0
          || summary.failures > 0
        ) {
          this.logger.audit('jarvis.dispatch.scheduled', { ...summary });
        }
      })
      .catch((e: unknown) => {
        this.logger.warn(
          `Dispatch Jarvis inattendu: ${e instanceof Error ? e.message : String(e)}`,
          'jarvis-dispatch',
        );
      });
  }

  run(): Promise<JarvisDispatchSummary> {
    return this.runAllCompanies();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const controller of this.activePageControllers) controller.abort();
    if (this.activePageTasks.size === 0) return;

    let graceTimer: NodeJS.Timeout | null = null;
    const grace = new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, DIRECTORY_SHUTDOWN_GRACE_MS);
      graceTimer.unref();
    });
    await Promise.race([
      Promise.allSettled([...this.activePageTasks]).then(() => undefined),
      grace,
    ]);
    if (graceTimer !== null) clearTimeout(graceTimer);
  }

  async runAllCompanies(limitPerRun = 10): Promise<JarvisDispatchSummary> {
    const base: JarvisDispatchSummary = { companies: 0, skipped: null, ...emptyCompanySummary() };
    if (this.stopping) return { ...base, skipped: 'shutdown' };
    if (this.repository === null || this.directory === null || this.admission === null) {
      if (!this.dependenciesWarned) {
        this.dependenciesWarned = true;
        this.logger.audit('jarvis.dispatch.dependencies_absent', {
          repository: this.repository !== null,
          directory: this.directory !== null,
          admission: this.admission !== null,
        });
      }
      return { ...base, skipped: 'dependencies_absent' };
    }
    const companyIds = await this.tenants.listCompanyIds();
    // Kill switch dispatch (revue C11) : il ne gate que les NOUVEAUX claims — la redelivery
    // des signaux et la réconciliation des effets déjà autorisés tournent quand même (§5.3).
    // `skipped: 'kill_switch'` signale que les claims ont été sautés, pas le tick entier.
    const summary: JarvisDispatchSummary = {
      ...base,
      companies: companyIds.length,
      skipped: jarvisDispatchEnabled() ? null : 'kill_switch',
    };
    for (const companyId of companyIds) {
      const companySummary = await this.runForCompany(companyId, limitPerRun);
      summary.busy += companySummary.busy;
      summary.claimed += companySummary.claimed;
      summary.executed += companySummary.executed;
      summary.unknown += companySummary.unknown;
      summary.cancelled += companySummary.cancelled;
      summary.retried += companySummary.retried;
      summary.signalled += companySummary.signalled;
      summary.failures += companySummary.failures;
    }
    return summary;
  }

  async runForCompany(companyId: string, limitPerRun = 10): Promise<JarvisDispatchCompanySummary> {
    const summary = emptyCompanySummary();
    const directory = this.directory;
    if (
      this.stopping
      || this.repository === null
      || directory === null
      || this.admission === null
    ) return summary;

    let claim: Awaited<ReturnType<JarvisDispatchRunDirectoryPort['claimDispatchCoordinates']>>;
    try {
      claim = await directory.claimDispatchCoordinates({
        companyId,
        limit: JARVIS_DISPATCH_DIRECTORY_RUNTIME_PAGE_SIZE,
      });
    } catch (e) {
      this.logger.warn(
        `Annuaire dispatch Jarvis indisponible: ${e instanceof Error ? e.message : String(e)}`,
        'jarvis-dispatch',
      );
      summary.failures += 1;
      return summary;
    }

    if (claim.status === 'unavailable') {
      summary.failures += 1;
      this.logger.warn('Annuaire dispatch Jarvis indisponible', 'jarvis-dispatch');
      return summary;
    }
    if (claim.status === 'empty') return summary;
    if (claim.status === 'busy') {
      summary.busy += 1;
      this.logger.audit('jarvis.dispatch.directory_busy', { companyId });
      return summary;
    }
    if (this.stopping) return summary;

    if (claim.status === 'ack_ready') {
      const acknowledged = await this.acknowledgeDirectoryPage(companyId, claim.claimId);
      if (!acknowledged) summary.failures += 1;
      return summary;
    }

    const controller = new AbortController();
    this.activePageControllers.add(controller);
    const pageTask = this.processDirectoryPage(
      companyId,
      claim,
      limitPerRun,
      controller.signal,
    );
    this.activePageTasks.add(pageTask);
    try {
      return await pageTask;
    } finally {
      controller.abort();
      this.activePageControllers.delete(controller);
      this.activePageTasks.delete(pageTask);
    }
  }

  private async processDirectoryPage(
    companyId: string,
    claim: Extract<
      Awaited<ReturnType<JarvisDispatchRunDirectoryPort['claimDispatchCoordinates']>>,
      { readonly status: 'claimed' }
    >,
    limitPerRun: number,
    shutdownSignal: AbortSignal,
  ): Promise<JarvisDispatchCompanySummary> {
    const summary = emptyCompanySummary();
    const directory = this.directory;
    if (directory === null) return summary;
    const hardDeadline = performance.now() + claim.hardLeaseRemainingMs;

    for (const entry of claim.entries) {
      if (this.stopping || shutdownSignal.aborted || performance.now() >= hardDeadline) {
        summary.failures += this.stopping || shutdownSignal.aborted ? 0 : 1;
        return summary;
      }
      const attempted = await this.processDirectoryEntry(
        companyId,
        claim.claimId,
        entry,
        limitPerRun,
        hardDeadline,
        shutdownSignal,
      );
      mergeCompanySummary(summary, attempted.summary);
      if (!attempted.completed) return summary;
    }

    if (this.stopping || shutdownSignal.aborted || performance.now() >= hardDeadline) {
      summary.failures += this.stopping || shutdownSignal.aborted ? 0 : 1;
      return summary;
    }
    const acknowledged = await this.acknowledgeDirectoryPage(companyId, claim.claimId);
    if (!acknowledged) summary.failures += 1;
    return summary;
  }

  private async processDirectoryEntry(
    companyId: string,
    claimId: string,
    entry: JarvisDispatchDirectoryClaimedCoordinate,
    limitPerRun: number,
    hardDeadline: number,
    shutdownSignal: AbortSignal,
  ): Promise<{ readonly completed: boolean; readonly summary: JarvisDispatchCompanySummary }> {
    const summary = emptyCompanySummary();
    const directory = this.directory;
    if (directory === null || this.stopping || shutdownSignal.aborted) {
      return { completed: false, summary };
    }

    const registryKey = canonicalDigest([
      'bob.jarvis.dispatch.in-flight.v1',
      entry.coordinates.companyId,
      entry.coordinates.ownerUserId,
      entry.coordinates.runId,
    ]);
    const existing = this.inFlightCoordinates.get(registryKey);
    if (existing === DIRECTORY_RESERVATION) {
      summary.failures += 1;
      this.logger.audit('jarvis.dispatch.directory_overloaded', {
        reason: 'coordinate_reservation_in_progress',
        registrySize: this.inFlightCoordinates.size,
      });
      return { completed: false, summary };
    }
    if (
      existing === undefined
      && this.inFlightCoordinates.size >= JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE
    ) {
      summary.failures += 1;
      this.logger.audit('jarvis.dispatch.directory_overloaded', {
        reason: 'registry_capacity_reached',
        registrySize: this.inFlightCoordinates.size,
      });
      return { completed: false, summary };
    }

    const ownsReservation = existing === undefined;
    if (ownsReservation) this.inFlightCoordinates.set(registryKey, DIRECTORY_RESERVATION);
    const releaseReservation = (): void => {
      if (
        ownsReservation
        && this.inFlightCoordinates.get(registryKey) === DIRECTORY_RESERVATION
      ) this.inFlightCoordinates.delete(registryKey);
    };

    const renewed = await this.renewDirectoryClaim(companyId, claimId);
    if (!renewed || this.stopping || shutdownSignal.aborted) {
      releaseReservation();
      summary.failures += this.stopping || shutdownSignal.aborted ? 0 : 1;
      return { completed: false, summary };
    }
    if (performance.now() >= hardDeadline) {
      releaseReservation();
      summary.failures += 1;
      return { completed: false, summary };
    }
    const started = await this.startDirectoryPosition(companyId, claimId, entry.position);
    if (!started) {
      releaseReservation();
      summary.failures += 1;
      return { completed: false, summary };
    }
    if (this.stopping || shutdownSignal.aborted || performance.now() >= hardDeadline) {
      releaseReservation();
      summary.failures += this.stopping || shutdownSignal.aborted ? 0 : 1;
      return { completed: false, summary };
    }

    // Une vraie Promise déjà lancée dans CE process peut porter un nouveau slot sans second
    // handler. Une sentinelle ne le peut jamais (elle a été refusée plus haut).
    if (existing instanceof Promise) return { completed: true, summary };

    const tracked = Promise.resolve().then(() => {
      if (
        this.stopping
        || shutdownSignal.aborted
        || performance.now() >= hardDeadline
      ) return emptyCompanySummary();
      return this.processCoordinate(entry.coordinates, limitPerRun);
    });
    this.inFlightCoordinates.set(registryKey, tracked);
    void tracked.then(
      () => {
        if (this.inFlightCoordinates.get(registryKey) === tracked) {
          this.inFlightCoordinates.delete(registryKey);
        }
      },
      () => {
        if (this.inFlightCoordinates.get(registryKey) === tracked) {
          this.inFlightCoordinates.delete(registryKey);
        }
      },
    );

    const heartbeat = this.startDirectoryHeartbeat(
      companyId,
      claimId,
      hardDeadline,
      shutdownSignal,
    );
    const controlled = await raceDirectoryCoordinate(
      tracked,
      heartbeat.lost,
      hardDeadline,
      shutdownSignal,
    );
    const heartbeatLost = await heartbeat.stop();
    if (controlled.kind !== 'completed' || heartbeatLost) {
      if (controlled.kind !== 'shutdown') summary.failures += 1;
      this.logger.audit('jarvis.dispatch.directory_control_lost', {
        reason: heartbeatLost ? 'claim_lost' : controlled.kind,
      });
      return { completed: false, summary };
    }
    mergeCompanySummary(summary, controlled.summary);
    return { completed: true, summary };
  }

  private startDirectoryHeartbeat(
    companyId: string,
    claimId: string,
    hardDeadline: number,
    shutdownSignal: AbortSignal,
  ): DirectoryHeartbeat {
    let active = true;
    let claimLost = false;
    let lostResolved = false;
    let timer: NodeJS.Timeout | null = null;
    let inFlight: Promise<void> | null = null;
    let stopPromise: Promise<boolean> | null = null;
    let resolveLost!: () => void;
    const lost = new Promise<void>((resolve) => {
      resolveLost = resolve;
    });
    const lose = (): void => {
      claimLost = true;
      active = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!lostResolved) {
        lostResolved = true;
        resolveLost();
      }
    };
    const schedule = (): void => {
      if (!active) return;
      if (shutdownSignal.aborted) return lose();
      const remaining = hardDeadline - performance.now();
      if (remaining <= 0) {
        lose();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (!active) return;
        if (shutdownSignal.aborted) return lose();
        inFlight = (async () => {
          const renewed = await this.renewDirectoryClaim(companyId, claimId);
          if (!renewed) {
            lose();
            return;
          }
          if (active) schedule();
        })();
        void inFlight.then(
          () => undefined,
          () => lose(),
        );
      }, Math.min(DIRECTORY_HEARTBEAT_INTERVAL_MS, remaining));
      timer.unref();
    };
    schedule();
    return {
      lost,
      stop: () => {
        if (stopPromise !== null) return stopPromise;
        active = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        stopPromise = (inFlight ?? Promise.resolve()).then(
          () => claimLost,
          () => {
            lose();
            return true;
          },
        );
        return stopPromise;
      },
    };
  }

  private async renewDirectoryClaim(companyId: string, claimId: string): Promise<boolean> {
    const directory = this.directory;
    if (directory === null) return false;
    try {
      const result = await directory.renewDispatchCoordinatesClaim({ companyId, claimId });
      return result.status === 'succeeded' && result.renewed;
    } catch {
      return false;
    }
  }

  private async startDirectoryPosition(
    companyId: string,
    claimId: string,
    position: number,
  ): Promise<boolean> {
    const directory = this.directory;
    if (directory === null || this.stopping) return false;
    try {
      const result = await directory.startDispatchCoordinate({ companyId, claimId, position });
      return result.status === 'succeeded' && result.started;
    } catch {
      return false;
    }
  }

  private async acknowledgeDirectoryPage(companyId: string, claimId: string): Promise<boolean> {
    const directory = this.directory;
    if (directory === null) return false;
    try {
      const result = await directory.acknowledgeDispatchCoordinates({ companyId, claimId });
      return result.status === 'succeeded' && result.acknowledged;
    } catch {
      return false;
    }
  }

  private async processCoordinate(
    coordinates: JarvisWorkItemCoordinates,
    limitPerRun: number,
  ): Promise<JarvisDispatchCompanySummary> {
    const summary = emptyCompanySummary();
    const repository = this.repository;
    if (repository === null || this.admission === null) return summary;

    // 1. Redelivery level-triggered avant le kill switch : un effet déjà parti doit toujours
    // être observé, même quand les nouveaux claims sont fermés.
    try {
      const pendings = await repository.listPendingSignals(coordinates, PENDING_SIGNAL_LIMIT);
      for (const pending of pendings) {
        const applied = await this.signalStoredResult(coordinates, pending);
        if (applied) summary.signalled += 1;
      }
    } catch (e) {
      this.logger.warn(
        `Redelivery signaux Jarvis impossible: ${e instanceof Error ? e.message : String(e)}`,
        'jarvis-dispatch',
      );
      summary.failures += 1;
    }

    // 2. Réconciliation des effets déjà autorisés, également indépendante du kill switch.
    try {
      const reclaimed = await repository.reclaimExpiredAuthorized(coordinates, {
        leaseOwner: `jarvis-dispatch:${process.pid}`,
        leaseToken: randomUUID(),
        leaseDurationMs: LEASE_DURATION_MS,
        limit: Math.max(1, Math.min(limitPerRun, 100)),
      });
      for (const lease of reclaimed) {
        const { outcome, signalled } = await this.reconcileReclaimedAuthorized(
          coordinates,
          lease,
        );
        summary.signalled += signalled;
        if (outcome === 'executed') summary.executed += 1;
        if (outcome === 'cancelled') summary.cancelled += 1;
        if (outcome === 'unknown') summary.unknown += 1;
        if (outcome === 'failed') summary.failures += 1;
      }
    } catch (e) {
      this.logger.warn(
        `Réconciliation authorized Jarvis impossible: ${e instanceof Error ? e.message : String(e)}`,
        'jarvis-dispatch',
      );
      summary.failures += 1;
    }

    // 3. Le kill switch ne coupe que les nouveaux claims/authorize.
    if (!jarvisDispatchEnabled()) return summary;
    let leases: readonly JarvisWorkItemLease[];
    try {
      leases = await repository.claimDue(coordinates, {
        leaseOwner: `jarvis-dispatch:${process.pid}`,
        leaseToken: randomUUID(),
        leaseDurationMs: LEASE_DURATION_MS,
        limit: Math.max(1, Math.min(limitPerRun, 100)),
      });
    } catch (e) {
      this.logger.warn(
        `Claim work items Jarvis impossible: ${e instanceof Error ? e.message : String(e)}`,
        'jarvis-dispatch',
      );
      summary.failures += 1;
      return summary;
    }
    summary.claimed += leases.length;
    for (const lease of leases) {
      const { outcome, signalled } = await this.processLease(coordinates, lease);
      summary.signalled += signalled;
      if (outcome === 'executed') summary.executed += 1;
      if (outcome === 'unknown') summary.unknown += 1;
      if (outcome === 'cancelled') summary.cancelled += 1;
      if (outcome === 'retried') summary.retried += 1;
      if (outcome === 'failed') summary.failures += 1;
    }
    return summary;
  }

  private async processLease(
    coordinates: JarvisWorkItemCoordinates,
    lease: JarvisWorkItemLease,
  ): Promise<{ outcome: LeaseOutcome; signalled: number }> {
    const repository = this.repository;
    if (repository === null) return { outcome: 'skipped', signalled: 0 };
    try {
      const verdict = await this.revalidate(coordinates, lease);

      if (verdict.kind === 'retry') {
        // Échec transitoire AVANT autorisation : la lease est rendue honnêtement (retry_due,
        // backoff exponentiel borné) — jamais une ligne abandonnée en `leased`.
        const released = await repository.markRetryDue(coordinates, {
          id: lease.id,
          leaseToken: lease.leaseToken,
          leaseFence: lease.leaseFence,
          retryDelayMs: jarvisDispatchRetryDelayMs(lease.attempts),
        });
        this.logger.audit('jarvis.dispatch.retry_due', {
          companyId: coordinates.companyId,
          workItemId: lease.id,
          effectId: lease.effectId,
          cause: verdict.cause,
          attempts: lease.attempts,
          released,
        });
        return { outcome: released ? 'retried' : 'skipped', signalled: 0 };
      }

      if (verdict.kind === 'cancel') {
        // Revalidation en échec ⇒ cancel SANS authorize. Fencé : un claim intercalé ou un
        // authorize concurrent fait perdre le cancel — un seul gagnant par ligne (§5.3).
        const resultDigest = noEffectResultDigest(lease.effectId, verdict.reason);
        const won = await repository.cancelUnauthorized(coordinates, {
          id: lease.id,
          expectedLeaseFence: lease.leaseFence,
          noEffectResultDigest: resultDigest,
        });
        this.logger.audit('jarvis.dispatch.cancelled', {
          companyId: coordinates.companyId,
          workItemId: lease.id,
          effectId: lease.effectId,
          reason: verdict.reason,
          won,
        });
        if (!won) return { outcome: 'skipped', signalled: 0 };
        // Cancel gagné ⇒ le résultat no-effect est SIGNALÉ au run, jamais tacite.
        const applied = await this.signalStoredResult(coordinates, {
          id: lease.id,
          effectId: lease.effectId,
          status: 'cancelled',
          resultDigest,
          leaseFence: lease.leaseFence,
        });
        return { outcome: 'cancelled', signalled: applied ? 1 : 0 };
      }

      const executor = this.executors.get(
        jarvisEffectExecutorKey(lease.actionId, lease.actionVersion),
      );
      if (executor === undefined) {
        // Aucun exécuteur n'est enregistré AVANT le point de non-retour : aucune I/O n'a pu
        // partir. On annule sous fence au lieu de fabriquer une issue indécidable.
        const resultDigest = noEffectResultDigest(lease.effectId, 'executor_unregistered');
        const won = await repository.cancelUnauthorized(coordinates, {
          id: lease.id,
          expectedLeaseFence: lease.leaseFence,
          noEffectResultDigest: resultDigest,
        });
        this.logger.audit('jarvis.dispatch.executor_unregistered', {
          companyId: coordinates.companyId,
          workItemId: lease.id,
          effectId: lease.effectId,
          actionId: lease.actionId,
          actionVersion: lease.actionVersion,
          cancelledNoEffect: won,
        });
        if (!won) return { outcome: 'skipped', signalled: 0 };
        const applied = await this.signalStoredResult(coordinates, {
          id: lease.id,
          effectId: lease.effectId,
          status: 'cancelled',
          resultDigest,
          leaseFence: lease.leaseFence,
        });
        return { outcome: 'cancelled', signalled: applied ? 1 : 0 };
      }

      // Point de non-retour : authorizedAt + authorizationDigest posés ENSEMBLE, réservé au
      // détenteur (token, fence) dont la lease couvre encore l'instant base.
      const authorized = await repository.authorize(coordinates, {
        id: lease.id,
        leaseToken: lease.leaseToken,
        leaseFence: lease.leaseFence,
        authorizationDigest: canonicalDigest([
          'bob.jarvis.dispatch.authorization.v1',
          lease.effectId,
          verdict.receiptId,
          verdict.readAt,
        ]),
      });
      if (!authorized) {
        // Autorisation perdue : fence repris par un successeur, lease expirée, OU échéance
        // `executeBy` passée DANS la transaction d'authorize (revue C12). AUCUNE I/O n'est
        // partie — route no-effect fencée (§5.3) : si un successeur détient la ligne, le
        // cancel perd (false) et ne touche rien ; sinon il clôt et le règlement est signalé.
        const resultDigest = noEffectResultDigest(lease.effectId, 'authorization_refused');
        const won = await repository.cancelUnauthorized(coordinates, {
          id: lease.id,
          expectedLeaseFence: lease.leaseFence,
          noEffectResultDigest: resultDigest,
        });
        this.logger.audit('jarvis.dispatch.authorize_lost', {
          companyId: coordinates.companyId,
          workItemId: lease.id,
          effectId: lease.effectId,
          cancelledNoEffect: won,
        });
        if (!won) return { outcome: 'skipped', signalled: 0 };
        const applied = await this.signalStoredResult(coordinates, {
          id: lease.id,
          effectId: lease.effectId,
          status: 'cancelled',
          resultDigest,
          leaseFence: lease.leaseFence,
        });
        return { outcome: 'cancelled', signalled: applied ? 1 : 0 };
      }

      let execution: JarvisEffectExecutionOutcome;
      try {
        execution = await executor.execute({ coordinates, lease });
      } catch (e) {
        // Après `authorized`, une exception d'exécuteur est INDÉCIDABLE : outcome_unknown,
        // jamais un retry aveugle (§5.3).
        this.logger.warn(
          `Exécuteur Jarvis en échec (${lease.actionId}@${lease.actionVersion}): ${
            e instanceof Error ? e.message : String(e)
          }`,
          'jarvis-dispatch',
        );
        execution = {
          status: 'outcome_unknown',
          resultDigest: unknownOutcomeResultDigest(lease.effectId, 'executor_error'),
        };
      }

      const stored = await repository.storeResult(coordinates, {
        id: lease.id,
        leaseToken: lease.leaseToken,
        leaseFence: lease.leaseFence,
        status: execution.status,
        resultDigest: execution.resultDigest,
      });
      if (!stored) {
        this.logger.audit('jarvis.dispatch.store_result_lost', {
          companyId: coordinates.companyId,
          workItemId: lease.id,
          effectId: lease.effectId,
        });
        return { outcome: 'skipped', signalled: 0 };
      }
      const applied = await this.signalStoredResult(coordinates, {
        id: lease.id,
        effectId: lease.effectId,
        status: execution.status,
        resultDigest: execution.resultDigest,
        leaseFence: lease.leaseFence,
      });
      return {
        outcome: execution.status === 'outcome_unknown' ? 'unknown' : 'executed',
        signalled: applied ? 1 : 0,
      };
    } catch (e) {
      this.logger.warn(
        `Dispatch work item Jarvis en échec: ${e instanceof Error ? e.message : String(e)}`,
        'jarvis-dispatch',
      );
      return { outcome: 'failed', signalled: 0 };
    }
  }

  /**
   * Règlement d'une ligne `authorized` reprise après expiration de lease (revue C10) : le
   * worker précédent est mort APRÈS le point de non-retour, AVANT `storeResult`.
   *
   * Registre absent à la REPRISE : l'image précédente a pu disposer d'un exécuteur et appeler
   * son provider. L'issue devient donc `outcome_unknown` et reste non signalée, jamais un faux
   * no-effect.
   *
   * Exécuteur ENREGISTRÉ (U1-d, revue C9) : l'issue ne se devine pas, elle se LIT. Le protocole
   * §5.3 est appliqué tel quel — « il réconcilie d'abord l'autorité métier/provider avec le même
   * effectId : reçu trouvé => persistance et observation du résultat ; absence d'effet prouvée
   * par l'autorité et action safe-to-retry => nouvel appel avec le MÊME effectId ; résultat
   * indécidable => outcome_unknown, sans retry aveugle ». Un exécuteur enregistré SANS
   * `reconcileEffect` n'a aucun arbitre : la ligne reste `authorized` sous sa lease renouvelée
   * (fail-closed, jamais une clôture inventée) et le défaut de câblage est audité.
   */
  private async reconcileReclaimedAuthorized(
    coordinates: JarvisWorkItemCoordinates,
    lease: JarvisWorkItemLease,
  ): Promise<{ outcome: LeaseOutcome; signalled: number }> {
    if (this.repository === null) return { outcome: 'skipped', signalled: 0 };
    const executor = this.executors.get(
      jarvisEffectExecutorKey(lease.actionId, lease.actionVersion),
    );
    if (executor === undefined) {
      return this.settleReclaimedAuthorized(coordinates, lease, {
        status: 'outcome_unknown',
        resultDigest: unknownOutcomeResultDigest(lease.effectId, 'executor_unregistered'),
      });
    }
    if (executor.reconcileEffect === undefined) {
      // Aucune lecture par effectId : rien ici ne peut trancher entre « parti » et « jamais
      // parti ». On ne clôt pas et on ne rejoue pas — l'exécuteur doit exposer sa
      // réconciliation avant d'être enregistré (§5.3).
      this.logger.audit('jarvis.dispatch.reconciliation_required', {
        companyId: coordinates.companyId,
        workItemId: lease.id,
        effectId: lease.effectId,
        actionId: lease.actionId,
        actionVersion: lease.actionVersion,
      });
      return { outcome: 'skipped', signalled: 0 };
    }
    let verdict: JarvisEffectReconciliation;
    try {
      verdict = await executor.reconcileEffect({ coordinates, lease });
    } catch (e) {
      // Une réconciliation qui lève n'a rien prouvé : indécidable, comme si l'autorité s'était
      // tue — jamais un rejeu sur une absence non démontrée.
      this.logger.warn(
        `Réconciliation Jarvis en échec (${lease.actionId}@${lease.actionVersion}): ${
          e instanceof Error ? e.message : String(e)
        }`,
        'jarvis-dispatch',
      );
      verdict = { kind: 'undecidable' };
    }
    this.logger.audit('jarvis.dispatch.reconciled', {
      companyId: coordinates.companyId,
      workItemId: lease.id,
      effectId: lease.effectId,
      actionId: lease.actionId,
      actionVersion: lease.actionVersion,
      verdict: verdict.kind,
    });
    const actionPublished = evaluateJarvisActionPublication(this.actionReleasePolicy, {
      companyId: coordinates.companyId,
      ownerUserId: coordinates.ownerUserId,
      actionId: lease.actionId,
      actionVersion: lease.actionVersion,
    }).published;
    if (verdict.kind === 'landed') {
      // Reçu trouvé : l'issue est celle que l'autorité montre, persistée puis observée.
      return this.settleReclaimedAuthorized(coordinates, lease, verdict.outcome);
    }
    if (verdict.kind === 'not_landed') {
      // Une autorisation historique ne vaut pas publication éternelle. Après avoir PROUVÉ
      // l'absence d'effet, un manifest fermé interdit le rejeu et produit un échec no-effect.
      if (!actionPublished) {
        return this.settleReclaimedAuthorized(coordinates, lease, {
          status: 'failed_terminal',
          resultDigest: noEffectResultDigest(
            lease.effectId,
            'action_not_released_after_authorization',
          ),
        }, 'cancelled');
      }
      // Absence prouvée (ou action idempotente par construction) : NOUVEL appel avec le MÊME
      // effectId — jamais un nouvel effectId, jamais un second effet.
      return this.settleReclaimedAuthorized(
        coordinates,
        lease,
        await this.executeReclaimed(executor, coordinates, lease),
      );
    }
    if (verdict.kind === 'safe_to_replay') {
      // `safe_to_replay` prouve l'idempotence, PAS l'absence d'un effet déjà committé. Sous
      // manifest fermé on ne rejoue rien et on conserve l'issue honnête : indécidable.
      if (!actionPublished) {
        return this.settleReclaimedAuthorized(coordinates, lease, {
          status: 'outcome_unknown',
          resultDigest: unknownOutcomeResultDigest(
            lease.effectId,
            'action_not_released_safe_replay_suppressed',
          ),
        });
      }
      return this.settleReclaimedAuthorized(
        coordinates,
        lease,
        await this.executeReclaimed(executor, coordinates, lease),
      );
    }
    // Indécidable : `outcome_unknown` motivé. Le laisser `authorized` sous une lease renouvelée
    // à chaque tick bloquerait le run À VIE ; le mot honnête pour « on ne sait pas si l'effet
    // est parti » existe dans le vocabulaire fermé, c'est celui-là (§5.3).
    return this.settleReclaimedAuthorized(coordinates, lease, {
      status: 'outcome_unknown',
      resultDigest: unknownOutcomeResultDigest(lease.effectId, 'reconciliation_undecidable'),
    });
  }

  /** Rejeu du MÊME effectId après réconciliation ; une exception reste indécidable (§5.3). */
  private async executeReclaimed(
    executor: JarvisEffectExecutor,
    coordinates: JarvisWorkItemCoordinates,
    lease: JarvisWorkItemLease,
  ): Promise<JarvisEffectExecutionOutcome> {
    try {
      return await executor.execute({ coordinates, lease });
    } catch (e) {
      this.logger.warn(
        `Rejeu d'effet Jarvis en échec (${lease.actionId}@${lease.actionVersion}): ${
          e instanceof Error ? e.message : String(e)
        }`,
        'jarvis-dispatch',
      );
      return {
        status: 'outcome_unknown',
        resultDigest: unknownOutcomeResultDigest(lease.effectId, 'executor_error'),
      };
    }
  }

  /** Résultat immuable fencé puis signal — la reprise ne repasse JAMAIS par `authorize`. */
  private async settleReclaimedAuthorized(
    coordinates: JarvisWorkItemCoordinates,
    lease: JarvisWorkItemLease,
    execution: JarvisEffectExecutionOutcome,
    outcomeOverride?: LeaseOutcome,
  ): Promise<{ outcome: LeaseOutcome; signalled: number }> {
    const repository = this.repository;
    if (repository === null) return { outcome: 'skipped', signalled: 0 };
    const stored = await repository.storeResult(coordinates, {
      id: lease.id,
      leaseToken: lease.leaseToken,
      leaseFence: lease.leaseFence,
      status: execution.status,
      resultDigest: execution.resultDigest,
    });
    if (!stored) {
      this.logger.audit('jarvis.dispatch.store_result_lost', {
        companyId: coordinates.companyId,
        workItemId: lease.id,
        effectId: lease.effectId,
      });
      return { outcome: 'skipped', signalled: 0 };
    }
    this.logger.audit('jarvis.dispatch.reclaimed_authorized_settled', {
      companyId: coordinates.companyId,
      workItemId: lease.id,
      effectId: lease.effectId,
      actionId: lease.actionId,
      actionVersion: lease.actionVersion,
      status: execution.status,
    });
    const applied = await this.signalStoredResult(coordinates, {
      id: lease.id,
      effectId: lease.effectId,
      status: execution.status,
      resultDigest: execution.resultDigest,
      leaseFence: lease.leaseFence,
    });
    return {
      outcome:
        outcomeOverride ?? (execution.status === 'outcome_unknown' ? 'unknown' : 'executed'),
      signalled: applied ? 1 : 0,
    };
  }

  /**
   * Revalidation en 2ᵉ transaction — LISTE FERMÉE (SPEC_U1C §3), fail-closed : tenant ouvert,
   * `actingPrincipalId = ownerUserId`, source `confirmation` seule avec reçu prouvé par la
   * lecture du run, `executeBy` contre l'horloge BASE, kill switch dispatch, action au
   * catalogue non fermée, `targetDigest` recalculé si présent. L'écriture qui suit reste
   * conditionnée par (leaseToken, leaseFence) — la revalidation ne décide jamais seule.
   */
  private async revalidate(
    coordinates: JarvisWorkItemCoordinates,
    lease: JarvisWorkItemLease,
  ): Promise<RevalidationVerdict> {
    // Source d'autorisation : `confirmation` SEULE en U1 (mandats/règles = post-V1, FD-05).
    const source = parseJarvisAuthorizationSource(lease.authorizationSource);
    if (!source.ok || source.value.source !== 'confirmation') {
      return { kind: 'cancel', reason: 'authorization_source_not_confirmation' };
    }
    const receiptId = source.value.receiptId;
    // Parité §15 : l'effet s'exécute au nom du propriétaire du run, jamais d'un autre principal.
    if (lease.actingPrincipalId !== coordinates.ownerUserId) {
      return { kind: 'cancel', reason: 'acting_principal_mismatch' };
    }
    // Kill switch coupé ENTRE claim et revalidation : opérationnel, pas sémantique — la ligne
    // est rendue (retry_due), jamais annulée.
    if (!jarvisDispatchEnabled()) {
      return { kind: 'retry', cause: 'dispatch_disabled' };
    }
    // Tenant ouvert : une société clôturée n'exécute plus JAMAIS un effet différé.
    try {
      const company = await this.p.runWithTenant(coordinates.companyId, () =>
        this.p.companies.findById(coordinates.companyId),
      );
      if (company === null || company.isClosed()) {
        return { kind: 'cancel', reason: 'tenant_closed' };
      }
    } catch (e) {
      return {
        kind: 'retry',
        cause: `company_read_failed:${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Lecture stateless (READ ONLY RepeatableRead) : le run ET l'horloge base du même instant.
    const admission = this.admission;
    if (admission === null) return { kind: 'retry', cause: 'admission_port_absent' };
    let run: JarvisRunEnvelope | null;
    let readAt: string;
    try {
      const read = await admission.readJarvisStateless(
        { companyId: coordinates.companyId, ownerUserId: coordinates.ownerUserId },
        (view) => view.runById(coordinates.runId),
      );
      run = read.value;
      readAt = read.readAt;
    } catch (e) {
      return {
        kind: 'retry',
        cause: `run_read_failed:${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (run === null) return { kind: 'cancel', reason: 'run_missing' };
    if (run.kind !== 'single_business_action' && run.kind !== 'customer_contact') {
      return { kind: 'cancel', reason: 'run_kind_unsupported' };
    }
    const definition = resolveJarvisDefinition(run.kind, run.definitionVersion);
    const serverAction = definition?.actionReference(run, null) ?? null;
    if (
      serverAction === null
      || serverAction.actionId !== lease.actionId
      || serverAction.actionVersion !== lease.actionVersion
    ) {
      return { kind: 'cancel', reason: 'action_binding_mismatch' };
    }
    // Publication évaluée sur l'action dérivée du state relu, jamais sur les seules colonnes de
    // la lease. Une ligne N-1/corrompue ne peut donc pas emprunter l'autorisation d'une autre
    // action pour exécuter un effet sous ce run.
    const publication = evaluateJarvisActionPublication(this.actionReleasePolicy, {
      companyId: coordinates.companyId,
      ownerUserId: coordinates.ownerUserId,
      ...serverAction,
    });
    if (!publication.published) {
      return {
        kind: 'cancel',
        reason: publication.reason === 'unknown_action' ? 'action_unknown' : publication.reason,
      };
    }
    // Cancel gagné côté run : un run terminal ou en annulation n'attend plus cet effet non
    // autorisé — clôture no-effect, jamais une exécution posthume.
    if (
      run.terminalAt !== null ||
      run.status === 'cancelled' ||
      run.status === 'cancelling' ||
      run.status === 'quarantined'
    ) {
      return { kind: 'cancel', reason: 'run_no_longer_expects_effect' };
    }
    // Reçu de confirmation prouvé par la trace durable du run (voir confirmationReceiptEvidenced).
    if (!confirmationReceiptEvidenced(run.state, lease.effectId, receiptId)) {
      return { kind: 'cancel', reason: 'confirmation_receipt_unverified' };
    }
    // Fenêtre d'exécution contre l'horloge BASE — jamais l'horloge ambiante du worker.
    if (Date.parse(lease.executeBy) < Date.parse(readAt)) {
      return { kind: 'cancel', reason: 'execute_window_expired' };
    }
    // targetDigest recalculé si présent — par l'exécuteur de l'action, qui seul sait relire la
    // cible. La méthode est optionnelle seulement pour les effets SANS targetDigest : accepter un
    // digest scellé sans savoir le recalculer transformerait la liste fermée U1-c en préflight
    // facultatif. Un registre sans exécuteur reste réglé no-effect par `processLease`, avant toute
    // autorisation ; un exécuteur présent mais incomplet est refusé ici, également sans I/O.
    if (lease.targetDigest !== null) {
      const executor = this.executors.get(
        jarvisEffectExecutorKey(lease.actionId, lease.actionVersion),
      );
      if (executor !== undefined) {
        if (executor.recalculateTargetDigest === undefined) {
          return { kind: 'cancel', reason: 'target_digest_revalidator_unavailable' };
        }
        let recalculated: string | null;
        try {
          recalculated = await executor.recalculateTargetDigest({ coordinates, lease });
        } catch (e) {
          return {
            kind: 'retry',
            cause: `target_digest_recalculation_failed:${e instanceof Error ? e.message : String(e)}`,
          };
        }
        if (recalculated !== lease.targetDigest) {
          return { kind: 'cancel', reason: 'target_digest_drift' };
        }
      }
    }
    return { kind: 'proceed', readAt, receiptId };
  }

  /**
   * Signale un résultat persisté au run par la voie canonique : `runJarvisSystemAdmission`
   * (commande `record_effect_receipt`), `commandId` DÉTERMINISTE — la même observation
   * re-signalée rejoue en zéro-write — puis `markSignalApplied` fencé. Reconstructible depuis
   * la seule ligne persistée : condition de la redelivery level-triggered.
   */
  private async signalStoredResult(
    coordinates: JarvisWorkItemCoordinates,
    stored: {
      readonly id: string;
      readonly effectId: string;
      readonly status: JarvisWorkItemStatus;
      readonly resultDigest: string;
      readonly leaseFence: bigint;
    },
  ): Promise<boolean> {
    const admission = this.admission;
    const repository = this.repository;
    if (admission === null || repository === null) return false;
    if (stored.status === 'outcome_unknown') {
      // Quarantaine durable : ni admission système, ni stamp. Le drain de release doit rester
      // rouge tant qu'une autorité purpose-specific n'a pas réconcilié cette issue.
      this.logger.audit('jarvis.dispatch.signal_quarantined', {
        companyId: coordinates.companyId,
        workItemId: stored.id,
        effectId: stored.effectId,
        status: stored.status,
      });
      return false;
    }
    try {
      const read = await admission.readJarvisStateless(
        { companyId: coordinates.companyId, ownerUserId: coordinates.ownerUserId },
        (view) => view.runById(coordinates.runId),
      );
      const run = read.value;
      const acknowledge = async (reason: string): Promise<boolean> => {
        const applied = await repository.markSignalApplied(coordinates, {
          id: stored.id,
          leaseFence: stored.leaseFence,
          resultDigest: stored.resultDigest,
        });
        this.logger.audit('jarvis.dispatch.signal_applied', {
          companyId: coordinates.companyId,
          workItemId: stored.id,
          effectId: stored.effectId,
          status: stored.status,
          reason,
          applied,
        });
        return applied;
      };
      if (run === null) {
        // Run purgé par la rétention : le signal est sans objet — acquitté explicitement.
        return acknowledge('run_missing');
      }
      if (run.kind !== 'single_business_action' && run.kind !== 'customer_contact') {
        this.logger.warn('Signal Jarvis: kind de run non signalable', 'jarvis-dispatch');
        return false;
      }
      // La DESCRIPTION de l'effet réussi vient de l'exécuteur de CETTE action : lui seul connaît
      // sa cible et son autorité. Une panne de description ne rend jamais un reçu approximatif —
      // elle laisse le travail dû, et le tick suivant réessaiera (level-triggered).
      let describedOutcome: unknown | null = null;
      if (stored.status === 'succeeded' && run.kind === 'customer_contact') {
        // Le work item pendant ne porte pas son action : on interroge TOUS les exécuteurs capables
        // de décrire, et le premier qui reconnaît l'effet répond. Chacun est borné à son propre
        // namespace d'idempotence — un exécuteur d'une autre action rend `null`.
        for (const executor of this.executors.values()) {
          if (executor.describeSucceededEffect === undefined) continue;
          try {
            describedOutcome = await executor.describeSucceededEffect({
              coordinates,
              effectId: stored.effectId,
            });
            if (describedOutcome !== null) break;
          } catch (e) {
            this.logger.warn(
              `Description d'effet Jarvis impossible: ${e instanceof Error ? e.message : String(e)}`,
              'jarvis-dispatch',
            );
            describedOutcome = null;
          }
        }
      }
      const command = buildReceiptCommand(
        run.kind,
        stored.status,
        stored.effectId,
        stored.resultDigest,
        describedOutcome,
      );
      if (command === null) {
        // Succès customer_contact sans description : reçu non reconstructible (fail-closed).
        this.logger.audit('jarvis.dispatch.signal_unbuildable', {
          companyId: coordinates.companyId,
          workItemId: stored.id,
          effectId: stored.effectId,
          kind: run.kind,
          status: stored.status,
        });
        return false;
      }
      const commandId = deriveJarvisSystemCommandId(
        coordinates.runId,
        stored.effectId,
        EFFECT_RESULT_OBSERVATION_KIND,
        stored.resultDigest,
      );
      if (!commandId.ok) {
        this.logger.warn(
          `Signal Jarvis: dérivation du commandId refusée (${commandId.error.field}:${commandId.error.reason})`,
          'jarvis-dispatch',
        );
        return false;
      }
      const envelope: JarvisSystemAdmissionEnvelope = {
        companyId: coordinates.companyId,
        ownerUserId: coordinates.ownerUserId,
        kind: run.kind,
        definitionVersion: run.definitionVersion,
        runId: coordinates.runId,
        commandId: commandId.value,
        expectedRevision: run.revision,
        command,
        observationKind: EFFECT_RESULT_OBSERVATION_KIND,
        effectId: stored.effectId,
        occurredAt: read.readAt,
      };
      const result: JarvisAdmissionResult = await admission.runJarvisSystemAdmission(envelope);
      switch (result.status) {
        case 'admitted':
        case 'replayed':
          return acknowledge(result.status);
        case 'command_conflict':
          // commandId déterministe déjà reçu par CE run sous une autre révision attendue : le
          // fingerprint diverge mais l'observation EST déjà admise — acquittement, zéro-write.
          return acknowledge('command_conflict_already_admitted');
        case 'run_not_found':
          return acknowledge('run_not_found');
        case 'refused':
          if (result.error.code === 'run_terminal') {
            // Signal tardif sur run terminal : acquitté comme no-op — jamais réadmis (§5.1).
            return acknowledge('run_terminal');
          }
          this.logger.warn(
            `Signal Jarvis refusé (${result.error.code}) — laissé en redelivery`,
            'jarvis-dispatch',
          );
          return false;
        case 'stale_revision':
          // Commande interactive intercalée : la redelivery du prochain tick relira la révision.
          return false;
        default:
          this.logger.warn(
            `Signal Jarvis non appliqué (${result.status}) — laissé en redelivery`,
            'jarvis-dispatch',
          );
          return false;
      }
    } catch (e) {
      this.logger.warn(
        `Signal Jarvis en échec: ${e instanceof Error ? e.message : String(e)}`,
        'jarvis-dispatch',
      );
      return false;
    }
  }
}

/** Redelivery : la vue persistée suffit à re-signaler — alias sémantique du type repository. */
export type { JarvisWorkItemPendingSignal };

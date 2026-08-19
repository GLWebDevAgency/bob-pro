/**
 * Jarvis U1-c — repository de dispatch des work items (spec Jarvis §5.3,
 * SPEC_U1C_ADMISSION_DISPATCH_20260818 §3).
 *
 * Patron `notification-jobs` (claim CAS single-statement + lease + authorize-avant-I/O),
 * adapté au fence générationnel BIGINT de `jarvis_work_items` (U1-a) : chaque claim
 * incrémente `leaseFence` ; seul le détenteur du couple (leaseToken, leaseFence) courant
 * autorise ou écrit un résultat. Une lease expirée est TOUJOURS récupérable (§5.3, revue
 * C10) : `claimDue` reprend aussi les lignes `leased` dont la lease a expiré (CAS fence+1,
 * token neuf) ; les lignes `authorized` expirées sont reprises par `reclaimExpiredAuthorized`
 * (fence+1, token neuf, statut INCHANGÉ — `authorized` est le point de non-retour, jamais de
 * retour à `prepared`) et routées par le worker vers la réconciliation.
 *
 * RLS — option zéro-amendement (SPEC_U1C §3) : aucune policy neuve. Chaque méthode
 * s'exécute sous les GUC de la LIGNE CIBLE — company/user posés par `withIsolatedOwner`,
 * mission (`app.current_agent_mission_id` = runId) posé ici — et réutilise les policies
 * U1-a inchangées. Le repository n'INSÈRE jamais : l'admission (§5.2) reste l'unique
 * inserteur de work items, dans SA transaction.
 *
 * Horloge : `statement_timestamp()` PostgreSQL partout — aucune horloge ambiante ne décide
 * d'une échéance, d'un fence ou d'un vieillissement.
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from './prisma.service';

/** Union fermée §5.3 — miroir exact du bloc GENERATED JARVIS_WORK_ITEM_STATUSES (U1-a). */
export type JarvisWorkItemStatus =
  | 'prepared'
  | 'leased'
  | 'authorized'
  | 'retry_due'
  | 'succeeded'
  | 'failed_terminal'
  | 'outcome_unknown'
  | 'cancelling'
  | 'cancelled';

/**
 * Issues persistables d'un règlement de work item par le détenteur du lease.
 * `outcome_unknown` = résultat indécidable, JAMAIS de retry aveugle derrière (§5.3).
 */
export type JarvisWorkItemResultStatus = 'succeeded' | 'failed_terminal' | 'outcome_unknown';

/**
 * Coordonnées complètes de la ligne cible. Elles proviennent d'un directory serveur
 * (jamais d'un client) : le repository les transforme en GUC de transaction pour que les
 * policies U1-a — épinglées company/user/mission — s'appliquent fail-closed.
 */
export interface JarvisWorkItemCoordinates {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly runId: string;
}

/** Vue du work item réclamé : tout ce que la revalidation (2ᵉ transaction) doit relire. */
export interface JarvisWorkItemLease {
  readonly id: string;
  readonly effectId: string;
  readonly actionId: string;
  readonly actionVersion: number;
  /** Union fermée §5.3 (confirmation | mandateGrant | certifiedSystemRule) — parsée en aval. */
  readonly authorizationSource: unknown;
  readonly actingPrincipalId: string;
  readonly targetDigest: string | null;
  readonly payloadRef: unknown;
  readonly executeBy: string;
  readonly attempts: number;
  readonly leaseToken: string;
  /** Fence générationnel APRÈS incrément : la seule autorité d'écriture de ce claim. */
  readonly leaseFence: bigint;
  readonly leaseExpiresAt: string;
}

/** Résultat persisté dont le signal n'est pas encore appliqué (redelivery level-triggered). */
export interface JarvisWorkItemPendingSignal {
  readonly id: string;
  readonly effectId: string;
  readonly status: JarvisWorkItemStatus;
  readonly resultDigest: string;
  readonly leaseFence: bigint;
  readonly updatedAt: string;
}

export interface ClaimDueJarvisWorkItemsInput {
  /** Identité d'exploitation du worker (diagnostic), jamais une autorité. */
  readonly leaseOwner: string;
  /** Token NEUF généré par l'appelant pour ce claim ; l'autorité est (token, fence). */
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
}

export interface AuthorizeJarvisWorkItemInput {
  readonly id: string;
  readonly leaseToken: string;
  readonly leaseFence: bigint;
  readonly authorizationDigest: string;
}

export interface StoreJarvisWorkItemResultInput {
  readonly id: string;
  readonly leaseToken: string;
  readonly leaseFence: bigint;
  readonly status: JarvisWorkItemResultStatus;
  readonly resultDigest: string;
}

export interface MarkJarvisWorkItemRetryDueInput {
  readonly id: string;
  readonly leaseToken: string;
  readonly leaseFence: bigint;
  readonly retryDelayMs: number;
}

export interface CancelUnauthorizedJarvisWorkItemInput {
  readonly id: string;
  /** Fence observé par l'annuleur : un claim intercalé (fence+1) fait perdre le cancel. */
  readonly expectedLeaseFence: bigint;
  /** Digest du résultat no-effect : le règlement d'annulation est signalé, jamais tacite. */
  readonly noEffectResultDigest: string;
}

export interface MarkJarvisWorkItemSignalAppliedInput {
  readonly id: string;
  readonly leaseFence: bigint;
  readonly resultDigest: string;
}

/**
 * Repository de dispatch §5.3 sur `jarvis_work_items`. Toutes les mutations sont des
 * compare-and-swap single-statement ; aucune lecture préalable ne décide d'une écriture.
 */
export interface JarvisWorkItemsDispatchRepository {
  /**
   * Claim atomique des work items dus du run : `prepared|retry_due` dû OU `leased` à lease
   * EXPIRÉE (worker mort avant autorisation — revue C10) → `leased`, `leaseFence + 1`,
   * token neuf, `leaseExpiresAt` posé — un seul UPDATE CAS, un seul gagnant par ligne.
   * Ne reprend JAMAIS une ligne `authorized` (point de non-retour).
   */
  claimDue(
    coordinates: JarvisWorkItemCoordinates,
    input: ClaimDueJarvisWorkItemsInput,
  ): Promise<readonly JarvisWorkItemLease[]>;
  /**
   * Reprise des lignes `authorized` dont la lease a expiré (worker mort APRÈS le point de
   * non-retour — §5.3, revue C10) : CAS fence+1, token neuf, statut INCHANGÉ `authorized`
   * — jamais re-`prepared`. Le worker route ces reprises vers la réconciliation : en U1-c
   * le registre d'exécuteurs VIDE prouve qu'aucune I/O n'a pu partir (règlement
   * `outcome_unknown` motif `executor_unregistered`, puis signal).
   */
  reclaimExpiredAuthorized(
    coordinates: JarvisWorkItemCoordinates,
    input: ClaimDueJarvisWorkItemsInput,
  ): Promise<readonly JarvisWorkItemLease[]>;
  /**
   * Point de non-retour `leased -> authorized`, réservé au détenteur du (token, fence)
   * courant dont la lease couvre encore l'instant base ; `authorizedAt` et
   * `authorizationDigest` sont posés ENSEMBLE (CHECK U1-a).
   */
  authorize(
    coordinates: JarvisWorkItemCoordinates,
    input: AuthorizeJarvisWorkItemInput,
  ): Promise<boolean>;
  /**
   * Résultat immuable fencé : `resultDigest` n'est écrit qu'une fois (jamais réécrit),
   * par le détenteur du (token, fence) courant. `succeeded`/`outcome_unknown` exigent
   * `authorized` ; `failed_terminal` est aussi permis depuis `leased` (refus de
   * revalidation AVANT toute I/O). La lease est libérée, le fence reste.
   */
  storeResult(
    coordinates: JarvisWorkItemCoordinates,
    input: StoreJarvisWorkItemResultInput,
  ): Promise<boolean>;
  /** Échec transitoire AVANT autorisation : `leased -> retry_due` avec backoff, fencé. */
  markRetryDue(
    coordinates: JarvisWorkItemCoordinates,
    input: MarkJarvisWorkItemRetryDueInput,
  ): Promise<boolean>;
  /**
   * Annulation d'un effet non autorisé : `prepared|leased -> cancelled`, conditionnée au
   * fence observé — cancel et authorize concourent sur la même ligne et le même fence,
   * une seule transition gagne (§5.3). Pose le résultat no-effect pour que le règlement
   * soit signalé au run par la voie canonique.
   */
  cancelUnauthorized(
    coordinates: JarvisWorkItemCoordinates,
    input: CancelUnauthorizedJarvisWorkItemInput,
  ): Promise<boolean>;
  /**
   * Redelivery level-triggered (§5.3) : résultats persistés dont le signal n'est pas
   * appliqué — porté par l'index partiel U1-a (`signalAppliedAt IS NULL AND
   * resultDigest IS NOT NULL`). Lecture pure, zéro verrou.
   */
  listPendingSignals(
    coordinates: JarvisWorkItemCoordinates,
    limit: number,
  ): Promise<readonly JarvisWorkItemPendingSignal[]>;
  /**
   * Acquittement du signal, fencé et épinglé au digest attendu : un signal stale est un
   * no-op EXPLICITE (false), jamais un écrasement silencieux.
   */
  markSignalApplied(
    coordinates: JarvisWorkItemCoordinates,
    input: MarkJarvisWorkItemSignalAppliedInput,
  ): Promise<boolean>;
}

const DISPATCH_TRANSACTION_OPTIONS = {
  maxWaitMs: 5_000,
  timeoutMs: 15_000,
} as const;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_LEASE_DURATION_MS = 30 * 60_000;
const MAX_RETRY_DELAY_MS = 120 * 60_000;
const MAX_CLAIM_LIMIT = 100;

function assertSha256Digest(value: string, label: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new Error(`Digest ${label} Jarvis invalide : sha-256 hexadécimal minuscule attendu.`);
  }
}

function assertLeaseFence(fence: bigint): void {
  if (fence < 0n) {
    throw new Error('Fence de lease Jarvis invalide : il est monotone et jamais négatif.');
  }
}

function assertLeaseDuration(leaseDurationMs: number): void {
  if (
    !Number.isInteger(leaseDurationMs) ||
    leaseDurationMs <= 0 ||
    leaseDurationMs > MAX_LEASE_DURATION_MS
  ) {
    throw new Error('Durée de lease Jarvis invalide.');
  }
}

function toIsoString(value: Date, label: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`Horodatage ${label} Jarvis corrompu.`);
  }
  return value.toISOString();
}

interface ClaimedJarvisWorkItemRow {
  readonly id: string;
  readonly effectId: string;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly authorizationSource: unknown;
  readonly actingPrincipalId: string;
  readonly targetDigest: string | null;
  readonly payloadRef: unknown;
  readonly executeBy: Date;
  readonly attempts: number;
  readonly leaseToken: string;
  readonly leaseFence: bigint;
  readonly leaseExpiresAt: Date;
}

function claimedRowToLease(row: ClaimedJarvisWorkItemRow): JarvisWorkItemLease {
  if (typeof row.leaseFence !== 'bigint' || row.leaseFence < 1n) {
    throw new Error('Claim Jarvis corrompu : fence de lease absent ou non incrémenté.');
  }
  return {
    id: row.id,
    effectId: row.effectId,
    actionId: row.actionId,
    actionVersion: row.actionVersion,
    authorizationSource: row.authorizationSource,
    actingPrincipalId: row.actingPrincipalId,
    targetDigest: row.targetDigest,
    payloadRef: row.payloadRef,
    executeBy: toIsoString(row.executeBy, 'executeBy'),
    attempts: row.attempts,
    leaseToken: row.leaseToken,
    leaseFence: row.leaseFence,
    leaseExpiresAt: toIsoString(row.leaseExpiresAt, 'leaseExpiresAt'),
  };
}

export class PrismaJarvisWorkItemsRepository implements JarvisWorkItemsDispatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Toute méthode ouvre SA transaction courte sous les GUC de la ligne cible (option
   * zéro-amendement SPEC_U1C §3) : company/user par `withIsolatedOwner`, mission ici.
   * Les policies U1-a s'appliquent telles quelles ; sans coordonnées exactes, la base
   * ne montre ni ne mute rien (fail-closed).
   */
  private withRowAuthority<T>(
    coordinates: JarvisWorkItemCoordinates,
    readOnly: boolean,
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withIsolatedOwner(
      coordinates.companyId,
      coordinates.ownerUserId,
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT
            set_config('lock_timeout', '5s', true),
            set_config('statement_timeout', '10s', true),
            set_config('app.current_agent_mission_id', ${coordinates.runId}, true)
        `;
        return work(transaction);
      },
      { ...DISPATCH_TRANSACTION_OPTIONS, readOnly },
    );
  }

  async claimDue(
    coordinates: JarvisWorkItemCoordinates,
    input: ClaimDueJarvisWorkItemsInput,
  ): Promise<readonly JarvisWorkItemLease[]> {
    assertLeaseDuration(input.leaseDurationMs);
    const safeLimit = Math.max(1, Math.min(input.limit, MAX_CLAIM_LIMIT));
    // Un seul UPDATE CAS, une seule horloge. Le fence est incrémenté PAR le claim : tout
    // détenteur antérieur devient stale à l'instant où la ligne est reprise. Le verrou de
    // ligne du SELECT candidat re-évalue ses prédicats après attente (READ COMMITTED) :
    // deux claims concurrents ne produisent qu'un gagnant par ligne. Une ligne `leased`
    // dont la lease a EXPIRÉ est reprise ici (revue C10) : son détenteur mort devient
    // stale par le fence+1 — jamais une ligne stranded, jamais une ligne `authorized`.
    const rows = await this.withRowAuthority(
      coordinates,
      false,
      (transaction) =>
        transaction.$queryRaw<ClaimedJarvisWorkItemRow[]>`
        WITH candidate AS (
          SELECT "id"
            FROM public.jarvis_work_items
           WHERE "companyId" = ${coordinates.companyId}
             AND "ownerUserId" = ${coordinates.ownerUserId}
             AND "runId" = ${coordinates.runId}::uuid
             AND (
               (
                 "status" IN ('prepared', 'retry_due')
                 AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= statement_timestamp())
               )
               OR (
                 "status" = 'leased'
                 AND "leaseExpiresAt" < statement_timestamp()
               )
             )
           ORDER BY "nextAttemptAt" ASC NULLS FIRST, "createdAt" ASC, "id" ASC
           LIMIT ${safeLimit}
           FOR UPDATE
        )
        UPDATE public.jarvis_work_items AS item
           SET "status" = 'leased',
               "leaseOwner" = ${input.leaseOwner},
               "leaseToken" = ${input.leaseToken}::uuid,
               "leaseFence" = item."leaseFence" + 1,
               "leaseExpiresAt" =
                 statement_timestamp() + (${input.leaseDurationMs} * INTERVAL '1 millisecond'),
               "updatedAt" = statement_timestamp()
          FROM candidate
         WHERE item."id" = candidate."id"
        RETURNING item."id", item."effectId", item."actionId", item."actionVersion",
                  item."authorizationSource", item."actingPrincipalId", item."targetDigest",
                  item."payloadRef", item."executeBy", item."attempts",
                  item."leaseToken", item."leaseFence", item."leaseExpiresAt"
      `,
    );
    return rows.map(claimedRowToLease);
  }

  async reclaimExpiredAuthorized(
    coordinates: JarvisWorkItemCoordinates,
    input: ClaimDueJarvisWorkItemsInput,
  ): Promise<readonly JarvisWorkItemLease[]> {
    assertLeaseDuration(input.leaseDurationMs);
    const safeLimit = Math.max(1, Math.min(input.limit, MAX_CLAIM_LIMIT));
    // Reprise post-point-de-non-retour (revue C10) : statut INCHANGÉ `authorized` — jamais
    // re-`prepared` (§5.3). Le CAS fence+1 rend stale le détenteur mort ; un `storeResult`
    // tardif de l'ancien détenteur (fence périmé) rend false, jamais un écrasement. Seules
    // les lignes SANS résultat sont reprises : un résultat persisté n'attend plus personne.
    const rows = await this.withRowAuthority(
      coordinates,
      false,
      (transaction) =>
        transaction.$queryRaw<ClaimedJarvisWorkItemRow[]>`
        WITH candidate AS (
          SELECT "id"
            FROM public.jarvis_work_items
           WHERE "companyId" = ${coordinates.companyId}
             AND "ownerUserId" = ${coordinates.ownerUserId}
             AND "runId" = ${coordinates.runId}::uuid
             AND "status" = 'authorized'
             AND "resultDigest" IS NULL
             AND "leaseExpiresAt" IS NOT NULL
             AND "leaseExpiresAt" < statement_timestamp()
           ORDER BY "leaseExpiresAt" ASC, "id" ASC
           LIMIT ${safeLimit}
           FOR UPDATE
        )
        UPDATE public.jarvis_work_items AS item
           SET "leaseOwner" = ${input.leaseOwner},
               "leaseToken" = ${input.leaseToken}::uuid,
               "leaseFence" = item."leaseFence" + 1,
               "leaseExpiresAt" =
                 statement_timestamp() + (${input.leaseDurationMs} * INTERVAL '1 millisecond'),
               "updatedAt" = statement_timestamp()
          FROM candidate
         WHERE item."id" = candidate."id"
        RETURNING item."id", item."effectId", item."actionId", item."actionVersion",
                  item."authorizationSource", item."actingPrincipalId", item."targetDigest",
                  item."payloadRef", item."executeBy", item."attempts",
                  item."leaseToken", item."leaseFence", item."leaseExpiresAt"
      `,
    );
    return rows.map(claimedRowToLease);
  }

  async authorize(
    coordinates: JarvisWorkItemCoordinates,
    input: AuthorizeJarvisWorkItemInput,
  ): Promise<boolean> {
    assertLeaseFence(input.leaseFence);
    assertSha256Digest(input.authorizationDigest, "d'autorisation");
    // authorizedAt + authorizationDigest ENSEMBLE (CHECK U1-a) ; la lease doit encore
    // couvrir l'instant base — un worker suspendu au-delà de sa fenêtre n'autorise pas.
    // §5.3 étape 2 (revue C12) : `executeBy` tient DANS la transaction qui autorise —
    // jamais seulement dans une revalidation applicative antérieure. Échéance passée ⇒
    // l'autorisation échoue et l'appelant route en cancel no-effect.
    const count = await this.withRowAuthority(
      coordinates,
      false,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE public.jarvis_work_items
           SET "status" = 'authorized',
               "authorizedAt" = statement_timestamp(),
               "authorizationDigest" = ${input.authorizationDigest},
               "updatedAt" = statement_timestamp()
         WHERE "id" = ${input.id}::uuid
           AND "companyId" = ${coordinates.companyId}
           AND "ownerUserId" = ${coordinates.ownerUserId}
           AND "runId" = ${coordinates.runId}::uuid
           AND "status" = 'leased'
           AND "leaseToken" = ${input.leaseToken}::uuid
           AND "leaseFence" = ${input.leaseFence}
           AND "leaseExpiresAt" > statement_timestamp()
           AND "executeBy" >= statement_timestamp()
           AND "authorizedAt" IS NULL
           AND "resultDigest" IS NULL
      `,
    );
    return count === 1;
  }

  async storeResult(
    coordinates: JarvisWorkItemCoordinates,
    input: StoreJarvisWorkItemResultInput,
  ): Promise<boolean> {
    assertLeaseFence(input.leaseFence);
    assertSha256Digest(input.resultDigest, 'de résultat');
    // Pas de condition d'expiration ici : après `authorized`, l'issue externe réelle vaut
    // plus qu'une fenêtre — seul le fence protège contre un successeur. `resultDigest`
    // est immuable : la ligne n'est écrite que si aucun résultat n'existe.
    const count = await this.withRowAuthority(
      coordinates,
      false,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE public.jarvis_work_items
           SET "status" = ${input.status},
               "resultDigest" = ${input.resultDigest},
               "leaseToken" = NULL,
               "leaseExpiresAt" = NULL,
               "updatedAt" = statement_timestamp()
         WHERE "id" = ${input.id}::uuid
           AND "companyId" = ${coordinates.companyId}
           AND "ownerUserId" = ${coordinates.ownerUserId}
           AND "runId" = ${coordinates.runId}::uuid
           AND "leaseToken" = ${input.leaseToken}::uuid
           AND "leaseFence" = ${input.leaseFence}
           AND "resultDigest" IS NULL
           AND (
             "status" = 'authorized'
             OR ("status" = 'leased' AND ${input.status} = 'failed_terminal')
           )
      `,
    );
    return count === 1;
  }

  async markRetryDue(
    coordinates: JarvisWorkItemCoordinates,
    input: MarkJarvisWorkItemRetryDueInput,
  ): Promise<boolean> {
    assertLeaseFence(input.leaseFence);
    if (
      !Number.isInteger(input.retryDelayMs) ||
      input.retryDelayMs < 1 ||
      input.retryDelayMs > MAX_RETRY_DELAY_MS
    ) {
      throw new Error('Délai de retry Jarvis invalide.');
    }
    const count = await this.withRowAuthority(
      coordinates,
      false,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE public.jarvis_work_items
           SET "status" = 'retry_due',
               "attempts" = "attempts" + 1,
               "nextAttemptAt" =
                 statement_timestamp() + (${input.retryDelayMs} * INTERVAL '1 millisecond'),
               "leaseToken" = NULL,
               "leaseExpiresAt" = NULL,
               "updatedAt" = statement_timestamp()
         WHERE "id" = ${input.id}::uuid
           AND "companyId" = ${coordinates.companyId}
           AND "ownerUserId" = ${coordinates.ownerUserId}
           AND "runId" = ${coordinates.runId}::uuid
           AND "status" = 'leased'
           AND "leaseToken" = ${input.leaseToken}::uuid
           AND "leaseFence" = ${input.leaseFence}
           AND "authorizedAt" IS NULL
      `,
    );
    return count === 1;
  }

  async cancelUnauthorized(
    coordinates: JarvisWorkItemCoordinates,
    input: CancelUnauthorizedJarvisWorkItemInput,
  ): Promise<boolean> {
    assertLeaseFence(input.expectedLeaseFence);
    assertSha256Digest(input.noEffectResultDigest, 'no-effect');
    // Cancel et authorize concourent sur la même ligne et le même fence : la première
    // transition committée gagne, l'autre re-évalue ses prédicats et rend false. Un
    // claim intercalé (fence+1) fait aussi perdre le cancel — l'appelant relit.
    const count = await this.withRowAuthority(
      coordinates,
      false,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE public.jarvis_work_items
           SET "status" = 'cancelled',
               "resultDigest" = ${input.noEffectResultDigest},
               "leaseToken" = NULL,
               "leaseExpiresAt" = NULL,
               "updatedAt" = statement_timestamp()
         WHERE "id" = ${input.id}::uuid
           AND "companyId" = ${coordinates.companyId}
           AND "ownerUserId" = ${coordinates.ownerUserId}
           AND "runId" = ${coordinates.runId}::uuid
           AND "status" IN ('prepared', 'leased')
           AND "leaseFence" = ${input.expectedLeaseFence}
           AND "authorizedAt" IS NULL
           AND "resultDigest" IS NULL
      `,
    );
    return count === 1;
  }

  async listPendingSignals(
    coordinates: JarvisWorkItemCoordinates,
    limit: number,
  ): Promise<readonly JarvisWorkItemPendingSignal[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_CLAIM_LIMIT));
    const rows = await this.withRowAuthority(
      coordinates,
      true,
      (transaction) =>
        transaction.$queryRaw<
          Array<{
            id: string;
            effectId: string;
            status: JarvisWorkItemStatus;
            resultDigest: string;
            leaseFence: bigint;
            updatedAt: Date;
          }>
        >`
        SELECT "id", "effectId", "status", "resultDigest", "leaseFence", "updatedAt"
          FROM public.jarvis_work_items
         WHERE "companyId" = ${coordinates.companyId}
           AND "ownerUserId" = ${coordinates.ownerUserId}
           AND "runId" = ${coordinates.runId}::uuid
           AND "signalAppliedAt" IS NULL
           AND "resultDigest" IS NOT NULL
         ORDER BY "updatedAt" ASC, "id" ASC
         LIMIT ${safeLimit}
      `,
    );
    return rows.map((row) => ({
      id: row.id,
      effectId: row.effectId,
      status: row.status,
      resultDigest: row.resultDigest,
      leaseFence: row.leaseFence,
      updatedAt: toIsoString(row.updatedAt, 'updatedAt'),
    }));
  }

  async markSignalApplied(
    coordinates: JarvisWorkItemCoordinates,
    input: MarkJarvisWorkItemSignalAppliedInput,
  ): Promise<boolean> {
    assertLeaseFence(input.leaseFence);
    assertSha256Digest(input.resultDigest, 'de résultat attendu');
    const count = await this.withRowAuthority(
      coordinates,
      false,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE public.jarvis_work_items
           SET "signalAppliedAt" = statement_timestamp(),
               "updatedAt" = statement_timestamp()
         WHERE "id" = ${input.id}::uuid
           AND "companyId" = ${coordinates.companyId}
           AND "ownerUserId" = ${coordinates.ownerUserId}
           AND "runId" = ${coordinates.runId}::uuid
           AND "resultDigest" = ${input.resultDigest}
           AND "signalAppliedAt" IS NULL
           AND "leaseFence" = ${input.leaseFence}
      `,
    );
    return count === 1;
  }
}

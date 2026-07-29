import { randomUUID } from 'node:crypto';
import type { AgentRunKind } from '@bob/ai';
import {
  openRealtimeControl,
  sealRealtimeControl,
  type RealtimeActionableControl,
  type RealtimeControlKeyRing,
  type RealtimeControlSealKeys,
} from './realtime-control-seal';
import type {
  RealtimeControlGrantIssueResult,
  RealtimeControlOwnerFence,
  RealtimeControlRepositoryPort,
} from './realtime-control.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_CONTROL_TTL_SECONDS = 120;

export interface RealtimeDurableControlConfig {
  readonly sealKeys: RealtimeControlSealKeys;
  readonly keyRing: RealtimeControlKeyRing;
  readonly maxTtlSeconds?: number;
}

export interface RealtimeDurableControlIssueInput extends RealtimeControlOwnerFence {
  readonly companyId: string;
  readonly sessionId: string;
  /** Tour autoritatif de l'artefact, notamment `redemptionId` pour Mistral. */
  readonly turnId: string;
  readonly artifactId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly kind: AgentRunKind;
  readonly navigate?: string;
  readonly proposalId?: string;
  readonly proposalExpiresAt?: string;
}

export type RealtimeDurableControlIssueResult =
  | { readonly status: 'not_required' }
  | RealtimeControlGrantIssueResult;

export interface RealtimeDurableControlConsumeInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Identité durable de l'ACK audio, générée une fois par le mobile. */
  readonly acknowledgementId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export type RealtimeDurableControlConsumption =
  | { readonly status: 'approved'; readonly control: RealtimeActionableControl; readonly idempotent: boolean }
  | { readonly status: 'not_found' | 'conflict' | 'unavailable' };

export interface RealtimeDurableControlPort {
  issue(input: RealtimeDurableControlIssueInput): Promise<RealtimeDurableControlIssueResult>;
  consume(input: RealtimeDurableControlConsumeInput): Promise<RealtimeDurableControlConsumption>;
}

export class DisabledRealtimeDurableControlAuthority implements RealtimeDurableControlPort {
  async issue(): Promise<RealtimeDurableControlIssueResult> {
    return { status: 'unavailable' };
  }

  async consume(): Promise<RealtimeDurableControlConsumption> {
    return { status: 'unavailable' };
  }
}

export interface RealtimeDurableControlEntropy {
  grantId(): string;
}

function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INT_MAX;
}

function validOwner(input: RealtimeControlOwnerFence): boolean {
  return SHA256_HEX.test(input.subjectHash)
    && validVersion(input.sidebandOwnerEpoch)
    && SHA256_HEX.test(input.sidebandOwnerTokenHash);
}

function validBinding(input: {
  readonly companyId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly artifactId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}): boolean {
  return COMPANY_ID.test(input.companyId)
    && UUID.test(input.sessionId)
    && UUID.test(input.turnId)
    && UUID.test(input.artifactId)
    && validVersion(input.contextRevision)
    && SHA256_HEX.test(input.contextDigest);
}

function validConsumption(input: RealtimeDurableControlConsumeInput): boolean {
  return COMPANY_ID.test(input.companyId)
    && SHA256_HEX.test(input.subjectHash)
    && UUID.test(input.sessionId)
    && UUID.test(input.turnId)
    && UUID.test(input.acknowledgementId)
    && validVersion(input.contextRevision)
    && SHA256_HEX.test(input.contextDigest);
}

function actionable(input: RealtimeDurableControlIssueInput): boolean {
  return input.navigate !== undefined || input.proposalId !== undefined;
}

/**
 * Autorité applicative des contrôles Bob Live.
 *
 * Elle ne déclenche jamais navigation ou mutation. Elle transforme seulement un outcome du cerveau
 * en capacité opaque, puis échange une preuve d'ACK audio durable contre ce payload one-shot.
 */
export class RealtimeDurableControlAuthority implements RealtimeDurableControlPort {
  private readonly maxTtlSeconds: number;

  constructor(
    private readonly repository: RealtimeControlRepositoryPort,
    private readonly config: RealtimeDurableControlConfig,
    private readonly entropy: RealtimeDurableControlEntropy = { grantId: randomUUID },
  ) {
    this.maxTtlSeconds = config.maxTtlSeconds ?? MAX_CONTROL_TTL_SECONDS;
    if (!Number.isSafeInteger(this.maxTtlSeconds)
      || this.maxTtlSeconds < 1
      || this.maxTtlSeconds > MAX_CONTROL_TTL_SECONDS) {
      throw new Error('Invalid realtime control TTL.');
    }
  }

  async issue(input: RealtimeDurableControlIssueInput): Promise<RealtimeDurableControlIssueResult> {
    if (!actionable(input)) return { status: 'not_required' };
    if (!validBinding(input) || !validOwner(input)) return { status: 'unavailable' };
    const grantId = this.entropy.grantId();
    if (!UUID.test(grantId)) return { status: 'unavailable' };
    const binding = {
      companyId: input.companyId,
      sessionId: input.sessionId.toLowerCase(),
      // Le contrôle hérite toujours de l'identité du tour acoustique, jamais de celle du LLM.
      turnId: input.turnId.toLowerCase(),
      artifactId: input.artifactId.toLowerCase(),
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
    };
    let sealed;
    try {
      sealed = sealRealtimeControl({
        turnId: binding.turnId,
        kind: input.kind,
        contextRevision: binding.contextRevision,
        contextDigest: binding.contextDigest,
        ...(input.navigate === undefined ? {} : { navigate: input.navigate }),
        ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
        ...(input.proposalExpiresAt === undefined
          ? {}
          : { proposalExpiresAt: input.proposalExpiresAt }),
      }, binding, this.config.sealKeys);
    } catch {
      return { status: 'unavailable' };
    }
    return this.repository.issue({
      ...binding,
      subjectHash: input.subjectHash,
      sidebandOwnerEpoch: input.sidebandOwnerEpoch,
      sidebandOwnerTokenHash: input.sidebandOwnerTokenHash,
      grantId: grantId.toLowerCase(),
      maxTtlSeconds: this.maxTtlSeconds,
      proposalExpiresAt: input.proposalExpiresAt ?? null,
      ...sealed,
    });
  }

  async consume(
    input: RealtimeDurableControlConsumeInput,
  ): Promise<RealtimeDurableControlConsumption> {
    if (!validConsumption(input)) return { status: 'not_found' };
    let read;
    try {
      read = await this.repository.readConsumable({
        ...input,
        sessionId: input.sessionId.toLowerCase(),
        turnId: input.turnId.toLowerCase(),
        acknowledgementId: input.acknowledgementId.toLowerCase(),
      });
    } catch {
      return { status: 'unavailable' };
    }
    if (read.status !== 'eligible') return read;
    const grant = read.grant;
    if (!(grant.databaseNow instanceof Date) || Number.isNaN(grant.databaseNow.getTime())) {
      return { status: 'unavailable' };
    }
    const control = openRealtimeControl(grant, grant, this.config.keyRing, grant.databaseNow.getTime());
    if (!control
      || control.turnId !== input.turnId.toLowerCase()
      || control.contextRevision !== input.contextRevision
      || control.contextDigest !== input.contextDigest) {
      return { status: 'unavailable' };
    }
    let consumed;
    try {
      consumed = await this.repository.consume({
        companyId: input.companyId,
        subjectHash: input.subjectHash,
        sessionId: input.sessionId.toLowerCase(),
        turnId: input.turnId.toLowerCase(),
        acknowledgementId: input.acknowledgementId.toLowerCase(),
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        grantId: grant.grantId,
        artifactId: grant.artifactId,
        sidebandOwnerEpoch: grant.sidebandOwnerEpoch,
        sidebandOwnerTokenHash: grant.sidebandOwnerTokenHash,
        controlPayloadHmac: grant.controlPayloadHmac,
      });
    } catch {
      return { status: 'unavailable' };
    }
    if (consumed.status !== 'consumed') return consumed;
    // Le même ACK acoustique est un reçu durable rejouable. C'est indispensable quand le commit
    // PostgreSQL réussit mais que le HTTP 200 se perd : le mobile doit retrouver le contrôle exact
    // sans rouvrir la capacité pour un autre ACK. La déduplication de l'effet UI reste un ledger
    // borné côté session mobile.
    return {
      status: 'approved',
      control,
      idempotent: consumed.idempotent,
    };
  }
}

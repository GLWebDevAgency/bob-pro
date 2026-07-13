import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  AcceptCabinetInvitation,
  ChangeCabinetMemberRole,
  CreateCabinet,
  EvaluateReleaseFlag,
  GetCabinet,
  InviteCabinetMember,
  ListCabinetMembers,
  ListCabinetsForUser,
  ResolveCabinetActor,
  RevokeCabinetInvitation,
  RestoreCabinetMember,
  RevokeCabinetMember,
  SuspendCabinetMember,
  SystemClock,
  cabinetInvitationToView,
  type AppError,
  type CabinetMemberView,
  type CabinetRole,
  type CabinetView,
  type NotificationPort,
  type Result,
} from '@bob/core';
import { NOTIFIER } from '../notifications/notifier';
import { SUPABASE_ADMIN, type SupabaseAdminPort } from '../auth/supabase-admin';
import { AppLogger, getPrincipal } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import { PERSISTENCE, type Persistence } from '../persistence/persistence';
import { jobCabinetIds } from '../config/env';
import { CabinetOptimisticConflictError, CabinetPersistenceConflictError } from './cabinet-infrastructure';

const CABINET_SLICE_FLAG = 'cabinet.slice0';
const DELIVERY_LEASE_MS = 60_000;
type DeliveryGate = {
  status: 'open' | 'feature_disabled' | 'cabinet_inactive';
  actorRole: 'admin' | 'manager' | null;
};

export interface CabinetSummaryResponse extends CabinetView {
  membership: {
    id: string;
    role: CabinetRole;
    status: 'active';
  };
}

function releaseEnvironment(): 'development' | 'staging' | 'production' {
  const value = process.env.CABINET_RELEASE_ENV;
  return value === 'staging' || value === 'production' ? value : 'development';
}

function domainCode(error: AppError): { status: number; code: string; params?: Record<string, unknown> } {
  if (error.kind === 'not_found') {
    return {
      status: HttpStatus.NOT_FOUND,
      code: error.entity === 'cabinet_invitation' ? 'CABINET_INVITATION_INVALID' : 'CABINET_NOT_FOUND',
    };
  }
  if (error.kind === 'forbidden') {
    return { status: HttpStatus.FORBIDDEN, code: 'CABINET_FORBIDDEN', params: { reason: error.reason } };
  }
  if (error.kind === 'conflict') {
    return { status: HttpStatus.CONFLICT, code: 'CABINET_CONFLICT', params: { reason: error.reason } };
  }
  if (error.kind === 'validation') {
    return { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'CABINET_VALIDATION', params: { issues: error.issues } };
  }
  if (error.kind === 'dependency') {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, code: 'CABINET_DEPENDENCY_UNAVAILABLE' };
  }
  if (error.kind === 'rate_limited') {
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'CABINET_RATE_LIMITED',
      params: { retryAfterSeconds: error.retryAfterSeconds },
    };
  }
  if (error.kind === 'unavailable') {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, code: 'CABINET_DEPENDENCY_UNAVAILABLE' };
  }

  const domain = error.error;
  switch (domain.code) {
    case 'CABINET_LAST_ADMIN_REQUIRED':
      return { status: HttpStatus.CONFLICT, code: domain.code, params: { cabinetId: domain.cabinetId } };
    case 'CABINET_INVITATION_EXPIRED':
      return { status: HttpStatus.GONE, code: domain.code, params: { expiresAt: domain.expiresAt } };
    case 'CABINET_INVITATION_ALREADY_USED':
      return { status: HttpStatus.CONFLICT, code: domain.code };
    case 'CABINET_INVITATION_EMAIL_MISMATCH':
      // Capacité liée à l'email vérifié : un porteur non destinataire reçoit exactement la même
      // réponse qu'un jeton invalide (parité avec la policy cabinet_invitation_select qui cache
      // l'invitation en prod). Ne jamais confirmer qu'un jeton volé est valide.
      return { status: HttpStatus.NOT_FOUND, code: 'CABINET_INVITATION_INVALID' };
    case 'CABINET_MEMBER_ALREADY_EXISTS':
      return { status: HttpStatus.CONFLICT, code: domain.code };
    case 'VALIDATION':
      return { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'CABINET_VALIDATION', params: { field: domain.field } };
    case 'INVALID_TRANSITION':
      return { status: HttpStatus.CONFLICT, code: 'CABINET_CONFLICT', params: { from: domain.from, to: domain.to } };
    default:
      return { status: HttpStatus.UNPROCESSABLE_ENTITY, code: domain.code };
  }
}

function unwrapCabinet<T>(result: Result<T, AppError>, operation: string, metrics: Metrics): T {
  if (result.ok) return result.value;
  const mapped = domainCode(result.error);
  if (mapped.status === HttpStatus.FORBIDDEN) {
    metrics.cabinetAuthorizationDenials.inc({ operation, reason: String(mapped.params?.reason ?? mapped.code) });
  }
  throw new HttpException({ code: mapped.code, ...(mapped.params ? { params: mapped.params } : {}) }, mapped.status);
}

@Injectable()
export class CabinetApiService {
  private readonly clock = new SystemClock();
  private readonly ids = { newId: (): string => randomUUID() };
  private readonly identityCache = new Map<string, {
    expiresAt: number;
    value: { email: string | null; displayName: string | null };
  }>();

  constructor(
    @Inject(PERSISTENCE) private readonly persistence: Persistence,
    @Inject(NOTIFIER) private readonly notifier: NotificationPort,
    @Inject(SUPABASE_ADMIN) private readonly supabaseAdmin: SupabaseAdminPort,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async availability(): Promise<{ enabled: boolean; source: string; flagVersion: number | null }> {
    const principal = this.principal();
    return this.persistence.runWithIdentity(principal.userId, async () => {
      const userDecision = await this.evaluateFlag(principal.userId);
      if (userDecision.enabled) return userDecision;
      const cabinets = await this.persistence.cabinet.cabinets.listByUserId(principal.userId);
      for (const cabinet of cabinets) {
        const decision = await this.persistence.runWithCabinet(principal.userId, cabinet.id, () =>
          this.evaluateFlag(principal.userId, cabinet.id),
        );
        if (decision.enabled) return decision;
      }
      return userDecision;
    });
  }

  async listCabinets(): Promise<{ items: CabinetSummaryResponse[] }> {
    const principal = this.principal();
    return this.operation('list_cabinets', () =>
      this.persistence.runWithIdentity(principal.userId, async () => {
        const useCase = new ListCabinetsForUser(this.persistence.cabinet.cabinets);
        const cabinets = unwrapCabinet(await useCase.execute({ userId: principal.userId }), 'list_cabinets', this.metrics);
        const items: CabinetSummaryResponse[] = [];
        for (const cabinet of cabinets) {
          await this.persistence.runWithCabinet(principal.userId, cabinet.id, async () => {
            const decision = await this.evaluateFlag(principal.userId, cabinet.id);
            if (!decision.enabled) return;
            const aggregate = await this.persistence.cabinet.cabinets.findById(cabinet.id);
            const member = aggregate?.activeMemberForUser(principal.userId);
            if (member) {
              items.push({
                ...cabinet,
                membership: { id: member.id, role: member.role, status: 'active' },
              });
            }
          });
        }
        return { items };
      }),
    );
  }

  async createCabinet(input: { name: string; timeZone?: string }): Promise<CabinetSummaryResponse> {
    const principal = this.principal();
    return this.operation('create_cabinet', async () => {
      const cabinet = await this.persistence.runWithIdentity(principal.userId, async () => {
        await this.requireEnabled(principal.userId);
        const timeZone = input.timeZone?.trim() || 'Europe/Paris';
        try {
          new Intl.DateTimeFormat('fr-FR', { timeZone }).format(new Date());
        } catch {
          throw new HttpException({ code: 'CABINET_VALIDATION', params: { field: 'timeZone' } }, HttpStatus.UNPROCESSABLE_ENTITY);
        }
        const useCase = new CreateCabinet({
          cabinets: this.persistence.cabinet.cabinets,
          ids: this.ids,
          clock: this.clock,
          uow: this.persistence,
        });
        return unwrapCabinet(
          await useCase.execute({
            name: input.name ?? '',
            timeZone,
            creatorUserId: principal.userId,
          }),
          'create_cabinet',
          this.metrics,
        );
      });
      return this.persistence.runWithCabinet(principal.userId, cabinet.id, async () => {
        const aggregate = await this.persistence.cabinet.cabinets.findById(cabinet.id);
        const member = aggregate?.activeMemberForUser(principal.userId);
        if (!member) throw new HttpException({ code: 'CABINET_FORBIDDEN' }, HttpStatus.FORBIDDEN);
        return { ...cabinet, membership: { id: member.id, role: member.role, status: 'active' } };
      });
    });
  }

  async getCabinet(cabinetId: string): Promise<CabinetSummaryResponse> {
    const principal = this.principal();
    return this.withCabinet('get_cabinet', cabinetId, async () => {
      const useCase = new GetCabinet(this.persistence.cabinet.cabinets);
      const cabinet = unwrapCabinet(
        await useCase.execute({ cabinetId, actorUserId: principal.userId }),
        'get_cabinet',
        this.metrics,
      );
      const aggregate = await this.persistence.cabinet.cabinets.findById(cabinetId);
      const member = aggregate?.activeMemberForUser(principal.userId);
      // Parité RLS : membership disparue entre les deux lectures → même 404 qu'un cabinet inconnu
      // (en prod, cabinet_select rend le cabinet invisible ; pas d'oracle d'existence).
      if (!member) throw new HttpException({ code: 'CABINET_NOT_FOUND' }, HttpStatus.NOT_FOUND);
      return { ...cabinet, membership: { id: member.id, role: member.role, status: 'active' } };
    });
  }

  async listMembers(cabinetId: string, input: { cursor?: string; limit?: number } = {}) {
    const principal = this.principal();
    return this.withCabinet('list_members', cabinetId, async () => {
      const useCase = new ListCabinetMembers(this.persistence.cabinet.cabinets);
      const items = unwrapCabinet(
        await useCase.execute({ cabinetId, actorUserId: principal.userId }),
        'list_members',
        this.metrics,
      );
      const start = input.cursor ? items.findIndex((member) => member.id === input.cursor) + 1 : 0;
      if (input.cursor && start === 0) {
        throw new HttpException({ code: 'CABINET_VALIDATION', params: { field: 'cursor' } }, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
      const pageItems = items.slice(start, start + limit);
      const enriched = await this.mapWithConcurrency(pageItems, 8, async (member) => ({
        ...member,
        ...(await this.identityForRoster(member.userId)),
      }));
      const hasMore = items.length > start + limit;
      return {
        items: enriched,
        nextCursor: hasMore ? (pageItems.at(-1)?.id ?? null) : null,
        hasMore,
      };
    });
  }

  async listInvitations(cabinetId: string, input: { cursor?: string; limit?: number } = {}) {
    const principal = this.principal();
    return this.withCabinet('list_invitations', cabinetId, async () => {
      const actor = unwrapCabinet(
        await new ResolveCabinetActor(this.persistence.cabinet.cabinets).execute({
          cabinetId,
          authenticatedUserId: principal.userId,
        }),
        'list_invitations',
        this.metrics,
      );
      if (!actor.permissions.includes('cabinet.members.invite_basic')) {
        throw new HttpException({ code: 'CABINET_FORBIDDEN' }, HttpStatus.FORBIDDEN);
      }
      const page = await this.persistence.cabinet.invitationQueries.listPendingPage({
        cabinetId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit ?? 50,
      });
      return {
        items: page.items.map((invitation) => cabinetInvitationToView(invitation, this.clock.now())),
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      };
    });
  }

  async inviteMember(cabinetId: string, input: { email: string; role: CabinetRole }) {
    const principal = this.principal();
    if (!['admin', 'manager', 'collaborator'].includes(input.role as string)) {
      throw new HttpException({ code: 'CABINET_VALIDATION', params: { field: 'role' } }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const invitation = await this.withCabinet('invite_member', cabinetId, async () => {
      const useCase = new InviteCabinetMember({
        cabinets: this.persistence.cabinet.cabinets,
        invitations: this.persistence.cabinet.invitations,
        tokens: this.persistence.cabinet.tokens,
        dispatch: this.persistence.cabinet.dispatch,
        ids: this.ids,
        clock: this.clock,
        uow: this.persistence,
      });
      return unwrapCabinet(
        await useCase.execute({
          cabinetId,
          actorUserId: principal.userId,
          email: input.email ?? '',
          role: input.role,
        }),
        'invite_member',
        this.metrics,
      );
    });

    await this.deliverOne(cabinetId, principal.userId, invitation.id);
    const deliveryStatus = await this.persistence.runWithCabinet(principal.userId, cabinetId, () =>
      this.persistence.cabinet.deliveries.statusForInvitation(invitation.id),
    );
    return { invitation, delivery: { status: deliveryStatus ?? 'pending' } };
  }

  async revokeInvitation(cabinetId: string, invitationId: string) {
    const principal = this.principal();
    return this.withCabinet('revoke_invitation', cabinetId, async () => {
      const useCase = new RevokeCabinetInvitation({
        cabinets: this.persistence.cabinet.cabinets,
        invitations: this.persistence.cabinet.invitations,
        clock: this.clock,
        uow: this.persistence,
      });
      return unwrapCabinet(
        await useCase.execute({ cabinetId, invitationId, actorUserId: principal.userId }),
        'revoke_invitation',
        this.metrics,
      );
    });
  }

  async retryInvitationDeliveries(cabinetId: string): Promise<{ status: string }> {
    const principal = this.principal();
    await this.withCabinet('retry_invitation_delivery', cabinetId, async () => {
      const useCase = new ResolveCabinetActor(this.persistence.cabinet.cabinets);
      const actor = unwrapCabinet(
        await useCase.execute({ cabinetId, authenticatedUserId: principal.userId }),
        'retry_invitation_delivery',
        this.metrics,
      );
      if (actor.role === 'collaborator') {
        throw new HttpException({ code: 'CABINET_FORBIDDEN' }, HttpStatus.FORBIDDEN);
      }
    });
    return { status: (await this.deliverOne(cabinetId, principal.userId)) ?? 'idle' };
  }

  /** Worker borné : le user de service doit être une membership active autorisée dans chaque cabinet. */
  async processInvitationDeliveries(cabinetId: string, workerUserId: string, limit = 10): Promise<number> {
    await this.persistence.runWithCabinet(workerUserId, cabinetId, async () => {
      const cabinet = await this.persistence.cabinet.cabinets.findById(cabinetId);
      const actor = cabinet?.activeMemberForUser(workerUserId);
      if (!actor || actor.role !== 'admin') {
        throw new HttpException({ code: 'CABINET_WORKER_ADMIN_REQUIRED' }, HttpStatus.FORBIDDEN);
      }
      const now = this.clock.now();
      const expiredIds = await this.persistence.cabinet.invitationQueries.listExpiredPendingIds({
        cabinetId,
        now,
        limit: 10,
      });
      for (const invitationId of expiredIds) {
        const locked = await this.persistence.cabinet.invitations.lockById(invitationId);
        if (!locked || locked.status !== 'pending' || locked.effectiveStatus(now) !== 'expired') continue;
        const expectedVersion = locked.version;
        const expired = locked.expire(now);
        if (!expired.ok) continue;
        await this.persistence.cabinet.invitations.save(locked, expectedVersion);
        this.metrics.cabinetInvitationDeliveries.inc({ outcome: 'expired_cancelled' });
      }
    });
    let processed = 0;
    for (let index = 0; index < Math.max(0, Math.min(limit, 10)); index += 1) {
      const status = await this.deliverOne(cabinetId, workerUserId);
      if (status === null) break;
      processed += 1;
    }
    const oldestEncryptedAt = await this.persistence.runWithCabinet(workerUserId, cabinetId, () =>
      this.persistence.cabinet.deliveries.oldestEncryptedCreatedAt(cabinetId),
    );
    const nowSeconds = Date.now() / 1_000;
    this.metrics.cabinetInvitationOldestEncryptedSeconds.set(
      { cabinet_id: cabinetId },
      oldestEncryptedAt ? Math.max(0, nowSeconds - Date.parse(oldestEncryptedAt) / 1_000) : 0,
    );
    this.metrics.cabinetInvitationWorkerLastSuccess.set({ cabinet_id: cabinetId }, nowSeconds);
    return processed;
  }

  async acceptInvitation(input: { token: string }): Promise<{
    cabinet: CabinetSummaryResponse;
    membership: CabinetMemberView;
  }> {
    const principal = this.principal();
    if (!input.token?.trim()) {
      throw new HttpException({ code: 'CABINET_VALIDATION', params: { field: 'token' } }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const verifiedEmail = await this.resolveVerifiedEmail(principal);
    if (!verifiedEmail) {
      throw new HttpException({ code: 'CABINET_INVITATION_EMAIL_UNVERIFIED' }, HttpStatus.FORBIDDEN);
    }
    return this.operation('accept_invitation', async () => {
      const hash = await this.persistence.cabinet.tokens.hash(input.token ?? '');
      const membership = await this.persistence.runWithCabinetInvitation(
        principal.userId,
        verifiedEmail,
        hash.value,
        async () => {
          const invitation = await this.persistence.cabinet.invitations.lockByTokenHash(hash);
          if (!invitation || invitation.email !== verifiedEmail.trim().toLowerCase()) {
            throw new HttpException({ code: 'CABINET_INVITATION_INVALID' }, HttpStatus.NOT_FOUND);
          }
          await this.persistence.cabinet.cabinets.lockById(invitation.cabinetId);
          await this.requireEnabled(principal.userId, invitation.cabinetId);
          const useCase = new AcceptCabinetInvitation({
            cabinets: this.persistence.cabinet.cabinets,
            invitations: this.persistence.cabinet.invitations,
            tokens: this.persistence.cabinet.tokens,
            ids: this.ids,
            clock: this.clock,
            uow: this.persistence,
          });
          return unwrapCabinet(
            await useCase.execute({
              rawToken: input.token ?? '',
              authenticatedUserId: principal.userId,
              verifiedEmail,
            }),
            'accept_invitation',
            this.metrics,
          );
        },
      );
      const cabinet = await this.getCabinet(membership.cabinetId);
      return { cabinet, membership };
    });
  }

  async updateMember(
    cabinetId: string,
    memberId: string,
    input: { role?: CabinetRole; status?: 'active' | 'suspended' | 'revoked' },
  ): Promise<CabinetMemberView> {
    const principal = this.principal();
    const keys = Object.keys(input);
    const validRole = input.role === undefined || ['admin', 'manager', 'collaborator'].includes(input.role as string);
    const validStatus = input.status === undefined || ['active', 'suspended', 'revoked'].includes(input.status as string);
    if (
      keys.some((key) => key !== 'role' && key !== 'status') ||
      !validRole ||
      !validStatus ||
      (input.role !== undefined ? 1 : 0) + (input.status !== undefined ? 1 : 0) !== 1
    ) {
      throw new HttpException(
        { code: 'CABINET_VALIDATION', params: { fields: ['role', 'status'] } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.withCabinet('update_member', cabinetId, async () => {
      const workerUserId = process.env.CABINET_INVITATION_WORKER_USER_ID?.trim();
      if (
        process.env.CABINET_INVITATION_WORKER_ENABLED === 'true' &&
        workerUserId &&
        jobCabinetIds().includes(cabinetId)
      ) {
        const aggregate = await this.persistence.cabinet.cabinets.findById(cabinetId);
        if (aggregate?.memberById(memberId)?.userId === workerUserId) {
          throw new HttpException(
            { code: 'CABINET_WORKER_MEMBERSHIP_IMMUTABLE' },
            HttpStatus.CONFLICT,
          );
        }
      }
      const deps = { cabinets: this.persistence.cabinet.cabinets, clock: this.clock, uow: this.persistence };
      const base = { cabinetId, actorUserId: principal.userId, memberId };
      const result = input.role
        ? new ChangeCabinetMemberRole(deps).execute({ ...base, role: input.role })
        : input.status === 'active'
          ? new RestoreCabinetMember(deps).execute(base)
          : input.status === 'suspended'
            ? new SuspendCabinetMember(deps).execute(base)
            : new RevokeCabinetMember(deps).execute(base);
      return unwrapCabinet(await result, 'update_member', this.metrics);
    });
  }

  private async withCabinet<T>(operation: string, cabinetId: string, fn: () => Promise<T>): Promise<T> {
    const principal = this.principal();
    return this.operation(operation, () =>
      this.persistence.runWithCabinet(principal.userId, cabinetId, async () => {
        await this.requireEnabled(principal.userId, cabinetId);
        return fn();
      }),
    );
  }

  private async evaluateFlag(userId: string, cabinetId?: string) {
    const useCase = new EvaluateReleaseFlag(this.persistence.cabinet.flags);
    const result = await useCase.execute({
      environment: releaseEnvironment(),
      key: CABINET_SLICE_FLAG,
      userId,
      ...(cabinetId ? { cabinetId } : {}),
    });
    const decision = unwrapCabinet(result, 'evaluate_release_flag', this.metrics);
    this.metrics.cabinetFlagEvaluations.inc({
      key: CABINET_SLICE_FLAG,
      source: decision.source,
      enabled: String(decision.enabled),
    });
    return decision;
  }

  private async requireEnabled(userId: string, cabinetId?: string): Promise<void> {
    const decision = await this.evaluateFlag(userId, cabinetId);
    if (!decision.enabled) {
      throw new HttpException(
        { code: 'CABINET_FEATURE_DISABLED', params: { source: decision.source } },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async deliverOne(cabinetId: string, actorUserId: string, invitationId?: string): Promise<string | null> {
    const gateBeforeClaim = await this.deliveryGate(cabinetId, actorUserId);
    if (gateBeforeClaim.status !== 'open' || !gateBeforeClaim.actorRole) {
      this.metrics.cabinetInvitationDeliveries.inc({
        outcome: gateBeforeClaim.status === 'cabinet_inactive' ? 'skipped_cabinet_inactive' : 'skipped_flag_disabled',
      });
      return null;
    }
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const delivery = await this.persistence.runWithCabinet(actorUserId, cabinetId, () => {
      const input = {
        cabinetId,
        now: now.toISOString(),
        leaseUntil: leaseUntil.toISOString(),
        allowedInvitationRoles: gateBeforeClaim.actorRole === 'admin'
          ? ['admin', 'manager', 'collaborator'] as const
          : ['collaborator'] as const,
      };
      return invitationId
        ? this.persistence.cabinet.deliveries.claimForInvitation({ ...input, invitationId })
        : this.persistence.cabinet.deliveries.claimNext(input);
    });
    if (!delivery) return null;

    const gateBeforeSend = await this.deliveryGate(cabinetId, actorUserId);
    if (gateBeforeSend.status !== 'open') {
      // Si le cabinet vient d'être suspendu, la RLS interdit aussi de muter le job : on laisse le
      // lease expirer sans envoyer. Une réactivation permettra un claim fenced ultérieur.
      if (gateBeforeSend.status === 'feature_disabled') {
        try {
          await this.persistence.runWithCabinet(actorUserId, cabinetId, () =>
            this.persistence.cabinet.deliveries.markFailed({
              id: delivery.id,
              expectedAttempts: delivery.attempts,
              failedAt: new Date().toISOString(),
              nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
              error: 'release_flag_disabled',
            }),
          );
        } catch (error) {
          if (!(error instanceof CabinetPersistenceConflictError)) throw error;
        }
      }
      this.metrics.cabinetInvitationDeliveries.inc({
        outcome: gateBeforeSend.status === 'cabinet_inactive' ? 'skipped_cabinet_inactive' : 'skipped_flag_disabled',
      });
      return null;
    }

    let rawToken: string;
    try {
      rawToken = this.persistence.cabinet.decryptInvitationToken(delivery);
      const baseUrl = (process.env.CABINET_INVITATION_WEB_BASE_URL ?? 'https://demo.bobpro.fr/cabinet')
        .replace(/#.*$/, '');
      const invitationLink = `${baseUrl}#invitation=${encodeURIComponent(rawToken)}`;
      await this.notifier.send({
        channel: 'email',
        to: delivery.email,
        idempotencyKey: delivery.id,
        subject: `Invitation à rejoindre ${delivery.cabinetName}`,
        body: [
          `Vous êtes invité à rejoindre ${delivery.cabinetName} dans Bob Pro.`,
          'Ouvrez ce lien sécurisé pour accepter l’invitation :',
          invitationLink,
          `Ce code expire le ${delivery.expiresAt}.`,
        ].join('\n\n'),
      });
    } catch {
      const failedAt = new Date();
      const delayMs = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(delivery.attempts, 6));
      try {
        await this.persistence.runWithCabinet(actorUserId, cabinetId, () =>
          this.persistence.cabinet.deliveries.markFailed({
            id: delivery.id,
            expectedAttempts: delivery.attempts,
            failedAt: failedAt.toISOString(),
            nextAttemptAt: new Date(failedAt.getTime() + delayMs).toISOString(),
            error: 'delivery_provider_error',
          }),
        );
      } catch (error) {
        if (error instanceof CabinetPersistenceConflictError) {
          this.metrics.cabinetInvitationDeliveries.inc({ outcome: 'terminal_or_stale' });
          return 'cancelled';
        }
        throw error;
      }
      this.logger.warn('Invitation cabinet conservée dans l’outbox après échec de livraison.', 'CabinetInvitation');
      this.metrics.cabinetInvitationDeliveries.inc({ outcome: 'failed' });
      return 'failed';
    }

    try {
      const sentAt = new Date().toISOString();
      await this.persistence.runWithCabinet(actorUserId, cabinetId, () =>
        this.persistence.cabinet.deliveries.markDone({
          id: delivery.id,
          expectedAttempts: delivery.attempts,
          sentAt,
        }),
      );
      this.logger.audit('cabinet.invitation.delivered', {
        cabinetId,
        invitationId: delivery.invitationId,
        attempts: delivery.attempts,
      });
      this.metrics.cabinetInvitationDeliveries.inc({ outcome: 'done' });
      return 'done';
    } catch (error) {
      if (error instanceof CabinetPersistenceConflictError) {
        this.metrics.cabinetInvitationDeliveries.inc({ outcome: 'terminal_or_stale' });
        return 'cancelled';
      }
      throw error;
    }
  }

  private principal() {
    const principal = getPrincipal();
    if (!principal?.userId) {
      throw new HttpException({ code: 'CABINET_UNAUTHENTICATED' }, HttpStatus.UNAUTHORIZED);
    }
    return principal;
  }

  private async deliveryGate(
    cabinetId: string,
    actorUserId: string,
  ): Promise<DeliveryGate> {
    return this.persistence.runWithCabinet(actorUserId, cabinetId, async () => {
      const cabinet = await this.persistence.cabinet.cabinets.findById(cabinetId);
      const actor = cabinet?.activeMemberForUser(actorUserId);
      if (!cabinet || cabinet.status !== 'active' || !actor || actor.role === 'collaborator') {
        return { status: 'cabinet_inactive', actorRole: null };
      }
      return {
        status: (await this.evaluateFlag(actorUserId, cabinetId)).enabled ? 'open' : 'feature_disabled',
        actorRole: actor.role,
      };
    });
  }

  private async resolveVerifiedEmail(principal: ReturnType<CabinetApiService['principal']>): Promise<string | null> {
    if (process.env.DEMO_MODE !== 'false') {
      return principal.emailVerified === true && principal.email ? principal.email.trim().toLowerCase() : null;
    }
    if (!this.supabaseAdmin.getVerifiedEmail) {
      throw new HttpException({ code: 'CABINET_IDENTITY_PROVIDER_UNAVAILABLE' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    try {
      return await this.supabaseAdmin.getVerifiedEmail(principal.userId);
    } catch {
      throw new HttpException({ code: 'CABINET_IDENTITY_PROVIDER_UNAVAILABLE' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  private async identityForRoster(userId: string): Promise<{ email: string | null; displayName: string | null }> {
    const cached = this.identityCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (!this.supabaseAdmin.getUserIdentity || process.env.DEMO_MODE !== 'false') {
      return { email: null, displayName: null };
    }
    try {
      const value = await this.supabaseAdmin.getUserIdentity(userId);
      this.identityCache.set(userId, { expiresAt: Date.now() + 5 * 60_000, value });
      return value;
    } catch {
      return { email: null, displayName: null };
    }
  }

  private async mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
    const output = new Array<U>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(items[index]!);
      }
    });
    await Promise.all(workers);
    return output;
  }

  private async operation<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      const value = await fn();
      this.metrics.cabinetOperations.inc({ operation: name, outcome: 'success' });
      return value;
    } catch (error) {
      this.metrics.cabinetOperations.inc({ operation: name, outcome: 'failure' });
      if (error instanceof CabinetOptimisticConflictError || error instanceof CabinetPersistenceConflictError) {
        throw new HttpException({ code: 'CABINET_CONFLICT', params: { reason: error.message } }, HttpStatus.CONFLICT);
      }
      throw error;
    }
  }
}

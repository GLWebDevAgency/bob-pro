import { HttpException } from '@nestjs/common';
import {
  QUOTE_DRAFT_PAYLOAD_SCHEMA,
  QUOTE_DRAFT_PAYLOAD_VERSION,
  type QuoteDraftPayloadV1,
} from '@bob/core';
import { describe, expect, it, vi } from 'vitest';
import { AppLogger, requestContext, type Principal } from '../observability/logger';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import { QuoteDraftController } from './quote-draft.controller';
import { QuoteDraftService } from './quote-draft.service';

function payload(sessionId: string): QuoteDraftPayloadV1 {
  return {
    schema: QUOTE_DRAFT_PAYLOAD_SCHEMA,
    version: QUOTE_DRAFT_PAYLOAD_VERSION,
    draft: {
      sessionId,
      contentRevision: 0,
      stagingRevision: 0,
      step: 'client',
      customer: null,
      lines: [],
      lineMetadata: [],
      lineForm: { label: '', quantity: '1', unitPrice: '', category: 'labor' },
      vatDecision: null,
      depositPct: 30,
      signMode: null,
    },
  };
}

function asPrincipal<T>(principal: Principal, operation: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'quote-draft-test', principal }, operation);
}

function harness() {
  const persistence = new InMemoryPersistence();
  const logger = { audit: vi.fn() } as unknown as AppLogger;
  const service = new QuoteDraftService(persistence, logger);
  return { persistence, logger, service, controller: new QuoteDraftController(service) };
}

describe('QuoteDraftService — identité JWT, isolation et CAS', () => {
  it('isole le slot par société ET propriétaire issus du Principal', async () => {
    const { service } = harness();

    const created = await asPrincipal(
      { companyId: 'company-a', userId: 'owner-a' },
      () => service.saveCurrent({ expectedRevision: 0, payload: payload('draft-a') }),
    );
    expect(created).toMatchObject({ ok: true, value: { revision: 1 } });

    const foreignOwner = await asPrincipal(
      { companyId: 'company-a', userId: 'owner-b' },
      () => service.getCurrent(),
    );
    expect(foreignOwner).toEqual({ ok: true, value: { slot: null } });

    const foreignTenant = await asPrincipal(
      { companyId: 'company-b', userId: 'owner-a' },
      () => service.getCurrent(),
    );
    expect(foreignTenant).toEqual({ ok: true, value: { slot: null } });

    const owner = await asPrincipal(
      { companyId: 'company-a', userId: 'owner-a' },
      () => service.getCurrent(),
    );
    expect(owner).toMatchObject({
      ok: true,
      value: { slot: { revision: 1, payload: { draft: { sessionId: 'draft-a' } } } },
    });
  });

  it('refuse les sauvegardes et suppressions sur révision périmée', async () => {
    const { service } = harness();
    const principal = { companyId: 'company-a', userId: 'owner-a' } satisfies Principal;

    await asPrincipal(principal, () =>
      service.saveCurrent({ expectedRevision: 0, payload: payload('revision-1') }),
    );
    const staleCreate = await asPrincipal(principal, () =>
      service.saveCurrent({ expectedRevision: 0, payload: payload('duplicate') }),
    );
    expect(staleCreate).toEqual({
      ok: false,
      error: { kind: 'conflict', entity: 'quote_draft_slot', reason: 'stale_revision' },
    });

    const updated = await asPrincipal(principal, () =>
      service.saveCurrent({ expectedRevision: 1, payload: payload('revision-2') }),
    );
    expect(updated).toMatchObject({ ok: true, value: { revision: 2 } });

    const staleDelete = await asPrincipal(principal, () =>
      service.deleteCurrent({ expectedRevision: 1 }),
    );
    expect(staleDelete).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(await asPrincipal(principal, () => service.deleteCurrent({ expectedRevision: 2 })))
      .toEqual({ ok: true, value: { deleted: true } });
  });

  it('échoue explicitement sans propriétaire et tenant authentifiés', async () => {
    const { service } = harness();
    expect(await service.getCurrent()).toEqual({
      ok: false,
      error: { kind: 'forbidden', reason: 'authenticated_quote_draft_owner_required' },
    });
    expect(await asPrincipal({ companyId: null, userId: 'owner-a' }, () => service.getCurrent()))
      .toEqual({
        ok: false,
        error: { kind: 'forbidden', reason: 'authenticated_quote_draft_owner_required' },
      });
  });

  it('restaure le slot test-only lors du rollback du harness', async () => {
    const { persistence } = harness();
    await expect(persistence.runInTransaction(async () => {
      await persistence.quoteDraftSlots.upsert({
        companyId: 'company-a',
        ownerUserId: 'owner-a',
        expectedRevision: 0,
        payload: payload('rolled-back'),
      });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await persistence.quoteDraftSlots.get({ companyId: 'company-a', ownerUserId: 'owner-a' }))
      .toBeNull();
  });

  it('laisse lire mais bloque save/delete legacy pendant la possession AgentMission', async () => {
    const { persistence, service } = harness();
    const principal = { companyId: 'company-a', userId: 'owner-a' } satisfies Principal;
    await asPrincipal(principal, () =>
      service.saveCurrent({ expectedRevision: 0, payload: payload('mission-owned') }),
    );
    persistence.agentMissionDraftFence.setOwned(true);

    expect(await asPrincipal(principal, () => service.getCurrent())).toMatchObject({
      ok: true,
      value: { slot: { revision: 1 } },
    });
    expect(await asPrincipal(principal, () =>
      service.saveCurrent({ expectedRevision: 1, payload: payload('forbidden-update') }),
    )).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'quote_draft_slot',
        reason: 'owned_by_agent_mission',
      },
    });
    expect(await asPrincipal(principal, () =>
      service.deleteCurrent({ expectedRevision: 1 }),
    )).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'quote_draft_slot',
        reason: 'owned_by_agent_mission',
      },
    });
  });

  it.each([
    ['closed', { kind: 'forbidden', reason: 'company_closed' }],
    ['missing', { kind: 'not_found', entity: 'company', id: 'current' }],
  ] as const)(
    'refuse save/delete sans exécuter le writer lorsque la société est %s',
    async (reason, expectedError) => {
      const { persistence, service } = harness();
      const principal = { companyId: 'company-a', userId: 'owner-a' } satisfies Principal;
      persistence.agentMissionDraftFence.setCompanyUnavailable(reason);

      expect(await asPrincipal(principal, () =>
        service.saveCurrent({ expectedRevision: 0, payload: payload('must-not-exist') }),
      )).toEqual({ ok: false, error: expectedError });
      expect(await asPrincipal(principal, () =>
        service.deleteCurrent({ expectedRevision: 1 }),
      )).toEqual({ ok: false, error: expectedError });
      expect(await persistence.quoteDraftSlots.get({
        companyId: principal.companyId,
        ownerUserId: principal.userId,
      })).toBeNull();
    },
  );
});

describe('QuoteDraftController — frontière HTTP stricte', () => {
  it.each(['companyId', 'ownerUserId'])('refuse le champ d’identité forgé %s', async (field) => {
    const { controller } = harness();
    const request = {
      expectedRevision: 0,
      payload: payload('forged'),
      [field]: 'forged-identity',
    };
    const caught = await controller.saveCurrent(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(422);
    expect((caught as HttpException).getResponse()).toMatchObject({
      error: { kind: 'validation', issues: [{ field, message: 'Champ non autorisé.' }] },
    });
  });
});

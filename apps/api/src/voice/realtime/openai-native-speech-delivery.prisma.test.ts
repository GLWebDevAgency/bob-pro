import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  createOpenAiNativeSpeechDelivery,
  reduceOpenAiNativeSpeechDelivery,
  type OpenAiNativeSpeechDeliveryPreparation,
  type OpenAiNativeSpeechDeliveryState,
} from './openai-native-speech-delivery';
import { PrismaOpenAiNativeSpeechDeliveryRepository } from './openai-native-speech-delivery.prisma';

const COMPANY = 'company-1';
const DELIVERY = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000002';
const TURN = '00000000-0000-4000-8000-000000000003';
const CLAIM = '00000000-0000-4000-8000-000000000004';
const OTHER_DELIVERY = '00000000-0000-4000-8000-000000000005';
const ACKNOWLEDGEMENT = '00000000-0000-4000-8000-000000000006';
const DATABASE_NOW = new Date('2026-07-21T10:00:00.000Z');
const CREATED_AT_MS = DATABASE_NOW.getTime() - 1_000;
const EXPIRES_AT_MS = DATABASE_NOW.getTime() + 4 * 60_000;
const SUBJECT_HMAC = '1'.repeat(64);
const CONTEXT_HMAC = '2'.repeat(64);
const OWNER_HMAC = '3'.repeat(64);
const SPEECH_HMAC = '4'.repeat(64);
const FACTS_HMAC = '5'.repeat(64);
const NONCE_HMAC = '6'.repeat(64);
const RESPONSE_HMAC = '7'.repeat(64);
const LOCAL_OBSERVATION = Object.freeze({
  formatVersion: 1 as const,
  kind: 'webrtc_remote_rtp_observed_provider_drained_v1' as const,
});

function preparation(
  overrides: Partial<OpenAiNativeSpeechDeliveryPreparation> = {},
): OpenAiNativeSpeechDeliveryPreparation {
  return {
    deliveryId: DELIVERY,
    companyId: COMPANY,
    subjectHmac: SUBJECT_HMAC,
    subjectKeyVersion: 1,
    sessionId: SESSION,
    turnId: TURN,
    contextRevision: 7,
    contextDigest: CONTEXT_HMAC,
    sidebandOwnerEpoch: 3,
    sidebandOwnerTokenHmac: OWNER_HMAC,
    speechPolicyVersion: 1,
    speechScenarioId: 'generic_help_v1',
    proofFormatVersion: 2,
    proofKeyVersion: 2,
    canonicalSpeechHmac: SPEECH_HMAC,
    factsHmac: FACTS_HMAC,
    requestNonceHmac: NONCE_HMAC,
    provider: 'openai',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    createdAtMs: CREATED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
    ...overrides,
  };
}

function prepared(
  overrides: Partial<OpenAiNativeSpeechDeliveryPreparation> = {},
): OpenAiNativeSpeechDeliveryState {
  return createOpenAiNativeSpeechDelivery(preparation(overrides));
}

function claimed(state = prepared()): OpenAiNativeSpeechDeliveryState {
  return reduceOpenAiNativeSpeechDelivery(state, {
    type: 'CLAIM_DISPATCH',
    dispatchClaimId: CLAIM,
    atMs: DATABASE_NOW.getTime() + 1_000,
  });
}

function completed(state = prepared()): OpenAiNativeSpeechDeliveryState {
  let next = claimed(state);
  next = reduceOpenAiNativeSpeechDelivery(next, {
    type: 'MARK_REQUESTED',
    dispatchClaimId: CLAIM,
    atMs: DATABASE_NOW.getTime() + 2_000,
  });
  next = reduceOpenAiNativeSpeechDelivery(next, {
    type: 'ACCEPT_RESPONSE',
    providerResponseIdHmac: RESPONSE_HMAC,
    atMs: DATABASE_NOW.getTime() + 3_000,
  });
  next = reduceOpenAiNativeSpeechDelivery(next, {
    type: 'START_STREAMING',
    providerResponseIdHmac: RESPONSE_HMAC,
    atMs: DATABASE_NOW.getTime() + 4_000,
  });
  next = reduceOpenAiNativeSpeechDelivery(next, {
    type: 'RESPONSE_DONE',
    providerResponseIdHmac: RESPONSE_HMAC,
    outputTranscriptHmac: SPEECH_HMAC,
    atMs: DATABASE_NOW.getTime() + 5_000,
  });
  return reduceOpenAiNativeSpeechDelivery(next, {
    type: 'OUTPUT_STOPPED',
    providerResponseIdHmac: RESPONSE_HMAC,
    atMs: DATABASE_NOW.getTime() + 6_000,
  });
}

function rowFromState(
  state: OpenAiNativeSpeechDeliveryState,
  overrides: Record<string, unknown> = {},
) {
  return {
    deliveryId: state.deliveryId,
    companyId: state.companyId,
    subjectHmac: state.subjectHmac,
    subjectKeyVersion: state.subjectKeyVersion,
    sessionId: state.sessionId,
    turnId: state.turnId,
    contextRevision: state.contextRevision,
    contextDigest: state.contextDigest,
    sidebandOwnerEpoch: state.sidebandOwnerEpoch,
    sidebandOwnerTokenHmac: state.sidebandOwnerTokenHmac,
    speechPolicyVersion: state.speechPolicyVersion,
    speechScenarioId: state.speechScenarioId,
    canonicalSpeechHmac: state.canonicalSpeechHmac,
    factsHmac: state.factsHmac,
    requestNonceHmac: state.requestNonceHmac,
    proofFormatVersion: state.proofFormatVersion,
    proofKeyVersion: state.proofKeyVersion,
    provider: state.provider,
    model: state.model,
    voice: state.voice,
    version: state.version,
    revision: state.revision,
    phase: state.phase,
    dispatchClaimId: state.dispatchClaimId,
    dispatchingAt: state.dispatchingAtMs === null ? null : new Date(state.dispatchingAtMs),
    requestedAt: state.requestedAtMs === null ? null : new Date(state.requestedAtMs),
    providerResponseIdHmac: state.providerResponseIdHmac,
    acceptedAt: state.acceptedAtMs === null ? null : new Date(state.acceptedAtMs),
    streamingAt: state.streamingAtMs === null ? null : new Date(state.streamingAtMs),
    responseDoneAt: state.responseDoneAtMs === null ? null : new Date(state.responseDoneAtMs),
    outputStoppedAt: state.outputStoppedAtMs === null ? null : new Date(state.outputStoppedAtMs),
    outputTranscriptHmac: state.outputTranscriptHmac,
    completedAt: state.completedAtMs === null ? null : new Date(state.completedAtMs),
    acknowledgementId: state.acknowledgementId,
    deliveredAt: state.deliveredAtMs === null ? null : new Date(state.deliveredAtMs),
    localObservationFormatVersion: state.localObservationFormatVersion,
    localObservationKind: state.localObservationKind,
    sloFormatVersion: state.sloFormatVersion,
    speechStoppedEventToFirstInboundRtpMs: state.speechStoppedEventToFirstInboundRtpMs,
    bargeInStatus: state.bargeInStatus,
    bargeInDurationsMs: [...state.bargeInDurationsMs],
    cancellationId: state.cancellationId,
    cancellationReason: state.cancellationReason,
    failureId: state.failureId,
    failureReason: state.failureReason,
    terminalAt: state.terminalAtMs === null ? null : new Date(state.terminalAtMs),
    createdAt: new Date(state.createdAtMs),
    expiresAt: new Date(state.expiresAtMs),
    retentionExpiresAt: new Date(DATABASE_NOW.getTime() + 30 * 24 * 60 * 60_000),
    ...overrides,
  };
}

function harness(results: readonly unknown[]) {
  const queue = [...results];
  const queryRaw = vi.fn(async () => {
    if (queue.length === 0) throw new Error('Unexpected SQL query.');
    const result = queue.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  const rollback = vi.fn();
  const withIsolatedTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
    _options?: unknown,
  ) => {
    try {
      return await operation(tx);
    } catch (error) {
      rollback();
      throw error;
    }
  });
  return {
    repository: new PrismaOpenAiNativeSpeechDeliveryRepository(
      { withIsolatedTenant } as unknown as PrismaService,
    ),
    queryRaw,
    rollback,
    withIsolatedTenant,
  };
}

function queryAt(mock: ReturnType<typeof vi.fn>, index: number): { sql: string; values: unknown[] } {
  const query = mock.mock.calls[index]?.[0] as { sql?: unknown; values?: unknown } | undefined;
  return {
    sql: typeof query?.sql === 'string' ? query.sql.replace(/\s+/gu, ' ').trim() : '',
    values: Array.isArray(query?.values) ? query.values : [],
  };
}

describe('PrismaOpenAiNativeSpeechDeliveryRepository — prepare', () => {
  it('prépare sous RLS avec le fence complet, policy v1 et preuve v2 sans contenu brut', async () => {
    const state = prepared();
    const h = harness([
      [],
      [{ databaseNow: DATABASE_NOW }],
      [rowFromState(state)],
    ]);

    await expect(h.repository.prepare(state)).resolves.toEqual({ status: 'created', state });
    expect(h.withIsolatedTenant).toHaveBeenCalledWith(
      COMPANY,
      expect.any(Function),
      { maxWaitMs: 1_000, timeoutMs: 4_000 },
    );
    expect(h.queryRaw).toHaveBeenCalledTimes(3);

    const fence = queryAt(h.queryRaw, 1);
    expect(fence.sql).toContain('FOR SHARE OF lease');
    expect(fence.sql).toContain('lease."providerId" =');
    expect(fence.sql).toContain('lease."contextAppliedOwnerEpoch" =');
    expect(fence.sql).toContain('lease."sidebandProtocolVersion" = 2');

    const insert = queryAt(h.queryRaw, 2);
    expect(insert.sql).toContain('INSERT INTO realtime_native_speech_deliveries');
    expect(insert.sql).toContain('"speechPolicyVersion", "speechScenarioId"');
    expect(insert.sql).toContain('"proofFormatVersion", "proofKeyVersion"');
    expect(insert.sql).toContain('ON CONFLICT DO NOTHING');
    expect(insert.sql).not.toContain('realtime_control_grants');
    expect(insert.values).toEqual(expect.arrayContaining([
      1,
      'generic_help_v1',
      2,
      'gpt-realtime-2.1',
      'marin',
    ]));
    expect(JSON.stringify(insert.values)).not.toContain('transcript');
    expect(JSON.stringify(insert.values)).not.toContain('audio');
  });

  it('reconnaît un replay exact sans INSERT, y compris après la fenêtre live', async () => {
    const state = prepared();
    const h = harness([[rowFromState(state)]]);

    await expect(h.repository.prepare(state)).resolves.toEqual({
      status: 'already_prepared',
      state,
    });
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(queryAt(h.queryRaw, 0).sql).toMatch(/^SELECT/u);
  });

  it('distingue une collision d’un replay et refuse les états enrichis avant SQL', async () => {
    const state = prepared();
    const collision = prepared({
      deliveryId: OTHER_DELIVERY,
      requestNonceHmac: '7'.repeat(64),
    });
    const h = harness([[rowFromState(collision)]]);

    await expect(h.repository.prepare(state)).resolves.toEqual({ status: 'conflict' });

    const invalid = { ...state, transcript: 'contenu interdit' } as OpenAiNativeSpeechDeliveryState;
    const invalidHarness = harness([]);
    await expect(invalidHarness.repository.prepare(invalid)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(invalidHarness.withIsolatedTenant).not.toHaveBeenCalled();
  });

  it('rollback implicitement si la projection insérée ne correspond pas exactement', async () => {
    const state = prepared();
    const h = harness([
      [],
      [{ databaseNow: DATABASE_NOW }],
      [rowFromState(state, { speechScenarioId: 'generic_unknown_v1' })],
    ]);

    await expect(h.repository.prepare(state)).resolves.toEqual({ status: 'unavailable' });
    expect(h.rollback).toHaveBeenCalledOnce();
  });
});

describe('PrismaOpenAiNativeSpeechDeliveryRepository — read', () => {
  it('mappe exactement la projection tenantée et normalise les UUID', async () => {
    const state = prepared();
    const h = harness([[rowFromState(state, {
      deliveryId: state.deliveryId.toUpperCase(),
      sessionId: state.sessionId.toUpperCase(),
      turnId: state.turnId.toUpperCase(),
    })]]);

    await expect(h.repository.read({ companyId: COMPANY, deliveryId: DELIVERY })).resolves.toEqual({
      status: 'found',
      state,
    });
  });

  it('reste honnête pour absence, corruption et clé non canonique', async () => {
    const absent = harness([[]]);
    await expect(absent.repository.read({ companyId: COMPANY, deliveryId: DELIVERY })).resolves
      .toEqual({ status: 'not_found' });

    const corrupt = harness([[rowFromState(prepared(), { revision: 2 })]]);
    await expect(corrupt.repository.read({ companyId: COMPANY, deliveryId: DELIVERY })).resolves
      .toEqual({ status: 'unavailable' });

    const invalid = harness([]);
    await expect(invalid.repository.read({ companyId: COMPANY, deliveryId: 'not-a-uuid' })).resolves
      .toEqual({ status: 'unavailable' });
    await expect(invalid.repository.read(null as unknown as {
      companyId: string;
      deliveryId: string;
    })).resolves.toEqual({ status: 'unavailable' });
    expect(invalid.withIsolatedTenant).not.toHaveBeenCalled();
  });
});

describe('PrismaOpenAiNativeSpeechDeliveryRepository — CAS', () => {
  it('applique expectedRevision -> next avec toutes les preuves immuables dans le WHERE', async () => {
    const initial = prepared();
    const next = claimed(initial);
    const h = harness([[rowFromState(next)]]);

    await expect(h.repository.compareAndSwap({
      key: { companyId: COMPANY, deliveryId: DELIVERY },
      expectedRevision: initial.revision,
      next,
    })).resolves.toEqual({ status: 'applied', state: next });

    const update = queryAt(h.queryRaw, 0);
    expect(update.sql).toContain('UPDATE realtime_native_speech_deliveries');
    expect(update.sql).toContain('AND revision =');
    expect(update.sql).toContain('AND "speechPolicyVersion" =');
    expect(update.sql).toContain('AND "speechScenarioId" =');
    expect(update.sql).toContain('AND "proofFormatVersion" =');
    expect(update.sql).toContain('"expiresAt" > clock_timestamp()');
  });

  it('classe le replay exact après perte de réponse sans rejouer la mutation', async () => {
    const initial = prepared();
    const next = claimed(initial);
    const h = harness([[], [rowFromState(next)]]);

    await expect(h.repository.compareAndSwap({
      key: { companyId: COMPANY, deliveryId: DELIVERY },
      expectedRevision: initial.revision,
      next,
    })).resolves.toEqual({ status: 'already_applied', state: next });
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    expect(queryAt(h.queryRaw, 0).sql).toMatch(/^UPDATE/u);
    expect(queryAt(h.queryRaw, 1).sql).toMatch(/^SELECT/u);
  });

  it('persiste atomiquement l’observation RTP V1 et sa métrologie avec le premier ACK', async () => {
    const initial = completed();
    const next = reduceOpenAiNativeSpeechDelivery(initial, {
      type: 'ACK_DELIVERY',
      acknowledgementId: ACKNOWLEDGEMENT,
      deliveryId: initial.deliveryId,
      sessionId: initial.sessionId,
      turnId: initial.turnId,
      contextRevision: initial.contextRevision,
      contextDigest: initial.contextDigest,
      localObservation: LOCAL_OBSERVATION,
      slo: { speechStoppedEventToFirstInboundRtpMs: 701 },
      atMs: DATABASE_NOW.getTime() + 7_000,
    });
    const h = harness([[rowFromState(next)]]);

    await expect(h.repository.compareAndSwap({
      key: { companyId: COMPANY, deliveryId: DELIVERY },
      expectedRevision: initial.revision,
      next,
    })).resolves.toEqual({ status: 'applied', state: next });

    const update = queryAt(h.queryRaw, 0);
    expect(update.sql).toContain('"localObservationFormatVersion" =');
    expect(update.sql).toContain('"localObservationKind" =');
    expect(update.values).toEqual(expect.arrayContaining([
      1,
      LOCAL_OBSERVATION.kind,
      701,
    ]));
  });

  it('distingue conflit, absence et entrées impossibles sans fabriquer de succès', async () => {
    const initial = prepared();
    const next = claimed(initial);
    const conflict = harness([[], [rowFromState(initial)]]);
    await expect(conflict.repository.compareAndSwap({
      key: { companyId: COMPANY, deliveryId: DELIVERY },
      expectedRevision: initial.revision,
      next,
    })).resolves.toEqual({ status: 'conflict' });

    const absent = harness([[], []]);
    await expect(absent.repository.compareAndSwap({
      key: { companyId: COMPANY, deliveryId: DELIVERY },
      expectedRevision: initial.revision,
      next,
    })).resolves.toEqual({ status: 'not_found' });

    const invalid = harness([]);
    await expect(invalid.repository.compareAndSwap({
      key: { companyId: COMPANY, deliveryId: OTHER_DELIVERY },
      expectedRevision: initial.revision,
      next,
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(invalid.repository.compareAndSwap(
      null as unknown as Parameters<typeof invalid.repository.compareAndSwap>[0],
    )).resolves.toEqual({ status: 'unavailable' });
    expect(invalid.withIsolatedTenant).not.toHaveBeenCalled();
  });

  it('rollback si la projection UPDATE diverge de l’état demandé', async () => {
    const initial = prepared();
    const next = claimed(initial);
    const h = harness([[rowFromState(next, { speechScenarioId: 'generic_unknown_v1' })]]);

    await expect(h.repository.compareAndSwap({
      key: { companyId: COMPANY, deliveryId: DELIVERY },
      expectedRevision: initial.revision,
      next,
    })).resolves.toEqual({ status: 'unavailable' });
    expect(h.rollback).toHaveBeenCalledOnce();
  });

  it('absorbe toute panne SQL et ne révèle aucune erreur interne', async () => {
    const state = prepared();
    const read = harness([new Error('secret database failure')]);
    await expect(read.repository.read({ companyId: COMPANY, deliveryId: DELIVERY })).resolves
      .toEqual({ status: 'unavailable' });

    const cas = harness([new Error('secret database failure')]);
    await expect(cas.repository.compareAndSwap({
      key: { companyId: COMPANY, deliveryId: DELIVERY },
      expectedRevision: state.revision,
      next: claimed(state),
    })).resolves.toEqual({ status: 'unavailable' });
  });
});

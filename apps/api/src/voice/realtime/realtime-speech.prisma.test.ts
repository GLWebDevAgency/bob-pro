import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type {
  RealtimeSpeechArtifactClaimInput,
  RealtimeSpeechArtifactReadyInput,
} from './realtime-speech-publisher';
import { PrismaRealtimeSpeechArtifactRepository } from './realtime-speech.prisma';

const COMPANY = 'company-a';
const SUBJECT = '1'.repeat(64);
const SESSION = '00000000-0000-4000-8000-000000000001';
const TURN = '00000000-0000-4000-8000-000000000002';
const ARTIFACT = '00000000-0000-4000-8000-000000000003';
const OTHER_ARTIFACT = '00000000-0000-4000-8000-000000000004';
const CANCELLATION = '00000000-0000-4000-8000-000000000005';
const CONTEXT = '2'.repeat(64);
const CANONICAL = '3'.repeat(64);
const FACTS = '4'.repeat(64);
const TOKEN = '5'.repeat(64);
const SIDEBAND_OWNER = 'a'.repeat(64);
const OTHER_TOKEN = '6'.repeat(64);
const EVIDENCE = '7'.repeat(64);
const AUDIO = '8'.repeat(64);
const AUDIT = '9'.repeat(64);
const NOW = new Date('2026-07-13T18:00:00.000Z');

function claimInput(
  overrides: Partial<RealtimeSpeechArtifactClaimInput> = {},
): RealtimeSpeechArtifactClaimInput {
  return {
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    turnId: TURN,
    segmentIndex: 0,
    candidateArtifactId: ARTIFACT,
    contextRevision: 7,
    contextDigest: CONTEXT,
    sidebandOwnerTokenHash: SIDEBAND_OWNER,
    classification: 'fixed_safe',
    canonicalSpeechHmac: CANONICAL,
    factsHmac: FACTS,
    renderTokenHash: TOKEN,
    ...overrides,
  };
}

function readyInput(
  overrides: Partial<RealtimeSpeechArtifactReadyInput> = {},
): RealtimeSpeechArtifactReadyInput {
  return {
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    turnId: TURN,
    artifactId: ARTIFACT,
    sequence: 12,
    renderTokenHash: TOKEN,
    contextRevision: 7,
    contextDigest: CONTEXT,
    sidebandOwnerTokenHash: SIDEBAND_OWNER,
    classification: 'fixed_safe',
    source: 'preapproved_static',
    storageKey: `companies/${COMPANY}/bob-live/${SESSION}/${TURN}/${ARTIFACT}`,
    mimeType: 'audio/mpeg',
    byteLength: 4_096,
    durationMs: 1_200,
    canonicalSpeechHmac: CANONICAL,
    factsHmac: FACTS,
    auditTranscriptHmac: null,
    evidenceHmac: EVIDENCE,
    audioSha256: AUDIO,
    proofKeyVersion: 1,
    synthesisAdapterId: 'bob.static.v1',
    synthesisTrustDomain: 'bob.assets',
    auditAdapterId: null,
    auditTrustDomain: null,
    ...overrides,
  };
}

function artifactRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ARTIFACT,
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    turnId: TURN,
    sequence: 12,
    segmentIndex: 0,
    renderTokenHash: TOKEN,
    sidebandOwnerEpoch: 1,
    sidebandOwnerTokenHash: SIDEBAND_OWNER,
    state: 'rendering',
    classification: 'fixed_safe',
    source: null,
    contextRevision: 7,
    contextDigest: CONTEXT,
    storageKey: null,
    storageExpiresAt: null,
    mimeType: null,
    byteLength: null,
    durationMs: null,
    canonicalSpeechHmac: CANONICAL,
    auditTranscriptHmac: null,
    factsHmac: FACTS,
    evidenceHmac: null,
    audioSha256: null,
    proofKeyVersion: null,
    synthesisAdapterId: null,
    synthesisTrustDomain: null,
    auditAdapterId: null,
    auditTrustDomain: null,
    renderLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
    cancellationId: null,
    cancellationReasonCode: null,
    failureReasonCode: null,
    retentionExpiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1_000),
    version: 1,
    ...overrides,
  };
}

function readyRow(input: RealtimeSpeechArtifactReadyInput = readyInput()): Record<string, unknown> {
  return artifactRow({
    state: 'ready',
    source: input.source,
    storageKey: input.storageKey,
    storageExpiresAt: new Date(NOW.getTime() + 900_000),
    mimeType: input.mimeType,
    byteLength: input.byteLength,
    durationMs: input.durationMs,
    auditTranscriptHmac: input.auditTranscriptHmac,
    evidenceHmac: input.evidenceHmac,
    audioSha256: input.audioSha256,
    proofKeyVersion: input.proofKeyVersion,
    synthesisAdapterId: input.synthesisAdapterId,
    synthesisTrustDomain: input.synthesisTrustDomain,
    auditAdapterId: input.auditAdapterId,
    auditTrustDomain: input.auditTrustDomain,
    renderLeaseExpiresAt: null,
    version: 2,
  });
}

type QueryMock = ReturnType<typeof vi.fn>;

function scriptedRepository(results: readonly unknown[]): {
  repository: PrismaRealtimeSpeechArtifactRepository;
  queryRaw: QueryMock;
  withTenant: QueryMock;
} {
  const queue = [...results];
  const queryRaw = vi.fn(async () => {
    if (queue.length === 0) throw new Error('Unexpected SQL query.');
    const result = queue.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  const prisma = { withTenant } as unknown as PrismaService;
  return {
    repository: new PrismaRealtimeSpeechArtifactRepository(prisma),
    queryRaw,
    withTenant,
  };
}

function sqlAt(queryRaw: QueryMock, index: number): string {
  const strings = queryRaw.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings ? strings.join('?').replace(/\s+/gu, ' ').trim() : '';
}

class SerializedClaimPrisma {
  private tail: Promise<void> = Promise.resolve();
  private row: Record<string, unknown> | null = null;
  readonly sql: string[] = [];
  sequenceAllocations = 0;

  readonly tx = {
    $queryRaw: async (strings: readonly string[], ...values: readonly unknown[]): Promise<unknown[]> => {
      const sql = strings.join('?').replace(/\s+/gu, ' ').trim();
      this.sql.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('SELECT clock_timestamp() AS now')) return [{ now: NOW }];
      if (sql.includes('FROM realtime_speech_artifacts')) return this.row ? [{ ...this.row }] : [];
      if (sql.includes('FROM realtime_session_leases')) return [{ ok: 1, sidebandOwnerEpoch: 1 }];
      if (sql.includes('INSERT INTO realtime_speech_artifacts')) {
        if (this.row) return [];
        this.sequenceAllocations += 1;
        this.row = artifactRow({
          id: values[0],
          companyId: values[1],
          subjectHash: values[2],
          sessionId: values[3],
          turnId: values[4],
          segmentIndex: values[5],
          renderTokenHash: values[6],
          sidebandOwnerEpoch: values[7],
          sidebandOwnerTokenHash: values[8],
          classification: values[9],
          contextRevision: values[10],
          contextDigest: values[11],
          canonicalSpeechHmac: values[12],
          factsHmac: values[13],
          sequence: 1,
        });
        return [{ id: values[0], sequence: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as Prisma.TransactionClient;

  withTenant<T>(
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const run = this.tail.then(() => operation(this.tx));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

describe('Bob Live — repository acoustique Prisma durable', () => {
  it('alloue une seule séquence face à deux claims concurrents du même segment', async () => {
    const prisma = new SerializedClaimPrisma();
    const repository = new PrismaRealtimeSpeechArtifactRepository(prisma as unknown as PrismaService);
    const [winner, concurrent] = await Promise.all([
      repository.claimRender(claimInput()),
      repository.claimRender(claimInput({
        candidateArtifactId: OTHER_ARTIFACT,
        renderTokenHash: OTHER_TOKEN,
      })),
    ]);

    expect(winner).toEqual({ status: 'claimed', artifactId: ARTIFACT, sequence: 1 });
    expect(concurrent).toEqual({ status: 'busy' });
    expect(prisma.sequenceAllocations).toBe(1);
    expect(prisma.sql.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    expect(prisma.sql).toEqual(expect.arrayContaining([
      expect.stringMatching(/FROM realtime_session_leases.*FOR UPDATE/u),
    ]));
  });

  it('verrouille et revalide le lease avant l’INSERT initial', async () => {
    const claimed = scriptedRepository([
      [],
      [{ now: NOW }],
      [],
      [{ ok: 1, sidebandOwnerEpoch: 1 }],
      [{ id: ARTIFACT, sequence: 12 }],
    ]);
    await expect(claimed.repository.claimRender(claimInput())).resolves.toEqual({
      status: 'claimed', artifactId: ARTIFACT, sequence: 12,
    });
    expect(sqlAt(claimed.queryRaw, 3)).toMatch(/FROM realtime_session_leases.*FOR UPDATE/u);

    const stale = scriptedRepository([
      [],
      [{ now: NOW }],
      [],
      [],
    ]);
    await expect(stale.repository.claimRender(claimInput())).resolves.toEqual({ status: 'terminal' });
    expect(stale.queryRaw).toHaveBeenCalledTimes(4);
  });

  it('rend un retry exact idempotent et refuse de voler un lease vivant', async () => {
    const exact = scriptedRepository([
      [],
      [{ now: NOW }],
      [artifactRow()],
    ]);
    await expect(exact.repository.claimRender(claimInput())).resolves.toEqual({
      status: 'claimed', artifactId: ARTIFACT, sequence: 12,
    });
    expect(exact.queryRaw).toHaveBeenCalledTimes(3);

    const liveOther = scriptedRepository([
      [],
      [{ now: NOW }],
      [artifactRow()],
    ]);
    await expect(liveOther.repository.claimRender(claimInput({ renderTokenHash: OTHER_TOKEN })))
      .resolves.toEqual({ status: 'busy' });
    expect(liveOther.queryRaw).toHaveBeenCalledTimes(3);
  });

  it('refuse tout takeover d’un rendu expiré pour préserver la propriété de l’objet', async () => {
    const expired = artifactRow({ renderLeaseExpiresAt: new Date(NOW.getTime() - 1) });
    const takeover = scriptedRepository([
      [],
      [{ now: NOW }],
      [expired],
    ]);
    await expect(takeover.repository.claimRender(claimInput({ renderTokenHash: OTHER_TOKEN })))
      .resolves.toEqual({ status: 'terminal' });
    expect(takeover.queryRaw).toHaveBeenCalledTimes(3);
  });

  it('traite une preuve ou un contexte divergents comme terminaux sans toucher le rendu', async () => {
    const mismatch = scriptedRepository([
      [],
      [{ now: NOW }],
      [artifactRow({ canonicalSpeechHmac: 'a'.repeat(64) })],
    ]);
    await expect(mismatch.repository.claimRender(claimInput())).resolves.toEqual({ status: 'terminal' });
    expect(mismatch.queryRaw).toHaveBeenCalledTimes(3);

    const expiredRetention = scriptedRepository([
      [],
      [{ now: NOW }],
      [artifactRow({ retentionExpiresAt: new Date(NOW.getTime() - 1) })],
    ]);
    await expect(expiredRetention.repository.claimRender(claimInput()))
      .resolves.toEqual({ status: 'terminal' });
    expect(expiredRetention.queryRaw).toHaveBeenCalledTimes(3);

    const expiredReadyRow = readyRow(readyInput());
    expiredReadyRow.storageExpiresAt = new Date(NOW.getTime() - 1);
    const expiredReadyHarness = scriptedRepository([
      [],
      [{ now: NOW }],
      [expiredReadyRow],
    ]);
    await expect(expiredReadyHarness.repository.claimRender(claimInput()))
      .resolves.toEqual({ status: 'terminal' });
    expect(expiredReadyHarness.queryRaw).toHaveBeenCalledTimes(3);
  });

  it('finalise ready sous verrou lease et quatrième fence dans la même transaction', async () => {
    const harness = scriptedRepository([
      [artifactRow()],
      [{ now: NOW }],
      [{ ok: 1 }],
      [{ id: ARTIFACT }],
    ]);
    await expect(harness.repository.finalizeReady(readyInput())).resolves.toEqual({ status: 'ready' });
    expect(harness.withTenant).toHaveBeenCalledTimes(1);
    expect(sqlAt(harness.queryRaw, 0)).toMatch(/FROM realtime_speech_artifacts.*FOR UPDATE/u);
    expect(sqlAt(harness.queryRaw, 2)).toMatch(/contextDigest.*contextAppliedDigest.*FOR SHARE/u);
    expect(sqlAt(harness.queryRaw, 3)).toMatch(
      /state = 'rendering'.*"renderTokenHash" = \?.*"renderLeaseExpiresAt" > \?.*version = \?.*RETURNING id/u,
    );

    const expiredRenderer = scriptedRepository([
      [artifactRow({ renderLeaseExpiresAt: new Date(NOW.getTime() - 1) })],
      [{ now: NOW }],
    ]);
    await expect(expiredRenderer.repository.finalizeReady(readyInput()))
      .resolves.toEqual({ status: 'lost_claim' });
    expect(expiredRenderer.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('accepte une synthèse dynamique uniquement avec un audit indépendant complet', async () => {
    const dynamic = readyInput({
      classification: 'dynamic_sensitive',
      source: 'synthesized_audited',
      auditTranscriptHmac: AUDIT,
      synthesisAdapterId: 'tts.primary',
      synthesisTrustDomain: 'provider.tts',
      auditAdapterId: 'asr.auditor',
      auditTrustDomain: 'provider.asr',
    });
    const harness = scriptedRepository([
      [artifactRow({ classification: 'dynamic_sensitive' })],
      [{ now: NOW }],
      [{ ok: 1 }],
      [{ id: ARTIFACT }],
    ]);
    await expect(harness.repository.finalizeReady(dynamic)).resolves.toEqual({ status: 'ready' });
  });

  it('classe stale_context avant toute écriture et ne transforme pas une annulation en ready', async () => {
    const stale = scriptedRepository([
      [artifactRow()],
      [{ now: NOW }],
      [],
    ]);
    await expect(stale.repository.finalizeReady(readyInput())).resolves.toEqual({ status: 'stale_context' });
    expect(stale.queryRaw).toHaveBeenCalledTimes(3);

    const cancelled = scriptedRepository([
      [artifactRow({
        state: 'cancelled',
        renderLeaseExpiresAt: null,
        cancellationId: CANCELLATION,
        cancellationReasonCode: 'barge_in',
      })],
    ]);
    await expect(cancelled.repository.finalizeReady(readyInput())).resolves.toEqual({ status: 'cancelled' });
    expect(cancelled.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rend la finalisation ready strictement idempotente sur toute la preuve acoustique', async () => {
    const idempotent = scriptedRepository([[readyRow()], [{ now: NOW }]]);
    await expect(idempotent.repository.finalizeReady(readyInput())).resolves.toEqual({ status: 'ready' });

    const forged = scriptedRepository([
      [readyRow(readyInput({ audioSha256: 'a'.repeat(64) }))],
      [{ now: NOW }],
    ]);
    await expect(forged.repository.finalizeReady(readyInput())).resolves.toEqual({ status: 'lost_claim' });
    expect(forged.queryRaw).toHaveBeenCalledTimes(2);

    const expired = readyRow();
    expired.storageExpiresAt = new Date(NOW.getTime() - 1);
    const expiredHarness = scriptedRepository([[expired], [{ now: NOW }]]);
    await expect(expiredHarness.repository.finalizeReady(readyInput()))
      .resolves.toEqual({ status: 'lost_claim' });
  });

  it('rejette avant SQL les formats non certifiés, les clés forgées et les trust domains confondus', async () => {
    const unsupported = scriptedRepository([]);
    await expect(unsupported.repository.finalizeReady(readyInput({ mimeType: 'audio/webm' as never })))
      .resolves.toEqual({ status: 'lost_claim' });
    expect(unsupported.withTenant).not.toHaveBeenCalled();

    const forgedKey = scriptedRepository([]);
    await expect(forgedKey.repository.finalizeReady(readyInput({ storageKey: 'companies/other/audio' })))
      .resolves.toEqual({ status: 'lost_claim' });
    expect(forgedKey.withTenant).not.toHaveBeenCalled();

    const sameTrust = scriptedRepository([]);
    await expect(sameTrust.repository.finalizeReady(readyInput({
      classification: 'dynamic_sensitive',
      source: 'synthesized_audited',
      auditTranscriptHmac: AUDIT,
      synthesisAdapterId: 'tts.primary',
      synthesisTrustDomain: 'provider.same',
      auditAdapterId: 'asr.auditor',
      auditTrustDomain: 'provider.same',
    }))).resolves.toEqual({ status: 'lost_claim' });
    expect(sameTrust.withTenant).not.toHaveBeenCalled();
  });

  it('conserve fail/cancel en transitions exactes, minuscules et terminales', async () => {
    const invalidFailure = scriptedRepository([]);
    await invalidFailure.repository.failRender({
      companyId: COMPANY,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      renderTokenHash: TOKEN,
      sidebandOwnerTokenHash: SIDEBAND_OWNER,
      reasonCode: 'RENDER_FAILED',
    });
    expect(invalidFailure.withTenant).not.toHaveBeenCalled();

    const failure = scriptedRepository([[{ id: ARTIFACT }], []]);
    const failureInput = {
      companyId: COMPANY,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      renderTokenHash: TOKEN,
      sidebandOwnerTokenHash: SIDEBAND_OWNER,
      reasonCode: 'render_failed',
    } as const;
    await failure.repository.failRender(failureInput);
    await failure.repository.failRender(failureInput);
    expect(sqlAt(failure.queryRaw, 0)).toMatch(/state = 'rendering'.*"renderTokenHash" = \?/u);

    const cancellation = scriptedRepository([[{ id: ARTIFACT }], []]);
    const cancellationInput = {
      companyId: COMPANY,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      cancellationId: CANCELLATION,
      sidebandOwnerTokenHash: SIDEBAND_OWNER,
      reason: 'barge_in',
    } as const;
    await cancellation.repository.cancel(cancellationInput);
    await cancellation.repository.cancel(cancellationInput);
    expect(sqlAt(cancellation.queryRaw, 0)).toMatch(/state IN \('rendering', 'ready'\).*RETURNING id/u);
  });

  it('fail closed sur une indisponibilité PostgreSQL sans exposer l’erreur', async () => {
    const claim = scriptedRepository([new Error('secret database diagnostics')]);
    await expect(claim.repository.claimRender(claimInput())).resolves.toEqual({ status: 'unavailable' });

    const finalize = scriptedRepository([new Error('secret database diagnostics')]);
    await expect(finalize.repository.finalizeReady(readyInput())).resolves.toEqual({ status: 'unavailable' });
  });

  it('rejette les UUID uppercase pour rester canonique avec uuid::text et la clé stockage', async () => {
    const harness = scriptedRepository([]);
    await expect(harness.repository.claimRender(claimInput({
      sessionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    })))
      .resolves.toEqual({ status: 'unavailable' });
    expect(harness.withTenant).not.toHaveBeenCalled();
  });
});

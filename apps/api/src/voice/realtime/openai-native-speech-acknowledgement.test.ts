import { describe, expect, it, vi } from 'vitest';
import { requestContext } from '../../observability/logger';
import type {
  OpenAiNativeSpeechAuthority,
  OpenAiNativeSpeechMobileAcknowledgementOutcome,
} from './openai-native-speech-authority';
import {
  OPENAI_NATIVE_SPEECH_ACKNOWLEDGEMENT_SLO_LIMITS,
  OpenAiNativeSpeechAcknowledgementService,
  parseOpenAiNativeSpeechAcknowledgementBody,
  parseOpenAiNativeSpeechAcknowledgementPath,
} from './openai-native-speech-acknowledgement';
import { admissionSubjectHash } from './realtime.service';

const SESSION = '10000000-0000-4000-8000-000000000001';
const TURN = '20000000-0000-4000-8000-000000000002';
const DELIVERY = '30000000-0000-4000-8000-000000000003';
const ACKNOWLEDGEMENT = '40000000-0000-4000-8000-000000000004';
const CONTEXT_DIGEST = 'a'.repeat(64);
const SUBJECT_SECRET = 'subject-secret-with-at-least-thirty-two-characters';
const SUBJECT_KEY_RING = Object.freeze({
  currentVersion: 1,
  versions: Object.freeze([1]),
  secret: (version: number) => version === 1 ? SUBJECT_SECRET : null,
});
const LOCAL_OBSERVATION = Object.freeze({
  formatVersion: 1 as const,
  kind: 'webrtc_remote_rtp_observed_provider_drained_v1' as const,
});

function body() {
  return {
    acknowledgementId: ACKNOWLEDGEMENT,
    contextRevision: 7,
    contextDigest: CONTEXT_DIGEST,
    localObservation: LOCAL_OBSERVATION,
    slo: {
      speechStoppedEventToFirstInboundRtpMs: 701,
      pendingBargeIn: { status: 'complete', durationsMs: [91, 120] },
    },
  };
}

function harness(
  outcome: OpenAiNativeSpeechMobileAcknowledgementOutcome = {
    status: 'applied',
    state: {} as never,
  },
) {
  const acknowledgeMobileDelivery = vi.fn(async () => outcome);
  const logger = { audit: vi.fn(), warn: vi.fn() };
  return {
    acknowledgeMobileDelivery,
    logger,
    service: new OpenAiNativeSpeechAcknowledgementService(
      { acknowledgeMobileDelivery } as unknown as Pick<
      OpenAiNativeSpeechAuthority,
      'acknowledgeMobileDelivery'
      >,
      { enabled: true, subjectHmacKeyRing: SUBJECT_KEY_RING },
      logger as never,
    ),
  };
}

function asPrincipal<T>(run: () => T): T {
  return requestContext.run({
    correlationId: 'native-acknowledgement-test',
    principal: { userId: 'user-1', companyId: 'company-1' },
  }, run);
}

describe('OpenAI native delivery acknowledgement wire parsers', () => {
  it('normalise les identifiants et copie une observation V1 avec son lot SLO borne', () => {
    const path = parseOpenAiNativeSpeechAcknowledgementPath(
      SESSION.toUpperCase(),
      TURN.toUpperCase(),
      DELIVERY.toUpperCase(),
    );
    const parsed = parseOpenAiNativeSpeechAcknowledgementBody(body());

    expect(path).toEqual({
      ok: true,
      value: { sessionId: SESSION, turnId: TURN, deliveryId: DELIVERY },
    });
    expect(parsed).toEqual({ ok: true, value: body() });
    if (!parsed.ok || parsed.value.slo === null) throw new Error('SLO fixture missing.');
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.localObservation)).toBe(true);
    expect(Object.isFrozen(parsed.value.slo)).toBe(true);
    expect(Object.isFrozen(parsed.value.slo.pendingBargeIn)).toBe(true);
    expect(OPENAI_NATIVE_SPEECH_ACKNOWLEDGEMENT_SLO_LIMITS).toEqual({
      speechStoppedEventToFirstInboundRtpMs: 60_000,
      bargeInMs: 10_000,
      bargeInCount: 16,
    });
  });

  it.each([
    ['corps absent', null],
    ['champ absent', { acknowledgementId: ACKNOWLEDGEMENT, contextRevision: 7, contextDigest: CONTEXT_DIGEST }],
    ['champ en trop', { ...body(), providerResponseId: 'resp_secret' }],
    ['ack invalide', { ...body(), acknowledgementId: 'ack-1' }],
    ['revision flottante', { ...body(), contextRevision: 1.5 }],
    ['digest majuscule', { ...body(), contextDigest: 'A'.repeat(64) }],
    ['observation absente', (() => {
      const { localObservation: _localObservation, ...candidate } = body();
      return candidate;
    })()],
    ['observation enrichie', {
      ...body(),
      localObservation: { ...LOCAL_OBSERVATION, deviceRoute: 'speaker' },
    }],
    ['version observation inconnue', {
      ...body(),
      localObservation: { ...LOCAL_OBSERVATION, formatVersion: 2 },
    }],
    ['preuve DAC reservee', {
      ...body(),
      localObservation: { formatVersion: 1, kind: 'native_playout_queue_drained_v1' },
    }],
    ['SLO nul', { ...body(), slo: null }],
    ['SLO vide', { ...body(), slo: {} }],
    ['SLO sans premier RTP', {
      ...body(),
      slo: { pendingBargeIn: { status: 'complete', durationsMs: [91] } },
    }],
    ['SLO enrichi', { ...body(), slo: { speechStoppedEventToFirstInboundRtpMs: 1, secret: true } }],
    ['premier RTP hors borne', { ...body(), slo: { speechStoppedEventToFirstInboundRtpMs: 60_001 } }],
    ['barge-in vide', { ...body(), slo: { pendingBargeIn: { status: 'complete', durationsMs: [] } } }],
    ['barge-in hors borne', { ...body(), slo: { pendingBargeIn: { status: 'complete', durationsMs: [10_001] } } }],
    ['overflow enrichi', { ...body(), slo: { pendingBargeIn: { status: 'overflowed', durationsMs: [1] } } }],
  ])('refuse %s', (_label, candidate) => {
    expect(parseOpenAiNativeSpeechAcknowledgementBody(candidate)).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
  });

  it.each([
    ['session', 'not-a-session', TURN, DELIVERY],
    ['turn', SESSION, 'not-a-turn', DELIVERY],
    ['delivery', SESSION, TURN, 'not-a-delivery'],
  ])('refuse un mauvais identifiant de %s', (_label, session, turn, delivery) => {
    expect(parseOpenAiNativeSpeechAcknowledgementPath(session, turn, delivery)).toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
  });
});

describe('OpenAiNativeSpeechAcknowledgementService', () => {
  it('derive le sujet authentifie et ne renvoie qu’un reçu Bob durable minimal', async () => {
    const h = harness();
    const result = await asPrincipal(() => h.service.acknowledge(
      SESSION,
      TURN,
      DELIVERY,
      body(),
      new AbortController().signal,
    ));

    expect(result).toEqual({
      ok: true,
      value: {
        deliveryId: DELIVERY,
        turnId: TURN,
        acknowledgementId: ACKNOWLEDGEMENT,
        contextRevision: 7,
        contextDigest: CONTEXT_DIGEST,
        idempotent: false,
      },
    });
    expect(h.acknowledgeMobileDelivery).toHaveBeenCalledWith({
      companyId: 'company-1',
      subjectHmacCandidates: [{
        version: 1,
        subjectHmac: admissionSubjectHash(SUBJECT_SECRET, 'company-1', 'user-1'),
      }],
      deliveryId: DELIVERY,
      sessionId: SESSION,
      turnId: TURN,
      acknowledgementId: ACKNOWLEDGEMENT,
      contextRevision: 7,
      contextDigest: CONTEXT_DIGEST,
      localObservation: LOCAL_OBSERVATION,
      slo: body().slo,
    });
    expect(h.logger.audit).toHaveBeenCalledWith('bob.live.native_speech.delivered', {
      idempotent: false,
      localObservationKind: LOCAL_OBSERVATION.kind,
      sloIncluded: true,
    });
  });

  it('rend le replay exact visible comme idempotent sans second contrat', async () => {
    const h = harness({ status: 'idempotent', state: {} as never });
    const result = await asPrincipal(() => h.service.acknowledge(
      SESSION,
      TURN,
      DELIVERY,
      body(),
    ));
    expect(result).toMatchObject({ ok: true, value: { idempotent: true } });
  });

  it.each([
    ['not_found', 'not_found'],
    ['conflict', 'conflict'],
    ['unavailable', 'unavailable'],
  ] as const)('mappe %s vers une erreur HTTP honnête et bornée', async (status, kind) => {
    const h = harness({ status });
    const result = await asPrincipal(() => h.service.acknowledge(
      SESSION,
      TURN,
      DELIVERY,
      body(),
    ));
    expect(result).toMatchObject({ ok: false, error: { kind } });
    expect(JSON.stringify(result)).not.toContain(DELIVERY);
    expect(h.acknowledgeMobileDelivery).toHaveBeenCalledTimes(1);
  });

  it('rend not_ready retryable et machine-typé sans le confondre avec un conflit terminal', async () => {
    const h = harness({ status: 'not_ready' });
    const result = await asPrincipal(() => h.service.acknowledge(
      SESSION,
      TURN,
      DELIVERY,
      body(),
    ));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        service: 'bob-live-native-acknowledgement-not-ready',
        retryAfterSeconds: 1,
      },
    });
  });

  it('soumet les clés sujet courante et historique en un seul appel authority', async () => {
    const oldSecret = 'historical-subject-secret-with-at-least-thirty-two-characters';
    const currentSecret = 'current-subject-secret-with-at-least-thirty-two-characters';
    const acknowledgeMobileDelivery = vi.fn()
      .mockResolvedValueOnce({ status: 'applied' as const, state: {} as never });
    const service = new OpenAiNativeSpeechAcknowledgementService(
      { acknowledgeMobileDelivery } as never,
      {
        enabled: true,
        subjectHmacKeyRing: {
          currentVersion: 2,
          versions: [2, 1],
          secret: (version) => version === 2 ? currentSecret : version === 1 ? oldSecret : null,
        },
      },
    );

    await expect(asPrincipal(() => service.acknowledge(SESSION, TURN, DELIVERY, body())))
      .resolves.toMatchObject({ ok: true });
    expect(acknowledgeMobileDelivery).toHaveBeenCalledTimes(1);
    expect(acknowledgeMobileDelivery).toHaveBeenCalledWith(expect.objectContaining({
      subjectHmacCandidates: [
        {
          version: 2,
          subjectHmac: admissionSubjectHash(currentSecret, 'company-1', 'user-1'),
        },
        {
          version: 1,
          subjectHmac: admissionSubjectHash(oldSecret, 'company-1', 'user-1'),
        },
      ],
    }));
  });

  it('copie la keyring au boot avant toute mutation ultérieure de sa source', async () => {
    const oldSecret = 'copied-old-subject-secret-with-at-least-thirty-two-characters';
    const currentSecret = 'copied-current-subject-secret-with-at-least-thirty-two-characters';
    const versions = [2, 1];
    const secrets = new Map([[2, currentSecret], [1, oldSecret]]);
    const acknowledgeMobileDelivery = vi.fn(async () => ({
      status: 'applied' as const,
      state: {} as never,
    }));
    const service = new OpenAiNativeSpeechAcknowledgementService(
      { acknowledgeMobileDelivery } as never,
      {
        enabled: true,
        subjectHmacKeyRing: {
          currentVersion: 2,
          versions,
          secret: (version) => secrets.get(version) ?? null,
        },
      },
    );
    versions.splice(0, versions.length, 99);
    secrets.set(2, 'mutated-current-subject-secret-with-at-least-thirty-two-characters');
    secrets.delete(1);

    await expect(asPrincipal(() => service.acknowledge(SESSION, TURN, DELIVERY, body())))
      .resolves.toMatchObject({ ok: true });
    expect(acknowledgeMobileDelivery).toHaveBeenCalledWith(expect.objectContaining({
      subjectHmacCandidates: [
        {
          version: 2,
          subjectHmac: admissionSubjectHash(currentSecret, 'company-1', 'user-1'),
        },
        {
          version: 1,
          subjectHmac: admissionSubjectHash(oldSecret, 'company-1', 'user-1'),
        },
      ],
    }));
  });

  it('échoue fermé avant l’autorité si le client est déconnecté ou la requête abandonnée', async () => {
    const h = harness();
    await expect(h.service.acknowledge(SESSION, TURN, DELIVERY, body()))
      .resolves.toMatchObject({ ok: false, error: { kind: 'forbidden' } });

    const aborted = new AbortController();
    aborted.abort();
    await expect(asPrincipal(() => h.service.acknowledge(
      SESSION,
      TURN,
      DELIVERY,
      body(),
      aborted.signal,
    ))).resolves.toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(h.acknowledgeMobileDelivery).not.toHaveBeenCalled();
  });

  it('convertit une exception d’adapter en indisponibilité sans exposer sa cause', async () => {
    const acknowledgeMobileDelivery = vi.fn(async () => {
      throw new Error('postgres-secret-host');
    });
    const service = new OpenAiNativeSpeechAcknowledgementService(
      { acknowledgeMobileDelivery } as never,
      { enabled: true, subjectHmacKeyRing: SUBJECT_KEY_RING },
    );
    const result = await asPrincipal(() => service.acknowledge(
      SESSION,
      TURN,
      DELIVERY,
      body(),
    ));
    expect(result).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(JSON.stringify(result)).not.toContain('postgres-secret-host');
  });

  it('refuse au boot une configuration native partielle', () => {
    expect(() => new OpenAiNativeSpeechAcknowledgementService(
      null,
      { enabled: true, subjectHmacKeyRing: SUBJECT_KEY_RING },
    )).toThrow(/incompletely configured/u);
    expect(() => new OpenAiNativeSpeechAcknowledgementService(
      { acknowledgeMobileDelivery: vi.fn() } as never,
      {
        enabled: true,
        subjectHmacKeyRing: {
          currentVersion: 1,
          versions: [1],
          secret: () => 'short',
        },
      },
    )).toThrow(/incompletely configured/u);
  });

  it.each([
    {
      label: 'clé courante absente',
      currentVersion: 2,
      versions: [1],
      secret: (_version: number) => SUBJECT_SECRET,
    },
    {
      label: 'version dupliquée',
      currentVersion: 1,
      versions: [1, 1],
      secret: (_version: number) => SUBJECT_SECRET,
    },
    {
      label: 'secrets dupliqués',
      currentVersion: 2,
      versions: [2, 1],
      secret: (_version: number) => SUBJECT_SECRET,
    },
    {
      label: 'plus de 32 versions',
      currentVersion: 1,
      versions: Array.from({ length: 33 }, (_, index) => index + 1),
      secret: (version: number) => `${SUBJECT_SECRET}-${version}`,
    },
    {
      label: 'liste trouée',
      currentVersion: 1,
      versions: new Array<number>(1),
      secret: (_version: number) => SUBJECT_SECRET,
    },
    {
      label: 'liste enrichie',
      currentVersion: 1,
      versions: (() => {
        const enriched = [1] as number[] & { extra?: boolean };
        enriched.extra = true;
        return enriched;
      })(),
      secret: (_version: number) => SUBJECT_SECRET,
    },
    {
      label: 'version hors int4',
      currentVersion: 2_147_483_648,
      versions: [2_147_483_648],
      secret: (_version: number) => SUBJECT_SECRET,
    },
  ])('refuse une keyring sujet non bornée ou ambiguë : $label', ({ currentVersion, versions, secret }) => {
    expect(() => new OpenAiNativeSpeechAcknowledgementService(
      { acknowledgeMobileDelivery: vi.fn() } as never,
      { enabled: true, subjectHmacKeyRing: { currentVersion, versions, secret } },
    )).toThrow(/incompletely configured/u);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryPersistence } from '../persistence/persistence.testing';
import type { Persistence } from '../persistence/persistence';
import { AppLogger } from '../observability/logger';
import type { ErrorReporter } from '../observability/error-reporter';
import type { InMemoryVoiceTraceRepository } from '../persistence/voice-traces.testing';
import { VoiceTraceRecorder, voiceTurnStitchesToTranscript } from './voice-trace.recorder';

const SPOKEN = 'facture Martin quinze mille euros';

function harness(startMs = 1_700_000_000_000) {
  const persistence = new InMemoryPersistence();
  const traces = persistence.voiceTraces as unknown as InMemoryVoiceTraceRepository;
  const reporter: ErrorReporter = { captureException: vi.fn() };
  let clockMs = startMs;
  const recorder = new VoiceTraceRecorder(
    persistence as unknown as Persistence,
    new AppLogger(),
    reporter,
    () => clockMs,
  );
  return {
    recorder,
    traces,
    reporter,
    advance: (ms: number) => {
      clockMs += ms;
    },
  };
}

function transcription(overrides: Partial<Parameters<VoiceTraceRecorder['noteTranscription']>[0]> = {}) {
  return {
    companyId: 'co_1',
    userId: 'usr_1',
    transcript: SPOKEN,
    sttModel: 'voxtral-mini-latest',
    transcriptionMs: 820,
    error: null,
    ...overrides,
  };
}

function planning(overrides: Partial<Parameters<VoiceTraceRecorder['notePlanning']>[0]> = {}) {
  return {
    companyId: 'co_1',
    userId: 'usr_1',
    message: SPOKEN,
    intent: 'invoice.create',
    tool: 'facture_directe',
    toolArgs: { customerName: 'Martin', amountCents: 1_500_000 },
    autonomy: 'assiste',
    llmModel: 'claude-opus-4-8',
    reply: 'Je prépare la facture pour Martin.',
    planificationMs: 1_400,
    executionMs: 260,
    error: null,
    ...overrides,
  };
}

describe('VoiceTraceRecorder — drapeau d’activation fail-closed', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('n’écrit RIEN sans VOICE_TRACE_ENABLED : zéro coût, zéro donnée', async () => {
    vi.stubEnv('VOICE_TRACE_ENABLED', undefined);
    const { recorder, traces } = harness();
    recorder.noteTranscription(transcription());
    recorder.notePlanning(planning());
    await recorder.flush();
    expect(traces.list()).toEqual([]);
  });

  it.each(['false', 'TRUE', '1', ''])('reste éteint pour la valeur %o', async (value) => {
    vi.stubEnv('VOICE_TRACE_ENABLED', value);
    const { recorder, traces } = harness();
    recorder.noteTranscription(transcription());
    await recorder.flush();
    expect(traces.list()).toEqual([]);
  });
});

describe('VoiceTraceRecorder — le fil complet d’un tour', () => {
  beforeEach(() => vi.stubEnv('VOICE_TRACE_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('enregistre ce qui a été dit → compris → fait → répondu → en combien de temps', async () => {
    const { recorder, traces, advance } = harness();

    recorder.noteTranscription(transcription());
    advance(1_400);
    recorder.notePlanning(planning());
    advance(300);
    recorder.noteSynthesis({
      companyId: 'co_1',
      userId: 'usr_1',
      text: 'Je prépare la facture pour Martin.',
      ttsModel: 'voxtral-mini-tts-2603',
      syntheseMs: 300,
      error: null,
    });
    await recorder.flush();

    const [trace] = traces.list();
    expect(trace).toMatchObject({
      companyId: 'co_1',
      userId: 'usr_1',
      turnIndex: 1,
      transcript: SPOKEN,
      sttModel: 'voxtral-mini-latest',
      intent: 'invoice.create',
      tool: 'facture_directe',
      toolArgs: { customerName: 'Martin', amountCents: 1_500_000 },
      autonomy: 'assiste',
      llmModel: 'claude-opus-4-8',
      outcome: 'success',
      level: 'info',
      reason: null,
      reply: 'Je prépare la facture pour Martin.',
      ttsModel: 'voxtral-mini-tts-2603',
      transcriptionMs: 820,
      planificationMs: 1_400,
      executionMs: 260,
      syntheseMs: 300,
    });
  });

  it('un tour reste UNE ligne : la synthèse complète, elle ne duplique pas', async () => {
    const { recorder, traces } = harness();
    recorder.noteTranscription(transcription());
    recorder.notePlanning(planning());
    recorder.noteSynthesis({
      companyId: 'co_1',
      userId: 'usr_1',
      text: 'Je prépare la facture pour Martin.',
      ttsModel: 'voxtral-mini-tts-2603',
      syntheseMs: 300,
      error: null,
    });
    await recorder.flush();
    expect(traces.list()).toHaveLength(1);
  });

  it('borne la rétention à 30 jours du début du tour', async () => {
    const { recorder, traces } = harness(Date.parse('2026-07-20T10:00:00.000Z'));
    recorder.noteTranscription(transcription());
    await recorder.flush();
    expect(traces.list()[0]?.retentionExpiresAt).toBe('2026-08-19T10:00:00.000Z');
  });

  it('incrémente l’index de tour dans une même session, puis rouvre après inactivité', async () => {
    const { recorder, traces, advance } = harness();
    recorder.noteTranscription(transcription());
    advance(30_000);
    recorder.noteTranscription(transcription({ transcript: 'et le devis Dupont' }));
    await recorder.flush();
    const [first, second] = traces.list();
    expect(first?.sessionId).toBe(second?.sessionId);
    expect([first?.turnIndex, second?.turnIndex]).toEqual([1, 2]);

    advance(10 * 60_000);
    recorder.noteTranscription(transcription({ transcript: 'bonjour Bob' }));
    await recorder.flush();
    const sessions = new Set(traces.list().map((row) => row.sessionId));
    expect(sessions.size).toBe(2);
  });
});

describe('VoiceTraceRecorder — les trois niveaux d’alerte', () => {
  beforeEach(() => vi.stubEnv('VOICE_TRACE_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('(a) comportement normal : info', async () => {
    const { recorder, traces } = harness();
    recorder.noteTranscription(transcription());
    recorder.notePlanning(planning());
    await recorder.flush();
    expect(traces.list()[0]).toMatchObject({ outcome: 'success', level: 'info', reason: null });
  });

  it('(b) refus métier attendu : warn, AVEC sa raison, sans remontée au canal d’incident', async () => {
    const { recorder, traces, reporter } = harness();
    recorder.noteTranscription(transcription());
    recorder.notePlanning(
      planning({
        error: { kind: 'forbidden', cause: "L'assistant Bob est inclus à partir de l'offre Solo." },
        reply: null,
      }),
    );
    await recorder.flush();
    const trace = traces.list()[0];
    expect(trace).toMatchObject({ outcome: 'refused', level: 'warn' });
    expect(trace?.reason).toContain('offre Solo');
    expect(reporter.captureException).not.toHaveBeenCalled();
  });

  it('(c) anomalie réelle : error', async () => {
    const { recorder, traces } = harness();
    recorder.noteTranscription(
      transcription({ transcript: null, error: { kind: 'dependency', port: 'voice-stt' } }),
    );
    await recorder.flush();
    const trace = traces.list()[0];
    expect(trace).toMatchObject({ outcome: 'error', level: 'error' });
    expect(trace?.reason).toContain('voice-stt');
  });

  it('une dégradation assumée (unavailable) reste un refus, pas une anomalie', async () => {
    const { recorder, traces } = harness();
    recorder.noteTranscription(transcription());
    recorder.notePlanning(planning({ error: { kind: 'unavailable', service: 'bob-llm' } }));
    await recorder.flush();
    expect(traces.list()[0]).toMatchObject({ outcome: 'refused', level: 'warn' });
  });

  it('une synthèse en échec dégrade le tour sans effacer ce que Bob avait compris', async () => {
    const { recorder, traces } = harness();
    recorder.noteTranscription(transcription());
    recorder.notePlanning(planning());
    recorder.noteSynthesis({
      companyId: 'co_1',
      userId: 'usr_1',
      text: 'Je prépare la facture pour Martin.',
      ttsModel: null,
      syntheseMs: 90,
      error: { kind: 'dependency', port: 'voice-tts' },
    });
    await recorder.flush();
    const trace = traces.list()[0];
    expect(trace).toMatchObject({ outcome: 'error', level: 'error', tool: 'facture_directe' });
    expect(trace?.reason).toContain('synthèse vocale');
  });
});

describe('VoiceTraceRecorder — raccord du tour et frontière avec le texte', () => {
  beforeEach(() => vi.stubEnv('VOICE_TRACE_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('raccorde même si le client préfixe le transcript', () => {
    expect(voiceTurnStitchesToTranscript(SPOKEN, `Contexte : écran factures. ${SPOKEN}`)).toBe(true);
  });

  it('ne raccorde pas deux textes étrangers', () => {
    expect(voiceTurnStitchesToTranscript(SPOKEN, 'relance Dupont')).toBe(false);
  });

  it('une conversation TEXTE ne laisse aucune trace vocale', async () => {
    const { recorder, traces } = harness();
    recorder.notePlanning(planning({ message: 'écris-moi un devis' }));
    await recorder.flush();
    expect(traces.list()).toEqual([]);
  });

  it('un tour entendu mais jamais suivi reste visible en `heard` — c’est un symptôme', async () => {
    const { recorder, traces } = harness();
    recorder.noteTranscription(transcription());
    await recorder.flush();
    expect(traces.list()[0]).toMatchObject({ outcome: 'heard', level: 'info', transcript: SPOKEN });
  });

  it('une synthèse orpheline n’invente pas de tour', async () => {
    const { recorder, traces } = harness();
    recorder.noteSynthesis({
      companyId: 'co_1',
      userId: 'usr_1',
      text: 'bonjour',
      ttsModel: 'voxtral-mini-tts-2603',
      syntheseMs: 120,
      error: null,
    });
    await recorder.flush();
    expect(traces.list()).toEqual([]);
  });

  it('isole les testeurs : deux utilisateurs ne partagent jamais un tour', async () => {
    const { recorder, traces } = harness();
    recorder.noteTranscription(transcription());
    recorder.noteTranscription(transcription({ userId: 'usr_2', transcript: 'devis Dupont' }));
    recorder.notePlanning(planning({ userId: 'usr_2', message: 'devis Dupont', tool: 'creer_devis' }));
    await recorder.flush();
    const rows = traces.list();
    expect(rows.find((row) => row.userId === 'usr_1')?.outcome).toBe('heard');
    expect(rows.find((row) => row.userId === 'usr_2')?.tool).toBe('creer_devis');
  });
});

describe('VoiceTraceRecorder — la trace s’efface devant l’usage', () => {
  beforeEach(() => vi.stubEnv('VOICE_TRACE_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('une base en panne ne fait JAMAIS lever le chemin vocal', async () => {
    const { recorder } = harness();
    const persistence = new InMemoryPersistence();
    persistence.voiceTraces.openTurn = () => Promise.reject(new Error('base indisponible'));
    const broken = new VoiceTraceRecorder(
      persistence as unknown as Persistence,
      new AppLogger(),
      { captureException: vi.fn() },
      () => 1_700_000_000_000,
    );
    expect(() => broken.noteTranscription(transcription())).not.toThrow();
    await expect(broken.flush()).resolves.toBeUndefined();
    expect(recorder).toBeDefined();
  });

  it('se coupe et alerte après 5 échecs consécutifs, sans marteler la base', async () => {
    const persistence = new InMemoryPersistence();
    persistence.voiceTraces.openTurn = () => Promise.reject(new Error('base indisponible'));
    const reporter: ErrorReporter = { captureException: vi.fn() };
    let clockMs = 1_700_000_000_000;
    const recorder = new VoiceTraceRecorder(
      persistence as unknown as Persistence,
      new AppLogger(),
      reporter,
      () => clockMs,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recorder.noteTranscription(transcription());
      clockMs += 1_000;
      await recorder.flush();
    }
    expect(reporter.captureException).toHaveBeenCalledTimes(1);

    const calls = vi.mocked(persistence.voiceTraces.openTurn).mock?.calls?.length;
    recorder.noteTranscription(transcription());
    await recorder.flush();
    // Après coupure, plus aucune tentative d'écriture.
    expect(vi.mocked(persistence.voiceTraces.openTurn).mock?.calls?.length ?? calls).toBe(calls);
  });
});

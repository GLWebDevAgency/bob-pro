import { describe, expect, it } from 'vitest';
import {
  boundVoiceTraceArgs,
  boundVoiceTraceText,
  classifyVoiceTurn,
  describeVoiceTurnError,
  resolveVoiceSessionCursor,
  voiceTraceExpiryAt,
  voiceTurnTotalMs,
  EMPTY_VOICE_TURN_LATENCIES,
  VOICE_TRACE_RETENTION_DAYS,
  VOICE_TRACE_SESSION_IDLE_MS,
  VOICE_TRACE_TRUNCATION_MARK,
} from './voice-trace';

describe('classifyVoiceTurn — trois niveaux d’alerte du bêta-test', () => {
  it('comportement normal : succès en info, jamais remonté', () => {
    expect(classifyVoiceTurn(null)).toEqual({
      outcome: 'success',
      level: 'info',
      reportable: false,
      reason: null,
    });
  });

  it.each(['validation', 'forbidden', 'not_found', 'conflict', 'domain'])(
    'refus métier attendu (%s) : warn, avec sa raison, JAMAIS remonté au canal d’incident',
    (kind) => {
      const classification = classifyVoiceTurn({ kind });
      expect(classification.outcome).toBe('refused');
      expect(classification.level).toBe('warn');
      expect(classification.reportable).toBe(false);
      expect(classification.reason).toContain(kind);
    },
  );

  it('dégradation assumée (unavailable) : warn sans remontée — doctrine exception.filter', () => {
    const classification = classifyVoiceTurn({ kind: 'unavailable', service: 'bob-llm' });
    expect(classification).toMatchObject({
      outcome: 'refused',
      level: 'warn',
      reportable: false,
    });
    expect(classification.reason).toContain('bob-llm');
  });

  it('anomalie réelle (dependency) : error, et celle-là SEULE remonte', () => {
    const classification = classifyVoiceTurn({ kind: 'dependency', port: 'voice-stt' });
    expect(classification).toMatchObject({
      outcome: 'error',
      level: 'error',
      reportable: true,
    });
    expect(classification.reason).toContain('voice-stt');
  });

  it('kind inconnu : traité comme une anomalie, jamais silencieusement rangé en refus', () => {
    expect(classifyVoiceTurn({ kind: 'kind_jamais_vu' })).toMatchObject({
      outcome: 'error',
      level: 'error',
      reportable: true,
    });
  });

  it('seul le niveau error est remontable — invariant transverse', () => {
    for (const kind of ['validation', 'forbidden', 'unavailable', 'dependency', 'autre']) {
      const classification = classifyVoiceTurn({ kind });
      expect(classification.reportable).toBe(classification.level === 'error');
    }
  });
});

describe('describeVoiceTurnError — la raison doit être diagnosticable', () => {
  it('concatène les faits structurés dans un ordre stable', () => {
    expect(
      describeVoiceTurnError({
        kind: 'not_found',
        entity: 'quote',
        reason: 'redacted',
      }),
    ).toBe('not_found · entité=quote · motif=redacted');
  });

  it('expose les champs de validation : c’est ce qui manquait à Bob pour agir', () => {
    expect(
      describeVoiceTurnError({
        kind: 'validation',
        issues: [{ field: 'customerId', message: 'Client requis.' }],
      }),
    ).toBe('validation · champ customerId : Client requis.');
  });

  it('ignore les champs vides plutôt que de produire des séparateurs orphelins', () => {
    expect(describeVoiceTurnError({ kind: 'forbidden', cause: '', port: undefined })).toBe(
      'forbidden',
    );
  });
});

describe('resolveVoiceSessionCursor — continuité reconstruite côté serveur', () => {
  it('ouvre une session au premier tour', () => {
    expect(resolveVoiceSessionCursor(null, 1_000, 'sess-a')).toEqual({
      sessionId: 'sess-a',
      turnIndex: 1,
      lastActivityAtMs: 1_000,
    });
  });

  it('prolonge la session tant que l’inactivité reste sous la fenêtre', () => {
    const first = resolveVoiceSessionCursor(null, 1_000, 'sess-a');
    const second = resolveVoiceSessionCursor(first, 1_000 + 30_000, 'sess-b');
    expect(second).toEqual({
      sessionId: 'sess-a',
      turnIndex: 2,
      lastActivityAtMs: 31_000,
    });
  });

  it('ouvre une NOUVELLE session au-delà de la fenêtre d’inactivité', () => {
    const first = resolveVoiceSessionCursor(null, 1_000, 'sess-a');
    const later = resolveVoiceSessionCursor(
      first,
      1_000 + VOICE_TRACE_SESSION_IDLE_MS + 1,
      'sess-b',
    );
    expect(later).toEqual({
      sessionId: 'sess-b',
      turnIndex: 1,
      lastActivityAtMs: 1_000 + VOICE_TRACE_SESSION_IDLE_MS + 1,
    });
  });

  it('prolonge exactement AU BORD de la fenêtre (limite inclusive)', () => {
    const first = resolveVoiceSessionCursor(null, 1_000, 'sess-a');
    const border = resolveVoiceSessionCursor(first, 1_000 + VOICE_TRACE_SESSION_IDLE_MS, 'sess-b');
    expect(border.sessionId).toBe('sess-a');
    expect(border.turnIndex).toBe(2);
  });

  it('une horloge qui recule coupe le fil plutôt que de produire un index incohérent', () => {
    const first = resolveVoiceSessionCursor(null, 10_000, 'sess-a');
    const backwards = resolveVoiceSessionCursor(first, 9_000, 'sess-b');
    expect(backwards).toEqual({ sessionId: 'sess-b', turnIndex: 1, lastActivityAtMs: 9_000 });
  });
});

describe('bornage des contenus', () => {
  it('laisse un texte court intact', () => {
    expect(boundVoiceTraceText('facture Martin', 100)).toBe('facture Martin');
  });

  it('marque explicitement une troncature', () => {
    const bounded = boundVoiceTraceText('abcdefghij', 4);
    expect(bounded).toBe(`abcd${VOICE_TRACE_TRUNCATION_MARK}`);
  });

  it('laisse des paramètres d’outil raisonnables tels quels', () => {
    const args = { customerId: 'cus_1', amountCents: 12_000 };
    expect(boundVoiceTraceArgs(args, 1_000)).toBe(args);
  });

  it('remplace des paramètres trop gros par un aperçu marqué, jamais par un objet mutilé', () => {
    const bounded = boundVoiceTraceArgs({ notes: 'x'.repeat(500) }, 50) as {
      tronque: boolean;
      apercu: string;
    };
    expect(bounded.tronque).toBe(true);
    expect(bounded.apercu).toHaveLength(50);
  });

  it('ne casse jamais sur une structure cyclique : elle le DIT', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundVoiceTraceArgs(cyclic)).toEqual({
      tronque: true,
      apercu: '[paramètres non sérialisables]',
    });
  });

  it('normalise l’absence de paramètres en null', () => {
    expect(boundVoiceTraceArgs(undefined)).toBeNull();
  });
});

describe('latences', () => {
  it('une étape non franchie ne compte pas pour zéro', () => {
    expect(voiceTurnTotalMs(EMPTY_VOICE_TURN_LATENCIES)).toBe(0);
    expect(
      voiceTurnTotalMs({
        transcriptionMs: 800,
        planificationMs: 1_200,
        executionMs: null,
        syntheseMs: 400,
      }),
    ).toBe(2_400);
  });
});

describe('rétention', () => {
  it('matérialise l’échéance à 30 jours du début du tour', () => {
    expect(VOICE_TRACE_RETENTION_DAYS).toBe(30);
    expect(voiceTraceExpiryAt('2026-07-20T10:00:00.000Z')).toBe('2026-08-19T10:00:00.000Z');
  });

  it('refuse une date de début invalide plutôt que d’inventer une échéance', () => {
    expect(() => voiceTraceExpiryAt('pas-une-date')).toThrow(/date de début invalide/u);
  });
});

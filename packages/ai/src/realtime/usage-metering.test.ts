import { describe, expect, it } from 'vitest';
import { summarizeVoiceUsage, type VoiceUsageEvent } from './usage-metering';

const PRICES = {
  realtime_audio_in_seconds: 5, // 5 milli-centimes/s — EXEMPLE de calibration, pas un tarif
  realtime_audio_out_seconds: 10,
  llm_tokens_in: 0.02,
  llm_tokens_out: 0.06,
} as const;

const at = 1_700_000_000_000;
const e = (tenantId: string, kind: VoiceUsageEvent['kind'], amount: number, sessionId = 's1'): VoiceUsageEvent => ({
  tenantId,
  plan: 'pro',
  kind,
  amount,
  at,
  sessionId,
});

describe('summarizeVoiceUsage — l’étude tarifaire du fondateur (coût réel par utilisateur)', () => {
  it('agrège par tenant : volumes par nature, sessions distinctes, coût en centimes', () => {
    const study = summarizeVoiceUsage(
      [
        e('t1', 'realtime_audio_in_seconds', 120),
        e('t1', 'realtime_audio_out_seconds', 90, 's2'),
        e('t1', 'llm_tokens_in', 4_000),
        e('t2', 'realtime_audio_out_seconds', 30),
      ],
      PRICES,
    );
    const t1 = study.tenants.find((t) => t.tenantId === 't1')!;
    expect(t1.sessions).toBe(2);
    expect(t1.byKind.realtime_audio_in_seconds).toBe(120);
    // 120×5 + 90×10 + 4000×0,02 = 600+900+80 = 1580 milli-centimes → 158 centimes
    expect(t1.costCents).toBe(158);
    expect(study.totalCostCents).toBe(188); // t1 158 + t2 30 (300 milli-centimes)
  });

  it('un usage sans prix calibré compte en volume mais pas en coût (jamais un tarif inventé)', () => {
    const study = summarizeVoiceUsage([e('t1', 'tts_characters', 5_000)], PRICES);
    expect(study.tenants[0]!.byKind.tts_characters).toBe(5_000);
    expect(study.tenants[0]!.costCents).toBe(0);
  });

  it('tarife séparément cache/non-cache et chaque modalité sans double compter les agrégats', () => {
    const study = summarizeVoiceUsage(
      [
        e('t1', 'realtime_uncached_text_tokens_in', 100),
        e('t1', 'realtime_cached_text_tokens_in', 50),
        e('t1', 'realtime_uncached_audio_tokens_in', 10),
        e('t1', 'realtime_cached_audio_tokens_in', 5),
        e('t1', 'realtime_uncached_image_tokens_in', 4),
        e('t1', 'realtime_cached_image_tokens_in', 2),
        e('t1', 'realtime_text_tokens_out', 20),
        e('t1', 'realtime_audio_tokens_out', 10),
      ],
      {
        realtime_uncached_text_tokens_in: 1,
        realtime_cached_text_tokens_in: 0.2,
        realtime_uncached_audio_tokens_in: 5,
        realtime_cached_audio_tokens_in: 1,
        realtime_uncached_image_tokens_in: 5,
        realtime_cached_image_tokens_in: 2.5,
        realtime_text_tokens_out: 4,
        realtime_audio_tokens_out: 3,
      },
    );
    const row = study.tenants[0]!;
    expect(row.byKind).toMatchObject({
      realtime_uncached_text_tokens_in: 100,
      realtime_cached_text_tokens_in: 50,
      realtime_uncached_audio_tokens_in: 10,
      realtime_cached_audio_tokens_in: 5,
      realtime_uncached_image_tokens_in: 4,
      realtime_cached_image_tokens_in: 2,
      realtime_text_tokens_out: 20,
      realtime_audio_tokens_out: 10,
    });
    // 300 milli-centimes exactement : aucun total input/output n'est ajouté une seconde fois.
    expect(row.costCents).toBe(30);
    expect(row.byKind.realtime_tokens_in).toBeUndefined();
    expect(row.byKind.realtime_tokens_out).toBeUndefined();
  });

  it('montants négatifs/NaN ignorés (un compteur ne recule jamais) ; moyenne et médiane exposées', () => {
    const study = summarizeVoiceUsage(
      [e('t1', 'llm_tokens_out', -50), e('t1', 'llm_tokens_out', Number.NaN), e('t2', 'realtime_audio_out_seconds', 10)],
      PRICES,
    );
    expect(study.tenants.find((t) => t.tenantId === 't1')).toBeUndefined(); // que de l'invalide → pas de tenant fantôme
    expect(study.averageCostCentsPerTenant).not.toBeNull();
    expect(study.medianCostCentsPerTenant).not.toBeNull();
  });

  it('changement de plan en cours de période : coût attribué au plan RÉELLEMENT actif (une ligne par tenant×plan)', () => {
    const solo: VoiceUsageEvent = { tenantId: 't1', plan: 'solo', kind: 'realtime_audio_out_seconds', amount: 10, at, sessionId: 's1' };
    const pro: VoiceUsageEvent = { tenantId: 't1', plan: 'pro', kind: 'realtime_audio_out_seconds', amount: 100, at, sessionId: 's2' };
    const study = summarizeVoiceUsage([solo, pro], PRICES);
    const soloRow = study.tenants.find((t) => t.tenantId === 't1' && t.plan === 'solo')!;
    const proRow = study.tenants.find((t) => t.tenantId === 't1' && t.plan === 'pro')!;
    expect(soloRow.byKind.realtime_audio_out_seconds).toBe(10); // jamais 110 agrégés sous 'solo'
    expect(proRow.byKind.realtime_audio_out_seconds).toBe(100);
    // Moyenne/médiane par TENANT : t1 compte UNE fois (tous plans confondus), pas deux.
    expect(study.averageCostCentsPerTenant).toBe(study.totalCostCents);
  });

  it('l’étude est INDÉPENDANTE DE L’ORDRE des événements (rejouable sur l’historique)', () => {
    const events: VoiceUsageEvent[] = [
      { tenantId: 't1', plan: 'pro', kind: 'realtime_audio_out_seconds', amount: 100, at },
      { tenantId: 't1', plan: 'solo', kind: 'realtime_audio_out_seconds', amount: 10, at },
      { tenantId: 't2', plan: 'solo', kind: 'realtime_audio_out_seconds', amount: 5, at },
    ];
    const forward = summarizeVoiceUsage(events, PRICES);
    const backward = summarizeVoiceUsage([...events].reverse(), PRICES);
    expect(backward).toEqual(forward); // même ensemble, ordre différent → même étude, au champ près
  });
});

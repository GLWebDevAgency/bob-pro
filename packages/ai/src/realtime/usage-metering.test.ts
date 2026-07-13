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

  it('montants négatifs/NaN ignorés (un compteur ne recule jamais) ; moyenne et médiane exposées', () => {
    const study = summarizeVoiceUsage(
      [e('t1', 'llm_tokens_out', -50), e('t1', 'llm_tokens_out', Number.NaN), e('t2', 'realtime_audio_out_seconds', 10)],
      PRICES,
    );
    expect(study.tenants.find((t) => t.tenantId === 't1')).toBeUndefined(); // que de l'invalide → pas de tenant fantôme
    expect(study.averageCostCentsPerTenant).not.toBeNull();
    expect(study.medianCostCentsPerTenant).not.toBeNull();
  });
});

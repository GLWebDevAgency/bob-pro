import { createCanonicalSpeechEnvelope, FIXED_SAFE_SPEECH } from '@bob/ai';
import { describe, expect, it } from 'vitest';
import {
  OPENAI_NATIVE_ELIGIBLE_SPEECH_V1,
  deriveOpenAiNativeSpeechRisk,
  type OpenAiNativeSpeechPurpose,
  type OpenAiNativeSpeechSource,
} from './openai-native-speech-risk';

function decision(input: {
  readonly text: string;
  readonly purpose?: OpenAiNativeSpeechPurpose | null;
  readonly source?: OpenAiNativeSpeechSource | null;
  readonly runKind?: 'answer' | 'proposed' | 'done' | null;
  readonly hasTenantContext?: boolean;
  readonly hasControl?: boolean;
}) {
  return deriveOpenAiNativeSpeechRisk({
    envelope: createCanonicalSpeechEnvelope(input.text),
    purpose: input.purpose,
    source: input.source,
    runKind: input.runKind,
    hasTenantContext: input.hasTenantContext ?? false,
    hasControl: input.hasControl ?? false,
  });
}

function eligible(text = OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1) {
  return decision({
    text,
    purpose: 'generic_assistance',
    source: 'card_body',
    runKind: 'answer',
  });
}

describe('OpenAI native speech — routage de risque fail-closed', () => {
  it.each(Object.entries(OPENAI_NATIVE_ELIGIBLE_SPEECH_V1))(
    'autorise uniquement le scénario générique exact %s',
    (scenarioId, text) => {
      expect(eligible(text)).toEqual({
        version: 1,
        mode: 'native_conversational',
        scenarioId,
      });
    },
  );

  it('garde les phrases fixes préapprouvées sur leur artefact audité', () => {
    expect(decision({
      text: FIXED_SAFE_SPEECH.listening,
      purpose: 'generic_assistance',
      source: 'card_body',
      runKind: 'answer',
    })).toEqual({ version: 1, mode: 'audited_exact', reasons: ['preapproved_artifact'] });
  });

  it.each([
    'Il reste 1 320 euros à encaisser.',
    'La facture F2026-014 est en retard.',
    'Échéance le 20/07/2026.',
    'Contacte factures@example.com.',
  ])('force le chemin pré-audité dès qu’un fait métier est présent: %s', (text) => {
    expect(decision({
      text,
      purpose: 'generic_assistance',
      source: 'card_body',
      runKind: 'answer',
    })).toEqual({ version: 1, mode: 'audited_exact', reasons: ['business_fact'] });
  });

  it('n’autorise jamais une phrase arbitraire sans fait ni un nom client non détecté', () => {
    expect(decision({
      text: 'Très bien.',
      purpose: 'generic_assistance',
      source: 'card_body',
      runKind: 'answer',
    })).toEqual({ version: 1, mode: 'audited_exact', reasons: ['unknown_semantics'] });
    expect(decision({
      text: 'Camping les Pins est prêt.',
      purpose: 'business_answer',
      source: 'card_body',
      runKind: 'answer',
    })).toEqual({ version: 1, mode: 'audited_exact', reasons: ['unknown_semantics'] });
  });

  it.each([
    { name: 'contexte tenant', hasTenantContext: true, reasons: ['tenant_context'] },
    { name: 'contrôle', hasControl: true, reasons: ['action_or_control'] },
    { name: 'naturalisation', source: 'natural_body', reasons: ['llm_naturalized'] },
    { name: 'navigation', purpose: 'navigation', reasons: ['action_or_control'] },
    { name: 'choix', purpose: 'structured_choice', reasons: ['interactive_choice'] },
    { name: 'proposition', purpose: 'action_proposal', reasons: ['action_or_control'] },
    { name: 'résultat mutation', purpose: 'action_result', runKind: 'done', reasons: ['mutation_result'] },
  ] as const)('refuse le scénario générique dès qu’il porte $name', (override) => {
    expect(decision({
      text: OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1,
      purpose: 'generic_assistance',
      source: 'card_body',
      runKind: 'answer',
      ...override,
    })).toEqual({ version: 1, mode: 'audited_exact', reasons: override.reasons });
  });

  it('refuse les variations, les signaux absents et une enveloppe incohérente', () => {
    expect(eligible(`${OPENAI_NATIVE_ELIGIBLE_SPEECH_V1.generic_help_v1} `)).toEqual({
      version: 1,
      mode: 'audited_exact',
      reasons: ['unknown_semantics'],
    });
    expect(decision({ text: 'Très bien.' })).toEqual({
      version: 1,
      mode: 'audited_exact',
      reasons: ['unknown_semantics'],
    });
    expect(deriveOpenAiNativeSpeechRisk({
      envelope: {
        version: 1,
        text: FIXED_SAFE_SPEECH.listening,
        canonicalText: FIXED_SAFE_SPEECH.listening,
        classification: 'fixed_safe',
        fixedPhraseId: 'listening',
        facts: [{ kind: 'number', normalized: '42' }],
      },
      purpose: 'generic_assistance',
      source: 'card_body',
      runKind: 'answer',
      hasTenantContext: false,
      hasControl: false,
    })).toEqual({ version: 1, mode: 'audited_exact', reasons: ['invalid_envelope'] });
  });
});

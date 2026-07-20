import { describe, expect, it } from 'vitest';
import {
  createRealtimeSpeechContentProof,
  createRealtimeSpeechProof,
  type RealtimeSpeechProofInput,
} from './realtime-speech-proof';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';

function validInput(): RealtimeSpeechProofInput {
  return {
    secret: 'proof-secret-that-is-long-enough-0001',
    keyVersion: 1,
    companyId: 'company-1',
    subjectHash: '1'.repeat(64),
    artifactId: ARTIFACT_ID,
    sequence: 1,
    storageKey: `companies/company-1/bob-live/${SESSION_ID}/${TURN_ID}/${ARTIFACT_ID}`,
    metadata: {
      version: 1,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      contextRevision: 4,
      contextDigest: '2'.repeat(64),
      classification: 'dynamic_sensitive',
      source: 'synthesized_audited',
      mimeType: 'audio/mpeg',
      byteLength: 2_048,
      estimatedDurationMs: 1_000,
      textSha256: '3'.repeat(64),
      factsSha256: '4'.repeat(64),
      audioSha256: '5'.repeat(64),
      synthesisAdapterId: 'mistral-voxtral-tts',
      synthesisTrustDomain: 'mistral.ai',
      auditAdapterId: 'whisper',
      auditTrustDomain: 'openai.com',
      auditTranscriptSha256: '6'.repeat(64),
    },
  };
}

describe('createRealtimeSpeechProof', () => {
  it('produit quatre preuves déterministes sans exposer les digests de travail', () => {
    const input = validInput();
    const first = createRealtimeSpeechProof(input);
    const second = createRealtimeSpeechProof(input);

    expect(first).toEqual(second);
    for (const value of Object.values(first).filter((entry) => typeof entry === 'string')) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(JSON.stringify(first)).not.toContain(input.metadata.textSha256);
    expect(JSON.stringify(first)).not.toContain(input.metadata.factsSha256);
    expect(JSON.stringify(first)).not.toContain(input.metadata.auditTranscriptSha256);
  });

  it.each([
    ['tenant', (value: RealtimeSpeechProofInput) => ({
      ...value,
      companyId: 'company-2',
      storageKey: value.storageKey.replace('company-1', 'company-2'),
    })],
    ['contexte', (value: RealtimeSpeechProofInput) => ({
      ...value,
      metadata: { ...value.metadata, contextRevision: 5 },
    })],
    ['audio', (value: RealtimeSpeechProofInput) => ({
      ...value,
      metadata: { ...value.metadata, audioSha256: '7'.repeat(64) },
    })],
    ['séquence', (value: RealtimeSpeechProofInput) => ({ ...value, sequence: 2 })],
  ] as const)('lie le MAC d’évidence au %s', (_label, mutate) => {
    const input = validInput();
    const baseline = createRealtimeSpeechProof(input).evidenceHmac;
    const changed = mutate(input);
    expect(createRealtimeSpeechProof(changed).evidenceHmac).not.toBe(baseline);
  });

  it('refuse un storage key transplanté ou une preuve TTS/ASR non indépendante', () => {
    const input = validInput();
    expect(() => createRealtimeSpeechProof({
      ...input,
      storageKey: input.storageKey.replace('company-1', 'company-2'),
    })).toThrow(/storage binding/);
    expect(() => createRealtimeSpeechProof({
      ...input,
      metadata: { ...input.metadata, auditTrustDomain: input.metadata.synthesisTrustDomain },
    })).toThrow(/Invalid realtime speech proof input/);
  });

  it('preuve statique : exige l’absence totale d’ASR', () => {
    const input = validInput();
    expect(createRealtimeSpeechProof({
      ...input,
      metadata: {
        ...input.metadata,
        classification: 'fixed_safe',
        source: 'preapproved_static',
        synthesisAdapterId: 'preapproved-static',
        synthesisTrustDomain: 'bob-pro',
        auditAdapterId: null,
        auditTrustDomain: null,
        auditTranscriptSha256: null,
      },
    }).auditTranscriptHmac).toBeNull();
  });

  it('produit la même liaison de contenu avant la réservation durable', () => {
    const input = validInput();
    const content = createRealtimeSpeechContentProof({
      secret: input.secret,
      companyId: input.companyId,
      textSha256: input.metadata.textSha256,
      factsSha256: input.metadata.factsSha256,
      auditTranscriptSha256: input.metadata.auditTranscriptSha256,
    });
    const full = createRealtimeSpeechProof(input);
    expect(content).toEqual({
      canonicalSpeechHmac: full.canonicalSpeechHmac,
      factsHmac: full.factsHmac,
      auditTranscriptHmac: full.auditTranscriptHmac,
    });
  });
});

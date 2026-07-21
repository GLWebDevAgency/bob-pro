import { describe, expect, it } from 'vitest';
import {
  createOpenAiNativeProviderResponseIdHmac,
  createOpenAiNativeSpeechPreparationProof,
  createOpenAiNativeSpeechTranscriptHmac,
  type OpenAiNativeSpeechProofBinding,
} from './openai-native-speech-proof';

const SECRET = 'openai-native-speech-proof-secret-v1-000000000000000';
const BINDING: OpenAiNativeSpeechProofBinding = Object.freeze({
  companyId: 'company-1',
  deliveryId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  turnId: '33333333-3333-4333-8333-333333333333',
  contextRevision: 7,
  contextDigest: 'a'.repeat(64),
});

function base() {
  return {
    secret: SECRET,
    proofKeyVersion: 4,
    binding: BINDING,
  } as const;
}

describe('OpenAI native speech proof v1', () => {
  it('fait converger le canonique et le transcript acoustiquement équivalent', () => {
    const canonical = createOpenAiNativeSpeechTranscriptHmac({
      ...base(),
      transcript: 'Reste dû : 1 320 €.',
    });
    const provider = createOpenAiNativeSpeechTranscriptHmac({
      ...base(),
      transcript: 'reste dû 1320 €',
    });
    expect(provider).toBe(canonical);
    expect(createOpenAiNativeSpeechTranscriptHmac({
      ...base(),
      transcript: 'reste dû 1 230 €',
    })).not.toBe(canonical);
  });

  it('lie la preuve au tenant, à la livraison, au contexte et à la version de clé', () => {
    const original = createOpenAiNativeSpeechTranscriptHmac({
      ...base(),
      transcript: 'Tout est prêt.',
    });
    const variants = [
      { ...base(), binding: { ...BINDING, companyId: 'company-2' } },
      {
        ...base(),
        binding: { ...BINDING, deliveryId: '44444444-4444-4444-8444-444444444444' },
      },
      { ...base(), binding: { ...BINDING, contextRevision: 8 } },
      { ...base(), proofKeyVersion: 5 },
    ];
    for (const variant of variants) {
      expect(createOpenAiNativeSpeechTranscriptHmac({
        ...variant,
        transcript: 'Tout est prêt.',
      })).not.toBe(original);
    }
  });

  it('sépare strictement transcript, faits, nonce et identifiant fournisseur', () => {
    const proof = createOpenAiNativeSpeechPreparationProof({
      ...base(),
      canonicalSpeech: 'Reste dû : 1 320 €.',
      factsSha256: 'b'.repeat(64),
      requestNonce: 'request_nonce_1234567890_1234567890',
    });
    const responseIdHmac = createOpenAiNativeProviderResponseIdHmac({
      ...base(),
      providerResponseId: 'resp_123',
    });
    expect(new Set([
      proof.canonicalSpeechHmac,
      proof.factsHmac,
      proof.requestNonceHmac,
      responseIdHmac,
    ])).toHaveLength(4);
    expect(proof).toMatchObject({ proofFormatVersion: 1, proofKeyVersion: 4 });
    expect(JSON.stringify(proof)).not.toContain('Reste dû');
    expect(JSON.stringify(proof)).not.toContain('request_nonce');
  });

  it('refuse les entrées non canoniques et une clé trop courte', () => {
    expect(() => createOpenAiNativeSpeechTranscriptHmac({
      ...base(),
      transcript: '   ...   ',
    })).toThrow(/transcript proof/);
    expect(() => createOpenAiNativeSpeechTranscriptHmac({
      ...base(),
      secret: 'too-short',
      transcript: 'Bonjour',
    })).toThrow(/proof input/);
    expect(() => createOpenAiNativeProviderResponseIdHmac({
      ...base(),
      providerResponseId: 'bad response id',
    })).toThrow(/provider response proof/);
  });
});

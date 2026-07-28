import { describe, expect, it } from 'vitest';
import {
  isValidLocalWhisperAuditToken,
  isLocalWhisperAuditHealthPayload,
  LOCAL_WHISPER_AUDIT_CONTRACT,
  parseLocalWhisperAuditBaseUrl,
} from './local-whisper-audit-contract';

describe('contrat auditeur Whisper privé', () => {
  it('partage la limite de requête exacte du gateway', () => {
    expect(LOCAL_WHISPER_AUDIT_CONTRACT.maxRequestBytes).toBe(4_259_840);
  });

  it('partage exactement le format de jeton accepté par le gateway', () => {
    expect(isValidLocalWhisperAuditToken('a'.repeat(32))).toBe(true);
    expect(isValidLocalWhisperAuditToken('~'.repeat(256))).toBe(true);
    for (const invalid of [
      'a'.repeat(31),
      'a'.repeat(257),
      ` ${'a'.repeat(32)}`,
      `${'a'.repeat(32)}\n`,
      `é${'a'.repeat(31)}`,
      undefined,
    ]) {
      expect(isValidLocalWhisperAuditToken(invalid)).toBe(false);
    }
  });

  it('accepte uniquement le service Railway privé exact ou le loopback de développement', () => {
    expect(parseLocalWhisperAuditBaseUrl(
      'http://bob-live-whisper-audit.railway.internal:8080/v1',
    )).toEqual({
      topology: 'railway-private',
      baseUrl: 'http://bob-live-whisper-audit.railway.internal:8080/v1',
      healthUrl: 'http://bob-live-whisper-audit.railway.internal:8080/v1/health',
      transcriptionUrl:
        'http://bob-live-whisper-audit.railway.internal:8080/v1/audio/transcriptions',
    });
    expect(parseLocalWhisperAuditBaseUrl('https://localhost:8443/v1/')).toEqual({
      topology: 'loopback',
      baseUrl: 'https://localhost:8443/v1',
      healthUrl: 'https://localhost:8443/v1/health',
      transcriptionUrl: 'https://localhost:8443/v1/audio/transcriptions',
    });
  });

  it.each([
    'https://bob-live-whisper-audit.railway.internal:8080/v1',
    'http://bob-live-whisper-audit.railway.internal/v1',
    'http://another-service.railway.internal:8080/v1',
    'http://10.0.0.2:8080/v1',
    'http://169.254.169.254/v1',
    'https://audit.example/v1',
    'http://user:secret@127.0.0.1:8080/v1',
    'http://127.0.0.1:8080/other',
    'http://127.0.0.1:8080/v1?redirect=1',
    'http://127.0.0.1:8080/v1#fragment',
  ])('refuse la destination non canonique %s', (url) => {
    expect(() => parseLocalWhisperAuditBaseUrl(url)).toThrow('local_whisper_invalid_config');
  });

  it('valide une readiness liée exactement aux digests compilés', () => {
    const payload = {
      status: 'ready',
      schemaVersion: 1,
      engine: { ...LOCAL_WHISPER_AUDIT_CONTRACT.engine },
      model: { ...LOCAL_WHISPER_AUDIT_CONTRACT.model },
      capacity: { active: 1, queued: 2 },
    };
    expect(isLocalWhisperAuditHealthPayload(payload)).toBe(true);
    expect(isLocalWhisperAuditHealthPayload({
      ...payload,
      model: { ...payload.model, sha256: '0'.repeat(64) },
    })).toBe(false);
    expect(isLocalWhisperAuditHealthPayload({
      ...payload,
      capacity: { active: 2, queued: 0 },
    })).toBe(false);
    expect(isLocalWhisperAuditHealthPayload({ status: 'ready' })).toBe(false);
  });
});

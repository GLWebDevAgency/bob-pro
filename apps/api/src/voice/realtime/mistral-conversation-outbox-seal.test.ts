import { describe, expect, it } from 'vitest';
import type { MistralConversationDurableCommand } from './mistral-conversation-gateway-v2';
import {
  fingerprintMistralConversationCommand,
  openMistralConversationOutboxPayload,
  sealMistralConversationOutboxPayload,
  validateMistralConversationPersistenceKeyRing,
  type MistralConversationPersistenceKeyRing,
} from './mistral-conversation-outbox-seal';

const keyRing: MistralConversationPersistenceKeyRing = {
  currentVersion: 2,
  secret: (version) => version === 1 || version === 2
    ? Uint8Array.from({ length: 32 }, () => version)
    : null,
};
const binding = {
  companyId: 'company-1',
  sessionHandle: 'session_handle_1234567890abcdef',
  serverSequence: 7,
  eventType: 'turn.transcript',
  payloadBytes: 91,
  missionConnectionEpoch: 1,
};
const payload = '{"type":"turn.transcript","serverSequence":7,"text":"deux heures de main-d’œuvre plomberie"}';

describe('Mistral conversation persistence cryptography', () => {
  it('chiffre le transcript avec une AAD tenant/session/séquence stricte et supporte la rotation', () => {
    const exactBinding = { ...binding, payloadBytes: Buffer.byteLength(payload, 'utf8') };
    const sealed = sealMistralConversationOutboxPayload(
      payload,
      exactBinding,
      keyRing,
      () => Uint8Array.from({ length: 12 }, (_, index) => index + 1),
    );

    expect(Buffer.from(sealed.ciphertext).toString('utf8')).not.toContain('plomberie');
    expect(openMistralConversationOutboxPayload(sealed, exactBinding, keyRing)).toBe(payload);
    expect(openMistralConversationOutboxPayload(
      sealed,
      { ...exactBinding, serverSequence: 8 },
      keyRing,
    )).toBeNull();
    expect(openMistralConversationOutboxPayload(
      { ...sealed, ciphertext: Uint8Array.from(sealed.ciphertext, (byte, index) => index === 0 ? byte ^ 1 : byte) },
      exactBinding,
      keyRing,
    )).toBeNull();
    expect(openMistralConversationOutboxPayload(sealed, exactBinding, {
      currentVersion: 3,
      secret: (version) => version === 3 ? new Uint8Array(32).fill(3) : null,
    })).toBeNull();
  });

  it('HMACe le payload de commande canoniquement sans stocker transcript ni capacité', () => {
    const first = {
      type: 'record_transcript',
      commandId: 'transcript:turn_1234567890123456:0',
      turnId: 'turn_1234567890123456',
      providerSequence: 0,
      text: 'deux heures de main-d’œuvre plomberie',
      final: true,
    } satisfies MistralConversationDurableCommand;
    const reordered = {
      final: true,
      text: 'deux heures de main-d’œuvre plomberie',
      providerSequence: 0,
      turnId: 'turn_1234567890123456',
      commandId: 'transcript:turn_1234567890123456:0',
      type: 'record_transcript',
    } satisfies MistralConversationDurableCommand;
    const a = fingerprintMistralConversationCommand(first, binding, keyRing);
    const b = fingerprintMistralConversationCommand(reordered, binding, keyRing);

    expect(a).toEqual(b);
    expect(a.commandIdHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(a.payloadHmac).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(a)).not.toContain('plomberie');
    expect(fingerprintMistralConversationCommand(
      { ...first, text: 'autre texte' },
      binding,
      keyRing,
    ).payloadHmac).not.toBe(a.payloadHmac);
  });

  it('rejette un key ring courant incomplet', () => {
    expect(() => validateMistralConversationPersistenceKeyRing(keyRing)).not.toThrow();
    expect(() => validateMistralConversationPersistenceKeyRing({
      currentVersion: 4,
      secret: () => null,
    })).toThrow(/Invalid Mistral conversation persistence key ring/u);
  });
});

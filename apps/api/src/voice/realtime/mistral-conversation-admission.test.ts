import { describe, expect, it } from 'vitest';
import {
  mistralConversationProviderCallId,
  parseMistralConversationProviderCallId,
  validateMistralConversationAdmissionPolicy,
} from './mistral-conversation-admission';

const BOOTSTRAP_ID = '3a000000-0000-4000-8000-000000000001';

describe('Mistral conversation admission contract', () => {
  it('réserve un namespace mcv2 strict et réversible', () => {
    const providerCallId = mistralConversationProviderCallId(BOOTSTRAP_ID);
    expect(providerCallId).toBe(`mcv2:${BOOTSTRAP_ID}`);
    expect(parseMistralConversationProviderCallId(providerCallId)).toBe(BOOTSTRAP_ID);
    expect(parseMistralConversationProviderCallId(`mcv2:${BOOTSTRAP_ID.toUpperCase()}`)).toBeNull();
    expect(parseMistralConversationProviderCallId(`mcv1:${BOOTSTRAP_ID}`)).toBeNull();
    expect(mistralConversationProviderCallId('not-a-uuid')).toBeNull();
  });

  it('refuse toute cadence qui pourrait laisser expirer le bail entre deux heartbeats', () => {
    expect(() => validateMistralConversationAdmissionPolicy({
      activeLeaseSeconds: 30,
      heartbeatSeconds: 10,
    })).not.toThrow();
    expect(() => validateMistralConversationAdmissionPolicy({
      activeLeaseSeconds: 30,
      heartbeatSeconds: 30,
    })).toThrow(/policy/i);
    expect(() => validateMistralConversationAdmissionPolicy({
      activeLeaseSeconds: 19,
      heartbeatSeconds: 5,
    })).toThrow(/policy/i);
  });
});

import { describe, expect, it } from 'vitest';
import { AGENT_MISSION_EVENT_MAX_DATA_BYTES } from '../domain/agent/agent-mission-event';
import { AGENT_MISSION_MAX_PAYLOAD_BYTES } from '../domain/agent/agent-mission';
import { jsonUtf8ByteLength, jsonUtf8Fits } from './json-size';

describe('jsonUtf8ByteLength', () => {
  it.each([
    ['mission', AGENT_MISSION_MAX_PAYLOAD_BYTES],
    ['événement', AGENT_MISSION_EVENT_MAX_DATA_BYTES],
  ] as const)('accepte exactement N octets et refuse N+1 pour %s', (_label, limit) => {
    const exact = 'x'.repeat(limit - 2); // guillemets JSON inclus
    const over = 'x'.repeat(limit - 1);
    expect(jsonUtf8ByteLength(exact)).toBe(limit);
    expect(jsonUtf8Fits(exact, limit)).toBe(true);
    expect(jsonUtf8ByteLength(over)).toBe(limit + 1);
    expect(jsonUtf8Fits(over, limit)).toBe(false);
  });

  it.each([
    ['mission', AGENT_MISSION_MAX_PAYLOAD_BYTES],
    ['événement', AGENT_MISSION_EVENT_MAX_DATA_BYTES],
  ] as const)('compte les octets UTF-8 à la borne réelle %s', (_label, limit) => {
    const exact = 'é'.repeat((limit - 2) / 2);
    expect(jsonUtf8ByteLength('é')).toBe(4); // deux guillemets + deux octets UTF-8
    expect(jsonUtf8ByteLength(exact)).toBe(limit);
    expect(jsonUtf8Fits(exact, limit)).toBe(true);
    expect(jsonUtf8ByteLength(`${exact}x`)).toBe(limit + 1);
    expect(jsonUtf8Fits(`${exact}x`, limit)).toBe(false);
  });

  it('refuse les valeurs non sérialisables et les bornes invalides', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(jsonUtf8ByteLength(cyclic)).toBeNull();
    expect(jsonUtf8Fits(cyclic, 64)).toBe(false);
    expect(jsonUtf8Fits({}, -1)).toBe(false);
  });
});

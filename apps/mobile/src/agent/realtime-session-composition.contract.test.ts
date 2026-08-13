import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENT_SESSION = readFileSync(
  fileURLToPath(new URL('./agent-session.tsx', import.meta.url)),
  'utf8',
);
const VERTICAL_PROOF = readFileSync(
  fileURLToPath(new URL('./realtime-native-vertical.test.ts', import.meta.url)),
  'utf8',
);
const COMPOSITION = readFileSync(
  fileURLToPath(new URL('./realtime-session-composition.ts', import.meta.url)),
  'utf8',
);

const DUPLICATED_ROOTS = [
  'new RealtimeSessionController(',
  'new RealtimeResilienceOrchestrator(',
  'createRealtimePrimaryTransport(',
  'composeRealtimeConversationTransport(',
  'new RealtimeWebRtcTransport(',
  'new MistralConversationTransport(',
  'new MistralRealtimeTransport(',
] as const;

describe('Bob Live — composition root mobile unique', () => {
  it.each([
    ['AgentSessionProvider', AGENT_SESSION],
    ['preuve verticale', VERTICAL_PROOF],
  ] as const)('%s appelle la fabrique de production sans réassembler les transports', (_name, source) => {
    expect(source).toContain('createAgentRealtimeSessionController({');
    for (const duplicatedRoot of DUPLICATED_ROOTS) {
      expect(source).not.toContain(duplicatedRoot);
    }
  });

  it('centralise chaque couture du composition root exactement une fois', () => {
    for (const root of DUPLICATED_ROOTS) {
      expect(COMPOSITION.split(root)).toHaveLength(2);
    }
  });
});

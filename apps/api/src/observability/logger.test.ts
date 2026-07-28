import { describe, expect, it } from 'vitest';
import { redactLogValue } from './logger';

describe('redactLogValue', () => {
  it('masque une capability AgentMission dans les messages, erreurs et objets imbriqués', () => {
    const capability = `bam1_${Buffer.alloc(32, 72).toString('base64url')}`;
    const providerError = new Error(`provider ${capability}`);
    providerError.name = `Provider_${capability}`;
    const redacted = redactLogValue({
      message: `échec ${capability}`,
      nested: [{ capability }],
      error: providerError,
      [`header_${capability}`]: 'refused',
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(capability);
    expect(serialized).toContain('[capability-agent]');
    expect((redacted as { error: Error }).error.message)
      .toBe('provider [capability-agent]');
    expect((redacted as { error: Error }).error.name)
      .toBe('Provider_[capability-agent]');
  });

  it('coupe les objets au-delà de la profondeur maximale sans appeler leur sérialiseur', () => {
    const capability = `bam1_${Buffer.alloc(32, 73).toString('base64url')}`;
    const dangerous = {
      toJSON: () => capability,
    };
    const redacted = redactLogValue({
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: dangerous,
              },
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(capability);
    expect(serialized).toContain('[truncated]');
  });

  it('ferme les cycles et les objets exotiques sans exposer leurs propriétés', () => {
    const capability = `bam1_${Buffer.alloc(32, 74).toString('base64url')}`;
    class ProviderEnvelope {
      readonly capability = capability;
    }
    const cycle: { capability: string; self?: unknown } = { capability };
    cycle.self = cycle;

    const redacted = redactLogValue({
      cycle,
      exotic: new ProviderEnvelope(),
      binary: Buffer.from(capability),
      url: new URL(`https://example.test/?token=${capability}`),
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(capability);
    expect(serialized).toContain('[capability-agent]');
    expect(serialized).toContain('[circular]');
    expect(serialized).toContain('[non-plain-object]');
    expect(serialized).toContain('[binary]');
  });
});

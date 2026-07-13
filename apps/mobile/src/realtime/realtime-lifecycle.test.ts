import { describe, expect, it } from 'vitest';
import { shouldCloseRealtimeForAppState } from './realtime-lifecycle-policy';

describe('shouldCloseRealtimeForAppState', () => {
  it('ferme uniquement en arrière-plan durable', () => {
    expect(shouldCloseRealtimeForAppState('background')).toBe(true);
    expect(shouldCloseRealtimeForAppState('active')).toBe(false);
    expect(shouldCloseRealtimeForAppState('inactive')).toBe(false);
    expect(shouldCloseRealtimeForAppState('unknown')).toBe(false);
  });
});

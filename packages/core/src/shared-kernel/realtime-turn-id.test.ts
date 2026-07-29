import { describe, expect, it } from 'vitest';
import { deriveRealtimeTurnId } from './realtime-turn-id';

const SESSION = '00000000-0000-4000-8000-000000000001';

describe('deriveRealtimeTurnId', () => {
  it('reste identique au vecteur Node historique du sideband', () => {
    expect(deriveRealtimeTurnId(SESSION, 'item_user_42')).toBe(
      '4b7a3534-1fe0-45ab-8608-3b265ab924d7',
    );
  });

  it('est stable par item et cloisonné par session', () => {
    const first = deriveRealtimeTurnId(SESSION, 'item_user_42');
    expect(deriveRealtimeTurnId(SESSION, 'item_user_42')).toBe(first);
    expect(deriveRealtimeTurnId(SESSION, 'item_user_43')).not.toBe(first);
    expect(
      deriveRealtimeTurnId('00000000-0000-4000-8000-000000000002', 'item_user_42'),
    ).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first).not.toContain('item_user_42');
  });
});

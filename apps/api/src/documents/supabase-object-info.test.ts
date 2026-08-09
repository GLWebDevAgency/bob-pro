import { describe, expect, it } from 'vitest';
import { CompositeRequestDeadline, parseSupabaseObjectInfo } from './supabase-object-info';

describe('parseSupabaseObjectInfo', () => {
  it('conserve la métadonnée MIME autoritative et accepte ses paramètres', () => {
    expect(parseSupabaseObjectInfo({
      size: 0,
      content_type: ' application/xml; charset=utf-8 ',
    })).toEqual({
      sizeBytes: 0,
      contentType: 'application/xml; charset=utf-8',
    });
  });

  it.each([
    ['payload absent', undefined],
    ['taille absente', { content_type: 'application/pdf' }],
    ['taille négative', { size: -1, content_type: 'application/pdf' }],
    ['taille non entière', { size: 1.5, content_type: 'application/pdf' }],
  ])('refuse %s', (_label, payload) => {
    expect(() => parseSupabaseObjectInfo(payload)).toThrow('missing valid size');
  });

  it.each([
    ['absent', { size: 1 }],
    ['vide', { size: 1, content_type: '   ' }],
    ['sans type', { size: 1, content_type: '; charset=utf-8' }],
    ['sans sous-type', { size: 1, content_type: 'application' }],
    ['charset sans valeur', { size: 1, content_type: 'application/xml; charset' }],
    ['paramètre non autorisé', { size: 1, content_type: 'application/xml; boundary=poison' }],
    [
      'charset dupliqué',
      { size: 1, content_type: 'application/xml; charset=utf-8; charset=latin1' },
    ],
    ['paramètre vide', { size: 1, content_type: 'application/xml;' }],
    ['non textuel', { size: 1, content_type: 42 }],
  ])('refuse un type MIME %s', (_label, payload) => {
    expect(() => parseSupabaseObjectInfo(payload)).toThrow('missing valid content type');
  });
});

describe('CompositeRequestDeadline', () => {
  it('transmet à chaque sous-requête uniquement le budget restant', () => {
    let now = 1_000;
    const budgets: number[] = [];
    const deadline = new CompositeRequestDeadline(15_000, {
      now: () => now,
      timeoutSignal: (milliseconds) => {
        budgets.push(milliseconds);
        return new AbortController().signal;
      },
    });

    deadline.signal();
    now += 6_250;
    deadline.signal();

    expect(budgets).toEqual([15_000, 8_750]);
  });

  it('échoue avant toute nouvelle requête quand le budget est épuisé', () => {
    let now = 100;
    let createdSignals = 0;
    const deadline = new CompositeRequestDeadline(20, {
      now: () => now,
      timeoutSignal: () => {
        createdSignals += 1;
        return new AbortController().signal;
      },
    });
    now = 120;

    expect(() => deadline.signal()).toThrowError(
      expect.objectContaining({ name: 'TimeoutError' }),
    );
    expect(createdSignals).toBe(0);
  });
});

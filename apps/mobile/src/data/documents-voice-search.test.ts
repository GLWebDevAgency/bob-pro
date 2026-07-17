import { describe, expect, it } from 'vitest';

import { isFreshSalesVoiceSnapshot } from './sales-voice-query-policy';

describe('isFreshSalesVoiceSnapshot', () => {
  it('attend les trois photographies serveur', () => {
    expect(
      isFreshSalesVoiceSnapshot(
        { data: [], isError: false },
        { data: undefined, isError: false },
        { data: [], isError: false },
      ),
    ).toBe(false);
  });

  it('refuse un cache réel devenu ancien après une erreur de rafraîchissement', () => {
    expect(
      isFreshSalesVoiceSnapshot(
        { data: [{ id: 'quote-1' }], isError: false },
        { data: [{ id: 'invoice-1' }], isError: true },
        { data: [{ id: 'customer-1' }], isError: false },
      ),
    ).toBe(false);
  });

  it('ouvre la voix uniquement sur un snapshot complet et frais', () => {
    expect(
      isFreshSalesVoiceSnapshot(
        { data: [], isError: false },
        { data: [], isError: false },
        { data: [], isError: false },
      ),
    ).toBe(true);
  });
});

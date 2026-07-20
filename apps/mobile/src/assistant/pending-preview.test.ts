import { describe, expect, it } from 'vitest';
import type { PendingAction } from '@bob/ai';
import { derivePendingPreview } from './pending-preview';

const invoices = {
  isError: false,
  data: [
    {
      id: 'invoice-1',
      number: 'F-2026-001',
      totals: { netToPay: 132_000 },
      paid: 20_000,
    },
  ],
} as const;
const quotes = {
  isError: false,
  data: [{ id: 'quote-1', number: 'D-2026-001' }],
} as const;

function pending(tool: string, args: Record<string, unknown>): PendingAction {
  return { tool, args, label: tool };
}

describe('derivePendingPreview', () => {
  it('bloque tant que la collection requise n’est pas vérifiable', () => {
    expect(
      derivePendingPreview({
        pending: pending('encaisser_facture', { invoiceId: 'invoice-1' }),
        invoices: { data: undefined, isError: false },
        quotes,
      }),
    ).toEqual({ kind: 'loading' });
    expect(
      derivePendingPreview({
        pending: pending('encaisser_facture', { invoiceId: 'invoice-1' }),
        invoices: { data: invoices.data, isError: true },
        quotes,
      }),
    ).toEqual({ kind: 'error' });
  });

  it('ne fabrique jamais un reste dû à zéro quand la facture est introuvable', () => {
    expect(
      derivePendingPreview({
        pending: pending('encaisser_facture', { invoiceId: 'unknown' }),
        invoices,
        quotes,
      }),
    ).toEqual({ kind: 'missing' });
  });

  it('calcule l’aperçu d’encaissement depuis les vrais montants', () => {
    const state = derivePendingPreview({
      pending: pending('encaisser_facture', { invoiceId: 'invoice-1' }),
      invoices,
      quotes,
    });
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.diff?.title).toContain('F-2026-001');
    expect(state.diff?.fields.find((field) => field.label === 'Reste dû')?.before).toContain(
      '1\u202f120,00',
    );
  });

  it('vérifie aussi la référence du devis avant envoi', () => {
    const state = derivePendingPreview({
      pending: pending('envoyer_devis', { quoteId: 'quote-1' }),
      invoices,
      quotes,
    });
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.diff?.title).toContain('D-2026-001');
  });

  it('laisse les outils non financiers prêts sans inventer d’aperçu', () => {
    expect(
      derivePendingPreview({
        pending: pending('navigation', {}),
        invoices: { data: undefined, isError: true },
        quotes: { data: undefined, isError: true },
      }),
    ).toEqual({ kind: 'ready', diff: null });
  });
});

import { describe, expect, it } from 'vitest';
import type { NotificationView } from '@bob/api-client';
import {
  relanceHistoryForInvoice,
  relanceHistoryStatusKey,
} from './invoice-relance-history.logic';

/** PR-06 — la section « Relances » de la fiche facture = filtre PUR du fil serveur. */

function item(overrides: Partial<NotificationView> & Pick<NotificationView, 'id'>): NotificationView {
  return {
    kind: 'invoice-relance',
    title: 'Facture F-1 — relance',
    body: null,
    channel: 'email',
    status: 'done',
    route: '/facture/inv-1',
    readAt: null,
    createdAt: '2026-07-20T06:00:00.000Z',
    ...overrides,
  };
}

describe('relanceHistoryForInvoice', () => {
  it('ne garde que les relances de LA facture — jamais celles d’une autre pièce ni d’un autre kind', () => {
    const items: NotificationView[] = [
      item({ id: 'n1' }),
      item({ id: 'n2', route: '/facture/inv-2' }),
      item({ id: 'n3', kind: 'invoice-delivery' }),
      item({ id: 'n4', kind: 'quote-signature', route: '/devis/q-1' }),
      item({ id: 'n5', status: 'pending' }),
      item({ id: 'n6', route: null }),
    ];
    expect(relanceHistoryForInvoice(items, 'inv-1').map((entry) => entry.id)).toEqual(['n1', 'n5']);
    // Un id préfixe d'un autre ne matche jamais (égalité stricte de route).
    expect(relanceHistoryForInvoice(items, 'inv')).toEqual([]);
  });

  it('statut honnête : done = envoyée, failed = échec, le reste = en cours', () => {
    expect(relanceHistoryStatusKey('done')).toBe('facture.relanceSent');
    expect(relanceHistoryStatusKey('failed')).toBe('facture.relanceFailed');
    expect(relanceHistoryStatusKey('pending')).toBe('facture.relancePending');
  });
});

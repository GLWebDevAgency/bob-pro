import { describe, expect, it } from 'vitest';
import {
  deriveChantierPieces,
  type ChantierPieceInvoiceProjection,
  type ChantierPieceQuoteProjection,
} from './derive-chantier-pieces';

const quotes: ChantierPieceQuoteProjection[] = [
  { id: 'q-1', chantierId: 'site-bastille', number: 'D-2026-001', status: 'signed', totalTtcCents: 120_000, issuedAt: '2026-05-01' },
  { id: 'q-2', chantierId: 'site-rouen', number: 'D-2026-002', status: 'sent', totalTtcCents: 80_000, issuedAt: '2026-05-02' },
  { id: 'q-3', chantierId: null, number: null, status: 'draft', totalTtcCents: 10_000, issuedAt: null },
  { id: 'q-4', chantierId: 'site-bastille', number: null, status: 'draft', totalTtcCents: 45_000, issuedAt: null },
  { id: 'q-5', chantierId: 'site-bastille', number: 'D-2026-005', status: 'sent', totalTtcCents: 30_000, issuedAt: '2026-06-01' },
];

const invoices: ChantierPieceInvoiceProjection[] = [
  { id: 'f-1', chantierId: 'site-bastille', number: 'F-2026-004', status: 'issued', kind: 'final', totalTtcCents: 120_000, issuedAt: '2026-05-20' },
  { id: 'f-2', chantierId: 'site-rouen', number: 'F-2026-005', status: 'paid', kind: 'final', totalTtcCents: 80_000, issuedAt: '2026-05-25' },
  { id: 'f-3', chantierId: null, number: null, status: 'draft', kind: 'final', totalTtcCents: 5_000, issuedAt: null },
];

describe('deriveChantierPieces (PR-08 — pièces d’un site, dérivation pure)', () => {
  it('ne retient que les pièces du site demandé', () => {
    const pieces = deriveChantierPieces({ chantierId: 'site-bastille', quotes, invoices });
    expect(pieces.quotes.map((quote) => quote.id)).toEqual(['q-4', 'q-5', 'q-1']);
    expect(pieces.invoices.map((invoice) => invoice.id)).toEqual(['f-1']);
  });

  it('ordre : brouillons d’abord (travail en cours), puis les plus récents — départage déterministe', () => {
    const pieces = deriveChantierPieces({ chantierId: 'site-bastille', quotes, invoices });
    expect(pieces.quotes[0]!.issuedAt).toBeNull();
    expect(pieces.quotes[1]!.issuedAt).toBe('2026-06-01');
    expect(pieces.quotes[2]!.issuedAt).toBe('2026-05-01');
  });

  it('fail-closed : une projection SANS chantierId transporté (serveur antérieur) n’est jamais comptée', () => {
    const legacy: ChantierPieceQuoteProjection[] = [
      { id: 'q-legacy', number: 'D-2025-009', status: 'signed', totalTtcCents: 99_000, issuedAt: '2025-04-01' },
    ];
    const pieces = deriveChantierPieces({ chantierId: 'site-bastille', quotes: legacy, invoices: [] });
    expect(pieces.quotes).toHaveLength(0);
  });

  it('chantierId vide → aucune pièce (jamais un site fabriqué)', () => {
    const pieces = deriveChantierPieces({ chantierId: '   ', quotes, invoices });
    expect(pieces.quotes).toHaveLength(0);
    expect(pieces.invoices).toHaveLength(0);
  });

  it('null explicite (pièce hors site) reste hors de tout site', () => {
    const pieces = deriveChantierPieces({ chantierId: 'site-rouen', quotes, invoices });
    expect(pieces.quotes.map((quote) => quote.id)).toEqual(['q-2']);
    expect(pieces.invoices.map((invoice) => invoice.id)).toEqual(['f-2']);
  });
});

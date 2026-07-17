import { describe, expect, it } from 'vitest';
import { parseSalesDocumentRouteParams } from './documents-search-route-params';

describe('parseSalesDocumentRouteParams (B9 — flow route-params -> filtres appliqués, deep link vocal)', () => {
  it('aucun paramètre : rien à appliquer (kindFilter null = le toggle actuel ne bouge pas)', () => {
    expect(parseSalesDocumentRouteParams({})).toEqual({ kindFilter: null, dateRange: null, customerId: null });
  });

  it('type=quote -> kindFilter "quotes"', () => {
    expect(parseSalesDocumentRouteParams({ type: 'quote' }).kindFilter).toBe('quotes');
  });

  it('type=invoice -> kindFilter "invoices"', () => {
    expect(parseSalesDocumentRouteParams({ type: 'invoice' }).kindFilter).toBe('invoices');
  });

  it('type=all -> kindFilter "all"', () => {
    expect(parseSalesDocumentRouteParams({ type: 'all' }).kindFilter).toBe('all');
  });

  it('type inconnu/forgé -> kindFilter null (jamais un pari sur une valeur non reconnue)', () => {
    expect(parseSalesDocumentRouteParams({ type: 'quelque-chose' }).kindFilter).toBeNull();
  });

  it('from + to valides -> dateRange préréglage "custom"', () => {
    expect(parseSalesDocumentRouteParams({ from: '2026-06-01', to: '2026-06-30' }).dateRange).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
      preset: 'custom',
    });
  });

  it('from sans to (ou inversement) -> dateRange null, jamais une plage à moitié posée', () => {
    expect(parseSalesDocumentRouteParams({ from: '2026-06-01' }).dateRange).toBeNull();
    expect(parseSalesDocumentRouteParams({ to: '2026-06-30' }).dateRange).toBeNull();
  });

  it('date invalide (calendaire impossible) -> dateRange null', () => {
    expect(parseSalesDocumentRouteParams({ from: '2026-13-40', to: '2026-06-30' }).dateRange).toBeNull();
  });

  it('date mal formée (pas YYYY-MM-DD) -> dateRange null', () => {
    expect(parseSalesDocumentRouteParams({ from: '01/06/2026', to: '30/06/2026' }).dateRange).toBeNull();
  });

  it('customerId présent (non vide) -> transmis tel quel', () => {
    expect(parseSalesDocumentRouteParams({ customerId: 'cust-sevres' }).customerId).toBe('cust-sevres');
  });

  it('customerId vide -> null (jamais une chaîne vide qui filtrerait tout à zéro)', () => {
    expect(parseSalesDocumentRouteParams({ customerId: '' }).customerId).toBeNull();
  });

  it('deep link complet (« /ventes?type=quote&customerId=cust-sevres&from=...&to=... ») combine tout', () => {
    expect(
      parseSalesDocumentRouteParams({
        type: 'quote',
        customerId: 'cust-sevres',
        from: '2026-06-01',
        to: '2026-06-30',
      }),
    ).toEqual({
      kindFilter: 'quotes',
      dateRange: { from: '2026-06-01', to: '2026-06-30', preset: 'custom' },
      customerId: 'cust-sevres',
    });
  });
});

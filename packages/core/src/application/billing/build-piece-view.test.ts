import { describe, expect, it } from 'vitest';
import {
  buildPieceView,
  buildPartyLine,
  buildTransmissionSteps,
  formatSiren,
  type PieceCustomerData,
  type PieceInvoiceData,
  type PieceQuoteData,
} from './build-piece-view';

const MARTIN: PieceCustomerData = { id: 'c-martin', name: 'SARL Martin Rénovation', type: 'b2b', siren: '821503642' };
const DURAND: PieceCustomerData = { id: 'c-durand', name: 'Mme Durand', type: 'b2c', siren: null };
const MAIRIE: PieceCustomerData = { id: 'c-sevres', name: 'Mairie de Sèvres', type: 'b2g', siren: '217504028' };

const LINE = { id: 'l1', label: 'Pose PAC', category: 'labor' as const, qty: 1, unitPriceHT: 135667, vatRate: 20 as const };

/** Devis du test d'or : 1 628,00 € TTC, acompte 30 % → netToPay 488,40 €. */
function goldenQuote(over: Partial<PieceQuoteData> = {}): PieceQuoteData {
  return {
    id: 'q1',
    status: 'signed',
    number: 'D-2026-014',
    depositPct: 30,
    totals: { ht: 135667, vatByRate: { '20': 27133 }, vat: 27133, ttc: 162800, netToPay: 48840 },
    lines: [LINE],
    signed: true,
    customerId: MARTIN.id,
    ...over,
  };
}

function invoice(over: Partial<PieceInvoiceData> = {}): PieceInvoiceData {
  return {
    id: 'i1',
    kind: 'deposit',
    status: 'issued',
    number: 'F-2026-118',
    parentQuoteId: 'q1',
    // Réalité du domaine (Invoice.fromQuote) : les totals sont ceux du CHANTIER,
    // netToPay = l'acompte — c'est tout l'objet du correctif A1-C16.
    totals: { ht: 135667, vatByRate: { '20': 27133 }, vat: 27133, ttc: 162800, netToPay: 48840 },
    paid: 0,
    mentions: ['TVA sur les encaissements.', 'Pénalités de retard : 3× taux légal.'],
    dueAt: '2026-07-15',
    lines: [LINE],
    customerId: MARTIN.id,
    ...over,
  };
}

describe('buildPieceView — TEST D’OR acompte 488,40 (30 % de 1 628,00 €)', () => {
  it('devis signé avec acompte : deposit = { 30 %, 48 840 c } (= netToPay du domaine)', () => {
    const v = buildPieceView({ source: 'quote', quote: goldenQuote(), customer: MARTIN });
    expect(v.kind).toBe('devis');
    expect(v.deposit).toEqual({ pct: 30, amountCents: 48840 });
    expect(v.primaryAction).toBe('facturer');
    expect(v.status.tone).toBe('success');
  });

  it('facture d’acompte issue du devis : suivi plafonné netToPay, jamais ttc du chantier', () => {
    const v = buildPieceView({ source: 'invoice', invoice: invoice(), customer: MARTIN });
    expect(v.kind).toBe('acompte');
    expect(v.suivi).toEqual({ paidCents: 0, remainingCents: 48840, isPaid: false });
    expect(v.primaryAction).toBe('encaisser');
  });
});

describe('buildPieceView — partyLine adaptatif (B2C sans SIREN)', () => {
  it('b2b/b2g : SIREN formaté ; particulier : RIEN', () => {
    expect(buildPartyLine(MARTIN)).toBe('SIREN 821 503 642');
    expect(buildPartyLine(MAIRIE)).toBe('SIREN 217 504 028');
    expect(buildPartyLine(DURAND)).toBeNull();
    expect(formatSiren('732829320')).toBe('SIREN 732 829 320');
  });

  it('client B2C : pas de frise PDP — encart e-reporting', () => {
    const v = buildPieceView({ source: 'invoice', invoice: invoice({ customerId: DURAND.id }), customer: DURAND });
    expect(v.partyLine).toBeNull();
    expect(v.transmission).toBeNull();
    expect(v.isEreporting).toBe(true);
  });
});

describe('buildPieceView — avoir, situation, frise, mentions figées', () => {
  it('avoir : montant SIGNÉ négatif, pas d’action primaire, pas de suivi', () => {
    const v = buildPieceView({
      source: 'invoice',
      invoice: invoice({
        kind: 'credit_note',
        number: 'A-2026-004',
        totals: { ht: 40700, vatByRate: { '20': 8140 }, vat: 8140, ttc: 48840, netToPay: 48840 },
      }),
      customer: MARTIN,
    });
    expect(v.kind).toBe('avoir');
    expect(v.signedAmountCents).toBe(-48840);
    expect(v.suivi).toBeNull();
    expect(v.primaryAction).toBeNull();
  });

  it('situation : % d’avancement = ttc situation / ttc devis parent', () => {
    const v = buildPieceView({
      source: 'invoice',
      invoice: invoice({ kind: 'situation', totals: { ht: 54267, vatByRate: { '20': 10853 }, vat: 10853, ttc: 65120, netToPay: 65120 } }),
      customer: MARTIN,
      parentQuote: { id: 'q1', number: 'D-2026-014', ttcCents: 162800 },
    });
    expect(v.kind).toBe('situation');
    expect(v.situationProgressPct).toBe(40);
  });

  it('frise PDP dérivée du statut réel : émise=done/transmise=current ; payée=tout done ; brouillon=null', () => {
    expect(buildTransmissionSteps('issued').map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
    expect(buildTransmissionSteps('paid').every((s) => s.state === 'done')).toBe(true);
    const draft = buildPieceView({ source: 'invoice', invoice: invoice({ status: 'draft', number: null }), customer: MARTIN });
    expect(draft.transmission).toBeNull();
    expect(draft.frozen).toBe(false);
    expect(draft.primaryAction).toBe('emettre');
    const issued = buildPieceView({ source: 'invoice', invoice: invoice(), customer: MARTIN });
    expect(issued.transmission?.channel).toBe('pa');
    expect(issued.frozen).toBe(true);
  });

  it('facture en retard : relancer ; encaissement partiel : reste plafonné', () => {
    const late = buildPieceView({ source: 'invoice', invoice: invoice({ status: 'late' }), customer: MARTIN });
    expect(late.primaryAction).toBe('relancer');
    const partial = buildPieceView({ source: 'invoice', invoice: invoice({ status: 'partially_paid', paid: 20000 }), customer: MARTIN });
    expect(partial.suivi?.remainingCents).toBe(28840);
    const overpaid = buildPieceView({ source: 'invoice', invoice: invoice({ status: 'paid', paid: 99999 }), customer: MARTIN });
    expect(overpaid.suivi?.remainingCents).toBe(0);
    expect(overpaid.suivi?.isPaid).toBe(true);
  });
});

describe('buildPieceView — A1-C16 : lisibilité acompte + pont facture finale', () => {
  it('facture d’acompte : le HÉROS est le net à payer (488,40), le TTC chantier reste contextuel', () => {
    const v = buildPieceView({ source: 'invoice', invoice: invoice(), customer: MARTIN });
    expect(v.amountDue).toEqual({ cents: 48840, isPartialOfTtc: true });
    expect(v.totals.ttc).toBe(162800); // contexte chantier, plus jamais en héros
  });

  it('acompte PAYÉ sans finale : pont « créer la facture finale » avec le reste EXACT', () => {
    const v = buildPieceView({
      source: 'invoice',
      invoice: invoice({ status: 'paid', paid: 48840 }),
      customer: MARTIN,
      parentQuote: { id: 'q1', number: 'D-2026-0001', ttcCents: 162800 },
    });
    expect(v.nextStep).toEqual({ kind: 'facture_finale', quoteId: 'q1', remainingToInvoiceCents: 113960 });
  });

  it('pont muet si la finale existe déjà, si l’acompte n’est pas payé, ou sans devis parent', () => {
    const paid = { status: 'paid' as const, paid: 48840 };
    const withFinal = buildPieceView({
      source: 'invoice',
      invoice: invoice(paid),
      customer: MARTIN,
      parentQuote: { id: 'q1', number: 'D-2026-0001', ttcCents: 162800 },
      hasFinalInvoice: true,
    });
    expect(withFinal.nextStep).toBeNull();
    const unpaid = buildPieceView({
      source: 'invoice',
      invoice: invoice(),
      customer: MARTIN,
      parentQuote: { id: 'q1', number: 'D-2026-0001', ttcCents: 162800 },
    });
    expect(unpaid.nextStep).toBeNull();
    const orphan = buildPieceView({ source: 'invoice', invoice: invoice(paid), customer: MARTIN });
    expect(orphan.nextStep).toBeNull();
  });

  it('facture finale classique : héros = TTC (pas de partiel), pas de pont', () => {
    const v = buildPieceView({
      source: 'invoice',
      invoice: invoice({ kind: 'final', totals: { ht: 94967, vatByRate: { '20': 18993 }, vat: 18993, ttc: 113960, netToPay: 113960 } }),
      customer: MARTIN,
    });
    expect(v.amountDue).toEqual({ cents: 113960, isPartialOfTtc: false });
    expect(v.nextStep).toBeNull();
  });
});

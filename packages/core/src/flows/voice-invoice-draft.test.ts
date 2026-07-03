import { describe, it, expect } from 'vitest';
import { computeTotals } from '../domain/services/compute-totals';
import { deriveVoiceInvoiceDraft } from './voice-invoice-draft';

const CUSTOMERS = [
  { id: 'durand', name: 'Mme Durand' },
  { id: 'martin', name: 'SARL Martin Rénovation' },
  { id: 'camping', name: 'Camping Les Pins' },
];

describe('flows/voice-invoice-draft (C20 — transcript -> brouillon pur)', () => {
  it('happy path du proto : client reconnu, matériel HT, reliquat main-d’œuvre, total TTC exact, carte', () => {
    const r = deriveVoiceInvoiceDraft({
      transcript:
        "Facture pour Mme Durand — remplacement du mitigeur de cuisine. Main-d'œuvre 1h30, matériel 85 €. Total 245 € TTC, paiement par carte.",
      customers: CUSTOMERS,
      defaultVatRate: 20,
    });
    expect(r.draft.customerId).toBe('durand');
    expect(r.paymentMethod).toBe('card');
    expect(r.vatRate).toBe(20);
    expect(r.draft.lines).toHaveLength(2);
    expect(r.draft.lines[0]).toMatchObject({ category: 'supply', unitPriceHT: 8500 });
    // Reliquat HT = round(24500 / 1,2) − 8500 = 11 917 — jamais un montant inventé au-delà du total énoncé.
    expect(r.draft.lines[1]).toMatchObject({ category: 'labor', unitPriceHT: 11917 });
    expect(r.draft.lines[1]?.label).toContain('1h30');
    expect(computeTotals([...r.draft.lines]).ttc).toBe(24500);
  });

  it('montant unique sans catégorie = total TTC (fixture C02 : 300 € -> 250 € HT à 20 %)', () => {
    const r = deriveVoiceInvoiceDraft({
      transcript: 'Facture de 300 euros pour le débouchage chez Mme Durand',
      customers: CUSTOMERS,
      defaultVatRate: 20,
    });
    expect(r.draft.customerId).toBe('durand');
    expect(r.draft.lines).toHaveLength(1);
    expect(r.draft.lines[0]).toMatchObject({ category: 'labor', unitPriceHT: 25000, vatRate: 20 });
    expect(r.paymentMethod).toBe('transfer');
  });

  it('TVA énoncée > TVA métier ; espèces reconnues ; forme juridique ignorée pour le client', () => {
    const r = deriveVoiceInvoiceDraft({
      transcript: 'Pour Martin, fournitures 120 €, TVA 10 %, payé en espèces',
      customers: CUSTOMERS,
      defaultVatRate: 20,
    });
    expect(r.vatRate).toBe(10);
    expect(r.paymentMethod).toBe('cash');
    expect(r.draft.customerId).toBe('martin');
    expect(r.draft.lines[0]).toMatchObject({ category: 'supply', unitPriceHT: 12000, vatRate: 10 });
  });

  it("rien d'exploitable : zéro ligne (voiceCaptured refusera), client inconnu -> null", () => {
    const r = deriveVoiceInvoiceDraft({
      transcript: 'Facture pour le chantier de la rue des Lilas',
      customers: CUSTOMERS,
    });
    expect(r.draft.customerId).toBeNull();
    expect(r.draft.lines).toHaveLength(0);
    expect(r.draft.transcript).toBe('Facture pour le chantier de la rue des Lilas');
  });

  it('TVA métier par défaut (BTP 10 %) et montants décimaux « 89,50 € »', () => {
    const r = deriveVoiceInvoiceDraft({
      transcript: 'Déplacement 20 €, matériel 89,50 € chez Camping Les Pins',
      customers: CUSTOMERS,
      defaultVatRate: 10,
    });
    expect(r.vatRate).toBe(10);
    expect(r.draft.customerId).toBe('camping');
    expect(r.draft.lines).toHaveLength(2);
    expect(r.draft.lines[0]).toMatchObject({ category: 'travel', unitPriceHT: 2000 });
    expect(r.draft.lines[1]).toMatchObject({ category: 'supply', unitPriceHT: 8950 });
  });
});

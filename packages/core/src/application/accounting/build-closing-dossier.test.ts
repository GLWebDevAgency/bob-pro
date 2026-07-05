import { describe, expect, it } from 'vitest';
import { buildClosingDossier, type ClosingDossierInput } from './build-closing-dossier';

/** Petite entreprise équilibrée (même jeu que le test bilan). */
const ENTRIES: ClosingDossierInput['entries'] = [
  { lines: [{ account: '512', debitCents: 500000, creditCents: 0 }, { account: '101', debitCents: 0, creditCents: 500000 }] },
  { lines: [{ account: '215', debitCents: 200000, creditCents: 0 }, { account: '512', debitCents: 0, creditCents: 200000 }] },
  { lines: [{ account: '6811', debitCents: 40000, creditCents: 0 }, { account: '2815', debitCents: 0, creditCents: 40000 }] },
  {
    lines: [
      { account: '411', debitCents: 120000, creditCents: 0 },
      { account: '706', debitCents: 0, creditCents: 100000 },
      { account: '44571', debitCents: 0, creditCents: 20000 },
    ],
  },
  { lines: [{ account: '512', debitCents: 120000, creditCents: 0 }, { account: '411', debitCents: 0, creditCents: 120000 }] },
  {
    lines: [
      { account: '606', debitCents: 30000, creditCents: 0 },
      { account: '44566', debitCents: 6000, creditCents: 0 },
      { account: '401', debitCents: 0, creditCents: 36000 },
    ],
  },
];

function input(over: Partial<ClosingDossierInput> = {}): ClosingDossierInput {
  return {
    company: { name: 'Mercier Plomberie', siren: '812507441' },
    period: { from: '2026-07-01', to: '2026-07-31' },
    generatedOn: '2026-08-01',
    entries: ENTRIES,
    ...over,
  };
}

describe('buildClosingDossier (DOSSIER-1 — la note de synthèse pour l’expert)', () => {
  it('assemble les trois états, cohérents, avec en-tête société et période', () => {
    const d = buildClosingDossier(input());
    expect(d.filename).toBe('Dossier-cloture-812507441-20260731.txt');
    expect(d.content).toContain('DOSSIER DE CLÔTURE');
    expect(d.content).toContain('Mercier Plomberie — SIREN 812507441');
    expect(d.content).toContain('Période du 2026-07-01 au 2026-07-31');
    // Les 3 états sont présents.
    expect(d.content).toContain('COMPTE DE RÉSULTAT');
    expect(d.content).toContain('BILAN');
    expect(d.content).toContain('BALANCE GÉNÉRALE');
  });

  it('reprend les chiffres réels : résultat net, équilibre du bilan, partie double', () => {
    const d = buildClosingDossier(input());
    expect(d.content).toContain('RÉSULTAT NET'); // 300,00 € sur ce jeu
    expect(d.content).toContain('300,00');
    expect(d.content).toContain('Équilibre : actif = passif ✓');
    expect(d.content).toContain('Partie double équilibrée ✓');
    expect(d.content).toContain('Total actif');
    expect(d.content).toContain('Total passif');
  });

  it('masque les rubriques nulles et signale à faire signer par l’expert', () => {
    const d = buildClosingDossier(input());
    expect(d.content).not.toContain('Stocks'); // pas de stock sur ce jeu
    expect(d.content).not.toContain('Résultat financier'); // pas de financier
    expect(d.content).toContain('À faire vérifier et signer par votre expert-comptable.');
  });

  it('grand-livre vide : dossier honnête, résultat nul, équilibré', () => {
    const d = buildClosingDossier(input({ entries: [] }));
    expect(d.content).toContain('Équilibre : actif = passif ✓');
    expect(d.content).toContain('Partie double équilibrée ✓');
  });
});

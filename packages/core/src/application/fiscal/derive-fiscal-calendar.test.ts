import { describe, it, expect } from 'vitest';
import {
  deriveFiscalCalendar,
  type FiscalCompanyData,
  type FiscalDeadline,
} from './derive-fiscal-calendar';

function micro(overrides?: Partial<FiscalCompanyData>): FiscalCompanyData {
  return { legalForm: 'micro', vatRegime: 'franchise', ...overrides };
}
function sasu(overrides?: Partial<FiscalCompanyData>): FiscalCompanyData {
  return { legalForm: 'SASU', vatRegime: 'reel_normal', ...overrides };
}

function byId(deadlines: FiscalDeadline[], id: string): FiscalDeadline {
  const found = deadlines.find((d) => d.id === id);
  if (!found) throw new Error(`échéance absente : ${id} (présentes : ${deadlines.map((d) => d.id).join(', ')})`);
  return found;
}
function kinds(deadlines: FiscalDeadline[]): Set<string> {
  return new Set(deadlines.map((d) => d.kind));
}

describe('deriveFiscalCalendar — URSSAF micro', () => {
  it('mensuel : dernier jour de chaque mois de la fenêtre, certain, art. L613-8 CSS', () => {
    const result = deriveFiscalCalendar({
      company: micro(),
      asOf: '2026-02-10',
      urssafPeriodicity: 'monthly',
    }); // fenêtre défaut 90 j → 2026-05-11
    expect(result.map((d) => d.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    for (const d of result) {
      expect(d.kind).toBe('urssaf');
      expect(d.legalRef).toBe('art. L613-8 CSS');
      expect(d.confidence).toBe('certain');
      expect(d.amountHint).toBeNull();
      expect(d.label).toContain('mensuelle');
    }
  });

  it('trimestriel : 31/1, 30/4, 31/7, 31/10 — seules les occurrences de la fenêtre', () => {
    const result = deriveFiscalCalendar({
      company: micro(),
      asOf: '2026-02-10',
      urssafPeriodicity: 'quarterly',
    });
    expect(result).toHaveLength(1);
    const d = byId(result, 'urssaf-2026-04-30');
    expect(d.date).toBe('2026-04-30');
    expect(d.kind).toBe('urssaf');
    expect(d.legalRef).toBe('art. L613-8 CSS');
    expect(d.confidence).toBe('certain');
    expect(d.label).toContain('trimestrielle');
  });

  it('périodicité inconnue : première occurrence de chaque hypothèse, assumed, explain invitant à préciser', () => {
    const result = deriveFiscalCalendar({ company: micro(), asOf: '2026-02-10' });
    expect(result.map((d) => d.date)).toEqual(['2026-02-28', '2026-04-30']);
    for (const d of result) {
      expect(d.kind).toBe('urssaf');
      expect(d.confidence).toBe('assumed');
      expect(d.explain).toContain('périodicité');
    }
  });

  it('périodicité inconnue : hypothèses confondues (fin de trimestre) → une seule échéance', () => {
    const result = deriveFiscalCalendar({ company: micro(), asOf: '2026-01-05', horizonDays: 30 });
    // Première mensuelle = première trimestrielle = 2026-01-31 → dédoublonnée.
    expect(result.map((d) => d.id)).toEqual(['urssaf-2026-01-31']);
    expect(byId(result, 'urssaf-2026-01-31').confidence).toBe('assumed');
  });

  it("l'EI au réel n'émet ni URSSAF ni IR (PAS automatique — hors périmètre v1)", () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'EI', vatRegime: 'franchise' },
      asOf: '2026-02-10',
      urssafPeriodicity: 'monthly',
    });
    expect(kinds(result).has('urssaf')).toBe(false);
    expect(kinds(result).has('ir')).toBe(false);
  });
});

describe('deriveFiscalCalendar — TVA', () => {
  it('franchise : aucune échéance TVA sur 12 mois', () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'SARL', vatRegime: 'franchise' },
      asOf: '2026-01-01',
      horizonDays: 365,
      fiscalYearEnd: '12-31',
    });
    expect(kinds(result).has('tva')).toBe(false);
  });

  it('réel normal : CA3 posée au 24 de chaque mois, assumed, art. 287, 2 CGI', () => {
    const result = deriveFiscalCalendar({
      company: micro({ vatRegime: 'reel_normal' }),
      asOf: '2026-03-01',
      horizonDays: 31,
      urssafPeriodicity: 'monthly',
    }); // fenêtre → 2026-04-01
    const ca3 = result.filter((d) => d.kind === 'tva');
    expect(ca3.map((d) => d.id)).toEqual(['tva-ca3-2026-03-24']);
    const d = byId(ca3, 'tva-ca3-2026-03-24');
    expect(d.legalRef).toBe('art. 287, 2 CGI');
    expect(d.confidence).toBe('assumed');
    expect(d.explain).toContain('15');
    expect(d.explain).toContain('24');
    // Orthogonalité micro × TVA : l'URSSAF mensuelle coexiste.
    expect(byId(result, 'urssaf-2026-03-31').kind).toBe('urssaf');
  });

  it('réel simplifié : CA12 au 2e jour ouvré suivant le 1er mai (5 mai 2026) + acompte de juillet 55 %', () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'EI', vatRegime: 'reel_simpl' },
      asOf: '2026-04-01',
      horizonDays: 120,
    }); // fenêtre → 2026-07-30
    const ca12 = byId(result, 'tva-ca12-2026');
    expect(ca12.date).toBe('2026-05-05'); // 1er mai 2026 = vendredi → lundi 4 (1er ouvré), mardi 5 (2e).
    expect(ca12.kind).toBe('tva');
    expect(ca12.legalRef).toBe('art. 287, 3 CGI');
    expect(ca12.confidence).toBe('certain');

    const july = byId(result, 'tva-acompte-juillet-2026');
    expect(july.date).toBe('2026-07-24');
    expect(july.confidence).toBe('assumed');
    expect(july.explain).toContain('55');
    expect(july.legalRef).toBe('art. 287, 3 CGI');

    // EI : ni IS, ni comptes, ni URSSAF (pas micro), ni IR.
    expect(kinds(result)).toEqual(new Set(['tva', 'cfe']));
  });

  it("réel simplifié : acompte de décembre 40 % dans une fenêtre d'hiver", () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'EI', vatRegime: 'reel_simpl' },
      asOf: '2026-11-01',
      horizonDays: 60,
    }); // fenêtre → 2026-12-31
    const december = byId(result, 'tva-acompte-decembre-2026');
    expect(december.date).toBe('2026-12-24');
    expect(december.confidence).toBe('assumed');
    expect(december.explain).toContain('40');
    expect(byId(result, 'cfe-solde-2026').date).toBe('2026-12-15');
  });
});

describe('deriveFiscalCalendar — société IS, clôture 31/12', () => {
  const input = {
    company: sasu(),
    asOf: '2026-04-01',
    horizonDays: 120, // fenêtre → 2026-07-30 (borne haute incluse)
    fiscalYearEnd: '12-31',
  };

  it('émet la séquence complète triée : CA3, liasse, solde 15 mai, acomptes, CFE, AG + dépôt', () => {
    const result = deriveFiscalCalendar(input);
    expect(result.map((d) => d.id)).toEqual([
      'tva-ca3-2026-04-24',
      'is-liasse-2065-2026-05-05',
      'is-solde-2026-05-15',
      'tva-ca3-2026-05-24',
      'is-acompte-2026-06-15',
      'cfe-acompte-2026',
      'tva-ca3-2026-06-24',
      'comptes-ag-2026-06-30',
      'tva-ca3-2026-07-24',
      'comptes-depot-2026-07-30',
    ]);
  });

  it('solde : 15 mai (dérogation clôture 31/12), certain, art. 1668, 2 + art. 360 annexe III', () => {
    const d = byId(deriveFiscalCalendar(input), 'is-solde-2026-05-15');
    expect(d.date).toBe('2026-05-15');
    expect(d.kind).toBe('is');
    expect(d.legalRef).toBe('art. 1668, 2 CGI ; art. 360 annexe III CGI');
    expect(d.confidence).toBe('certain');
  });

  it('liasse 2065 : 2e jour ouvré suivant le 1er mai, certain, art. 223, 1 CGI', () => {
    const d = byId(deriveFiscalCalendar(input), 'is-liasse-2065-2026-05-05');
    expect(d.date).toBe('2026-05-05');
    expect(d.kind).toBe('is');
    expect(d.legalRef).toBe('art. 223, 1 CGI');
    expect(d.confidence).toBe('certain');
  });

  it('acompte : assumed (dispense possible), art. 1668, 1 + art. 359, 3 annexe III', () => {
    const d = byId(deriveFiscalCalendar(input), 'is-acompte-2026-06-15');
    expect(d.date).toBe('2026-06-15');
    expect(d.kind).toBe('is');
    expect(d.label).toBe('IS : 2e acompte');
    expect(d.legalRef).toBe('art. 1668, 1 CGI ; art. 359, 3 annexe III CGI');
    expect(d.confidence).toBe('assumed');
    expect(d.explain).toContain('dispense');
  });

  it('rituel annuel : AG dans les 6 mois (30/6) puis dépôt un mois après (30/7), assumed, refs C. com.', () => {
    const result = deriveFiscalCalendar(input);
    const ag = byId(result, 'comptes-ag-2026-06-30');
    expect(ag.kind).toBe('comptes');
    expect(ag.legalRef).toBe('art. L227-9 C. com.');
    expect(ag.confidence).toBe('assumed');
    expect(ag.explain).toContain('dépôt au greffe vaut approbation'); // simplification associé unique (SASU)
    const depot = byId(result, 'comptes-depot-2026-07-30');
    expect(depot.kind).toBe('comptes');
    expect(depot.legalRef).toBe('art. L232-23 C. com.');
    expect(depot.confidence).toBe('assumed');
    expect(depot.explain).toContain('2 mois');
  });

  it('SARL : refs AG/dépôt côté L223-26 / L232-22, explain générique sans simplification', () => {
    const result = deriveFiscalCalendar({ ...input, company: { legalForm: 'SARL', vatRegime: 'franchise' } });
    const ag = byId(result, 'comptes-ag-2026-06-30');
    expect(ag.legalRef).toBe('art. L223-26 C. com.');
    expect(ag.explain).not.toContain('associé unique');
    expect(byId(result, 'comptes-depot-2026-07-30').legalRef).toBe('art. L232-22 C. com.');
  });

  it('CFE : acompte 15/6 conditionnel (assumed) — art. 1679 quinquies', () => {
    const d = byId(deriveFiscalCalendar(input), 'cfe-acompte-2026');
    expect(d.date).toBe('2026-06-15');
    expect(d.kind).toBe('cfe');
    expect(d.legalRef).toBe('art. 1679 quinquies CGI');
    expect(d.confidence).toBe('assumed');
    expect(d.explain).toContain('3 000');
  });
});

describe('deriveFiscalCalendar — société IS, clôture décalée', () => {
  it('clôture 30/6 : solde 15/10, liasse 30/9 (clôture + 3 mois), 3e acompte 15/9 — le tout certain/assumed', () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'SAS', vatRegime: 'franchise' },
      asOf: '2026-08-20',
      horizonDays: 90, // fenêtre → 2026-11-18
      fiscalYearEnd: '06-30',
    });
    expect(result.map((d) => d.id)).toEqual([
      'is-acompte-2026-09-15',
      'is-liasse-2065-2026-09-30',
      'is-solde-2026-10-15',
    ]);
    const solde = byId(result, 'is-solde-2026-10-15');
    expect(solde.confidence).toBe('certain'); // pas de dérogation 15 mai hors 31/12
    expect(solde.legalRef).toBe('art. 1668, 2 CGI ; art. 360 annexe III CGI');
    const liasse = byId(result, 'is-liasse-2065-2026-09-30');
    expect(liasse.confidence).toBe('certain');
    expect(byId(result, 'is-acompte-2026-09-15').label).toBe('IS : 3e acompte');
  });

  it("clôture 31/10 : liasse 31/1 N+1 (passage d'année) et solde 15/2 N+1", () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'SASU', vatRegime: 'franchise' },
      asOf: '2027-01-01',
      horizonDays: 45, // fenêtre → 2027-02-15
      fiscalYearEnd: '10-31',
    });
    expect(result.map((d) => d.id)).toEqual(['is-liasse-2065-2027-01-31', 'is-solde-2027-02-15']);
  });

  it("clôture inconnue : défaut 31/12 posé, solde/liasse en 'assumed' avec explain de confirmation", () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'SASU', vatRegime: 'franchise' },
      asOf: '2026-04-20',
      horizonDays: 30, // fenêtre → 2026-05-20
    });
    expect(result.map((d) => d.id)).toEqual(['is-liasse-2065-2026-05-05', 'is-solde-2026-05-15']);
    for (const d of result) {
      expect(d.confidence).toBe('assumed');
      expect(d.explain).toContain('confirme');
    }
  });

  it("fiscalYearEnd invalide ('31-12') : traité comme inconnu → défaut 31/12 assumed", () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'SASU', vatRegime: 'franchise' },
      asOf: '2026-04-20',
      horizonDays: 30,
      fiscalYearEnd: '31-12',
    });
    expect(byId(result, 'is-solde-2026-05-15').confidence).toBe('assumed');
  });
});

describe('deriveFiscalCalendar — année de création', () => {
  it('CFE : la 1447-C avant le 31/12 remplace le solde du 15/12, certain, art. 1478, II CGI', () => {
    const result = deriveFiscalCalendar({
      company: micro({ dateCreation: '2026-03-15' }),
      asOf: '2026-10-01',
      horizonDays: 92, // fenêtre → 2027-01-01 : le 15/12 est DANS la fenêtre, son absence est significative
      urssafPeriodicity: 'monthly',
    });
    expect(result.some((d) => d.id === 'cfe-solde-2026')).toBe(false);
    expect(result.some((d) => d.id === 'cfe-acompte-2026')).toBe(false);
    const cfe = byId(result, 'cfe-1447c-2026');
    expect(cfe.date).toBe('2026-12-31');
    expect(cfe.kind).toBe('cfe');
    expect(cfe.legalRef).toBe('art. 1478, II CGI');
    expect(cfe.confidence).toBe('certain');
    expect(cfe.explain).toContain('1447-C');
  });

  it('teinte les explains des échéances de la première année (« Ta première année : … »)', () => {
    const result = deriveFiscalCalendar({
      company: micro({ dateCreation: '2026-03-15' }),
      asOf: '2026-10-01',
      horizonDays: 92,
      urssafPeriodicity: 'monthly',
    });
    for (const d of result) {
      expect(d.date.startsWith('2026')).toBe(true);
      expect(d.explain.startsWith('Ta première année :')).toBe(true);
    }
    // Tri stable au 31/12 : URSSAF (génération avant CFE) puis 1447-C.
    const dec31 = result.filter((d) => d.date === '2026-12-31').map((d) => d.id);
    expect(dec31).toEqual(['urssaf-2026-12-31', 'cfe-1447c-2026']);
  });

  it("hors année de création (dateCreation passée), le solde CFE normal revient et rien n'est teinté", () => {
    const result = deriveFiscalCalendar({
      company: micro({ dateCreation: '2024-05-01' }),
      asOf: '2026-10-01',
      horizonDays: 92,
      urssafPeriodicity: 'monthly',
    });
    expect(byId(result, 'cfe-solde-2026').date).toBe('2026-12-15');
    expect(result.some((d) => d.id === 'cfe-1447c-2026')).toBe(false);
    for (const d of result) expect(d.explain.startsWith('Ta première année')).toBe(false);
  });
});

describe('deriveFiscalCalendar — fenêtre et tri', () => {
  it('borne basse incluse : une échéance tombant exactement sur asOf est émise (horizon 0)', () => {
    const result = deriveFiscalCalendar({
      company: micro(),
      asOf: '2026-02-28',
      horizonDays: 0,
      urssafPeriodicity: 'monthly',
    });
    expect(result.map((d) => d.date)).toEqual(['2026-02-28']);
  });

  it('borne haute incluse : asOf + horizonDays tombant sur une échéance la retient', () => {
    const result = deriveFiscalCalendar({
      company: micro(),
      asOf: '2026-02-01',
      horizonDays: 27, // → 2026-02-28
      urssafPeriodicity: 'monthly',
    });
    expect(result.map((d) => d.date)).toEqual(['2026-02-28']);
  });

  it('au-delà de la borne haute : exclue (horizon 26 → 2026-02-27)', () => {
    const result = deriveFiscalCalendar({
      company: micro(),
      asOf: '2026-02-01',
      horizonDays: 26,
      urssafPeriodicity: 'monthly',
    });
    expect(result).toHaveLength(0);
  });

  it('12 mois de SASU au réel simplifié : 13 échéances, ids uniques, dates croissantes, tri stable aux ex æquo', () => {
    const result = deriveFiscalCalendar({
      company: { legalForm: 'SASU', vatRegime: 'reel_simpl' },
      asOf: '2026-01-10',
      horizonDays: 365, // fenêtre → 2027-01-10
      fiscalYearEnd: '12-31',
    });
    expect(result.map((d) => d.id)).toEqual([
      'is-acompte-2026-03-15',
      'tva-ca12-2026', // 2026-05-05 — ex æquo avec la liasse : TVA générée avant IS
      'is-liasse-2065-2026-05-05',
      'is-solde-2026-05-15',
      'is-acompte-2026-06-15', // 2026-06-15 — ex æquo : IS avant CFE
      'cfe-acompte-2026',
      'comptes-ag-2026-06-30',
      'tva-acompte-juillet-2026',
      'comptes-depot-2026-07-30',
      'is-acompte-2026-09-15',
      'is-acompte-2026-12-15', // 2026-12-15 — ex æquo : IS avant CFE
      'cfe-solde-2026',
      'tva-acompte-decembre-2026',
    ]);
    expect(new Set(result.map((d) => d.id)).size).toBe(result.length);
    const dates = result.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
    for (const d of result) expect(d.amountHint).toBeNull();
  });
});

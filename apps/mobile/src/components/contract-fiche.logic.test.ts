import { describe, expect, it } from 'vitest';
import {
  contractEventDay,
  contractHistoryEntries,
  contractPrimaryCta,
  frContractDate,
  importCoveredUntilFromInclusive,
  inclusiveFromImportCoveredUntil,
  inclusivePeriodOf,
} from './contract-fiche.logic';

describe('[annexe erratum n° 4] importCoveredUntil — saisie INCLUSIVE → colonne EXCLUSIVE', () => {
  it('convertit +1 jour : « facturé jusqu’au 11/10/2026 inclus » → borne exclusive 2026-10-12', () => {
    expect(importCoveredUntilFromInclusive('2026-10-11')).toBe('2026-10-12');
  });

  it('anti off-by-one : la période migrée [2025-10-12, 2026-10-12) est ENTIÈREMENT couverte par la saisie 2026-10-11', () => {
    // La dérivation compare period.end ≤ importCoveredUntil (bornes exclusives toutes deux) :
    // sans la conversion, la saisie brute (2026-10-11) laisserait period.end (2026-10-12) >
    // importCoveredUntil → « facture annuelle à émettre » à TORT sur toute la flotte migrée
    // au jour 1 — exactement le bruit que P13 corrige, recréé par un off-by-one.
    const periodEndExclusive = '2026-10-12';
    const converted = importCoveredUntilFromInclusive('2026-10-11');
    expect(converted).not.toBeNull();
    expect(periodEndExclusive <= converted!).toBe(true);
    // Et la saisie de la VEILLE (2026-10-10) ne couvre PAS la période : rien n'est sur-couvert.
    const dayBefore = importCoveredUntilFromInclusive('2026-10-10');
    expect(periodEndExclusive <= dayBefore!).toBe(false);
  });

  it('traverse les fins de mois et d’année sans trou (31/12 → 01/01, 28/02 → 01/03)', () => {
    expect(importCoveredUntilFromInclusive('2026-12-31')).toBe('2027-01-01');
    expect(importCoveredUntilFromInclusive('2027-02-28')).toBe('2027-03-01');
  });

  it('vide ou invalide → null (champ optionnel, jamais une date inventée)', () => {
    expect(importCoveredUntilFromInclusive('')).toBeNull();
    expect(importCoveredUntilFromInclusive('  ')).toBeNull();
    expect(importCoveredUntilFromInclusive('11/10/2026')).toBeNull();
  });

  it('inverse exacte pour l’édition : colonne exclusive → affichage inclusif (aller-retour stable)', () => {
    expect(inclusiveFromImportCoveredUntil('2026-10-12')).toBe('2026-10-11');
    expect(inclusiveFromImportCoveredUntil(null)).toBe('');
    const inclusive = '2026-10-11';
    expect(inclusiveFromImportCoveredUntil(importCoveredUntilFromInclusive(inclusive))).toBe(inclusive);
  });
});

describe('affichage des périodes — bornes INCLUSES lisibles (amélioration 5)', () => {
  it('montre la VEILLE de la fin exclusive (jamais une borne qui ment d’un jour)', () => {
    expect(inclusivePeriodOf({ start: '2025-10-12', end: '2026-10-12' })).toEqual({
      start: '2025-10-12',
      end: '2026-10-11',
    });
  });

  it('frContractDate : dates complètes en toutes lettres (a11y — jamais couleur seule)', () => {
    expect(frContractDate('2026-10-12')).toBe('12 oct. 2026');
    expect(frContractDate('2027-02-01')).toBe('1 févr. 2027');
  });
});

describe('historique honnête [revue P10] — faits stockés + reconductions étiquetées (calculé)', () => {
  it('mêle activation (stockée), reconductions (calculées) et résiliation (stockée + motif), tri décroissant', () => {
    const entries = contractHistoryEntries({
      contract: {
        activatedAt: '2024-10-12T08:00:00.000Z',
        terminatedAt: '2026-11-02T09:00:00.000Z',
        terminationNote: 'Marché perdu.',
      },
      renewals: ['2025-10-12', '2026-10-12'],
    });
    expect(entries.map((entry) => entry.kind)).toEqual([
      'terminated',
      'renewed',
      'renewed',
      'activated',
    ]);
    expect(entries.filter((entry) => entry.computed).map((entry) => entry.kind)).toEqual([
      'renewed',
      'renewed',
    ]);
    expect(entries[0]!.note).toBe('Marché perdu.');
  });

  /**
   * MÊME faille que celle corrigée sur TerminateContract (97a96840) : `.slice(0, 10)` rend le
   * jour UTC, pas le jour MÉTIER. Entre 00 h et 02 h à Paris, l'UTC est encore la VEILLE —
   * l'historique daterait activation et résiliation d'un jour trop tôt, et le pro lirait une
   * date qui ne correspond ni à son geste ni à ce que le domaine a écrit.
   */
  it('[jour MÉTIER Paris] un fait posé à 00 h 30 n’est jamais daté de la veille', () => {
    const entries = contractHistoryEntries({
      contract: {
        // 12/10/2024 22 h 30 UTC = 13 octobre 00 h 30 à Paris (CEST, UTC+2).
        activatedAt: '2024-10-12T22:30:00.000Z',
        // 02/11/2026 23 h 30 UTC = 3 novembre 00 h 30 à Paris (CET, UTC+1).
        terminatedAt: '2026-11-02T23:30:00.000Z',
        terminationNote: 'Marché perdu.',
      },
      renewals: [],
    });
    expect(entries.map((entry) => entry.at)).toEqual(['2026-11-03', '2024-10-13']);
  });

  it('contractEventDay : jour métier Paris d’un instant stocké, null si le fait n’existe pas', () => {
    expect(contractEventDay('2026-11-02T23:30:00.000Z')).toBe('2026-11-03');
    // Même instant lu en plein jour : aucun décalage inventé.
    expect(contractEventDay('2026-11-02T09:00:00.000Z')).toBe('2026-11-02');
    expect(contractEventDay(null)).toBeNull();
    expect(contractEventDay('')).toBeNull();
  });

  it('brouillon jamais activé : historique vide (aucun fait inventé)', () => {
    expect(
      contractHistoryEntries({
        contract: { activatedAt: null, terminatedAt: null, terminationNote: null },
        renewals: [],
      }),
    ).toEqual([]);
  });
});

describe('CTA primaire §3.1 — dérivé, transitions interdites = CTA ABSENTS', () => {
  it('draft → Activer ; active + due → Préparer ; active couvert → aucun ; résilié → aucun', () => {
    expect(contractPrimaryCta({ status: 'draft', billingDue: null })).toBe('activate');
    expect(contractPrimaryCta({ status: 'active', billingDue: { period: {} } })).toBe(
      'prepare_annual_invoice',
    );
    expect(contractPrimaryCta({ status: 'active', billingDue: null })).toBeNull();
    expect(contractPrimaryCta({ status: 'terminated', billingDue: null })).toBeNull();
  });
});

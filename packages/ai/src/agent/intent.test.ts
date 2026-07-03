import { describe, it, expect } from 'vitest';
import { detectIntent } from './intent';

describe('detectIntent — clôture (préparer le mois)', () => {
  it('reconnaît les commandes de clôture / préparation du mois', () => {
    for (const m of [
      'Prépare mon mois pour le comptable',
      'Clôture le mois',
      'Prépare le mois',
      'Boucle mon mois',
      'Prépare tout pour le comptable',
      'Fais le bilan du mois',
    ]) {
      expect(detectIntent(m)).toBe('cloture');
    }
  });

  it('ne capte pas les intentions voisines par erreur', () => {
    expect(detectIntent('Prépare une relance')).toBe('relance');
    expect(detectIntent('Encaisse la facture 2026-014')).toBe('encaisser');
    expect(detectIntent('Fais-moi un devis')).toBe('nouveau_devis');
    expect(detectIntent('Ouvre mes chantiers')).toBe('voir_chantiers');
    expect(detectIntent('Quel temps fait-il ?')).toBe('unknown');
  });
});

describe('detectIntent — diagnostic 2026 (C40 TODO ⑦)', () => {
  it('reconnaît la chip « Prêt pour 2026 ? » et les demandes de diagnostic', () => {
    for (const m of [
      'Prêt pour 2026 ?',
      'prête pour 2026',
      'On est prêts pour 2026 ?',
      'Fais mon diagnostic',
      'Lance le diagnostic de conformité',
      'Je suis en règle sur la conformité 2026 ?',
      'conformité facturation électronique, ça donne quoi ?',
    ]) {
      expect(detectIntent(m)).toBe('diagnostic');
    }
  });

  it('ne détourne pas les intentions existantes', () => {
    expect(detectIntent('Prépare le mois')).toBe('cloture');
    expect(detectIntent('Combien je peux me verser ?')).toBe('payout');
    expect(detectIntent('Un devis pour 2026')).toBe('nouveau_devis');
  });
});

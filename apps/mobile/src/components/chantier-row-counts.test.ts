import { describe, expect, it } from 'vitest';
import {
  chantierRowCountsAccessibilityLabel,
  visibleChantierRowCounts,
} from './chantier-row-counts.logic';

describe('chantier-row-counts.logic — compteurs de rangée (fiche client + /chantiers)', () => {
  it('ne montre rien quand les deux compteurs sont à 0', () => {
    const visible = visibleChantierRowCounts({ noteCount: 0, photoCount: 0 });
    expect(visible).toEqual({ noteCount: 0, photoCount: 0 });
    expect(chantierRowCountsAccessibilityLabel(visible, 'pote')).toBeNull();
  });

  it('singulier à 1, pluriel au-delà, pour chaque humeur', () => {
    expect(chantierRowCountsAccessibilityLabel({ noteCount: 1, photoCount: 0 }, 'pote')).toBe('1 note');
    expect(chantierRowCountsAccessibilityLabel({ noteCount: 3, photoCount: 0 }, 'pote')).toBe('3 notes');
    expect(chantierRowCountsAccessibilityLabel({ noteCount: 0, photoCount: 1 }, 'pote')).toBe('1 photo');
    expect(chantierRowCountsAccessibilityLabel({ noteCount: 0, photoCount: 5 }, 'pote')).toBe('5 photos');
    expect(chantierRowCountsAccessibilityLabel({ noteCount: 1, photoCount: 0 }, 'pro')).toBe('1 note');
    expect(chantierRowCountsAccessibilityLabel({ noteCount: 2, photoCount: 0 }, 'direct')).toBe('2 notes');
  });

  it('combine notes et photos dans un seul libellé accessible', () => {
    expect(chantierRowCountsAccessibilityLabel({ noteCount: 3, photoCount: 1 }, 'pote')).toBe('3 notes, 1 photo');
  });

  it('ne descend jamais sous 0 (défense contre un agrégat serveur incohérent)', () => {
    expect(visibleChantierRowCounts({ noteCount: -1, photoCount: -4 })).toEqual({
      noteCount: 0,
      photoCount: 0,
    });
  });
});

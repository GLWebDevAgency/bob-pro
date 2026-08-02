/**
 * Fil rouge « couleur de l'argent » — la dérivation standing → teinte est UNE (critère de
 * preuve Lot 4 : « Mutants sur la dérivation standing → teinte ») : la rangée du carnet,
 * le héros de la fiche et le liseré de la StickyActionBar floating consomment ces mutants.
 */
import { describe, expect, it } from 'vitest';
import type { CustomerStandingKind } from '@bob/core';
import { standingAccentColor, standingAccentRole } from './standing-accent.logic';

const PALETTE = {
  success: '#0E7C5A',
  warning: '#C77A12',
  danger: '#E5544B',
  neutral: '#8CA0B3',
} as const;

describe('standingAccentRole — le MÊME token du carnet au geste', () => {
  it('à jour → success (vert)', () => {
    expect(standingAccentRole('a_jour')).toBe('success');
  });

  it('en retard → danger (rouge)', () => {
    expect(standingAccentRole('en_retard')).toBe('danger');
  });

  it('en attente → warning (ambre)', () => {
    expect(standingAccentRole('en_attente')).toBe('warning');
  });

  it('devis → warning (réf C12 : le devis en attente est ambré, comme l’attente — JAMAIS success)', () => {
    expect(standingAccentRole('devis')).toBe('warning');
    expect(standingAccentRole('devis')).not.toBe('success');
  });

  it('nouveau → neutral (aucune couleur d’argent inventée pour un client sans historique)', () => {
    expect(standingAccentRole('nouveau')).toBe('neutral');
  });

  it('exhaustivité : les 5 standings du domaine ont chacun un rôle', () => {
    const kinds: readonly CustomerStandingKind[] = [
      'a_jour',
      'en_retard',
      'en_attente',
      'devis',
      'nouveau',
    ];
    const roles = kinds.map(standingAccentRole);
    expect(roles).toEqual(['success', 'danger', 'warning', 'warning', 'neutral']);
  });
});

describe('standingAccentColor — résolution sur la palette injectée', () => {
  it('résout chaque rôle sur SA couleur de palette (aucun hex dans le kit)', () => {
    expect(standingAccentColor('a_jour', PALETTE)).toBe(PALETTE.success);
    expect(standingAccentColor('en_retard', PALETTE)).toBe(PALETTE.danger);
    expect(standingAccentColor('en_attente', PALETTE)).toBe(PALETTE.warning);
    expect(standingAccentColor('devis', PALETTE)).toBe(PALETTE.warning);
    expect(standingAccentColor('nouveau', PALETTE)).toBe(PALETTE.neutral);
  });
});

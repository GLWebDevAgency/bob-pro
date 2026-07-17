import { describe, expect, it } from 'vitest';
import {
  DELETE_ICON_BUTTON_MIN_HIT_TARGET,
  DELETE_ICON_BUTTON_SIZE_DEFAULT,
  clampDeleteIconButtonSize,
  deleteIconButtonOpacity,
} from './delete-icon-button.logic';

describe('clampDeleteIconButtonSize', () => {
  it('défaut sans valeur', () => {
    expect(clampDeleteIconButtonSize()).toBe(DELETE_ICON_BUTTON_SIZE_DEFAULT);
  });

  it('conserve une taille déjà ≥ 44 (ex. 52, DocumentActions)', () => {
    expect(clampDeleteIconButtonSize(52)).toBe(52);
  });

  it('remonte au plancher 44 une taille demandée plus petite (ex. 40, carte brouillon devis)', () => {
    expect(clampDeleteIconButtonSize(40)).toBe(DELETE_ICON_BUTTON_MIN_HIT_TARGET);
  });

  it('ne descend jamais sous le plancher, même avec 0 ou une valeur négative', () => {
    expect(clampDeleteIconButtonSize(0)).toBe(DELETE_ICON_BUTTON_MIN_HIT_TARGET);
    expect(clampDeleteIconButtonSize(-10)).toBe(DELETE_ICON_BUTTON_MIN_HIT_TARGET);
  });
});

describe('deleteIconButtonOpacity', () => {
  it('opaque quand actif et pas désactivé', () => {
    expect(deleteIconButtonOpacity(false, false)).toBe(1);
  });
  it('atténué quand désactivé', () => {
    expect(deleteIconButtonOpacity(true, false)).toBe(0.5);
  });
  it('atténué quand en chargement', () => {
    expect(deleteIconButtonOpacity(false, true)).toBe(0.5);
  });
  it('atténué quand les deux', () => {
    expect(deleteIconButtonOpacity(true, true)).toBe(0.5);
  });
});

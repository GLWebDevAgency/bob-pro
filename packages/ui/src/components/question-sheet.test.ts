/**
 * Tests de la logique pure de sélection de la QuestionSheet — compat ascendante du
 * tap sec (choix unique historique) + nouveau mode opt-in de confirmation.
 */
import { describe, expect, it } from 'vitest';
import { questionConfirmVisible, toggleQuestionOption } from './question-sheet.logic';

const SINGLE = { multiSelect: false, confirmSingle: false } as const;
const SINGLE_CONFIRM = { multiSelect: false, confirmSingle: true } as const;
const MULTI = { multiSelect: true, confirmSingle: false } as const;

describe('toggleQuestionOption', () => {
  it('choix unique historique : le tap sélectionne ET valide immédiatement (compat ascendante)', () => {
    const result = toggleQuestionOption(new Set(), 'a', SINGLE);
    expect([...result.picked]).toEqual(['a']);
    expect(result.committed).toBe(true);
  });

  it('choix unique historique : un nouveau tap remplace la sélection', () => {
    const result = toggleQuestionOption(new Set(['a']), 'b', SINGLE);
    expect([...result.picked]).toEqual(['b']);
    expect(result.committed).toBe(true);
  });

  it('confirmation opt-in : le tap surligne sans JAMAIS valider', () => {
    const result = toggleQuestionOption(new Set(), 'a', SINGLE_CONFIRM);
    expect([...result.picked]).toEqual(['a']);
    expect(result.committed).toBe(false);
  });

  it('confirmation opt-in : re-taper l’option sélectionnée la conserve (radio, pas de désélection)', () => {
    const result = toggleQuestionOption(new Set(['a']), 'a', SINGLE_CONFIRM);
    expect([...result.picked]).toEqual(['a']);
    expect(result.committed).toBe(false);
  });

  it('confirmation opt-in : un autre tap remplace la sélection sans valider', () => {
    const result = toggleQuestionOption(new Set(['a']), 'b', SINGLE_CONFIRM);
    expect([...result.picked]).toEqual(['b']);
    expect(result.committed).toBe(false);
  });

  it('choix multiple : le tap coche puis décoche, sans valider', () => {
    const added = toggleQuestionOption(new Set(['a']), 'b', MULTI);
    expect([...added.picked].sort()).toEqual(['a', 'b']);
    expect(added.committed).toBe(false);

    const removed = toggleQuestionOption(added.picked, 'a', MULTI);
    expect([...removed.picked]).toEqual(['b']);
    expect(removed.committed).toBe(false);
  });
});

describe('questionConfirmVisible', () => {
  it('bouton Confirmer : multi et choix unique confirmé seulement', () => {
    expect(questionConfirmVisible(SINGLE)).toBe(false);
    expect(questionConfirmVisible(SINGLE_CONFIRM)).toBe(true);
    expect(questionConfirmVisible(MULTI)).toBe(true);
  });
});

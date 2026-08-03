import { describe, expect, it } from 'vitest';
import { planAssistantLiveTurnImport } from './assistant-live-transcript';

const turn = (id: string, role: 'user' | 'bob', text: string) => Object.freeze({ id, role, text });

describe('Assistant — import monotone du dialogue Live', () => {
  it('n importe chaque tour qu une fois et conserve l ordre', () => {
    const conversation = [
      turn('1:1', 'user', 'Crée un client'),
      turn('1:2', 'bob', 'Quel est son nom ?'),
      turn('1:3', 'user', 'Camping Les Pins'),
    ];
    expect(planAssistantLiveTurnImport({
      conversation,
      importedIds: new Set(['1:1']),
    })).toEqual({
      consumedIds: ['1:2', '1:3'],
      visibleTurns: conversation.slice(1),
    });
  });

  it('acquitte sans dupliquer le dernier texte Bob rendu par une carte structurée', () => {
    const conversation = [
      turn('2:1', 'bob', 'Je prépare la proposition.'),
      turn('2:2', 'user', 'Oui'),
      turn('2:3', 'bob', 'Je prépare la proposition.'),
    ];
    expect(planAssistantLiveTurnImport({
      conversation,
      importedIds: new Set(),
      structuredBobText: 'Je prépare la proposition.',
    })).toEqual({
      consumedIds: ['2:1', '2:2', '2:3'],
      visibleTurns: conversation.slice(0, 2),
    });
  });
});

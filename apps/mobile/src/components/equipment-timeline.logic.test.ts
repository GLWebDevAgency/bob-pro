/**
 * Timeline d'équipement (Lot 4) — la couleur du point code le TYPE d'entrée, et le statut
 * d'intervention parle i18n (plus jamais le statut serveur brut à l'écran ni à l'oreille).
 */
import { describe, expect, it } from 'vitest';
import { interventionStatusKey, timelineDotVariant } from './equipment-timeline.logic';

describe('timelineDotVariant — scannable par couleur, sans l’indigo de Bob', () => {
  it('intervention → success (le geste pro accompli)', () => {
    expect(timelineDotVariant('intervention')).toBe('success');
  });

  it('document → neutral (doctrine Lot 0 : la matière document est neutre)', () => {
    expect(timelineDotVariant('document')).toBe('neutral');
  });

  it('note et photo → b2b (le journal, information bleue)', () => {
    expect(timelineDotVariant('note')).toBe('b2b');
    expect(timelineDotVariant('photo')).toBe('b2b');
  });

  it("aucun type ne rend 'ai' — l'indigo reste le canal exclusif de Bob", () => {
    for (const type of ['note', 'photo', 'intervention', 'document'] as const) {
      expect(timelineDotVariant(type)).not.toBe('ai');
    }
  });
});

describe('interventionStatusKey — les 5 statuts du domaine, l’inconnu reste brut', () => {
  it('couvre exactement InterventionStatus (scheduled/in_progress/completed/signed/cancelled)', () => {
    expect(interventionStatusKey('scheduled')).toBe('equipements.interventionScheduled');
    expect(interventionStatusKey('in_progress')).toBe('equipements.interventionInProgress');
    expect(interventionStatusKey('completed')).toBe('equipements.interventionCompleted');
    expect(interventionStatusKey('signed')).toBe('equipements.interventionSigned');
    expect(interventionStatusKey('cancelled')).toBe('equipements.interventionCancelled');
  });

  it('statut inconnu du domaine → null (l’écran affiche le fait serveur brut, jamais une invention)', () => {
    expect(interventionStatusKey('archived')).toBeNull();
    expect(interventionStatusKey('')).toBeNull();
  });
});

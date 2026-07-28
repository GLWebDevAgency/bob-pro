import { describe, expect, it } from 'vitest';
import { deriveEquipmentHistory } from './derive-equipment-history';

describe('deriveEquipmentHistory — fusion PURE, triée, fail-closed (Bloc A §1.5)', () => {
  it('fusionne notes + photos + interventions + documents du SEUL équipement, du plus récent au plus ancien', () => {
    const history = deriveEquipmentHistory({
      equipmentId: 'equip-1',
      notes: [
        { id: 'n1', text: 'Détartrage complet', authorLabel: 'Papa', createdAt: '2026-05-12T10:00:00.000Z', equipmentId: 'equip-1' },
        { id: 'n2', text: 'Note du site (non taguée)', authorLabel: 'Papa', createdAt: '2026-06-01T10:00:00.000Z' },
        { id: 'n3', text: 'Autre équipement', authorLabel: 'Papa', createdAt: '2026-06-02T10:00:00.000Z', equipmentId: 'equip-2' },
      ],
      photos: [
        { id: 'p1', filename: 'avant.jpg', createdAt: '2026-07-26T09:00:00.000Z', equipmentId: 'equip-1' },
        { id: 'p2', filename: 'site.jpg', createdAt: '2026-07-27T09:00:00.000Z', equipmentId: null },
      ],
      interventions: [
        { id: 'i1', label: 'Passage signé', status: 'signed', at: '2026-07-26T11:00:00.000Z', equipmentId: 'equip-1' },
      ],
      documents: [
        { id: 'd1', filename: 'certificat.pdf', kind: 'other', createdAt: '2026-04-01T08:00:00.000Z', linkedEntityType: 'equipment', linkedEntityId: 'equip-1' },
        { id: 'd2', filename: 'facture.pdf', kind: 'invoice_pdf', createdAt: '2026-04-02T08:00:00.000Z', linkedEntityType: 'chantier', linkedEntityId: 'equip-1' },
      ],
    });
    expect(history.map((entry) => entry.id)).toEqual(['i1', 'p1', 'n1', 'd1']);
    expect(history[0]).toMatchObject({ type: 'intervention', label: 'Passage signé', status: 'signed' });
  });

  it('fail-closed : horodatage illisible = trace exclue, jamais une date inventée', () => {
    const history = deriveEquipmentHistory({
      equipmentId: 'equip-1',
      notes: [
        { id: 'n1', text: 'ok', authorLabel: 'Papa', createdAt: '2026-05-12T10:00:00.000Z', equipmentId: 'equip-1' },
        { id: 'n2', text: 'sans date', authorLabel: 'Papa', createdAt: '' as never, equipmentId: 'equip-1' },
      ],
      photos: [],
    });
    expect(history.map((entry) => entry.id)).toEqual(['n1']);
  });

  it('départage stable à horodatage égal (type puis id) — rendu déterministe', () => {
    const at = '2026-07-26T09:00:00.000Z';
    const history = deriveEquipmentHistory({
      equipmentId: 'equip-1',
      notes: [{ id: 'b', text: 'note', authorLabel: 'Papa', createdAt: at, equipmentId: 'equip-1' }],
      photos: [
        { id: 'a', filename: 'z.jpg', createdAt: at, equipmentId: 'equip-1' },
        { id: 'c', filename: 'a.jpg', createdAt: at, equipmentId: 'equip-1' },
      ],
    });
    expect(history.map((entry) => `${entry.type}:${entry.id}`)).toEqual(['note:b', 'photo:a', 'photo:c']);
  });

  it('vide honnête : aucune trace taguée = historique vide (jamais l’historique du site)', () => {
    expect(
      deriveEquipmentHistory({
        equipmentId: 'equip-1',
        notes: [{ id: 'n1', text: 'note site', authorLabel: 'Papa', createdAt: '2026-05-12T10:00:00.000Z' }],
        photos: [{ id: 'p1', filename: 'site.jpg', createdAt: '2026-05-12T10:00:00.000Z' }],
      }),
    ).toEqual([]);
  });
});

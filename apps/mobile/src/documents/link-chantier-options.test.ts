import { describe, expect, it } from 'vitest';
import {
  linkChantierOptions,
  linkedChantierName,
  type LinkChantierCandidate,
} from './link-chantier-options';

const chantiers: readonly LinkChantierCandidate[] = [
  { id: 'ch-durand', name: 'Rénovation Durand', status: 'open' },
  { id: 'ch-martin', name: 'Extension Martin', status: 'open' },
  { id: 'ch-clos', name: 'Salle de bain Perez', status: 'closed' },
];

describe('linkChantierOptions', () => {
  it('ne propose que les chantiers OUVERTS (jamais un chantier clos)', () => {
    const options = linkChantierOptions(chantiers, null);
    expect(options.map((option) => option.chantierId)).toEqual(['ch-durand', 'ch-martin']);
    expect(options.every((option) => !option.suggested)).toBe(true);
  });

  it('place la suggestion d’analyse EN TÊTE sans la dupliquer dans la liste', () => {
    const options = linkChantierOptions(chantiers, 'ch-martin');
    expect(options.map((option) => option.chantierId)).toEqual(['ch-martin', 'ch-durand']);
    expect(options[0]).toEqual({ chantierId: 'ch-martin', name: 'Extension Martin', suggested: true });
    expect(options[1]?.suggested).toBe(false);
  });

  it('ignore une suggestion qui désigne un chantier CLOS (anti-hallucination)', () => {
    const options = linkChantierOptions(chantiers, 'ch-clos');
    expect(options.map((option) => option.chantierId)).toEqual(['ch-durand', 'ch-martin']);
    expect(options.every((option) => !option.suggested)).toBe(true);
  });

  it('ignore une suggestion inconnue de la liste réelle', () => {
    const options = linkChantierOptions(chantiers, 'ch-fantome');
    expect(options.map((option) => option.chantierId)).toEqual(['ch-durand', 'ch-martin']);
  });

  it('liste vide → aucune option (la ligne d’action reste masquée côté écran)', () => {
    expect(linkChantierOptions([], 'ch-durand')).toEqual([]);
  });
});

describe('linkedChantierName', () => {
  it('retrouve le nom du chantier lié, y compris un chantier CLOS (lien historique)', () => {
    expect(linkedChantierName(chantiers, 'ch-durand')).toBe('Rénovation Durand');
    expect(linkedChantierName(chantiers, 'ch-clos')).toBe('Salle de bain Perez');
  });

  it('null si aucun lien ou si l’id ne correspond à aucun chantier connu (jamais inventé)', () => {
    expect(linkedChantierName(chantiers, null)).toBeNull();
    expect(linkedChantierName(chantiers, 'ch-fantome')).toBeNull();
    expect(linkedChantierName([], 'ch-durand')).toBeNull();
  });
});

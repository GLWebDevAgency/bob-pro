import { describe, expect, it } from 'vitest';
import { DOCUMENT_FOLDER_SYSTEM_KEYS } from './document-folder';
import {
  DOCUMENT_DESTINATION_MOTIF_MAX_LENGTH,
  documentSystemFolderLabel,
  makeDocumentDestinationSuggestion,
  type DocumentDestinationContext,
} from './document-destination';

const contexte: DocumentDestinationContext = {
  chantiers: [
    { id: 'ch-durand', nom: 'Rénovation Durand' },
    { id: 'ch-martin', nom: '  Salle de bain   Martin ' },
  ],
};

describe('makeDocumentDestinationSuggestion — chantier (anti-hallucination)', () => {
  it('accepte un chantier du contexte : label = nom réel du chantier, motif assaini', () => {
    const suggestion = makeDocumentDestinationSuggestion(
      { kind: 'chantier', chantierId: 'ch-durand', motif: '  matériel pour le\nchantier Durand ' },
      contexte,
    );
    expect(suggestion).toEqual({
      kind: 'chantier',
      chantierId: 'ch-durand',
      label: 'Rénovation Durand',
      motif: 'matériel pour le chantier Durand',
    });
  });

  it('rejette un chantierId absent du contexte — un id inventé ne passe jamais', () => {
    expect(
      makeDocumentDestinationSuggestion({ kind: 'chantier', chantierId: 'ch-hallucine' }, contexte),
    ).toBeNull();
    expect(
      makeDocumentDestinationSuggestion({ kind: 'chantier', chantierId: 'ch-durand' }, { chantiers: [] }),
    ).toBeNull();
  });

  it('ignore le label proposé par le modèle : le libellé vient toujours du contexte', () => {
    const suggestion = makeDocumentDestinationSuggestion(
      { kind: 'chantier', chantierId: 'ch-martin', label: 'Chantier Piscine (inventé)' },
      contexte,
    );
    expect(suggestion?.label).toBe('Salle de bain Martin');
  });

  it('rejette un chantierId vide ou un chantier au nom vide', () => {
    expect(makeDocumentDestinationSuggestion({ kind: 'chantier', chantierId: '  ' }, contexte)).toBeNull();
    expect(
      makeDocumentDestinationSuggestion(
        { kind: 'chantier', chantierId: 'ch-anonyme' },
        { chantiers: [{ id: 'ch-anonyme', nom: '   ' }] },
      ),
    ).toBeNull();
  });

  it('fournit un motif déterministe quand le modèle n’en propose pas', () => {
    const suggestion = makeDocumentDestinationSuggestion({ kind: 'chantier', chantierId: 'ch-durand' }, contexte);
    expect(suggestion?.motif).toBe('Chantier reconnu dans le document.');
  });
});

describe('makeDocumentDestinationSuggestion — dossier système (première classe, jamais un échec)', () => {
  it('accepte une clé système autorisée avec le libellé produit', () => {
    const suggestion = makeDocumentDestinationSuggestion(
      { kind: 'system_folder', systemKey: 'purchases', motif: 'abonnement téléphone — frais généraux' },
      contexte,
    );
    expect(suggestion).toEqual({
      kind: 'system_folder',
      systemKey: 'purchases',
      label: 'Achats',
      motif: 'abonnement téléphone — frais généraux',
    });
  });

  it('rejette une clé système inconnue ou hors de la liste autorisée', () => {
    expect(makeDocumentDestinationSuggestion({ kind: 'system_folder', systemKey: 'inventee' }, contexte)).toBeNull();
    expect(
      makeDocumentDestinationSuggestion(
        { kind: 'system_folder', systemKey: 'bank' },
        { chantiers: [], systemKeys: ['purchases', 'insurance'] },
      ),
    ).toBeNull();
  });

  it('borne le motif et neutralise les caractères de contrôle', () => {
    const suggestion = makeDocumentDestinationSuggestion(
      { kind: 'system_folder', systemKey: 'insurance', motif: `a\u0000b${'x'.repeat(400)}` },
      contexte,
    );
    expect(suggestion?.motif.length).toBeLessThanOrEqual(DOCUMENT_DESTINATION_MOTIF_MAX_LENGTH);
    expect(suggestion?.motif.startsWith('a b')).toBe(true);
  });
});

describe('makeDocumentDestinationSuggestion — brouillons irrécupérables', () => {
  it('rend null pour un brouillon absent, un kind inconnu ou vide', () => {
    expect(makeDocumentDestinationSuggestion(null, contexte)).toBeNull();
    expect(makeDocumentDestinationSuggestion(undefined, contexte)).toBeNull();
    expect(makeDocumentDestinationSuggestion({}, contexte)).toBeNull();
    expect(makeDocumentDestinationSuggestion({ kind: 'expense', chantierId: 'ch-durand' }, contexte)).toBeNull();
  });
});

describe('documentSystemFolderLabel', () => {
  it('couvre toutes les clés produit avec les libellés des dossiers par défaut', () => {
    const expected = {
      projects: 'Chantiers',
      purchases: 'Achats',
      insurance: 'Assurances',
      tax_social: 'Fiscal & social',
      bank: 'Banque',
      accounting: 'Comptable',
    } as const;
    for (const key of DOCUMENT_FOLDER_SYSTEM_KEYS) expect(documentSystemFolderLabel(key)).toBe(expected[key]);
  });
});

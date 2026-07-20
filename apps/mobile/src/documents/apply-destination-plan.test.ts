import { describe, expect, it } from 'vitest';
import type { DocumentDestinationSuggestion } from '@bob/core';
import { planDestinationApplication, type ApplyDestinationFolder } from './apply-destination-plan';

const folders: readonly ApplyDestinationFolder[] = [
  { id: 'folder-projects', systemKey: 'projects' },
  { id: 'folder-purchases', systemKey: 'purchases' },
  { id: 'folder-custom', systemKey: null },
];

const purchases: DocumentDestinationSuggestion = {
  kind: 'system_folder',
  systemKey: 'purchases',
  label: 'Achats',
  motif: 'fournitures',
};

const chantier: DocumentDestinationSuggestion = {
  kind: 'chantier',
  chantierId: 'chantier-1',
  label: 'Chantier · Durand',
  motif: 'matériel pour le chantier Durand',
};

describe('planDestinationApplication', () => {
  it('dossier système absent du coffre → ask_human (aucun rangement deviné)', () => {
    const insurance: DocumentDestinationSuggestion = {
      kind: 'system_folder',
      systemKey: 'insurance',
      label: 'Assurances',
      motif: '',
    };
    expect(planDestinationApplication(insurance, { folderId: null }, folders)).toEqual({ kind: 'ask_human' });
  });

  it('dossier système présent → déplacement vers ce dossier depuis « À classer »', () => {
    expect(planDestinationApplication(purchases, { folderId: null }, folders)).toEqual({
      kind: 'apply',
      moveToFolderId: 'folder-purchases',
      classifyChantierId: null,
    });
  });

  it('document déjà dans le dossier cible → aucun déplacement rejoué', () => {
    expect(planDestinationApplication(purchases, { folderId: 'folder-purchases' }, folders)).toEqual({
      kind: 'apply',
      moveToFolderId: null,
      classifyChantierId: null,
    });
  });

  it('document rangé ailleurs + destination dossier système → déplacement (action explicite)', () => {
    expect(planDestinationApplication(purchases, { folderId: 'folder-custom' }, folders)).toEqual({
      kind: 'apply',
      moveToFolderId: 'folder-purchases',
      classifyChantierId: null,
    });
  });

  it('chantier + document non rangé → rangement dans Chantiers PUIS lien métier', () => {
    expect(planDestinationApplication(chantier, { folderId: null }, folders)).toEqual({
      kind: 'apply',
      moveToFolderId: 'folder-projects',
      classifyChantierId: 'chantier-1',
    });
  });

  it('chantier + document déjà rangé → lien métier SEUL (jamais écraser un rangement humain)', () => {
    expect(planDestinationApplication(chantier, { folderId: 'folder-custom' }, folders)).toEqual({
      kind: 'apply',
      moveToFolderId: null,
      classifyChantierId: 'chantier-1',
    });
  });

  it('chantier sans dossier « Chantiers » au coffre → lien métier seul, pas d’ask_human', () => {
    expect(planDestinationApplication(chantier, { folderId: null }, [{ id: 'x', systemKey: 'purchases' }])).toEqual({
      kind: 'apply',
      moveToFolderId: null,
      classifyChantierId: 'chantier-1',
    });
  });
});

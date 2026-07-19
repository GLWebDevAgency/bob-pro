import { describe, expect, it } from 'vitest';
import { planScanChantierChoice } from './scan-chantier-destination';

describe('planScanChantierChoice', () => {
  it('document SANS extraction → lien métier document↔chantier (comportement historique)', () => {
    expect(
      planScanChantierChoice({ hasExtraction: false, documentFolderId: null, projectsFolderId: 'f-projects' }),
    ).toEqual({ kind: 'link_document' });
  });

  it('document de dépense non rangé → imputation par la dépense + rangement dans « Chantiers »', () => {
    expect(
      planScanChantierChoice({ hasExtraction: true, documentFolderId: null, projectsFolderId: 'f-projects' }),
    ).toEqual({ kind: 'impute_expense', moveToFolderId: 'f-projects' });
  });

  it('document de dépense DÉJÀ rangé → imputation seule, on n’écrase jamais un rangement humain', () => {
    expect(
      planScanChantierChoice({ hasExtraction: true, documentFolderId: 'f-achats', projectsFolderId: 'f-projects' }),
    ).toEqual({ kind: 'impute_expense', moveToFolderId: null });
  });

  it('dossier « Chantiers » absent du coffre → imputation sans déplacement (original dans À classer)', () => {
    expect(
      planScanChantierChoice({ hasExtraction: true, documentFolderId: null, projectsFolderId: null }),
    ).toEqual({ kind: 'impute_expense', moveToFolderId: null });
  });
});

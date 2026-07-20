import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import { ChantiersController } from './api.controllers';

function controller(overrides: Partial<BackendService> = {}) {
  return new ChantiersController(overrides as BackendService);
}

describe('ChantiersController — journal (notes) et photos (fiche chantier, extension V1)', () => {
  it('POST :id/notes délègue à addChantierNote avec le texte validé', async () => {
    const addChantierNote = vi.fn(async () => ({ ok: true as const, value: { id: 'note-1' } }));
    const value = controller({ addChantierNote } as never);
    await expect(value.addNote('chantier-1', { text: 'Fuite réparée.' })).resolves.toEqual({ id: 'note-1' });
    expect(addChantierNote).toHaveBeenCalledWith('chantier-1', { text: 'Fuite réparée.' });
  });

  it('refuse une note vide avant le domaine', async () => {
    const addChantierNote = vi.fn();
    const value = controller({ addChantierNote } as never);
    await expect(value.addNote('chantier-1', { text: '   ' })).rejects.toMatchObject({ status: 422 });
    expect(addChantierNote).not.toHaveBeenCalled();
  });

  it('refuse un champ inconnu sur le corps de note', async () => {
    const addChantierNote = vi.fn();
    const value = controller({ addChantierNote } as never);
    await expect(value.addNote('chantier-1', { text: 'x', extra: 1 })).rejects.toMatchObject({ status: 422 });
    expect(addChantierNote).not.toHaveBeenCalled();
  });

  it('GET :id/notes délègue à listChantierNotes', async () => {
    const listChantierNotes = vi.fn(async () => ({ ok: true as const, value: [] }));
    const value = controller({ listChantierNotes } as never);
    await value.listNotes('chantier-1');
    expect(listChantierNotes).toHaveBeenCalledWith('chantier-1');
  });

  it('POST :id/photos délègue à uploadWorksitePhoto avec le corps validé', async () => {
    const uploadWorksitePhoto = vi.fn(async () => ({
      ok: true as const,
      value: { id: 'photo-1', companyId: 'co', chantierId: 'chantier-1', filename: 'x.jpg', mimeType: 'image/jpeg', byteSize: 3, storageKey: 'k', createdAt: '2026-07-17T10:00:00.000Z' },
    }));
    const value = controller({ uploadWorksitePhoto } as never);
    const body = { contentBase64: 'aGVsbG8=', mimeType: 'image/jpeg', filename: 'chantier.jpg' };
    await value.uploadPhoto('chantier-1', body);
    expect(uploadWorksitePhoto).toHaveBeenCalledWith('chantier-1', body);
  });

  it('refuse un mimeType non-image sur le corps de photo', async () => {
    const uploadWorksitePhoto = vi.fn();
    const value = controller({ uploadWorksitePhoto } as never);
    await expect(
      value.uploadPhoto('chantier-1', { contentBase64: 'aGVsbG8=', mimeType: 'application/pdf', filename: 'x.pdf' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(uploadWorksitePhoto).not.toHaveBeenCalled();
  });

  it('refuse un corps de photo incomplet', async () => {
    const uploadWorksitePhoto = vi.fn();
    const value = controller({ uploadWorksitePhoto } as never);
    await expect(value.uploadPhoto('chantier-1', { mimeType: 'image/jpeg', filename: 'x.jpg' })).rejects.toMatchObject({
      status: 422,
    });
    expect(uploadWorksitePhoto).not.toHaveBeenCalled();
  });

  it('GET photos/:photoId/view-url délègue à worksitePhotoViewUrl', async () => {
    const worksitePhotoViewUrl = vi.fn(async () => ({ ok: true as const, value: { url: 'https://x', expiresInSeconds: 300 } }));
    const value = controller({ worksitePhotoViewUrl } as never);
    await value.photoViewUrl('photo-1');
    expect(worksitePhotoViewUrl).toHaveBeenCalledWith('photo-1');
  });

  it('DELETE photos/:photoId délègue à deleteWorksitePhoto', async () => {
    const deleteWorksitePhoto = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const value = controller({ deleteWorksitePhoto } as never);
    await value.deletePhoto('photo-1');
    expect(deleteWorksitePhoto).toHaveBeenCalledWith('photo-1');
  });
});

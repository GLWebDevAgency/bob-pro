import { describe, it, expect } from 'vitest';
import { ChantierNote } from './chantier-note';

const base = {
  id: 'n1',
  companyId: 'co',
  chantierId: 'c1',
  text: '  Fuite réparée, reste le joint du ballon  ',
  authorLabel: 'Mercier Plomberie',
  createdAt: '2026-07-17T10:00:00.000Z',
};

describe('ChantierNote', () => {
  it('crée et normalise une note (trim)', () => {
    const r = ChantierNote.record(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe('Fuite réparée, reste le joint du ballon');
      expect(r.value.authorLabel).toBe('Mercier Plomberie');
    }
  });

  it('rejette un texte vide', () => {
    expect(ChantierNote.record({ ...base, text: '   ' }).ok).toBe(false);
  });

  it('rejette un texte trop long (> 2000 caractères)', () => {
    expect(ChantierNote.record({ ...base, text: 'a'.repeat(2001) }).ok).toBe(false);
  });

  it('rejette un auteur vide', () => {
    expect(ChantierNote.record({ ...base, authorLabel: '  ' }).ok).toBe(false);
  });
});

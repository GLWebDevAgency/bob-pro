import { describe, expect, it } from 'vitest';
import { Chantier } from '../../domain/chantier/chantier';
import { ChantierNote } from '../../domain/chantier/chantier-note';
import { type ChantierRepository, type ChantierNoteRepository } from '../ports/repositories';
import { AddChantierNote } from './add-chantier-note';

class MemoryChantiers implements ChantierRepository {
  private readonly map = new Map<string, Chantier>();
  constructor(seed: Chantier[]) {
    for (const c of seed) this.map.set(c.id, c);
  }
  async save(c: Chantier): Promise<void> {
    this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Chantier | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Chantier[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }
}

class MemoryNotes implements ChantierNoteRepository {
  private readonly rows: ChantierNote[] = [];
  async save(n: ChantierNote): Promise<void> {
    this.rows.push(n);
  }
  async listByChantier(companyId: string, chantierId: string): Promise<ChantierNote[]> {
    return this.rows.filter((n) => n.companyId === companyId && n.chantierId === chantierId);
  }
  all(): ChantierNote[] {
    return this.rows;
  }
}

function chantier(): Chantier {
  const r = Chantier.record({
    id: 'c1',
    companyId: 'co-1',
    name: 'Villa Durand',
    customerId: null,
    address: null,
    notes: null,
    status: 'open',
    openedAt: '2026-07-17',
  });
  if (!r.ok) throw new Error('chantier de test invalide');
  return r.value;
}

const ids = { newId: () => 'note-1' };
const clock = { now: () => '2026-07-17T10:00:00.000Z', today: () => '2026-07-17' };

describe('AddChantierNote', () => {
  it('ajoute une note horodatée et attribuée', async () => {
    const chantiers = new MemoryChantiers([chantier()]);
    const notes = new MemoryNotes();
    const useCase = new AddChantierNote({ chantiers, notes, ids, clock });

    const r = await useCase.execute({
      companyId: 'co-1',
      chantierId: 'c1',
      text: 'Fuite réparée, reste le joint du ballon.',
      authorLabel: 'Mercier Plomberie',
    });

    expect(r.ok).toBe(true);
    const saved = notes.all();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('Fuite réparée, reste le joint du ballon.');
    expect(saved[0]?.createdAt).toBe('2026-07-17T10:00:00.000Z');
  });

  it('refuse une note sur un chantier introuvable ou d’un autre tenant', async () => {
    const chantiers = new MemoryChantiers([chantier()]);
    const notes = new MemoryNotes();
    const useCase = new AddChantierNote({ chantiers, notes, ids, clock });

    const r = await useCase.execute({
      companyId: 'autre-tenant',
      chantierId: 'c1',
      text: 'x',
      authorLabel: 'x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
    expect(notes.all()).toHaveLength(0);
  });

  it('propage une erreur domaine (texte vide) sans écrire', async () => {
    const chantiers = new MemoryChantiers([chantier()]);
    const notes = new MemoryNotes();
    const useCase = new AddChantierNote({ chantiers, notes, ids, clock });

    const r = await useCase.execute({ companyId: 'co-1', chantierId: 'c1', text: '   ', authorLabel: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
  });
});

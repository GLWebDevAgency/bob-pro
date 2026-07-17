import { describe, expect, it } from 'vitest';
import { Chantier } from '../../domain/chantier/chantier';
import { type ChantierRepository } from '../ports/repositories';
import { type WorksiteMediaStorage, type WorksiteMediaItem } from '../ports/worksite-media';
import { type DocumentStoragePort, type StoredObject } from '../ports/document-storage';
import { UploadWorksitePhoto } from './upload-worksite-photo';
import { DeleteWorksitePhoto } from './delete-worksite-photo';

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

class MemoryMedia implements WorksiteMediaStorage {
  private readonly map = new Map<string, WorksiteMediaItem>();
  async save(item: WorksiteMediaItem): Promise<void> {
    this.map.set(item.id, item);
  }
  async listByChantier(companyId: string, chantierId: string): Promise<WorksiteMediaItem[]> {
    return [...this.map.values()].filter((i) => i.companyId === companyId && i.chantierId === chantierId);
  }
  async findById(companyId: string, id: string): Promise<WorksiteMediaItem | null> {
    const item = this.map.get(id);
    return item && item.companyId === companyId ? item : null;
  }
  async remove(companyId: string, id: string): Promise<void> {
    const item = this.map.get(id);
    if (item && item.companyId === companyId) this.map.delete(id);
  }
}

class MemoryStorage implements DocumentStoragePort {
  readonly removed: string[] = [];
  async put(input: { companyId: string; key: string; bytes: Uint8Array; contentType: string }): Promise<StoredObject> {
    return { key: input.key, sizeBytes: input.bytes.byteLength, sha256: 'fake' };
  }
  async get(): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return null;
  }
  async getSignedUrl(): Promise<string> {
    return 'signed://fake';
  }
  async stat(): Promise<{ sizeBytes: number; contentType: string } | null> {
    return null;
  }
  async remove(_companyId: string, key: string): Promise<void> {
    this.removed.push(key);
  }
}

function chantier(companyId = 'co-1'): Chantier {
  const r = Chantier.record({
    id: 'c1',
    companyId,
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

const ids = { newId: () => 'photo-1' };
const clock = { now: () => '2026-07-17T10:00:00.000Z', today: () => '2026-07-17' };

describe('UploadWorksitePhoto', () => {
  it('stocke les octets et la métadonnée, clé bornée au tenant/chantier', async () => {
    const chantiers = new MemoryChantiers([chantier()]);
    const media = new MemoryMedia();
    const storage = new MemoryStorage();
    const useCase = new UploadWorksitePhoto({ chantiers, media, storage, ids, clock });

    const r = await useCase.execute({
      companyId: 'co-1',
      chantierId: 'c1',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
      filename: 'chantier.jpg',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.storageKey).toBe('companies/co-1/chantiers/c1/photos/photo-1.jpeg');
      expect(r.value.byteSize).toBe(3);
    }
    expect((await media.listByChantier('co-1', 'c1'))).toHaveLength(1);
  });

  it('refuse un type non-image', async () => {
    const chantiers = new MemoryChantiers([chantier()]);
    const useCase = new UploadWorksitePhoto({ chantiers, media: new MemoryMedia(), storage: new MemoryStorage(), ids, clock });
    const r = await useCase.execute({
      companyId: 'co-1',
      chantierId: 'c1',
      bytes: new Uint8Array([1]),
      contentType: 'application/pdf',
      filename: 'x.pdf',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('domain');
  });

  it('refuse un chantier d’un autre tenant', async () => {
    const chantiers = new MemoryChantiers([chantier('autre-tenant')]);
    const useCase = new UploadWorksitePhoto({ chantiers, media: new MemoryMedia(), storage: new MemoryStorage(), ids, clock });
    const r = await useCase.execute({
      companyId: 'co-1',
      chantierId: 'c1',
      bytes: new Uint8Array([1]),
      contentType: 'image/jpeg',
      filename: 'x.jpg',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });
});

describe('DeleteWorksitePhoto', () => {
  it('supprime les octets ET la métadonnée', async () => {
    const media = new MemoryMedia();
    const storage = new MemoryStorage();
    await media.save({
      id: 'photo-1',
      companyId: 'co-1',
      chantierId: 'c1',
      filename: 'x.jpg',
      mimeType: 'image/jpeg',
      byteSize: 3,
      storageKey: 'companies/co-1/chantiers/c1/photos/photo-1.jpeg',
      createdAt: '2026-07-17T10:00:00.000Z',
    });
    const useCase = new DeleteWorksitePhoto({ media, storage });

    const r = await useCase.execute({ companyId: 'co-1', id: 'photo-1' });
    expect(r.ok).toBe(true);
    expect(storage.removed).toEqual(['companies/co-1/chantiers/c1/photos/photo-1.jpeg']);
    expect(await media.findById('co-1', 'photo-1')).toBeNull();
  });

  it('refuse une photo introuvable', async () => {
    const useCase = new DeleteWorksitePhoto({ media: new MemoryMedia(), storage: new MemoryStorage() });
    const r = await useCase.execute({ companyId: 'co-1', id: 'ghost' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });
});

import { describe, expect, it } from 'vitest';
import { DocumentFolder, Equipment } from '@bob/core';
import { InMemoryPersistence } from './persistence.testing';

function folder(id: string, name: string) {
  const result = DocumentFolder.create({
    id,
    companyId: 'company-transaction-test',
    name,
    now: '2026-07-13T12:00:00.000Z',
  });
  if (!result.ok) throw new Error(`fixture dossier invalide : ${result.error.code}`);
  return result.value;
}

function equipment(id: string, label: string) {
  const result = Equipment.record({
    id,
    companyId: 'company-transaction-test',
    chantierId: 'chantier-transaction-test',
    label,
    kind: null,
    brand: null,
    serialNumber: null,
    location: null,
    installedAt: null,
    warrantyUntil: null,
    status: 'active',
    retiredAt: null,
    notes: null,
    revision: 0,
  });
  if (!result.ok) throw new Error(`fixture équipement invalide : ${result.error.code}`);
  return result.value;
}

describe('InMemoryPersistence.runInTransaction', () => {
  it('sérialise les transactions racines pour qu’un rollback ne puisse pas effacer un commit concurrent', async () => {
    const persistence = new InMemoryPersistence();
    let markFirstEntered: () => void = () => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = persistence.runInTransaction(async () => {
      markFirstEntered();
      await firstGate;
      const saved = await persistence.documentFolders.save(folder('folder-rolled-back', 'À annuler'), null);
      expect(saved.status).toBe('saved');
      throw new Error('rollback attendu');
    });
    await firstEntered;

    let secondStarted = false;
    const second = persistence.runInTransaction(async () => {
      secondStarted = true;
      const saved = await persistence.documentFolders.save(folder('folder-committed', 'Conservé'), null);
      expect(saved.status).toBe('saved');
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    const firstRejected = expect(first).rejects.toThrow('rollback attendu');
    releaseFirst();
    await firstRejected;
    await second;

    expect(await persistence.documentFolders.findById('company-transaction-test', 'folder-rolled-back')).toBeNull();
    expect(await persistence.documentFolders.findById('company-transaction-test', 'folder-committed')).not.toBeNull();
  });

  it('[re-revue] un rollback restaure AUSSI le parc d’équipements — jamais d’état fantôme', async () => {
    const persistence = new InMemoryPersistence();
    await persistence.equipments.save(equipment('equipment-committed', 'Fontaine accueil'));

    await expect(
      persistence.runInTransaction(async () => {
        await persistence.equipments.save(equipment('equipment-rolled-back', 'Clim fantôme'));
        expect(
          await persistence.equipments.findById('company-transaction-test', 'equipment-rolled-back'),
        ).not.toBeNull();
        throw new Error('rollback attendu');
      }),
    ).rejects.toThrow('rollback attendu');

    expect(
      await persistence.equipments.findById('company-transaction-test', 'equipment-rolled-back'),
    ).toBeNull();
    expect(
      await persistence.equipments.findById('company-transaction-test', 'equipment-committed'),
    ).not.toBeNull();
  });

  it('reste réentrante lorsqu’un use case ouvre une transaction dans une transaction orchestrée', async () => {
    const persistence = new InMemoryPersistence();

    await persistence.runInTransaction(async () => {
      await persistence.runInTransaction(async () => {
        const saved = await persistence.documentFolders.save(folder('folder-nested', 'Transaction imbriquée'), null);
        expect(saved.status).toBe('saved');
      });
    });

    expect(await persistence.documentFolders.findById('company-transaction-test', 'folder-nested')).not.toBeNull();
  });
});

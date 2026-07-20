import { describe, expect, it } from 'vitest';
import { DocumentFolder } from '@bob/core';
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

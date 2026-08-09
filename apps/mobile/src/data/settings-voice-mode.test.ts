import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import { neutralizeLegacyCloudVoiceMode } from './settings';

describe('préférence vocale historique — confidentialité fail-closed', () => {
  beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset();
  });

  it('migre durablement la valeur cloud historique au démarrage', async () => {
    storage.getItem.mockResolvedValue('cloud');
    storage.setItem.mockResolvedValue(undefined);
    await expect(neutralizeLegacyCloudVoiceMode()).resolves.toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith('bob.voiceMode', 'native');
  });

  it('ne réécrit pas une installation déjà locale', async () => {
    storage.getItem.mockResolvedValue('native');
    await expect(neutralizeLegacyCloudVoiceMode()).resolves.toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('reste fail-closed quand le stockage historique est illisible', async () => {
    storage.getItem.mockRejectedValueOnce(new Error('storage'));
    await expect(neutralizeLegacyCloudVoiceMode()).resolves.toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

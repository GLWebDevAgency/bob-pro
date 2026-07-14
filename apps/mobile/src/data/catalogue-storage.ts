import { isCatalogueCategory, isVatRate, type CustomPrestation } from '@bob/core';

function isCustomPrestation(value: unknown): value is CustomPrestation {
  if (typeof value !== 'object' || value === null) return false;
  const prestation = value as Record<string, unknown>;
  return (
    typeof prestation['id'] === 'string' &&
    prestation['id'].length > 0 &&
    typeof prestation['label'] === 'string' &&
    prestation['label'].trim().length > 0 &&
    isCatalogueCategory(prestation['category']) &&
    (prestation['unit'] === null || typeof prestation['unit'] === 'string') &&
    typeof prestation['unitPriceHT'] === 'number' &&
    Number.isInteger(prestation['unitPriceHT']) &&
    prestation['unitPriceHT'] > 0 &&
    typeof prestation['vatRate'] === 'number' &&
    isVatRate(prestation['vatRate'])
  );
}

/**
 * Decode a locally persisted catalogue without ever turning corruption into an empty state.
 * The getter is injected so this financial-data boundary remains testable without React Native.
 */
export async function readCustomPrestations(
  getItem: () => Promise<string | null>,
): Promise<CustomPrestation[]> {
  const raw = await getItem();
  if (raw === null) return [];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isCustomPrestation)) {
    throw new Error('CATALOGUE_STORAGE_INVALID');
  }
  return parsed;
}

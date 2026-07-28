/**
 * PR-11 — logique PURE des rangées du parc (écrans §2.1) : chip de garantie dérivée de la
 * colonne réelle `warrantyUntil` (jamais couleur seule — toujours texte + date), et filtre de
 * recherche locale insensible aux accents. Testée sans react-native.
 */

export type WarrantyChipTone = 'success' | 'warning' | 'neutral';

export interface WarrantyChip {
  tone: WarrantyChipTone;
  /** Clé i18n : `equipements.warrantyUntil` (valide) ou `equipements.warrantyExpired` (échue). */
  labelKey: 'equipements.warrantyUntil' | 'equipements.warrantyExpired';
  date: string;
}

const WARNING_WINDOW_DAYS = 90;

/** Chip garantie : success > 90 j restants, warning ≤ 90 j, neutral échue — null si absente. */
export function warrantyChipOf(warrantyUntil: string | null, today: string): WarrantyChip | null {
  if (warrantyUntil === null) return null;
  if (warrantyUntil < today) {
    return { tone: 'neutral', labelKey: 'equipements.warrantyExpired', date: warrantyUntil };
  }
  const remainingDays = Math.round(
    (Date.parse(`${warrantyUntil}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000,
  );
  return {
    tone: remainingDays > WARNING_WINDOW_DAYS ? 'success' : 'warning',
    labelKey: 'equipements.warrantyUntil',
    date: warrantyUntil,
  };
}

function normalized(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export interface SearchableEquipment {
  label: string;
  kind: string | null;
  brand: string | null;
  serialNumber: string | null;
  location: string | null;
}

/** Recherche locale (label + type + marque + n° série + emplacement), accents repliés. */
export function matchesEquipmentQuery(equipment: SearchableEquipment, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === '') return true;
  const haystack = normalized(
    [equipment.label, equipment.kind, equipment.brand, equipment.serialNumber, equipment.location]
      .filter((part): part is string => part !== null)
      .join(' '),
  );
  return normalized(trimmed)
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/** Sous-titre de rangée : « Fontaine réseau · Culligan · SN 88-4121 » (parts réelles seulement). */
export function equipmentRowSubtitle(equipment: SearchableEquipment): string | null {
  const parts = [equipment.kind, equipment.brand, equipment.serialNumber].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

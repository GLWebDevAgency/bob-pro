import { type Instant } from '../../shared-kernel/time';

/**
 * Bloc A §1.5 — historique PAR ÉQUIPEMENT : dérivation PURE (zéro I/O) fusionnant les traces
 * réelles taguées `equipmentId` — notes et photos du site (colonnes additives), interventions
 * (Bloc C, quand livré) et documents liés (`linkedEntityType='equipment'`). C'est LA valeur
 * (« montre-moi l'historique de la fontaine Y ») : rien n'est inventé, une trace non taguée
 * n'apparaît jamais (fail-closed — l'historique antérieur au tagage reste sur la fiche site).
 */

export interface EquipmentHistoryNoteSource {
  id: string;
  text: string;
  authorLabel: string;
  createdAt: Instant;
  /** Tag additif — `null`/`undefined` = note du site non liée à un équipement (exclue). */
  equipmentId?: string | null;
}

export interface EquipmentHistoryPhotoSource {
  id: string;
  filename: string;
  createdAt: Instant;
  equipmentId?: string | null;
}

export interface EquipmentHistoryInterventionSource {
  id: string;
  label: string;
  status: string;
  at: Instant;
  equipmentId?: string | null;
}

export interface EquipmentHistoryDocumentSource {
  id: string;
  filename: string;
  kind: string;
  createdAt: Instant;
  linkedEntityType?: string | null;
  linkedEntityId?: string | null;
}

export type EquipmentHistoryEntry =
  | { type: 'note'; id: string; at: Instant; text: string; authorLabel: string }
  | { type: 'photo'; id: string; at: Instant; filename: string }
  | { type: 'intervention'; id: string; at: Instant; label: string; status: string }
  | { type: 'document'; id: string; at: Instant; filename: string; kind: string };

export interface DeriveEquipmentHistoryInput {
  equipmentId: string;
  notes: readonly EquipmentHistoryNoteSource[];
  photos: readonly EquipmentHistoryPhotoSource[];
  interventions?: readonly EquipmentHistoryInterventionSource[];
  documents?: readonly EquipmentHistoryDocumentSource[];
}

function validInstant(at: unknown): at is Instant {
  return typeof at === 'string' && at.length > 0;
}

/** Fusion triée DESC (plus récent d'abord) ; départage stable type puis id pour un rendu
 * déterministe. Fail-closed : tag absent/divergent ou horodatage illisible = trace exclue. */
export function deriveEquipmentHistory(input: DeriveEquipmentHistoryInput): EquipmentHistoryEntry[] {
  const entries: EquipmentHistoryEntry[] = [];
  for (const note of input.notes) {
    if (note.equipmentId !== input.equipmentId || !validInstant(note.createdAt)) continue;
    entries.push({ type: 'note', id: note.id, at: note.createdAt, text: note.text, authorLabel: note.authorLabel });
  }
  for (const photo of input.photos) {
    if (photo.equipmentId !== input.equipmentId || !validInstant(photo.createdAt)) continue;
    entries.push({ type: 'photo', id: photo.id, at: photo.createdAt, filename: photo.filename });
  }
  for (const intervention of input.interventions ?? []) {
    if (intervention.equipmentId !== input.equipmentId || !validInstant(intervention.at)) continue;
    entries.push({
      type: 'intervention',
      id: intervention.id,
      at: intervention.at,
      label: intervention.label,
      status: intervention.status,
    });
  }
  for (const document of input.documents ?? []) {
    if (
      document.linkedEntityType !== 'equipment' ||
      document.linkedEntityId !== input.equipmentId ||
      !validInstant(document.createdAt)
    ) continue;
    entries.push({
      type: 'document',
      id: document.id,
      at: document.createdAt,
      filename: document.filename,
      kind: document.kind,
    });
  }
  const typeOrder: Record<EquipmentHistoryEntry['type'], number> = {
    note: 0,
    photo: 1,
    intervention: 2,
    document: 3,
  };
  return entries.sort(
    (left, right) =>
      right.at.localeCompare(left.at) ||
      typeOrder[left.type] - typeOrder[right.type] ||
      left.id.localeCompare(right.id),
  );
}

/**
 * JOURNAL LOCAL DES ÉCHECS API (SPEC_SYSTEME_ERREUR §5.1) — la face développeur qui reste SUR
 * l'appareil : les N derniers échecs (code court, corrélation, heure, route expurgée, statut),
 * consultables sur l'écran « Diagnostic technique » et partageables en un geste.
 *
 * JAMAIS de PII : l'entrée est construite par LISTE BLANCHE depuis le rapport du client API
 * (dont le chemin est déjà expurgé — ré-expurgation défensive ici) ; ni cause, ni message, ni
 * issues, ni entity/id (un id métier peut être un SIRET) n'entrent dans le journal.
 *
 * Logique PURE (append borné, parse tolérant, texte de partage) séparée de la persistance
 * AsyncStorage (best-effort, écritures sérialisées — patron `settings.ts`).
 */
import { redactPathForDiagnostics, type ApiErrorReport } from '@bob/api-client';

export const ERROR_JOURNAL_MAX_ENTRIES = 50;
export const ERROR_JOURNAL_STORAGE_KEY = 'bob.errorJournal.v1';

export interface ErrorJournalEntry {
  /** Horodatage ISO de l'échec. */
  readonly at: string;
  /** Code court du registre fermé (« BOB-… »). */
  readonly code: string;
  /** `kind` de l'AppError. */
  readonly kind: string;
  /** Corrélation complète — null si l'échec n'en portait pas. */
  readonly correlationId: string | null;
  readonly method: string;
  /** Chemin EXPURGÉ (query supprimée, segments :id/:num/:token). */
  readonly path: string;
  readonly status: number | null;
  readonly durationMs: number | null;
}

// ── Logique pure ────────────────────────────────────────────────────────────────

/** Ajoute en TÊTE (le plus récent d'abord) et borne la taille — jamais de croissance infinie. */
export function appendJournalEntry(
  entries: readonly ErrorJournalEntry[],
  entry: ErrorJournalEntry,
  max: number = ERROR_JOURNAL_MAX_ENTRIES,
): ErrorJournalEntry[] {
  return [entry, ...entries].slice(0, Math.max(1, max));
}

/**
 * Entrée de journal depuis un rapport du client API — LISTE BLANCHE : seuls les champs
 * ci-dessous sont copiés, le chemin est ré-expurgé par défense en profondeur.
 */
export function journalEntryFromReport(report: ApiErrorReport): ErrorJournalEntry {
  return {
    at: report.at,
    code: report.code,
    kind: typeof report.error.kind === 'string' ? report.error.kind : 'inconnu',
    correlationId: report.error.correlationId ?? null,
    method: report.method,
    path: redactPathForDiagnostics(report.path),
    status: report.status,
    durationMs: report.durationMs,
  };
}

function isJournalEntry(value: unknown): value is ErrorJournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.at === 'string' &&
    typeof entry.code === 'string' &&
    typeof entry.kind === 'string' &&
    (entry.correlationId === null || typeof entry.correlationId === 'string') &&
    typeof entry.method === 'string' &&
    typeof entry.path === 'string' &&
    (entry.status === null || typeof entry.status === 'number') &&
    (entry.durationMs === null || typeof entry.durationMs === 'number')
  );
}

/**
 * Parse TOLÉRANT du stockage : une entrée corrompue est écartée, jamais le journal entier ;
 * un contenu illisible rend un journal vide (le diagnostic ne plante jamais l'app).
 */
export function parseJournal(raw: string | null): ErrorJournalEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isJournalEntry).slice(0, ERROR_JOURNAL_MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** Heure locale courte « JJ/MM HH:MM » — chaîne vide si l'ISO est illisible. */
export function journalEntryTime(atIso: string): string {
  const date = new Date(atIso);
  if (Number.isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month} ${hours}:${minutes}`;
}

/**
 * Texte de partage du journal — une ligne par échec, composition FERMÉE (code, corrélation,
 * heure, méthode+route expurgée, statut) : aucun slot pour un message ou une donnée saisie.
 */
export function journalShareText(entries: readonly ErrorJournalEntry[]): string {
  const header = `Bob Pro — diagnostic technique (${entries.length} échec(s))`;
  const lines = entries.map((entry) => {
    const parts = [
      entry.code,
      entry.correlationId ?? 'sans-correlation',
      journalEntryTime(entry.at) || entry.at,
      `${entry.method} ${entry.path}`,
      entry.status === null ? 'sans-reponse' : `HTTP ${entry.status}`,
    ];
    return parts.join(' · ');
  });
  return [header, ...lines].join('\n');
}

// ── Persistance AsyncStorage (best-effort, écritures sérialisées) ───────────────

export interface JournalStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Import PARESSEUX : les tests (environnement node) injectent leur stockage — le module natif
 * n'est jamais évalué hors de l'app.
 */
async function defaultStorage(): Promise<JournalStorage> {
  const mod = await import('@react-native-async-storage/async-storage');
  return mod.default;
}

/** File d'écriture : sérialise lecture-modification-écriture — deux échecs simultanés ne se
 * perdent pas l'un l'autre. */
let writeQueue: Promise<void> = Promise.resolve();

export function recordJournalEntry(
  entry: ErrorJournalEntry,
  storage?: JournalStorage,
): Promise<void> {
  const task = async (): Promise<void> => {
    try {
      const store = storage ?? (await defaultStorage());
      const current = parseJournal(await store.getItem(ERROR_JOURNAL_STORAGE_KEY));
      const next = appendJournalEntry(current, entry);
      await store.setItem(ERROR_JOURNAL_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Journal best-effort : un stockage en panne ne fabrique jamais un second échec.
    }
  };
  writeQueue = writeQueue.then(task);
  return writeQueue;
}

export async function readJournal(storage?: JournalStorage): Promise<ErrorJournalEntry[]> {
  try {
    const store = storage ?? (await defaultStorage());
    return parseJournal(await store.getItem(ERROR_JOURNAL_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function clearJournal(storage?: JournalStorage): Promise<void> {
  const task = async (): Promise<void> => {
    try {
      const store = storage ?? (await defaultStorage());
      await store.removeItem(ERROR_JOURNAL_STORAGE_KEY);
    } catch {
      // best-effort
    }
  };
  writeQueue = writeQueue.then(task);
  return writeQueue;
}

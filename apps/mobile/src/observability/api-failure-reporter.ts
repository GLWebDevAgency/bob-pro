/**
 * PONT échec API → canaux d'observabilité (SPEC_SYSTEME_ERREUR §5) — l'unique branchement du
 * hook `onError` du client HTTP (`data/client.tsx`) :
 *
 *  1. JOURNAL LOCAL : chaque échec entre au journal (entrée liste blanche, bornée, sans PII) —
 *     c'est la matière de l'écran « Diagnostic technique ».
 *  2. SENTRY : SEULS les `kind === 'dependency'` remontent (premier site d'appel réel de
 *     `captureCrash`) — même doctrine que le serveur (décision prod 20/07) : `unavailable` est
 *     un état normal assumé et les 4xx sont des refus applicatifs, aucun des deux n'alerte.
 *
 * Tout est best-effort : ce pont ne jette jamais (le client avale déjà, ceinture ici).
 */
import type { ApiErrorReport } from '@bob/api-client';
import { journalEntryFromReport, recordJournalEntry } from '../data/error-journal';
import { captureCrash } from './crash-reporter';

export interface ApiFailureSinks {
  readonly record: typeof recordJournalEntry;
  readonly capture: typeof captureCrash;
}

const DEFAULT_SINKS: ApiFailureSinks = {
  record: recordJournalEntry,
  capture: captureCrash,
};

export function reportApiFailure(
  report: ApiErrorReport,
  sinks: ApiFailureSinks = DEFAULT_SINKS,
): void {
  try {
    void sinks.record(journalEntryFromReport(report));
    if (report.error.kind === 'dependency') {
      // Message = code du registre uniquement ; le contexte part en TAGS (scrubbés par la
      // politique partagée @bob/core) — jamais de cause brute, jamais de contenu utilisateur.
      sinks.capture(new Error(`api_failure ${report.code}`), {
        code: report.code,
        kind: report.error.kind,
        port: report.error.port,
        correlationId: report.error.correlationId ?? 'absente',
        method: report.method,
        path: report.path,
        status: report.status ?? 'sans-reponse',
      });
    }
  } catch {
    // Un canal d'observabilité défaillant ne fabrique jamais un second échec.
  }
}

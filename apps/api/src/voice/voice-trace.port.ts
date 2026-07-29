import type { AppError, VoiceTraceErrorFacts } from '@bob/core';

/**
 * PORT du traçage vocal — contrat vu par le chemin vocal (BackendService).
 *
 * Ce fichier est délibérément SANS DÉPENDANCE LOURDE : ni `@prisma/client`, ni Nest, ni la
 * couche persistance. `backend.service.ts` n'importait aucun client Prisma ; l'y faire entrer
 * par la porte du traçage alourdissait le graphe de modules de tout le chemin agent et
 * déstabilisait des suites voisines sensibles au temps de chargement. Le port reste léger,
 * l'implémentation (voice-trace.recorder.ts) porte seule les dépendances d'infrastructure.
 */
export const VOICE_TRACE_RECORDER = Symbol('VOICE_TRACE_RECORDER');

export interface VoiceTraceIdentity {
  readonly companyId: string;
  readonly userId: string | null;
}

export interface VoiceTraceTranscriptionInput extends VoiceTraceIdentity {
  readonly transcript: string | null;
  readonly sttModel: string | null;
  readonly transcriptionMs: number;
  readonly error: VoiceTraceErrorFacts | null;
}

export interface VoiceTracePlanningInput extends VoiceTraceIdentity {
  /** Message soumis à l'agent — sert à raccorder ce tour à la transcription qui l'a produit. */
  readonly message: string;
  readonly intent: string | null;
  readonly tool: string | null;
  readonly toolArgs: unknown;
  readonly autonomy: string | null;
  readonly llmModel: string | null;
  readonly reply: string | null;
  readonly planificationMs: number;
  readonly executionMs: number | null;
  readonly error: VoiceTraceErrorFacts | null;
}

export interface VoiceTraceSynthesisInput extends VoiceTraceIdentity {
  readonly text: string;
  readonly ttsModel: string | null;
  readonly syntheseMs: number;
  readonly error: VoiceTraceErrorFacts | null;
}

/**
 * Aucune méthode ne rend de promesse : le tour vocal ne doit jamais attendre sa propre trace,
 * ni pouvoir échouer à cause d'elle. La signature EST la garantie.
 */
export interface VoiceTraceRecorderPort {
  noteTranscription(input: VoiceTraceTranscriptionInput): void;
  notePlanning(input: VoiceTracePlanningInput): void;
  noteSynthesis(input: VoiceTraceSynthesisInput): void;
}

/**
 * Réduit un `AppError` aux faits journalisables du traçage vocal.
 *
 * Contrairement à `appErrorLogSummary` (exception.filter.ts), qui applique une liste blanche
 * stricte parce que sa destination est un log d'accès potentiellement expédié ailleurs, on
 * conserve ici les `issues` de validation et le `DomainError` : ce sont EXACTEMENT les faits qui
 * disent pourquoi Bob a refusé (« quel champ manquait », « quelle transition est interdite »).
 * La destination est notre base souveraine, à rétention bornée — pas un tiers.
 */
export function voiceTraceErrorFacts(error: AppError): VoiceTraceErrorFacts {
  switch (error.kind) {
    case 'not_found':
      return { kind: error.kind, entity: error.entity };
    case 'conflict':
      return { kind: error.kind, entity: error.entity, reason: error.reason };
    case 'gone':
      return { kind: error.kind, entity: error.entity, reason: error.reason };
    case 'forbidden':
    case 'rate_limited':
      return { kind: error.kind, reason: error.reason };
    case 'unavailable':
      return { kind: error.kind, service: error.service };
    case 'validation':
      return { kind: error.kind, issues: error.issues };
    case 'dependency':
      return { kind: error.kind, port: error.port, cause: error.cause };
    case 'domain':
      // Le code du DomainError est la règle métier qui a parlé : c'est LA raison du refus.
      return { kind: error.kind, reason: error.error.code };
    default:
      return { kind: (error as { kind: string }).kind };
  }
}

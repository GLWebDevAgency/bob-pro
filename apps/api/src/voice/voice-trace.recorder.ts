import { Inject, Injectable, Optional, type Provider } from '@nestjs/common';
import {
  boundVoiceTraceArgs,
  boundVoiceTraceText,
  classifyVoiceTurn,
  resolveVoiceSessionCursor,
  voiceTraceExpiryAt,
  VOICE_TRACE_REPLY_MAX_CHARS,
  VOICE_TRACE_SESSION_IDLE_MS,
  VOICE_TRACE_TRANSCRIPT_MAX_CHARS,
  type VoiceSessionCursor,
  type VoiceTraceErrorFacts,
  type VoiceTurnClassification,
} from '@bob/core';
import {
  VOICE_TRACE_RECORDER,
  type VoiceTracePlanningInput,
  type VoiceTraceRecorderPort,
  type VoiceTraceSynthesisInput,
  type VoiceTraceTranscriptionInput,
  type VoiceTraceIdentity,
} from './voice-trace.port';
import { isVoiceTraceEnabled } from '../config/env';
import { AppLogger, getCorrelationId } from '../observability/logger';
import { ERROR_REPORTER, type ErrorReporter } from '../observability/error-reporter';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';
import { newVoiceTraceId, type VoiceTraceCompleteTurn } from '../persistence/voice-traces';

/**
 * Plafond du registre de tours en vol. Un tour y séjourne au plus la fenêtre d'inactivité ;
 * ce plafond ne protège que d'une fuite pathologique (beaucoup de testeurs, aucun tour conclu).
 */
export const VOICE_TRACE_MAX_PENDING_TURNS = 200;

/**
 * Disjoncteur : au-delà de N échecs CONSÉCUTIFS d'écriture, le traçage se coupe pour le reste du
 * process. Même logique que `HttpErrorReporter` — mieux vaut un outil de debug muet et signalé
 * qu'une base martelée par un tour vocal sur deux.
 */
const VOICE_TRACE_DISABLE_AFTER_FAILURES = 5;

/**
 * Les faits détaillés (`cause`, `reason`, messages de validation) appartiennent exclusivement à
 * la trace PostgreSQL souveraine. Le journal Railway ne reçoit que des identifiants techniques
 * compacts. La validation syntaxique est volontairement fail-closed : une future valeur libre
 * ou enrichie de contexte métier est omise au lieu de franchir cette frontière.
 */
const VOICE_TRACE_LOG_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u;
const VOICE_TRACE_ERROR_KINDS: ReadonlySet<string> = new Set([
  'conflict',
  'dependency',
  'domain',
  'forbidden',
  'not_found',
  'rate_limited',
  'unavailable',
  'validation',
]);

function safeVoiceTraceLogToken(value: string | undefined): string | undefined {
  return value !== undefined && VOICE_TRACE_LOG_TOKEN.test(value) ? value : undefined;
}

/** Vue explicitement allowlistée d'une erreur pour les logs externes. */
export function voiceTraceLogErrorShape(
  error: VoiceTraceErrorFacts | null,
): Record<string, unknown> {
  if (error === null) return {};
  const port = safeVoiceTraceLogToken(error.port);
  const service = safeVoiceTraceLogToken(error.service);
  const entity = safeVoiceTraceLogToken(error.entity);
  return {
    errorKind: VOICE_TRACE_ERROR_KINDS.has(error.kind) ? error.kind : 'unknown',
    ...(port === undefined ? {} : { errorPort: port }),
    ...(service === undefined ? {} : { errorService: service }),
    ...(entity === undefined ? {} : { errorEntity: entity }),
    ...(error.issues === undefined ? {} : { validationIssueCount: error.issues.length }),
  };
}

interface PendingVoiceTurn {
  readonly traceId: string;
  readonly cursor: VoiceSessionCursor;
  readonly transcript: string | null;
  readonly startedAt: string;
  planned: boolean;
  completion: VoiceTraceCompleteTurn | null;
}

/**
 * Un tour vocal traverse TROIS requêtes HTTP indépendantes (/voice/transcribe → /ai/ask →
 * /voice/synthesize) : rien dans le protocole actuel ne les relie. Le raccord se fait donc sur
 * le TEXTE — le message soumis à l'agent est celui que la transcription vient de produire.
 *
 * L'inclusion (dans un sens ou dans l'autre) tolère qu'un client préfixe ou rogne légèrement le
 * transcript ; une divergence franche NE raccorde pas, et c'est voulu : mieux vaut un tour resté
 * `heard` — visible, interrogeable — qu'un fil recollé à tort qui ferait accuser le mauvais
 * outil. C'est aussi ce qui garantit qu'une conversation TEXTE n'est jamais tracée ici.
 */
export function voiceTurnStitchesToTranscript(transcript: string | null, message: string): boolean {
  if (transcript === null) return false;
  const spoken = transcript.trim();
  const submitted = message.trim();
  if (spoken.length === 0 || submitted.length === 0) return false;
  return submitted.includes(spoken) || spoken.includes(submitted);
}

/**
 * TRAÇAGE DU COMPORTEMENT VOCAL — enregistreur (adapter).
 *
 * Trois garanties, dans cet ordre de priorité :
 *
 * 1. FAIL-CLOSED SUR LE FLAG. Sans `VOICE_TRACE_ENABLED=true`, aucune ligne, aucun état en
 *    mémoire, aucun coût. Le flag est relu à chaque tour : le couper agit immédiatement.
 * 2. LA TRACE S'EFFACE DEVANT L'USAGE. Aucune méthode ne rend de promesse et aucune ne peut
 *    lever : les écritures sont mises en file et drainées HORS de la transaction de requête
 *    (`runDetachedWithTenant`). Une base lente ou en panne n'ajoute pas une milliseconde au tour
 *    vocal et ne peut pas l'avorter.
 * 3. LE CONTENU SENSIBLE NE SORT PAS. Transcript et réponse vont dans notre PostgreSQL et NULLE
 *    PART AILLEURS : les logs applicatifs (Railway, et demain Sentry) ne reçoivent que la forme
 *    du tour — session, index, intention, outil, issue, latences.
 */
@Injectable()
export class VoiceTraceRecorder implements VoiceTraceRecorderPort {
  private readonly pending = new Map<string, PendingVoiceTurn>();
  /** File sérialisée : au plus UNE écriture de trace en vol, donc pression connexions bornée. */
  private queue: Promise<void> = Promise.resolve();
  private consecutiveFailures = 0;
  private disabled = false;

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    private readonly logger: AppLogger,
    @Inject(ERROR_REPORTER) private readonly reporter: ErrorReporter,
    // @Optional() OBLIGATOIRE : sans lui, Nest tenterait d'injecter ce paramètre (metadata
    // `Function`) et la résolution du module échouerait au boot. Horloge substituable en test.
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {}

  private active(): boolean {
    return isVoiceTraceEnabled() && !this.disabled;
  }

  private static key(identity: VoiceTraceIdentity): string {
    return `${identity.companyId}:${identity.userId ?? 'anonyme'}`;
  }

  /** Ouvre un tour : Bob a entendu. La ligne existe AVANT de savoir ce qu'il en fera. */
  noteTranscription(input: VoiceTraceTranscriptionInput): void {
    if (!this.active()) return;
    try {
      const nowMs = this.now();
      this.prunePending(nowMs);
      const key = VoiceTraceRecorder.key(input);
      const cursor = resolveVoiceSessionCursor(
        this.pending.get(key)?.cursor ?? null,
        nowMs,
        newVoiceTraceId(),
      );
      const classification = input.error === null ? HEARD : classifyVoiceTurn(input.error);
      const startedAt = new Date(nowMs).toISOString();
      const transcript =
        input.transcript === null
          ? null
          : boundVoiceTraceText(input.transcript, VOICE_TRACE_TRANSCRIPT_MAX_CHARS);
      const traceId = newVoiceTraceId();
      this.pending.set(key, {
        traceId,
        cursor,
        transcript,
        startedAt,
        planned: false,
        completion: null,
      });
      const correlationId = getCorrelationId();
      this.enqueue(input.companyId, () =>
        this.p.voiceTraces.openTurn(input.companyId, {
          id: traceId,
          sessionId: cursor.sessionId,
          turnIndex: cursor.turnIndex,
          userId: input.userId,
          correlationId,
          startedAt,
          transcript,
          sttModel: input.sttModel,
          transcriptionMs: input.transcriptionMs,
          outcome: classification.outcome,
          level: classification.level,
          reason: classification.reason,
          retentionExpiresAt: voiceTraceExpiryAt(startedAt),
        }),
      );
      this.emit('voice.turn.entendu', cursor, classification, input.error, {
        sttModel: input.sttModel,
        transcriptionMs: input.transcriptionMs,
      });
    } catch {
      // Une trace ne casse jamais un tour vocal. Aucun relog : le drain compte déjà les échecs.
    }
  }

  /** Complète le tour : ce que Bob a compris, ce qu'il a fait, ce qu'il répond. */
  notePlanning(input: VoiceTracePlanningInput): void {
    if (!this.active()) return;
    try {
      const key = VoiceTraceRecorder.key(input);
      const turn = this.pending.get(key);
      // Pas de tour vocal ouvert, ou message sans rapport avec ce qui a été prononcé :
      // c'est une conversation TEXTE. Elle n'a rien à faire dans un traçage vocal.
      if (!turn || turn.planned || !voiceTurnStitchesToTranscript(turn.transcript, input.message))
        return;
      const classification = classifyVoiceTurn(input.error);
      turn.planned = true;
      const completion: VoiceTraceCompleteTurn = {
        id: turn.traceId,
        planCorrelationId: getCorrelationId(),
        intent: input.intent,
        tool: input.tool,
        toolArgs: boundVoiceTraceArgs(input.toolArgs),
        autonomy: input.autonomy,
        llmModel: input.llmModel,
        outcome: classification.outcome,
        level: classification.level,
        reason: classification.reason,
        reply:
          input.reply === null
            ? null
            : boundVoiceTraceText(input.reply, VOICE_TRACE_REPLY_MAX_CHARS),
        ttsModel: null,
        planificationMs: input.planificationMs,
        executionMs: input.executionMs,
        syntheseMs: null,
        updatedAt: new Date(this.now()).toISOString(),
      };
      turn.completion = completion;
      this.enqueue(input.companyId, () =>
        this.p.voiceTraces.completeTurn(input.companyId, completion),
      );
      this.emit('voice.turn.traite', turn.cursor, classification, input.error, {
        intent: input.intent,
        tool: input.tool,
        planificationMs: input.planificationMs,
        executionMs: input.executionMs,
      });
    } catch {
      // idem : jamais au détriment du tour.
    }
  }

  /** Clôt le tour : Bob a parlé. Complète la même ligne, n'en crée jamais une seconde. */
  noteSynthesis(input: VoiceTraceSynthesisInput): void {
    if (!this.active()) return;
    try {
      const key = VoiceTraceRecorder.key(input);
      const turn = this.pending.get(key);
      // Sans tour planifié, on ne sait pas à quel échange cette voix appartient : on n'invente pas.
      if (!turn?.completion) return;
      const synthesisError = classifyVoiceTurn(input.error);
      const completion: VoiceTraceCompleteTurn = {
        ...turn.completion,
        ttsModel: input.ttsModel,
        syntheseMs: input.syntheseMs,
        // La réponse effectivement vocalisée fait foi sur celle qu'on avait anticipée.
        reply: boundVoiceTraceText(input.text, VOICE_TRACE_REPLY_MAX_CHARS),
        // Une synthèse en échec n'efface pas une planification réussie : elle la DÉGRADE.
        ...(input.error === null
          ? {}
          : {
              outcome: synthesisError.outcome,
              level: synthesisError.level,
              reason: `synthèse vocale — ${synthesisError.reason ?? 'inconnue'}`,
            }),
        updatedAt: new Date(this.now()).toISOString(),
      };
      turn.completion = completion;
      this.enqueue(input.companyId, () =>
        this.p.voiceTraces.completeTurn(input.companyId, completion),
      );
      this.emit(
        'voice.turn.repondu',
        turn.cursor,
        input.error === null ? SPOKEN : synthesisError,
        input.error,
        { ttsModel: input.ttsModel, syntheseMs: input.syntheseMs },
      );
    } catch {
      // idem.
    }
  }

  /** Attend le drain de la file. Réservé aux tests et à l'arrêt propre du process. */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * Empile une écriture DÉTACHÉE. Ni `await`, ni rejet propagé : l'appelant — un tour vocal en
   * cours — reprend la main immédiatement, que la base réponde ou non.
   */
  private enqueue(companyId: string, write: () => Promise<void>): void {
    this.queue = this.queue
      .then(() => this.p.runDetachedWithTenant(companyId, write))
      .then(
        () => {
          this.consecutiveFailures = 0;
        },
        () => this.recordWriteFailure(),
      );
  }

  /**
   * SEULE remontée au canal d'incident portée par ce module, et elle est délibérée : les
   * anomalies MÉTIER d'un tour vocal remontent déjà via `AllExceptionsFilter` (elles sortent en
   * 5xx), les redoubler ici ne ferait que du bruit. En revanche, un traçage qui n'écrit plus est
   * invisible par construction — le fondateur croirait tester sous observation alors que rien
   * n'est enregistré. C'est cette panne-là qu'il faut faire remonter.
   */
  private recordWriteFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < VOICE_TRACE_DISABLE_AFTER_FAILURES) {
      this.logger.warn('Écriture de trace vocale impossible.', 'VoiceTrace');
      return;
    }
    this.disabled = true;
    this.pending.clear();
    this.logger.error(
      `Traçage vocal DÉSACTIVÉ après ${VOICE_TRACE_DISABLE_AFTER_FAILURES} échecs d'écriture consécutifs. ` +
        'Les tours vocaux continuent normalement, mais ne sont plus tracés — redémarrer pour réactiver.',
      undefined,
      'VoiceTrace',
    );
    const incident = new Error('voice-trace-write');
    incident.name = 'VoiceTracePersistenceError';
    this.reporter.captureException(incident, {
      correlationId: getCorrelationId(),
      channel: 'voice-trace',
    });
  }

  /**
   * Journal applicatif : la FORME du tour, jamais son contenu. Les trois niveaux exigés par le
   * bêta-test sont ici littéraux — `audit` (comportement normal), `warn` (refus métier attendu),
   * `error` (anomalie réelle). Le texte prononcé et la réponse restent en base souveraine.
   */
  private emit(
    action: string,
    cursor: VoiceSessionCursor,
    classification: VoiceTurnClassification,
    error: VoiceTraceErrorFacts | null,
    extra: Record<string, unknown>,
  ): void {
    const shape = {
      sessionId: cursor.sessionId,
      turnIndex: cursor.turnIndex,
      outcome: classification.outcome,
      ...extra,
      ...voiceTraceLogErrorShape(error),
    };
    if (classification.level === 'info') {
      this.logger.audit(action, shape);
      return;
    }
    const line = `${action} ${JSON.stringify(shape)}`;
    if (classification.level === 'warn') this.logger.warn(line, 'VoiceTrace');
    else this.logger.error(line, undefined, 'VoiceTrace');
  }

  /** Un tour jamais conclu ne doit pas retenir de mémoire au-delà de sa fenêtre de session. */
  private prunePending(nowMs: number): void {
    for (const [key, turn] of this.pending) {
      if (nowMs - turn.cursor.lastActivityAtMs > VOICE_TRACE_SESSION_IDLE_MS)
        this.pending.delete(key);
    }
    if (this.pending.size <= VOICE_TRACE_MAX_PENDING_TURNS) return;
    const oldestFirst = [...this.pending.entries()].sort(
      (left, right) => left[1].cursor.lastActivityAtMs - right[1].cursor.lastActivityAtMs,
    );
    for (const [key] of oldestFirst.slice(0, this.pending.size - VOICE_TRACE_MAX_PENDING_TURNS)) {
      this.pending.delete(key);
    }
  }
}

/** Bob a entendu, la suite n'est pas encore connue. Ce n'est ni un succès ni un échec. */
const HEARD: VoiceTurnClassification = {
  outcome: 'heard',
  level: 'info',
  reportable: false,
  reason: null,
};

/** Bob a fini de parler : le tour est bouclé. */
const SPOKEN: VoiceTurnClassification = {
  outcome: 'success',
  level: 'info',
  reportable: false,
  reason: null,
};

/**
 * Le chemin vocal reçoit l'enregistreur par TOKEN, jamais par sa classe : c'est ce qui garde
 * `backend.service.ts` à l'écart des dépendances d'infrastructure de ce module (cf. voice-trace.port.ts).
 */
export const voiceTraceRecorderProvider: Provider = {
  provide: VOICE_TRACE_RECORDER,
  useExisting: VoiceTraceRecorder,
};

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { VoiceTraceLevel, VoiceTurnOutcome } from '@bob/core';
import { PrismaService } from './prisma/prisma.service';

/**
 * Une TRACE = un TOUR de conversation vocale, écrit en deux temps : `openTurn` dès la
 * transcription (Bob a entendu), puis `completeTurn` quand la planification et la synthèse ont
 * livré leur verdict. Ce découpage n'est pas cosmétique : si l'app coupe entre les deux, la
 * ligne `heard` SUBSISTE et raconte précisément « Bob a entendu ceci, puis plus rien » —
 * exactement le symptôme qu'un fondateur ne sait pas décrire de mémoire.
 */
export interface VoiceTraceOpenTurn {
  readonly id: string;
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly userId: string | null;
  readonly correlationId: string;
  readonly startedAt: string;
  readonly transcript: string | null;
  readonly sttModel: string | null;
  readonly transcriptionMs: number | null;
  readonly outcome: VoiceTurnOutcome;
  readonly level: VoiceTraceLevel;
  readonly reason: string | null;
  readonly retentionExpiresAt: string;
}

export interface VoiceTraceCompleteTurn {
  readonly id: string;
  readonly planCorrelationId: string | null;
  readonly intent: string | null;
  readonly tool: string | null;
  readonly toolArgs: unknown;
  readonly autonomy: string | null;
  readonly llmModel: string | null;
  readonly outcome: VoiceTurnOutcome;
  readonly level: VoiceTraceLevel;
  readonly reason: string | null;
  readonly reply: string | null;
  readonly ttsModel: string | null;
  readonly planificationMs: number | null;
  readonly executionMs: number | null;
  readonly syntheseMs: number | null;
  readonly updatedAt: string;
}

export interface VoiceTraceRepository {
  /** Ouvre le tour dès la transcription. */
  openTurn(companyId: string, turn: VoiceTraceOpenTurn): Promise<void>;
  /** Complète le tour ouvert. Un identifiant inconnu est ignoré, jamais recréé en aveugle. */
  completeTurn(companyId: string, turn: VoiceTraceCompleteTurn): Promise<void>;
  /**
   * Purge de rétention, bornée par `limit`. Rend le nombre de lignes réellement supprimées :
   * un appelant qui ne peut pas mesurer sa purge ne peut pas prouver qu'elle tourne.
   */
  purgeExpired(input: { companyId: string; before: string; limit: number }): Promise<number>;
}

export function newVoiceTraceId(): string {
  return `vtr_${randomUUID()}`;
}

/**
 * Adapter PostgreSQL. Toutes les écritures portent `companyId` dans le `where` EN PLUS de la
 * RLS : la politique base est une défense en profondeur, pas la première ligne.
 */
export class PrismaVoiceTraceRepository implements VoiceTraceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async openTurn(companyId: string, turn: VoiceTraceOpenTurn): Promise<void> {
    try {
      await this.prisma.client().voiceTrace.create({
        data: {
          id: turn.id,
          companyId,
          sessionId: turn.sessionId,
          turnIndex: turn.turnIndex,
          userId: turn.userId,
          correlationId: turn.correlationId,
          startedAt: new Date(turn.startedAt),
          transcript: turn.transcript,
          sttModel: turn.sttModel,
          transcriptionMs: turn.transcriptionMs,
          outcome: turn.outcome,
          level: turn.level,
          reason: turn.reason,
          updatedAt: new Date(turn.startedAt),
          retentionExpiresAt: new Date(turn.retentionExpiresAt),
        },
      });
    } catch (cause) {
      // Course sur (companyId, sessionId, turnIndex) : deux tours concurrents du même testeur.
      // Le second est perdu — une trace de debug ne justifie pas de faire échouer un tour vocal.
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') return;
      throw cause;
    }
  }

  async completeTurn(companyId: string, turn: VoiceTraceCompleteTurn): Promise<void> {
    await this.prisma.client().voiceTrace.updateMany({
      where: { id: turn.id, companyId },
      data: {
        planCorrelationId: turn.planCorrelationId,
        intent: turn.intent,
        tool: turn.tool,
        toolArgs:
          turn.toolArgs === null || turn.toolArgs === undefined
            ? Prisma.DbNull
            : (turn.toolArgs as Prisma.InputJsonValue),
        autonomy: turn.autonomy,
        llmModel: turn.llmModel,
        outcome: turn.outcome,
        level: turn.level,
        reason: turn.reason,
        reply: turn.reply,
        ttsModel: turn.ttsModel,
        planificationMs: turn.planificationMs,
        executionMs: turn.executionMs,
        syntheseMs: turn.syntheseMs,
        updatedAt: new Date(turn.updatedAt),
      },
    });
  }

  async purgeExpired(input: {
    companyId: string;
    before: string;
    limit: number;
  }): Promise<number> {
    const candidates = await this.prisma.client().voiceTrace.findMany({
      where: { companyId: input.companyId, retentionExpiresAt: { lte: new Date(input.before) } },
      orderBy: [{ retentionExpiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: Math.max(0, input.limit),
    });
    if (candidates.length === 0) return 0;
    const removed = await this.prisma.client().voiceTrace.deleteMany({
      where: { companyId: input.companyId, id: { in: candidates.map((row) => row.id) } },
    });
    return removed.count;
  }
}

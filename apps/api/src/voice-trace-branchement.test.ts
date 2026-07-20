import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import type { Persistence } from './persistence/persistence';
import type { InMemoryVoiceTraceRepository } from './persistence/voice-traces.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { VoiceTraceRecorder } from './voice/voice-trace.recorder';
import { VOICE_TRACE_RECORDER } from './voice/voice-trace.port';
import { VoiceTracePurgeService } from './jobs/voice-trace-purge.service';

/**
 * BRANCHEMENT RÉEL du traçage vocal.
 *
 * Un enregistreur correct mais jamais appelé est le piège récurrent de ce dépôt : cette suite ne
 * teste pas l'enregistreur (voir voice/voice-trace.recorder.test.ts), elle prouve que le CHEMIN
 * VOCAL DE PRODUCTION — `BackendService.transcribe` / `askBob` / `synthesizeSpeech` — l'invoque,
 * et que la composition Nest le lui fournit.
 */

const PRINCIPAL: Principal = { userId: 'u-mercier', companyId: MERCIER_PROPS.id };

function makeService() {
  const p = new InMemoryPersistence();
  void p.subscriptions.startTrial({
    id: `sub-${MERCIER_PROPS.id}`,
    companyId: MERCIER_PROPS.id,
    plan: 'business',
    trialEndsAt: '2099-12-31T23:59:59.000Z',
    now: '2026-01-01T00:00:00.000Z',
  });
  const logger = {
    audit: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  } as unknown as AppLogger;
  const metrics = {
    aiRequests: { inc: vi.fn() },
    aiDuration: { observe: vi.fn() },
    aiGuardViolations: { inc: vi.fn() },
  } as unknown as Metrics;
  const recorder = new VoiceTraceRecorder(p as unknown as Persistence, logger, {
    captureException: vi.fn(),
  });
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    { setUserCompanyId: vi.fn(), deleteUser: vi.fn() } as unknown as SupabaseAdminPort,
    { enqueue: vi.fn(), tryDeliver: vi.fn() } as unknown as NotificationDeliveryService,
    metrics,
    logger,
    undefined,
    new InMemoryDocumentStorage(),
    null,
    null,
    recorder,
  );
  return {
    service,
    recorder,
    traces: p.voiceTraces as unknown as InMemoryVoiceTraceRepository,
  };
}

function asPrincipal<T>(fn: () => T): T {
  return requestContext.run({ correlationId: 'req-voice-1', principal: PRINCIPAL }, fn);
}

describe('Branchement — le chemin vocal de production écrit bien des traces', () => {
  beforeEach(() => {
    vi.stubEnv('VOICE_TRACE_ENABLED', 'true');
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://sign.bob.test');
    // Aucun fournisseur vocal cloud : le refus est ALORS déterministe, indépendant des clés qui
    // traînent dans l'environnement du développeur (les adapters STT/TTS sont construits à
    // l'instanciation du service, donc ce nettoyage doit précéder makeService()).
    vi.stubEnv('MISTRAL_API_KEY', undefined);
    vi.stubEnv('OPENAI_API_KEY', undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('transcribe() trace le refus quand la dictée cloud n’est pas configurée', async () => {
    const { service, recorder, traces } = makeService();
    const result = await asPrincipal(() =>
      service.transcribe({ audioBase64: 'YQ==', mimeType: 'audio/m4a' }),
    );
    await recorder.flush();

    // Sans fournisseur STT configuré dans le harness, le refus est ATTENDU : ce qui compte est
    // qu'il soit désormais TRACÉ avec sa raison, là où le code d'origine était muet.
    expect(result.ok).toBe(false);
    const [trace] = traces.list();
    expect(trace).toBeDefined();
    expect(trace?.level).toBe('warn');
    expect(trace?.reason).toBeTruthy();
    expect(trace?.transcriptionMs).toBeGreaterThanOrEqual(0);
  });

  it('transcribe() trace le refus de forme AVANT tout appel fournisseur', async () => {
    const { service, recorder, traces } = makeService();
    await asPrincipal(() => service.transcribe({ audioBase64: 'YQ==', mimeType: 'text/plain' }));
    await recorder.flush();

    const [trace] = traces.list();
    expect(trace?.outcome).toBe('refused');
    expect(trace?.reason).toContain('mimeType');
  });

  it('synthesizeSpeech() trace la clôture du tour', async () => {
    const { service, recorder, traces } = makeService();
    await asPrincipal(() => service.transcribe({ audioBase64: 'YQ==', mimeType: 'audio/m4a' }));
    await asPrincipal(() => service.synthesizeSpeech({ text: 'Bonjour patron.' }));
    await recorder.flush();

    // La synthèse ne se raccroche qu'à un tour PLANIFIÉ : sans /ai/ask entre les deux, elle
    // n'invente pas de tour. La transcription, elle, reste tracée.
    expect(traces.list()).toHaveLength(1);
    expect(traces.list()[0]?.outcome).toBe('refused');
  });

  it('le flag éteint : le même chemin de production n’écrit RIEN', async () => {
    vi.stubEnv('VOICE_TRACE_ENABLED', 'false');
    const { service, recorder, traces } = makeService();
    await asPrincipal(() => service.transcribe({ audioBase64: 'YQ==', mimeType: 'audio/m4a' }));
    await asPrincipal(() => service.synthesizeSpeech({ text: 'Bonjour patron.' }));
    await recorder.flush();
    expect(traces.list()).toEqual([]);
  });
});

describe('Branchement — la composition Nest fournit réellement l’enregistreur', () => {
  const moduleSource = readFileSync(resolve(__dirname, 'app.module.ts'), 'utf8');

  it('AppModule enregistre l’enregistreur ET la purge de rétention', () => {
    expect(moduleSource).toMatch(/^\s*VoiceTraceRecorder,\s*$/mu);
    expect(moduleSource).toMatch(/^\s*VoiceTracePurgeService,\s*$/mu);
    expect(moduleSource).toContain("from './voice/voice-trace.recorder'");
    expect(moduleSource).toContain("from './jobs/voice-trace-purge.service'");
  });

  it('BackendService DÉCLARE le token du traçage vocal comme dépendance injectable', () => {
    // `self:paramtypes` est exactement ce que Nest lit pour résoudre un paramètre annoté
    // @Inject(token) : si le token disparaissait du constructeur, l'enregistreur ne serait
    // jamais injecté en production et le chemin vocal redeviendrait muet, en silence.
    const injected = Reflect.getMetadata('self:paramtypes', BackendService) as Array<{
      param?: unknown;
    }>;
    expect(injected.map((entry) => entry?.param)).toContain(VOICE_TRACE_RECORDER);
  });

  it('le provider expose l’implémentation SOUS ce token', () => {
    expect(moduleSource).toMatch(/^\s*voiceTraceRecorderProvider,\s*$/mu);
    const recorderSource = readFileSync(
      resolve(__dirname, 'voice', 'voice-trace.recorder.ts'),
      'utf8',
    );
    expect(recorderSource).toContain('provide: VOICE_TRACE_RECORDER');
    expect(recorderSource).toContain('useExisting: VoiceTraceRecorder');
  });

  it('le chemin vocal reste à l’écart des dépendances d’infrastructure du traçage', () => {
    // Régression constatée le 20/07 : importer l'implémentation depuis backend.service.ts y
    // faisait entrer `@prisma/client`, alourdissait le graphe de modules de tout le chemin
    // agent et déstabilisait pont-serveur. Le port doit rester la seule porte d'entrée.
    const backendSource = readFileSync(resolve(__dirname, 'backend.service.ts'), 'utf8');
    expect(backendSource).toContain("from './voice/voice-trace.port'");
    expect(backendSource).not.toContain("from './voice/voice-trace.recorder'");
    const portSource = readFileSync(resolve(__dirname, 'voice', 'voice-trace.port.ts'), 'utf8');
    const portImports = portSource.match(/^import[\s\S]*?from '(.+)';$/gmu) ?? [];
    expect(portImports).toEqual(["import type { AppError, VoiceTraceErrorFacts } from '@bob/core';"]);
  });

  it('la purge est planifiée par un vrai cron, pas seulement écrite', () => {
    const scheduled = Reflect.getMetadataKeys(VoiceTracePurgeService.prototype.scheduled);
    expect(scheduled.length).toBeGreaterThan(0);
    const purgeSource = readFileSync(
      resolve(__dirname, 'jobs', 'voice-trace-purge.service.ts'),
      'utf8',
    );
    expect(purgeSource).toMatch(/@Cron\(CronExpression\.EVERY_HOUR\)\s*\n\s*scheduled\(\)/u);
  });
});

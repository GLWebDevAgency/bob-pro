import { describe, expect, it, vi } from 'vitest';
import { assertSentryDsnIsEuRegion } from '../config/env';
import {
  CompositeErrorReporter,
  SentryErrorReporter,
  buildSentryOptions,
  createSentryErrorReporter,
  isForbiddenIntegration,
  resolveSentryConfig,
  type SentrySdkLike,
} from './sentry-reporter';
import type { AppLogger } from './logger';
import type { ErrorReporter } from './error-reporter';

const EU_DSN = 'https://abc123def456@o4507000000000000.ingest.de.sentry.io/4507000000000001';

function loggerDouble(): AppLogger & { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  const error = vi.fn();
  return { log, error, warn: vi.fn() } as unknown as AppLogger & {
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function sdkDouble(): SentrySdkLike & {
  init: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
} {
  return { init: vi.fn(), captureException: vi.fn() };
}

const config = {
  dsn: EU_DSN,
  environment: 'production',
  tracesSampleRate: 0,
} as const;

describe('SENTRY_DSN — garde de région UE, fail-closed', () => {
  it('accepte un DSN de la région européenne', () => {
    expect(() => assertSentryDsnIsEuRegion(EU_DSN)).not.toThrow();
  });

  it('REFUSE la région US — région par défaut de Sentry, piège principal', () => {
    expect(() =>
      assertSentryDsnIsEuRegion('https://k@o4507000000000000.ingest.us.sentry.io/1'),
    ).toThrow(/région UE de Sentry/iu);
  });

  it('refuse un hôte d’ingestion historique sans région (donc US)', () => {
    expect(() => assertSentryDsnIsEuRegion('https://k@o123.ingest.sentry.io/1')).toThrow(
      /région UE de Sentry/iu,
    );
  });

  it('refuse un hôte qui imite le suffixe UE', () => {
    expect(() => assertSentryDsnIsEuRegion('https://k@ingest.de.sentry.io.evil.test/1')).toThrow(
      /région UE de Sentry/iu,
    );
  });

  it('refuse un placeholder, du HTTP en clair et un DSN sans clé publique', () => {
    expect(() => assertSentryDsnIsEuRegion('https://[CLE]@o1.ingest.de.sentry.io/1')).toThrow(
      /placeholder/iu,
    );
    expect(() => assertSentryDsnIsEuRegion('http://k@o1.ingest.de.sentry.io/1')).toThrow(/HTTPS/iu);
    expect(() => assertSentryDsnIsEuRegion('https://o1.ingest.de.sentry.io/1')).toThrow(
      /clé publique/iu,
    );
  });
});

describe('Canal Sentry — dormant sans DSN', () => {
  it('resolveSentryConfig renvoie null quand SENTRY_DSN est absent (valeur figée V1)', () => {
    expect(resolveSentryConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveSentryConfig({ SENTRY_DSN: '   ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('createSentryErrorReporter ne charge JAMAIS le SDK sans DSN', () => {
    const loadSdk = vi.fn(() => sdkDouble());
    const logger = loggerDouble();

    expect(createSentryErrorReporter(null, logger, loadSdk)).toBeNull();

    expect(loadSdk).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('déduit l’environnement de CABINET_RELEASE_ENV quand SENTRY_ENVIRONMENT est absent', () => {
    expect(
      resolveSentryConfig({ SENTRY_DSN: EU_DSN, CABINET_RELEASE_ENV: 'staging' } as NodeJS.ProcessEnv)
        ?.environment,
    ).toBe('staging');
  });

  it('un SDK qui explose à l’init n’empêche pas le démarrage', () => {
    const logger = loggerDouble();
    const reporter = createSentryErrorReporter(config, logger, () => {
      throw new Error('module introuvable');
    });

    expect(reporter).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toContain('webhook reste seul actif');
  });
});

describe('Options Sentry — posture RGPD par défaut', () => {
  it('n’envoie aucun PII par défaut et n’échantillonne aucune trace', () => {
    const options = buildSentryOptions(config);

    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.maxBreadcrumbs).toBe(30);
  });

  it('retire à la source les intégrations qui capturent variables locales et requêtes', () => {
    const options = buildSentryOptions(config);
    const filter = options.integrations as (d: readonly { name: string }[]) => { name: string }[];

    const kept = filter([
      { name: 'LocalVariables' },
      { name: 'RequestData' },
      { name: 'Console' },
      { name: 'OnUncaughtException' },
    ]).map((integration) => integration.name);

    expect(kept).toEqual(['OnUncaughtException']);
  });

  it('beforeSend redacte un événement porteur d’un IBAN et d’un e-mail AVANT tout envoi', () => {
    const options = buildSentryOptions(config);
    const beforeSend = options.beforeSend as (event: Record<string, unknown>) => Record<string, unknown>;

    const sent = beforeSend({
      event_id: 'e1',
      exception: {
        values: [
          {
            type: 'DomainError',
            value: 'échec du virement FR76 3000 6000 0112 3456 7890 189 vers marc@client.fr',
            stacktrace: {
              frames: [{ filename: 'pay.ts', vars: { iban: 'FR76 3000 6000 0112 3456 7890 189' } }],
            },
          },
        ],
      },
      request: { data: { iban: 'FR76 3000 6000 0112 3456 7890 189' }, headers: { cookie: 'x' } },
      user: { email: 'marc@client.fr' },
      extra: { montant: '12 480,50 €' },
    });

    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain('FR76');
    expect(serialized).not.toContain('marc@client.fr');
    expect(serialized).not.toContain('12 480,50');
    expect(serialized).toContain('[iban]');
    expect(serialized).toContain('[email]');
    expect(sent).not.toHaveProperty('request');
    expect(sent).not.toHaveProperty('user');
    expect(sent).not.toHaveProperty('extra');
  });

  it('beforeBreadcrumb réduit une miette HTTP à son transport', () => {
    const options = buildSentryOptions(config);
    const beforeBreadcrumb = options.beforeBreadcrumb as (
      breadcrumb: Record<string, unknown>,
    ) => Record<string, unknown> | null;

    const kept = beforeBreadcrumb({
      category: 'http',
      message: 'POST /invoices pour marc@client.fr',
      data: { method: 'POST', status_code: 500, url: 'https://api/x?siret=73282932000074' },
    });

    expect(kept?.data).toEqual({ method: 'POST', status_code: 500 });
    expect(String(kept?.message)).toBe('POST /invoices pour [email]');
  });
});

describe('SentryErrorReporter & composition des canaux', () => {
  it('ne promeut en étiquette que les clés de contexte autorisées', () => {
    const sdk = sdkDouble();
    const error = new RangeError('boom');

    new SentryErrorReporter(sdk).captureException(error, {
      correlationId: 'c-42',
      customerEmail: 'marc@client.fr',
    });

    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      captureContext: { tags: { correlationId: 'c-42' } },
    });
  });

  it('les deux canaux reçoivent l’incident — Sentry n’évince pas le webhook', () => {
    const webhook: ErrorReporter = { captureException: vi.fn() };
    const sentry: ErrorReporter = { captureException: vi.fn() };
    const error = new Error('boom');

    new CompositeErrorReporter([webhook, sentry]).captureException(error, { correlationId: 'c-1' });

    expect(webhook.captureException).toHaveBeenCalledWith(error, { correlationId: 'c-1' });
    expect(sentry.captureException).toHaveBeenCalledWith(error, { correlationId: 'c-1' });
  });

  it('un canal qui lève ne prive pas les autres et ne remonte jamais', () => {
    const cassé: ErrorReporter = {
      captureException: vi.fn(() => {
        throw new Error('canal mort');
      }),
    };
    const sain: ErrorReporter = { captureException: vi.fn() };

    expect(() =>
      new CompositeErrorReporter([cassé, sain]).captureException(new Error('boom'), {}),
    ).not.toThrow();
    expect(sain.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('isForbiddenIntegration — filtre par préfixe (défaut trouvé en émission réelle)', () => {
  it('filtre les variantes réellement chargées par le SDK, pas seulement le nom canonique', () => {
    // Le SDK Node v10 charge « LocalVariablesAsync » : un test d'égalité stricte laissait passer
    // l'intégration qui capture les variables locales de pile (où l'IBAN se trouve littéralement).
    expect(isForbiddenIntegration('LocalVariablesAsync')).toBe(true);
    expect(isForbiddenIntegration('LocalVariables')).toBe(true);
    expect(isForbiddenIntegration('RequestData')).toBe(true);
    expect(isForbiddenIntegration('Console')).toBe(true);
    // Les intégrations utiles au diagnostic restent chargées.
    expect(isForbiddenIntegration('ContextLines')).toBe(false);
    expect(isForbiddenIntegration('LinkedErrors')).toBe(false);
    expect(isForbiddenIntegration('Http')).toBe(false);
  });
});

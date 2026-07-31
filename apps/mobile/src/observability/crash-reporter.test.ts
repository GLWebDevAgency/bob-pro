import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCrashReporterOptions,
  captureCrash,
  initCrashReporter,
  resetCrashReporterForTests,
  resolveCrashReporterConfig,
  type CrashReporterSdkLike,
} from './crash-reporter';

const EU_DSN = 'https://abc123def456@o4507000000000000.ingest.de.sentry.io/4507000000000001';
const US_DSN = 'https://abc123def456@o4507000000000000.ingest.us.sentry.io/4507000000000001';

const IBAN = 'FR76 3000 6000 0112 3456 7890 189';
const EMAIL = 'marc.dupont@client-mercier.fr';

function sdkDouble(): CrashReporterSdkLike & {
  init: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
} {
  return { init: vi.fn(), captureException: vi.fn() };
}

afterEach(() => {
  resetCrashReporterForTests();
  vi.restoreAllMocks();
});

describe('Canal dormant — absence de EXPO_PUBLIC_SENTRY_DSN', () => {
  it('résout null sans DSN : le flag est OPTIONNEL, son absence ne casse rien', () => {
    expect(resolveCrashReporterConfig(undefined)).toBeNull();
    expect(resolveCrashReporterConfig('')).toBeNull();
    expect(resolveCrashReporterConfig('   ')).toBeNull();
  });

  it('n’importe JAMAIS @sentry/react-native sans DSN', async () => {
    const loadSdk = vi.fn(async () => sdkDouble());

    await expect(initCrashReporter(null, loadSdk)).resolves.toBeNull();

    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('captureCrash est un no-op strict tant que le canal est dormant', () => {
    expect(() => captureCrash(new Error('boom'), { screen: 'profil-fiscal' })).not.toThrow();
  });
});

describe('Souveraineté — seule la région UE est admise', () => {
  it('accepte un DSN européen', () => {
    expect(resolveCrashReporterConfig(EU_DSN)?.dsn).toBe(EU_DSN);
  });

  it('refuse un DSN région US sans jamais lever — le canal reste dormant', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveCrashReporterConfig(US_DSN)).toBeNull();

    expect(String(warn.mock.calls[0]?.[0])).toContain('région UE');
  });

  it('refuse un placeholder non remplacé', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveCrashReporterConfig('https://[CLE]@o1.ingest.de.sentry.io/1')).toBeNull();
  });
});

describe('Build de développement — canal dormant (SPEC_SYSTEME_ERREUR §5.3)', () => {
  it('un build __DEV__ reste dormant MÊME avec un DSN UE valide, sans jamais lever', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveCrashReporterConfig(EU_DSN, 'production', true)).toBeNull();

    expect(String(warn.mock.calls[0]?.[0])).toContain('build de développement');
  });

  it('hors dev (défaut des tests node), le même DSN active le canal', () => {
    expect(resolveCrashReporterConfig(EU_DSN, 'production', false)?.dsn).toBe(EU_DSN);
  });
});

describe('Initialisation — jamais une cause de plantage', () => {
  it('initialise le SDK avec les options minimisées quand le DSN est conforme', async () => {
    const sdk = sdkDouble();

    const active = await initCrashReporter(resolveCrashReporterConfig(EU_DSN), async () => sdk);

    expect(active).toBe(sdk);
    const options = sdk.init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.enableAutoPerformanceTracing).toBe(false);
    expect(options.dsn).toBe(EU_DSN);
  });

  it('est idempotent : un second appel ne réinitialise pas le SDK', async () => {
    const sdk = sdkDouble();
    const loadSdk = vi.fn(async () => sdk);
    const config = resolveCrashReporterConfig(EU_DSN);

    await initCrashReporter(config, loadSdk);
    await initCrashReporter(config, loadSdk);

    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it('un SDK indisponible laisse l’application démarrer normalement', async () => {
    await expect(
      initCrashReporter(resolveCrashReporterConfig(EU_DSN), async () => {
        throw new Error('module natif absent');
      }),
    ).resolves.toBeNull();
  });
});

describe('Minimisation — preuve qu’aucune donnée client ne sort', () => {
  it('beforeSend redacte un événement portant IBAN, e-mail et montant', async () => {
    const sdk = sdkDouble();
    await initCrashReporter(resolveCrashReporterConfig(EU_DSN), async () => sdk);
    const options = sdk.init.mock.calls[0]?.[0] as Record<string, unknown>;
    const beforeSend = options.beforeSend as (e: Record<string, unknown>) => Record<string, unknown>;

    const sent = beforeSend({
      event_id: 'e1',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: `impossible d'afficher le profil de ${EMAIL} (IBAN ${IBAN}, CA 84 200,00 €)`,
            stacktrace: {
              frames: [{ filename: 'profil-fiscal.tsx', lineno: 88, vars: { iban: IBAN } }],
            },
          },
        ],
      },
      user: { id: 'u-1', email: EMAIL, ip_address: '81.2.3.4' },
      request: { url: `https://api/fiscal?siret=73282932000074` },
      extra: { transcriptVocal: `déclare 84 200,00 € pour ${EMAIL}` },
      contexts: {
        device: { model: 'Pixel 7', manufacturer: 'Google' },
        state: { fiscalProfile: { iban: IBAN, email: EMAIL } },
      },
    });

    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain('FR76');
    expect(serialized).not.toContain('marc.dupont');
    expect(serialized).not.toContain('84 200,00');
    expect(serialized).not.toContain('73282932000074');
    expect(serialized).not.toContain('transcriptVocal');
    expect(serialized).toContain('[iban]');
    expect(serialized).toContain('[email]');
    expect(serialized).toContain('[montant]');
    // Ce qui RESTE est exactement ce qui rend le plantage terrain diagnosticable.
    expect(sent).not.toHaveProperty('user');
    expect(sent).not.toHaveProperty('request');
    expect(sent).not.toHaveProperty('extra');
    expect((sent.contexts as Record<string, unknown>).device).toEqual({
      model: 'Pixel 7',
      manufacturer: 'Google',
    });
    expect((sent.contexts as Record<string, unknown>).state).toBeUndefined();
    const frame = (
      (sent.exception as { values: Array<Record<string, unknown>> }).values[0]
        ?.stacktrace as { frames: Array<Record<string, unknown>> }
    ).frames[0];
    expect(frame).not.toHaveProperty('vars');
    expect(frame?.filename).toBe('profil-fiscal.tsx');
    expect(frame?.lineno).toBe(88);
  });

  it('ne promeut en étiquette que les clés autorisées', async () => {
    const sdk = sdkDouble();
    await initCrashReporter(resolveCrashReporterConfig(EU_DSN), async () => sdk);
    const error = new Error('boom');

    captureCrash(error, { screen: 'profil-fiscal', customerEmail: EMAIL, iban: IBAN });

    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      captureContext: { tags: { screen: 'profil-fiscal' } },
    });
  });

  it('les options par défaut retirent les intégrations HTTP et console', () => {
    const options = buildCrashReporterOptions({ dsn: EU_DSN, environment: 'production' });
    const filter = options.integrations as (d: readonly { name: string }[]) => { name: string }[];

    const kept = filter([
      { name: 'Http' },
      { name: 'Console' },
      { name: 'Breadcrumbs' },
      { name: 'ReactNativeErrorHandlers' },
    ]).map((integration) => integration.name);

    expect(kept).toEqual(['Breadcrumbs', 'ReactNativeErrorHandlers']);
  });
});

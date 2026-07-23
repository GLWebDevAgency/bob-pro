import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, resolveBobLiveEnv } from './config/env';

/**
 * Verrouillage anti-drift de la MATRICE FLAGS V1 (design_handoff_bob_pro/MATRICE_FLAGS_V1.md).
 *
 * La matrice FIGE les flags de la build V1 publiée ; toute modification exige l'accord
 * Claude + GPT. Cette suite lit le bloc machine-readable de la matrice et vérifie que les
 * défauts résolus par env.ts (environnement V1 minimal, NODE_ENV=production) correspondent
 * aux valeurs figées : changer un défaut dans le code sans amender la matrice — ou
 * inversement — fait échouer la suite.
 */

const MATRIX_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'design_handoff_bob_pro',
  'MATRICE_FLAGS_V1.md',
);
const JSON_START_MARKER = '<!-- FLAGS_V1_JSON_START -->';
const JSON_END_MARKER = '<!-- FLAGS_V1_JSON_END -->';

const FLAG_SCOPES = ['api', 'mobile', 'web', 'ci'] as const;
const FLAG_ENFORCEMENTS = ['default', 'posed'] as const;

interface FrozenFlag {
  readonly name: string;
  readonly v1Value: string | number;
  readonly scope: (typeof FLAG_SCOPES)[number];
  readonly enforcement: (typeof FLAG_ENFORCEMENTS)[number];
}

function readFrozenFlags(): readonly FrozenFlag[] {
  const content = readFileSync(MATRIX_PATH, 'utf8');
  const start = content.indexOf(JSON_START_MARKER);
  const end = content.indexOf(JSON_END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'MATRICE_FLAGS_V1.md doit contenir un bloc délimité par FLAGS_V1_JSON_START/END.',
    );
  }
  const raw = content.slice(start + JSON_START_MARKER.length, end).trim();
  const parsed = JSON.parse(raw) as { flags?: unknown };
  if (!Array.isArray(parsed.flags) || parsed.flags.length === 0) {
    throw new Error('Le bloc machine-readable doit exposer un tableau "flags" non vide.');
  }
  return parsed.flags.map((entry: unknown): FrozenFlag => {
    const candidate = entry as Partial<FrozenFlag>;
    if (
      typeof candidate.name !== 'string' ||
      candidate.name.length === 0 ||
      (typeof candidate.v1Value !== 'string' && typeof candidate.v1Value !== 'number') ||
      !FLAG_SCOPES.includes(candidate.scope as FrozenFlag['scope']) ||
      !FLAG_ENFORCEMENTS.includes(candidate.enforcement as FrozenFlag['enforcement'])
    ) {
      throw new Error(`Entrée de flag invalide dans la matrice : ${JSON.stringify(entry)}.`);
    }
    return candidate as FrozenFlag;
  });
}

const frozenFlags = readFrozenFlags();
const apiFlags = frozenFlags.filter((flag) => flag.scope === 'api');
const defaultApiFlags = apiFlags.filter((flag) => flag.enforcement === 'default');
const posedApiFlags = apiFlags.filter((flag) => flag.enforcement === 'posed');
const mobileFlags = frozenFlags.filter((flag) => flag.scope === 'mobile');

/**
 * Liste verrouillée EN DUR des flags api attendus dans le bloc machine-readable :
 * sans elle, supprimer silencieusement une entrée du bloc (puis changer le défaut
 * dans env.ts) laisserait la suite verte. Toute évolution de cette liste = amender
 * la matrice ET ce test dans le même commit (accord Claude + GPT).
 */
const EXPECTED_API_FLAG_NAMES = [
  'DEMO_MODE',
  'OPENAI_REALTIME_ENABLED',
  'BOB_LIVE_ENABLED',
  'BOB_LIVE_PROVIDER',
  'STT_PROVIDER',
  'CABINET_RELEASE_ENV',
  'BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED',
  'BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED',
  'BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS',
  'BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_BATCH_SIZE',
  'BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_MAX_BATCHES',
  'BOB_LIVE_AUDIT_PROVIDER',
  'BOB_LIVE_GATEWAY_TLS_MODE',
  'MISTRAL_STT_MODEL',
  'MISTRAL_TTS_MODEL',
  'MISTRAL_OCR_MODEL',
  'MISTRAL_OCR_EXTRACT_MODEL',
  'MISTRAL_REALTIME_STT_MODEL',
  'MISTRAL_REALTIME_BASE_URL',
  'MISTRAL_REALTIME_TARGET_DELAY_MS',
  'FISCAL_PUBLICODES_SIMULATIONS_ENABLED',
  'FISCAL_PUBLICODES_MAX_CONCURRENCY',
  'SENTRY_TRACES_SAMPLE_RATE',
  'SUPABASE_STORAGE_BUCKET',
  'SUPABASE_REALTIME_AUDIO_BUCKET',
  'CABINET_INVITATION_WORKER_ENABLED',
  'BREVO_API_BASE_URL',
  'BREVO_SENDER_NAME',
  'VOICE_TRACE_ENABLED',
] as const;

const EXPECTED_MOBILE_FLAG_NAMES = [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_TERMS_URL',
  'EXPO_PUBLIC_PRIVACY_URL',
  'EXPO_PUBLIC_SIGNUP_CONFIRMATION_WEB_URL',
] as const;

/**
 * Variables jamais figées par la matrice mais susceptibles de traîner dans l'environnement
 * du développeur ou du harnais de test : leur présence fausserait la mesure des défauts.
 */
const RESIDUAL_VARIABLES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_SOLO',
  'STRIPE_PRICE_PRO',
  'STRIPE_PRICE_BUSINESS',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_LIVEMODE',
  'PAYMENT_RETURN_BASE_URL',
  'JOB_CABINET_IDS',
  'CABINET_INVITATION_WORKER_USER_ID',
  'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION',
  'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING',
  'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION',
  'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING',
  'BOB_LIVE_SUBJECT_HMAC_SECRET',
  'BOB_LIVE_SUBJECT_HMAC_KEYRING',
  'BOB_LIVE_PROOF_SECRET',
  'BOB_LIVE_USAGE_HMAC_SECRET',
  'BOB_LIVE_CONTROL_ENCRYPTION_SECRET',
  'OPENAI_REALTIME_SAFETY_SECRET',
  'OPENAI_REALTIME_PROOF_SECRET',
  'OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET',
  // Observabilité §B4 : le canal Sentry est DORMANT en V1 (aucun DSN fourni). Un DSN traînant
  // dans l'environnement du développeur activerait la garde de région et fausserait la mesure.
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
] as const;

/**
 * Environnement V1 minimal : uniquement les dépendances exigées au boot par
 * `loadEnv()` en profil live (`env.ts:555-591`) + les flags posés déclarés par la
 * matrice. Valeurs de test non secrètes — seuls les NOMS engagent la production.
 */
function stubV1MinimalProductionEnv(): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL', 'postgresql://bob_app:test-only@db.internal.test:5432/postgres');
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.test');
  vi.stubEnv('SUPABASE_JWKS_URL', 'https://project.supabase.test/auth/v1/.well-known/jwks.json');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-de-test');
  vi.stubEnv('CABINET_INVITATION_TOKEN_ENCRYPTION_KEY', 'k'.repeat(32));
  vi.stubEnv('SIGN_WEB_BASE_URL', 'https://sign.bobpro.test');
  vi.stubEnv('CABINET_INVITATION_WEB_BASE_URL', 'https://cabinet.bobpro.test');
  vi.stubEnv('BREVO_API_KEY', 'brevo-key-de-test');
  vi.stubEnv('BREVO_SENDER_EMAIL', 'no-reply@bobpro.test');
  vi.stubEnv('METRICS_TOKEN', 'm'.repeat(32));
  vi.stubEnv('ERROR_REPORTER_WEBHOOK_URL', 'https://alerting.bobpro.test/webhook');
  vi.stubEnv('MISTRAL_API_KEY', 'mistral-key-de-test');
  for (const flag of posedApiFlags) {
    vi.stubEnv(flag.name, String(flag.v1Value));
  }
  // Les défauts figés se mesurent variable ABSENTE : on neutralise tout résidu
  // (le harnais vitest pose par exemple DEMO_MODE=true pour les suites unitaires).
  for (const flag of defaultApiFlags) {
    vi.stubEnv(flag.name, undefined);
  }
  for (const name of RESIDUAL_VARIABLES) {
    vi.stubEnv(name, undefined);
  }
}

function loadV1Env(): Record<string, unknown> {
  return loadEnv() as unknown as Record<string, unknown>;
}

describe('MATRICE FLAGS V1 — verrouillage anti-drift (scope api)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('expose exactement les flags api attendus — une entrée supprimée du bloc = échec', () => {
    const names = apiFlags.map((flag) => flag.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED_API_FLAG_NAMES].sort());
  });

  it('résout chaque défaut figé à sa valeur V1 (env V1 minimal, NODE_ENV=production)', () => {
    stubV1MinimalProductionEnv();
    const parsed = loadV1Env();
    for (const flag of defaultApiFlags) {
      expect(
        parsed[flag.name],
        `Défaut de ${flag.name} divergent de la matrice V1 — amender env.ts OU la matrice (accord Claude+GPT requis)`,
      ).toEqual(flag.v1Value);
    }
  });

  it('accepte chaque flag posé V1 et le résout tel quel', () => {
    stubV1MinimalProductionEnv();
    const parsed = loadV1Env();
    for (const flag of posedApiFlags) {
      expect(
        parsed[flag.name],
        `Valeur posée de ${flag.name} refusée ou altérée par env.ts — drift avec la matrice V1`,
      ).toEqual(flag.v1Value);
    }
  });

  it('garde liveness actée : la famille BOB_LIVE_MISTRAL_V2_*_ENABLED vaut false par défaut', () => {
    stubV1MinimalProductionEnv();
    const parsed = loadEnv();
    expect(parsed.BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED).toBe('false');
    expect(parsed.BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED).toBe('false');
    const bobLive = resolveBobLiveEnv(parsed);
    expect(bobLive.mistralV2TerminalReplayEnabled).toBe(false);
    expect(bobLive.mistralV2InitialBootstrapEnabled).toBe(false);
    expect(bobLive.enabled).toBe(false);
  });

  it('couplage fatal : le bootstrap v2 sans replay terminal refuse le boot', () => {
    stubV1MinimalProductionEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED', 'true');
    expect(() => loadEnv()).toThrow(
      /bootstrap initial Mistral v2 exige le replay terminal Mistral v2 actif/iu,
    );
  });

  it('couplage fatal : un keyring de persistance v2 résiduel avec replay OFF refuse le boot', () => {
    stubV1MinimalProductionEnv();
    vi.stubEnv(
      'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING',
      JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64url') }),
    );
    expect(() => loadEnv()).toThrow(
      /keyring Mistral v2 ne peut pas être configuré lorsque le replay terminal est désactivé/iu,
    );
  });

  it('couplage fatal : un keyring identité v2 résiduel avec replay OFF refuse le boot', () => {
    stubV1MinimalProductionEnv();
    vi.stubEnv('BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION', '1');
    vi.stubEnv(
      'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING',
      JSON.stringify({ 1: Buffer.alloc(32, 9).toString('base64url') }),
    );
    expect(() => loadEnv()).toThrow(
      /chiffrement identité Mistral v2 ne peut pas être configuré lorsque le replay terminal est désactivé/iu,
    );
  });

  it('canal Sentry DORMANT en V1 : aucun DSN, aucune trace de performance', () => {
    stubV1MinimalProductionEnv();
    const parsed = loadEnv();
    expect(parsed.SENTRY_DSN).toBeUndefined();
    expect(parsed.SENTRY_ENVIRONMENT).toBeUndefined();
    expect(parsed.SENTRY_TRACES_SAMPLE_RATE).toBe(0);
  });

  it('couplage fatal : SENTRY_ENVIRONMENT posé sans DSN refuse le boot', () => {
    stubV1MinimalProductionEnv();
    vi.stubEnv('SENTRY_ENVIRONMENT', 'production');
    expect(() => loadEnv()).toThrow(/SENTRY_ENVIRONMENT ne doit pas être posé sans SENTRY_DSN/iu);
  });

  it('souveraineté fail-closed : un DSN Sentry hors région UE refuse le boot', () => {
    stubV1MinimalProductionEnv();
    vi.stubEnv('SENTRY_DSN', 'https://k@o4507.ingest.us.sentry.io/1');
    expect(() => loadEnv()).toThrow(/région UE de Sentry/iu);
  });

  it("BOB_LIVE_ENABLED='false' posé ferme le chemin d'activation legacy OPENAI_REALTIME_ENABLED", () => {
    stubV1MinimalProductionEnv();
    vi.stubEnv('OPENAI_REALTIME_ENABLED', 'true');
    // Le flag canonique posé à 'false' (matrice V1) prime sur l'alias legacy résiduel.
    const bobLive = resolveBobLiveEnv(loadEnv());
    expect(bobLive.enabled).toBe(false);
  });

  it("sans le flag canonique posé, un OPENAI_REALTIME_ENABLED='true' résiduel refuse le boot faute de secrets", () => {
    stubV1MinimalProductionEnv();
    vi.stubEnv('BOB_LIVE_ENABLED', undefined);
    vi.stubEnv('OPENAI_REALTIME_ENABLED', 'true');
    expect(() => loadEnv()).toThrow(/Bob Live activé mais configuration incomplète/iu);
  });
});

describe('MATRICE FLAGS V1 — verrouillage anti-drift (scope mobile, eas.json)', () => {
  const easPath = resolve(__dirname, '..', '..', 'mobile', 'eas.json');
  const eas = JSON.parse(readFileSync(easPath, 'utf8')) as {
    build?: Record<string, { env?: Record<string, string> }>;
  };

  it('expose exactement les flags mobile attendus dans le bloc machine-readable', () => {
    const names = mobileFlags.map((flag) => flag.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED_MOBILE_FLAG_NAMES].sort());
  });

  it.each(['preview', 'production'])(
    'le profil %s de eas.json porte chaque valeur mobile figée par la matrice',
    (profile) => {
      const env = eas.build?.[profile]?.env;
      expect(env, `profil ${profile} sans bloc env dans eas.json`).toBeDefined();
      for (const flag of mobileFlags) {
        expect(
          env?.[flag.name],
          `${flag.name} divergent de la matrice V1 dans le profil ${profile} — amender eas.json OU la matrice (accord Claude+GPT requis)`,
        ).toBe(String(flag.v1Value));
      }
    },
  );
});

describe('MATRICE FLAGS V1 — verrouillage anti-drift (scope ci)', () => {
  it('MUSTANG_VERSION de ci.yml égale la valeur figée par la matrice', () => {
    const mustang = frozenFlags.find((flag) => flag.name === 'MUSTANG_VERSION');
    expect(mustang, 'MUSTANG_VERSION absent du bloc machine-readable').toBeDefined();
    const ciPath = resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml');
    const ci = readFileSync(ciPath, 'utf8');
    const match = ci.match(/^\s*MUSTANG_VERSION:\s*(["'])([^"']+)\1\s*$/mu);
    expect(match?.[2], 'MUSTANG_VERSION introuvable dans ci.yml').toBe(String(mustang?.v1Value));
  });

  // RUN_RLS_CERT / RLS_CERT_CLEANUP sont des variables de service Railway et le scope web
  // vit sur Vercel : invérifiables depuis le repo — contrôle humain (matrice, « À confirmer #2 »).
});

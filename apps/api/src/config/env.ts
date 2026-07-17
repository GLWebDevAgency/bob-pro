import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  // Le serveur normal est live. La démo n'existe que sur opt-in explicite (`DEMO_MODE=true`).
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  ANTHROPIC_API_KEY: z.string().optional(),
  GLM_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Contrat fournisseur-neutre Bob Live. Les OPENAI_REALTIME_* restent des alias de
  // transition pour les déploiements déjà configurés, mais un nouveau déploiement doit
  // utiliser BOB_LIVE_* afin de pouvoir sélectionner Mistral sans clé OpenAI.
  BOB_LIVE_ENABLED: z.enum(['true', 'false']).optional(),
  BOB_LIVE_PROVIDER: z.enum(['openai', 'mistral']).default('openai'),
  BOB_LIVE_SUBJECT_HMAC_SECRET: z.string().trim().min(32).optional(),
  BOB_LIVE_SUBJECT_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
  BOB_LIVE_PROOF_SECRET: z.string().trim().min(32).optional(),
  BOB_LIVE_PROOF_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  BOB_LIVE_USAGE_HMAC_SECRET: z.string().trim().min(32).optional(),
  BOB_LIVE_USAGE_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  BOB_LIVE_CONTROL_ENCRYPTION_SECRET: z.string().trim().min(32).optional(),
  BOB_LIVE_CONTROL_ENCRYPTION_KEY_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .optional(),
  BOB_LIVE_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(10_000).optional(),
  BOB_LIVE_CONTROL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(5_000).optional(),
  BOB_LIVE_MAX_SESSION_SECONDS: z.coerce.number().int().min(60).max(900).optional(),
  BOB_LIVE_MAX_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(20).optional(),
  BOB_LIVE_MAX_CALLS_PER_HOUR: z.coerce.number().int().min(1).max(500).optional(),
  BOB_LIVE_MAX_TENANT_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(5_000).optional(),
  BOB_LIVE_MAX_TENANT_CALLS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).optional(),
  BOB_LIVE_RESERVATION_TTL_SECONDS: z.coerce.number().int().min(10).max(30).optional(),
  BOB_LIVE_ACTIVE_LEASE_SECONDS: z.coerce.number().int().min(20).max(120).optional(),
  BOB_LIVE_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(60).optional(),
  BOB_LIVE_REAPER_LEASE_SECONDS: z.coerce.number().int().min(15).max(120).optional(),
  BOB_LIVE_GATEWAY_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10_000).default(500),
  BOB_LIVE_GATEWAY_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(25).max(10_000).default(1_500),
  BOB_LIVE_GATEWAY_TLS_MODE: z.enum(['direct', 'trusted-proxy']).default('direct'),
  // L'auditeur acoustique doit rester hors du domaine du TTS actif. Le mode OpenAI est
  // conservé au parseur pour détecter explicitement les anciennes configs et les refuser.
  BOB_LIVE_AUDIT_PROVIDER: z.enum(['openai', 'local-whisper']).default('local-whisper'),
  BOB_LIVE_LOCAL_AUDIT_BASE_URL: z.string().url().optional(),
  BOB_LIVE_LOCAL_AUDIT_TOKEN: z.string().trim().min(32).optional(),
  OPENAI_REALTIME_ENABLED: z.enum(['true', 'false']).default('false'),
  OPENAI_REALTIME_MODEL: z.string().trim().min(1).max(100).default('gpt-realtime-2.1'),
  OPENAI_REALTIME_VOICE: z.enum(['marin', 'cedar']).default('marin'),
  OPENAI_TTS_MODEL: z.string().trim().min(1).max(100).default('gpt-4o-mini-tts-2025-12-15'),
  OPENAI_REALTIME_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_REALTIME_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(6_000).default(4_000),
  OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(5_000).default(3_000),
  OPENAI_REALTIME_MAX_SESSION_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
  OPENAI_REALTIME_SAFETY_SECRET: z.string().min(32).optional(),
  OPENAI_REALTIME_PROOF_SECRET: z.string().min(32).optional(),
  OPENAI_REALTIME_PROOF_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
  OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET: z.string().min(32).optional(),
  OPENAI_REALTIME_CONTROL_ENCRYPTION_KEY_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .default(1),
  OPENAI_REALTIME_MAX_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(20).default(3),
  OPENAI_REALTIME_MAX_CALLS_PER_HOUR: z.coerce.number().int().min(1).max(500).default(30),
  OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(5_000)
    .default(50),
  OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(1_000),
  OPENAI_REALTIME_RESERVATION_TTL_SECONDS: z.coerce.number().int().min(10).max(30).default(15),
  OPENAI_REALTIME_ACTIVE_LEASE_SECONDS: z.coerce.number().int().min(20).max(120).default(30),
  OPENAI_REALTIME_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(60).default(10),
  OPENAI_REALTIME_REAPER_LEASE_SECONDS: z.coerce.number().int().min(15).max(120).default(30),
  MISTRAL_API_KEY: z.string().optional(),
  AI_ROUTER_DEFAULT: z.enum(['claude', 'glm']).default('claude'),
  CORS_ORIGINS: z.string().optional(),
  STT_PROVIDER: z.enum(['mistral', 'openai']).optional(),
  MISTRAL_STT_MODEL: z.string().default('voxtral-mini-latest'),
  MISTRAL_STT_CONTEXT_BIAS: z.string().optional(),
  MISTRAL_REALTIME_STT_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default('voxtral-mini-transcribe-realtime-2602'),
  MISTRAL_REALTIME_BASE_URL: z.string().url().default('wss://api.mistral.ai'),
  BOB_LIVE_MISTRAL_WEBSOCKET_URL: z
    .string()
    .url()
    .default('ws://127.0.0.1:3000/v1/voice/realtime/mistral'),
  MISTRAL_REALTIME_TARGET_DELAY_MS: z.coerce.number().int().min(100).max(5_000).default(240),
  MISTRAL_TTS_MODEL: z.string().default('voxtral-mini-tts-2603'),
  MISTRAL_TTS_VOICE_ID: z.string().optional(),
  // OCR (A2-C14) : modèle OCR DÉDIÉ Mistral (≠ Voxtral/chat) + petit modèle d'extraction structurée.
  MISTRAL_OCR_MODEL: z.string().default('mistral-ocr-latest'),
  MISTRAL_OCR_EXTRACT_MODEL: z.string().default('mistral-small-latest'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PRICE_SOLO: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  PAYMENT_RETURN_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('bob-documents'),
  SUPABASE_REALTIME_AUDIO_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .default('bob-live-audio'),
  JOB_COMPANY_IDS: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  BREVO_API_BASE_URL: z.string().url().default('https://api.brevo.com/v3'),
  BREVO_SENDER_EMAIL: z.string().email().optional(),
  BREVO_SENDER_NAME: z.string().default('Bob Pro'),
  SIGN_WEB_BASE_URL: z.string().url().default('https://demo.bobpro.fr'),
  METRICS_TOKEN: z.string().min(32).optional(),
  CABINET_RELEASE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  CABINET_INVITATION_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  CABINET_INVITATION_TOKEN_KEY_VERSION: z.coerce.number().int().positive().default(1),
  CABINET_INVITATION_WEB_BASE_URL: z.string().url().default('https://demo.bobpro.fr/cabinet'),
  CABINET_INVITATION_WORKER_ENABLED: z.enum(['true', 'false']).default('false'),
  JOB_CABINET_IDS: z.string().optional(),
  CABINET_INVITATION_WORKER_USER_ID: z.string().uuid().optional(),
  ERROR_REPORTER_WEBHOOK_URL: z.string().url().optional(),
  // BOB EXPERT FISCAL — service d'évaluation Publicodes serveur (SPIKE_PUBLICODES_20260715.md).
  // Shadow par défaut ('false') : le moteur Publicodes/modele-social embarque des trous de
  // couverture documentés (activités mixtes, PLR réglementées, non-résidents) et le format de
  // réponse (§V2 co-challenge GPT) attend encore le cadrage UX — pas d'exposition prod tant que
  // ce flag n'est pas explicitement activé.
  FISCAL_PUBLICODES_SIMULATIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  // Borne le nombre d'évaluations Publicodes exécutées "en vol" simultanément (chaque évaluation
  // est synchrone/mono-thread : ~5 ms pour le cas micro, ~40 ms mesurés pour l'inversion
  // numérique SASU — cf. publicodes-evaluation.service.ts). Ne parallélise rien (Node reste
  // mono-thread) : évite qu'une rafale de requêtes ne monopolise la boucle d'événements en continu
  // (dont /voice/realtime, sur le même process).
  FISCAL_PUBLICODES_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

export type Env = z.infer<typeof schema>;

export type BobLiveProviderId = 'openai' | 'mistral';
export type BobLiveAuditProviderId = 'openai' | 'local-whisper';

/**
 * Vue canonique de la configuration Bob Live. Les alias historiques ne sortent jamais de cette
 * frontière : le reste du runtime ne doit plus raisonner en termes de variables OPENAI_* pour
 * les quotas, les baux ou les secrets qui appartiennent à Bob.
 */
export interface ResolvedBobLiveEnv {
  enabled: boolean;
  provider: BobLiveProviderId;
  providerModel: string;
  providerBaseUrl: string;
  providerTimeoutMs: number;
  controlTimeoutMs: number;
  maxSessionSeconds: number;
  subjectHmacSecret: string | null;
  subjectKeyVersion: number;
  proofSecret: string | null;
  proofKeyVersion: number;
  usageHmacSecret: string | null;
  usageKeyVersion: number;
  controlEncryptionSecret: string | null;
  controlEncryptionKeyVersion: number;
  maxCallsPerMinute: number;
  maxCallsPerHour: number;
  maxTenantCallsPerMinute: number;
  maxTenantCallsPerHour: number;
  reservationTtlSeconds: number;
  activeLeaseSeconds: number;
  heartbeatSeconds: number;
  reaperLeaseSeconds: number;
  gatewayMaxConnections: number;
  gatewayShutdownGraceMs: number;
  gatewayTlsMode: 'direct' | 'trusted-proxy';
  auditProvider: BobLiveAuditProviderId;
  localAuditBaseUrl: string | null;
  localAuditToken: string | null;
  mistralTargetDelayMs: number;
  mistralWebsocketUrl: string;
}

export function resolveBobLiveEnv(env: Env): ResolvedBobLiveEnv {
  const provider = env.BOB_LIVE_PROVIDER;
  const proofSecret = env.BOB_LIVE_PROOF_SECRET ?? env.OPENAI_REALTIME_PROOF_SECRET ?? null;
  const proofKeyVersion = env.BOB_LIVE_PROOF_KEY_VERSION ?? env.OPENAI_REALTIME_PROOF_KEY_VERSION;
  return {
    enabled: (env.BOB_LIVE_ENABLED ?? env.OPENAI_REALTIME_ENABLED) === 'true',
    provider,
    providerModel:
      provider === 'mistral' ? env.MISTRAL_REALTIME_STT_MODEL : env.OPENAI_REALTIME_MODEL,
    providerBaseUrl:
      provider === 'mistral'
        ? env.MISTRAL_REALTIME_BASE_URL.replace(/\/$/u, '')
        : env.OPENAI_REALTIME_BASE_URL.replace(/\/$/u, ''),
    providerTimeoutMs: env.BOB_LIVE_PROVIDER_TIMEOUT_MS ?? env.OPENAI_REALTIME_PROVIDER_TIMEOUT_MS,
    controlTimeoutMs: env.BOB_LIVE_CONTROL_TIMEOUT_MS ?? env.OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS,
    maxSessionSeconds: env.BOB_LIVE_MAX_SESSION_SECONDS ?? env.OPENAI_REALTIME_MAX_SESSION_SECONDS,
    subjectHmacSecret:
      env.BOB_LIVE_SUBJECT_HMAC_SECRET ?? env.OPENAI_REALTIME_SAFETY_SECRET ?? null,
    subjectKeyVersion: env.BOB_LIVE_SUBJECT_KEY_VERSION,
    proofSecret,
    proofKeyVersion,
    // Compatibilité des anciens déploiements OpenAI. Toute configuration BOB_LIVE_* explicite
    // exige ci-dessous une clé usage dédiée afin qu'une rotation de preuve audio ne casse pas les retries.
    usageHmacSecret: env.BOB_LIVE_USAGE_HMAC_SECRET ?? proofSecret,
    usageKeyVersion: env.BOB_LIVE_USAGE_KEY_VERSION ?? proofKeyVersion,
    controlEncryptionSecret:
      env.BOB_LIVE_CONTROL_ENCRYPTION_SECRET ??
      env.OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET ??
      null,
    controlEncryptionKeyVersion:
      env.BOB_LIVE_CONTROL_ENCRYPTION_KEY_VERSION ??
      env.OPENAI_REALTIME_CONTROL_ENCRYPTION_KEY_VERSION,
    maxCallsPerMinute:
      env.BOB_LIVE_MAX_CALLS_PER_MINUTE ?? env.OPENAI_REALTIME_MAX_CALLS_PER_MINUTE,
    maxCallsPerHour: env.BOB_LIVE_MAX_CALLS_PER_HOUR ?? env.OPENAI_REALTIME_MAX_CALLS_PER_HOUR,
    maxTenantCallsPerMinute:
      env.BOB_LIVE_MAX_TENANT_CALLS_PER_MINUTE ?? env.OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE,
    maxTenantCallsPerHour:
      env.BOB_LIVE_MAX_TENANT_CALLS_PER_HOUR ?? env.OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR,
    reservationTtlSeconds:
      env.BOB_LIVE_RESERVATION_TTL_SECONDS ?? env.OPENAI_REALTIME_RESERVATION_TTL_SECONDS,
    activeLeaseSeconds:
      env.BOB_LIVE_ACTIVE_LEASE_SECONDS ?? env.OPENAI_REALTIME_ACTIVE_LEASE_SECONDS,
    heartbeatSeconds: env.BOB_LIVE_HEARTBEAT_SECONDS ?? env.OPENAI_REALTIME_HEARTBEAT_SECONDS,
    reaperLeaseSeconds:
      env.BOB_LIVE_REAPER_LEASE_SECONDS ?? env.OPENAI_REALTIME_REAPER_LEASE_SECONDS,
    gatewayMaxConnections: env.BOB_LIVE_GATEWAY_MAX_CONNECTIONS,
    gatewayShutdownGraceMs: env.BOB_LIVE_GATEWAY_SHUTDOWN_GRACE_MS,
    gatewayTlsMode: env.BOB_LIVE_GATEWAY_TLS_MODE,
    auditProvider: env.BOB_LIVE_AUDIT_PROVIDER,
    localAuditBaseUrl: env.BOB_LIVE_LOCAL_AUDIT_BASE_URL?.replace(/\/$/u, '') ?? null,
    localAuditToken: env.BOB_LIVE_LOCAL_AUDIT_TOKEN ?? null,
    mistralTargetDelayMs: env.MISTRAL_REALTIME_TARGET_DELAY_MS,
    mistralWebsocketUrl: env.BOB_LIVE_MISTRAL_WEBSOCKET_URL,
  };
}

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Variables d'environnement invalides : ${parsed.error.toString()}`);
  }
  // Garde-fou : en production, le mode démo (auth pass-through) exposerait des endpoints sans token
  // et consommerait des ressources externes (API publiques) de façon anonyme. On refuse de démarrer.
  if (process.env.NODE_ENV === 'production' && parsed.data.DEMO_MODE !== 'false') {
    throw new Error(
      "Refus de démarrer : en production, DEMO_MODE doit valoir 'false' (l'auth pass-through démo désactive la sécurité).",
    );
  }
  if (parsed.data.DEMO_MODE === 'false') {
    const required: Array<keyof Env> = [
      'DATABASE_URL',
      'SUPABASE_JWKS_URL',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'CABINET_INVITATION_TOKEN_ENCRYPTION_KEY',
      'BREVO_API_KEY',
      'BREVO_SENDER_EMAIL',
      'METRICS_TOKEN',
      'ERROR_REPORTER_WEBHOOK_URL',
    ];
    const missing = required.filter((key) => !parsed.data[key]);
    if (missing.length > 0) {
      throw new Error(`Configuration live incomplète : ${missing.join(', ')}.`);
    }
    const llmConfigured = Boolean(
      parsed.data.ANTHROPIC_API_KEY ||
      parsed.data.GLM_API_KEY ||
      parsed.data.DEEPSEEK_API_KEY ||
      parsed.data.MISTRAL_API_KEY ||
      parsed.data.OPENAI_API_KEY,
    );
    if (!llmConfigured) {
      throw new Error(
        'Configuration live incomplète : au moins un fournisseur LLM est requis ' +
          '(ANTHROPIC_API_KEY, GLM_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY ou OPENAI_API_KEY).',
      );
    }
    if (!parsed.data.MISTRAL_API_KEY && !parsed.data.ANTHROPIC_API_KEY) {
      throw new Error(
        'Configuration live incomplète : OCR indisponible ' +
          '(MISTRAL_API_KEY ou ANTHROPIC_API_KEY requis).',
      );
    }
    const paymentRequired: Array<keyof Env> = [
      'STRIPE_SECRET_KEY',
      'STRIPE_PRICE_SOLO',
      'STRIPE_PRICE_PRO',
      'STRIPE_PRICE_BUSINESS',
      'PAYMENT_RETURN_BASE_URL',
    ];
    const missingPayment = paymentRequired.filter((key) => !parsed.data[key]);
    if (missingPayment.length > 0) {
      throw new Error(`Configuration paiement live incomplète : ${missingPayment.join(', ')}.`);
    }
    const paymentReturnUrl = new URL(parsed.data.PAYMENT_RETURN_BASE_URL as string);
    if (
      paymentReturnUrl.protocol !== 'https:' ||
      paymentReturnUrl.hostname === 'localhost' ||
      paymentReturnUrl.hostname === '127.0.0.1' ||
      paymentReturnUrl.hostname === 'demo.bobpro.fr'
    ) {
      throw new Error(
        'PAYMENT_RETURN_BASE_URL doit être une origine HTTPS live, non locale et non démo.',
      );
    }
    for (const [name, raw] of [
      ['SIGN_WEB_BASE_URL', parsed.data.SIGN_WEB_BASE_URL],
      ['CABINET_INVITATION_WEB_BASE_URL', parsed.data.CABINET_INVITATION_WEB_BASE_URL],
    ] as const) {
      const url = new URL(raw);
      if (
        url.protocol !== 'https:' ||
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === 'demo.bobpro.fr'
      ) {
        throw new Error(`${name} doit être une URL HTTPS live, non locale et non démo.`);
      }
    }
    const hasCabinetIds = Boolean(parsed.data.JOB_CABINET_IDS);
    const hasWorker = Boolean(parsed.data.CABINET_INVITATION_WORKER_USER_ID);
    const workerEnabled = parsed.data.CABINET_INVITATION_WORKER_ENABLED === 'true';
    if (workerEnabled && (!hasCabinetIds || !hasWorker)) {
      throw new Error(
        'Le worker Cabinet activé exige JOB_CABINET_IDS et CABINET_INVITATION_WORKER_USER_ID.',
      );
    }
    if (!workerEnabled && (hasCabinetIds || hasWorker)) {
      throw new Error(
        'Le worker Cabinet désactivé ne doit pas conserver de liste ou identité active.',
      );
    }
    if (parsed.data.JOB_CABINET_IDS) parseJobCabinetIds(parsed.data.JOB_CABINET_IDS);
    for (const [name, secret] of [
      [
        'CABINET_INVITATION_TOKEN_ENCRYPTION_KEY',
        parsed.data.CABINET_INVITATION_TOKEN_ENCRYPTION_KEY,
      ],
      ['METRICS_TOKEN', parsed.data.METRICS_TOKEN],
    ] as const) {
      if (secret?.includes('[') || secret?.includes(']'))
        throw new Error(`${name} contient un placeholder.`);
    }
    const invitationUrl = new URL(parsed.data.CABINET_INVITATION_WEB_BASE_URL);
    if (invitationUrl.protocol !== 'https:' && invitationUrl.hostname !== 'localhost') {
      throw new Error('CABINET_INVITATION_WEB_BASE_URL doit utiliser HTTPS hors localhost.');
    }
  }
  if (process.env.NODE_ENV === 'production' && parsed.data.CABINET_RELEASE_ENV === 'development') {
    throw new Error(
      "CABINET_RELEASE_ENV doit valoir 'staging' ou 'production' lorsque NODE_ENV=production.",
    );
  }
  const bobLive = resolveBobLiveEnv(parsed.data);
  if (bobLive.enabled) {
    const explicitProviderNeutralConfig = parsed.data.BOB_LIVE_ENABLED !== undefined;
    const providerKeyName = bobLive.provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY';
    const providerKey =
      bobLive.provider === 'mistral' ? parsed.data.MISTRAL_API_KEY : parsed.data.OPENAI_API_KEY;
    const missing = [
      !providerKey ? providerKeyName : null,
      !bobLive.subjectHmacSecret ? 'BOB_LIVE_SUBJECT_HMAC_SECRET' : null,
      !bobLive.proofSecret ? 'BOB_LIVE_PROOF_SECRET' : null,
      explicitProviderNeutralConfig && !parsed.data.BOB_LIVE_USAGE_HMAC_SECRET
        ? 'BOB_LIVE_USAGE_HMAC_SECRET'
        : null,
      !bobLive.controlEncryptionSecret ? 'BOB_LIVE_CONTROL_ENCRYPTION_SECRET' : null,
      bobLive.auditProvider === 'local-whisper' && !bobLive.localAuditBaseUrl
        ? 'BOB_LIVE_LOCAL_AUDIT_BASE_URL'
        : null,
      bobLive.auditProvider === 'local-whisper' && !bobLive.localAuditToken
        ? 'BOB_LIVE_LOCAL_AUDIT_TOKEN'
        : null,
    ].filter((value): value is string => value !== null);
    if (missing.length > 0) {
      throw new Error(`Bob Live activé mais configuration incomplète : ${missing.join(', ')}.`);
    }
    if (bobLive.auditProvider !== 'local-whisper') {
      throw new Error(
        'BOB_LIVE_AUDIT_PROVIDER doit valoir local-whisper : le TTS ne peut pas être audité ' +
          'par le même domaine fournisseur.',
      );
    }
    for (const [name, secret] of [
      ['BOB_LIVE_SUBJECT_HMAC_SECRET', bobLive.subjectHmacSecret],
      ['BOB_LIVE_PROOF_SECRET', bobLive.proofSecret],
      ['BOB_LIVE_USAGE_HMAC_SECRET', parsed.data.BOB_LIVE_USAGE_HMAC_SECRET ?? null],
      ['BOB_LIVE_CONTROL_ENCRYPTION_SECRET', bobLive.controlEncryptionSecret],
      ['BOB_LIVE_LOCAL_AUDIT_TOKEN', bobLive.localAuditToken],
    ] as const) {
      if (secret?.includes('[') || secret?.includes(']')) {
        throw new Error(`${name} contient un placeholder.`);
      }
    }
    const dedicatedSecrets = [
      bobLive.subjectHmacSecret,
      bobLive.proofSecret,
      bobLive.controlEncryptionSecret,
      ...(parsed.data.BOB_LIVE_USAGE_HMAC_SECRET ? [parsed.data.BOB_LIVE_USAGE_HMAC_SECRET] : []),
      ...(bobLive.localAuditToken ? [bobLive.localAuditToken] : []),
    ];
    if (new Set(dedicatedSecrets).size !== dedicatedSecrets.length) {
      throw new Error(
        'Chaque clé Bob Live (identité, preuve, contrôle et audit) doit être dédiée.',
      );
    }
    if (parsed.data.SUPABASE_REALTIME_AUDIO_BUCKET === parsed.data.SUPABASE_STORAGE_BUCKET) {
      throw new Error('Le bucket audio Bob Live doit être distinct du bucket documentaire.');
    }
    const realtimeUrl = new URL(bobLive.providerBaseUrl);
    const expectedProtocol = bobLive.provider === 'mistral' ? 'wss:' : 'https:';
    if (realtimeUrl.protocol !== expectedProtocol) {
      throw new Error(
        `${bobLive.provider === 'mistral' ? 'MISTRAL_REALTIME_BASE_URL' : 'OPENAI_REALTIME_BASE_URL'} ` +
          `doit utiliser ${expectedProtocol === 'wss:' ? 'WSS' : 'HTTPS'}.`,
      );
    }
    const expectedHostname = bobLive.provider === 'mistral' ? 'api.mistral.ai' : 'api.openai.com';
    if (process.env.NODE_ENV === 'production' && realtimeUrl.hostname !== expectedHostname) {
      throw new Error(
        `L’URL Bob Live ${bobLive.provider} doit cibler ${expectedHostname} en production.`,
      );
    }
    if (bobLive.provider === 'mistral') {
      const gatewayUrl = new URL(bobLive.mistralWebsocketUrl);
      const loopback = gatewayUrl.hostname === 'localhost' || gatewayUrl.hostname === '127.0.0.1';
      if (
        (gatewayUrl.protocol !== 'wss:' && !(gatewayUrl.protocol === 'ws:' && loopback)) ||
        gatewayUrl.username !== '' ||
        gatewayUrl.password !== '' ||
        gatewayUrl.search !== '' ||
        gatewayUrl.hash !== '' ||
        gatewayUrl.pathname !== '/v1/voice/realtime/mistral'
      ) {
        throw new Error(
          'BOB_LIVE_MISTRAL_WEBSOCKET_URL doit être une URL WSS canonique du gateway Bob.',
        );
      }
      if (process.env.NODE_ENV === 'production' && gatewayUrl.protocol !== 'wss:') {
        throw new Error('BOB_LIVE_MISTRAL_WEBSOCKET_URL doit utiliser WSS en production.');
      }
    }
    if (bobLive.localAuditBaseUrl) {
      const auditUrl = new URL(bobLive.localAuditBaseUrl);
      const loopback =
        auditUrl.hostname === 'localhost' ||
        auditUrl.hostname === '127.0.0.1' ||
        auditUrl.hostname === '[::1]';
      if (!loopback || (auditUrl.protocol !== 'http:' && auditUrl.protocol !== 'https:')) {
        throw new Error(
          'BOB_LIVE_LOCAL_AUDIT_BASE_URL doit cibler exclusivement le sidecar loopback local.',
        );
      }
    }
    if (bobLive.providerTimeoutMs + bobLive.controlTimeoutMs > 8_500) {
      throw new Error(
        'Le budget bootstrap Bob Live serveur doit rester inférieur ou égal à 8500 ms.',
      );
    }
    const bootstrapBudgetMs = bobLive.providerTimeoutMs + bobLive.controlTimeoutMs;
    if (bobLive.reservationTtlSeconds * 1_000 < bootstrapBudgetMs + 1_000) {
      throw new Error(
        'Le bail de réservation Bob Live doit dépasser le budget bootstrap d’au moins une seconde.',
      );
    }
    if (bobLive.maxCallsPerHour < bobLive.maxCallsPerMinute) {
      throw new Error(
        'Le quota Bob Live utilisateur horaire doit être supérieur ou égal au quota minute.',
      );
    }
    if (
      bobLive.maxTenantCallsPerMinute < bobLive.maxCallsPerMinute ||
      bobLive.maxTenantCallsPerHour < bobLive.maxCallsPerHour ||
      bobLive.maxTenantCallsPerHour < bobLive.maxTenantCallsPerMinute
    ) {
      throw new Error(
        'Les quotas Bob Live tenant doivent couvrir les quotas utilisateur correspondants.',
      );
    }
    if (bobLive.heartbeatSeconds >= bobLive.activeLeaseSeconds) {
      throw new Error('Le heartbeat Bob Live doit être plus court que le bail actif.');
    }
    if (bobLive.activeLeaseSeconds > bobLive.maxSessionSeconds) {
      throw new Error('Le bail actif Bob Live ne peut pas dépasser la durée maximale de session.');
    }
  }
  return parsed.data;
}

export const hasClaudeKey = (): boolean => !!process.env.ANTHROPIC_API_KEY;
export const hasGlmKey = (): boolean => !!process.env.GLM_API_KEY;
export const hasDeepseekKey = (): boolean => !!process.env.DEEPSEEK_API_KEY;
export const hasMistralKey = (): boolean => !!process.env.MISTRAL_API_KEY;
export const hasOpenaiKey = (): boolean => !!process.env.OPENAI_API_KEY;
export const isDemoMode = (): boolean => process.env.DEMO_MODE === 'true';
export const isFiscalPublicodesSimulationsEnabled = (): boolean =>
  process.env.FISCAL_PUBLICODES_SIMULATIONS_ENABLED === 'true';
export const fiscalPublicodesMaxConcurrency = (): number => {
  const raw = Number(process.env.FISCAL_PUBLICODES_MAX_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 && raw <= 32 ? raw : 4;
};

export function jobCompanyIds(): string[] {
  const raw = process.env.JOB_COMPANY_IDS;
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

export function jobCabinetIds(): string[] {
  if (process.env.CABINET_INVITATION_WORKER_ENABLED !== 'true') return [];
  return parseJobCabinetIds(process.env.JOB_CABINET_IDS);
}

export function parseJobCabinetIds(raw?: string): string[] {
  if (!raw) return [];
  const ids = [
    ...new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.some((id) => !/^[A-Za-z0-9-]{1,64}$/.test(id))) {
    throw new Error('JOB_CABINET_IDS contient un identifiant invalide.');
  }
  if (ids.length > 100)
    throw new Error('JOB_CABINET_IDS est limité à 100 cabinets pilotes distincts.');
  return ids;
}

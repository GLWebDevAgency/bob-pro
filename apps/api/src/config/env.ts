import { z } from 'zod';
import { sentryDsnRejectionReason } from '@bob/core';

const MISTRAL_V2_VERSIONED_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const MISTRAL_V2_MAX_VERSIONED_KEYS = 8;
const BOB_LIVE_SUBJECT_MAX_VERSIONED_KEYS = 32;
const BOB_LIVE_PROOF_MAX_VERSIONED_KEYS = 2;

/**
 * Verrou de compilation du downlink OpenAI natif.
 *
 * La valeur ne passe a `true` qu'apres livraison du sendrecv, du barge-in local et de la
 * certification device. Une variable d'environnement ne peut donc pas activer un chemin
 * acoustique incomplet par erreur.
 */
export const OPENAI_NATIVE_WEBRTC_RUNTIME_READY = false;

/** Normalisation commune aux parseurs et aux composition roots qui lisent encore process.env. */
export function normalizeOptionalEnvironmentString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

const emptyStringAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' ? normalizeOptionalEnvironmentString(value) : value;

const optionalStripeString = z.preprocess(
  emptyStringAsUndefined,
  z.string().trim().min(1).optional(),
);
const optionalStripeWebhookSecret = z.preprocess(
  emptyStringAsUndefined,
  z.string().trim().startsWith('whsec_').optional(),
);
const optionalStripeLiveMode = z.preprocess(
  emptyStringAsUndefined,
  z.enum(['true', 'false']).optional(),
);
const optionalStripeReturnUrl = z.preprocess(
  emptyStringAsUndefined,
  z.string().url().optional(),
);

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  // Relâche uniquement les dépendances externes obligatoires dans certains tests de composition.
  // Ce flag ne peut désactiver ni JWT/RLS, ni fournir de données synthétiques au runtime.
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  ANTHROPIC_API_KEY: z.string().optional(),
  GLM_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Contrat fournisseur-neutre Bob Live. Les OPENAI_REALTIME_* restent des alias de
  // transition pour les déploiements déjà configurés, mais un nouveau déploiement doit
  // utiliser BOB_LIVE_* afin de pouvoir sélectionner Mistral sans clé OpenAI.
  // FUTUR DASHBOARD ADMIN (décision fondateur 25/07/2026) : la bascule GPT Realtime ↔
  // Voxtral tour-par-tour est une configuration d'ADMINISTRATION — jamais un sélecteur
  // utilisateur. BOB_LIVE_ENABLED et BOB_LIVE_PROVIDER seront exposés dans le dashboard
  // admin (à construire) pour tester l'un ou l'autre sans redéploiement Railway.
  BOB_LIVE_ENABLED: z.enum(['true', 'false']).optional(),
  BOB_LIVE_PROVIDER: z.enum(['openai', 'mistral']).default('openai'),
  // Rollout acoustique distinct du fournisseur. Le défaut audité conserve le chemin N-1 ;
  // le RTP natif reste un choix explicite tant que son duplex device n'est pas certifié.
  BOB_LIVE_SPEECH_DELIVERY: z
    .enum(['audited-signed-url-v1', 'openai-native-webrtc-v1'])
    .default('audited-signed-url-v1'),
  BOB_LIVE_SUBJECT_HMAC_SECRET: z.string().trim().min(32).optional(),
  BOB_LIVE_SUBJECT_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
  // Objet JSON {"version":"secret-HMAC"}. Le format UTF-8 historique reste accepté afin qu'une
  // rotation n'altère jamais le pseudonyme des preuves existantes. Obligatoire pour Mistral v2 :
  // un reçu terminal peut survivre à Mission et doit rester owner-bound après rotation.
  BOB_LIVE_SUBJECT_HMAC_KEYRING: z.string().trim().min(1).max(4_096).optional(),
  BOB_LIVE_PROOF_SECRET: z.string().trim().min(32).optional(),
  BOB_LIVE_PROOF_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  // Objet JSON {"version":"secret-HMAC"}. La preuve native ne conserve que N-1/N ; chaque
  // matériau est ensuite lié append-only à sa version dans PostgreSQL avant le boot.
  BOB_LIVE_PROOF_KEYRING: z.string().trim().min(1).max(4_096).optional(),
  BOB_LIVE_USAGE_HMAC_SECRET: z.string().trim().min(32).optional(),
  BOB_LIVE_USAGE_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  BOB_LIVE_CONTROL_ENCRYPTION_SECRET: z.string().trim().min(32).optional(),
  BOB_LIVE_CONTROL_ENCRYPTION_KEY_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .optional(),
  // Canary strictement limité au replay terminal v2. Aucun flag ne permet le takeover live.
  BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED: z.enum(['true', 'false']).default('false'),
  // Canary initial explicitement non annoncé : ouvre seulement une mission sans autoriser de tour.
  BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED: z.enum(['true', 'false']).default('false'),
  // Rétention bootstrap : cadence dynamique et travail borné par sweep. Il n'existe aucun flag
  // séparé qui permettrait d'activer le replay v2 tout en oubliant durablement la purge.
  BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(60_000),
  BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10),
  BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_MAX_BATCHES: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(4),
  BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .optional(),
  // Keyring AEAD dédié aux identités de bootstrap. Une rotation conserve les anciennes versions
  // jusqu'au drainage/purge de toutes les preuves qui les référencent.
  BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING: z.string().trim().min(1).max(4_096).optional(),
  BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .optional(),
  // Objet JSON {"version":"clé-base64url-32-octets"}. Les anciennes versions restent
  // présentes jusqu'à expiration de la dernière mission scellée avec elles.
  BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING: z.string().trim().min(1).max(4_096).optional(),
  BOB_LIVE_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(10_000).optional(),
  BOB_LIVE_CONTROL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(5_000).optional(),
  BOB_LIVE_MAX_SESSION_SECONDS: z.coerce.number().int().min(60).max(900).optional(),
  BOB_LIVE_MAX_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(20).optional(),
  BOB_LIVE_MAX_CALLS_PER_HOUR: z.coerce.number().int().min(1).max(500).optional(),
  BOB_LIVE_MAX_TENANT_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(5_000).optional(),
  BOB_LIVE_MAX_TENANT_CALLS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).optional(),
  // Plafond physique partagé par toutes les répliques. Il n'a volontairement aucun défaut :
  // activer Bob Live sans budget de concurrence explicite doit faire échouer le démarrage.
  BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).max(1_000).optional(),
  // Valeur contractuelle confirmée dans le compte du fournisseur. Elle n'est jamais déduite
  // d'un événement temps réel et borne le plafond Bob ci-dessus.
  BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).max(10_000).optional(),
  // Incrément manuel obligatoire à chaque changement provider/modèle/plafond. PostgreSQL et
  // chaque réplique doivent attester exactement la même version avant toute admission.
  BOB_LIVE_CAPACITY_CONFIG_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
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
  // Les plateformes de déploiement conservent souvent une variable déclarée avec une valeur
  // vide. Pour le contrat V1, les sept valeurs vides équivalent à « Stripe non provisionné » ;
  // une seule valeur non vide déclenche ensuite le contrôle tout-ou-rien dans loadEnv().
  STRIPE_SECRET_KEY: optionalStripeString,
  STRIPE_PRICE_SOLO: optionalStripeString,
  STRIPE_PRICE_PRO: optionalStripeString,
  STRIPE_PRICE_BUSINESS: optionalStripeString,
  STRIPE_WEBHOOK_SECRET: optionalStripeWebhookSecret,
  STRIPE_LIVEMODE: optionalStripeLiveMode,
  PAYMENT_RETURN_BASE_URL: optionalStripeReturnUrl,
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/)
    .default('bob-documents'),
  SUPABASE_REALTIME_AUDIO_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .default('bob-live-audio'),
  JOB_COMPANY_IDS: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  BREVO_API_BASE_URL: z.string().url().default('https://api.brevo.com/v3'),
  BREVO_SENDER_EMAIL: z.string().email().optional(),
  BREVO_SENDER_NAME: z.string().default('Bob Pro'),
  SIGN_WEB_BASE_URL: z.string().url().optional(),
  METRICS_TOKEN: z.string().min(32).optional(),
  CABINET_RELEASE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  CABINET_INVITATION_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  CABINET_INVITATION_TOKEN_KEY_VERSION: z.coerce.number().int().positive().default(1),
  CABINET_INVITATION_WEB_BASE_URL: z.string().url().optional(),
  CABINET_INVITATION_WORKER_ENABLED: z.enum(['true', 'false']).default('false'),
  JOB_CABINET_IDS: z.string().optional(),
  CABINET_INVITATION_WORKER_USER_ID: z.string().uuid().optional(),
  ERROR_REPORTER_WEBHOOK_URL: z.string().url().optional(),
  // OBSERVABILITÉ §B4 — Sentry (crash reporting serveur). DORMANT en V1 : sans DSN, le SDK
  // n'est même pas chargé (zéro appel réseau, zéro avertissement). Ce canal COMPLÈTE
  // ERROR_REPORTER_WEBHOOK_URL — qui reste le canal d'alerte critique — il ne le remplace pas.
  // Le DSN doit cibler la RÉGION UE de Sentry : garde fail-closed `assertSentryDsnIsEuRegion`.
  SENTRY_DSN: z.string().url().optional(),
  // Absent : l'environnement est déduit de CABINET_RELEASE_ENV, jamais inventé.
  SENTRY_ENVIRONMENT: z.enum(['development', 'staging', 'production']).optional(),
  // 0 = AUCUNE trace de performance. Les spans transportent des noms de route et des attributs
  // applicatifs dont le scrubbing n'est pas spécifié : rien à gagner, du PII à risquer.
  // Valeur figée par design_handoff_bob_pro/MATRICE_FLAGS_V1.md (§5 Observabilité).
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
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
  // TRAÇAGE DU COMPORTEMENT VOCAL (bêta-test fondateur). Dormant par défaut, et c'est le point :
  // une trace vocale transporte le texte prononcé et la réponse de Bob, soit les données les plus
  // sensibles de l'app. Sans ce flag, AUCUNE ligne n'est écrite — zéro coût, zéro donnée. Le
  // consommateur (VoiceTraceRecorder) relit `process.env` à chaque tour : couper le flag arrête
  // l'écriture au tour suivant, sans redéploiement.
  VOICE_TRACE_ENABLED: z.enum(['true', 'false']).default('false'),
});

export type Env = z.infer<typeof schema>;

export type BobLiveProviderId = 'openai' | 'mistral';
export type BobLiveAuditProviderId = 'openai' | 'local-whisper';
export type BobLiveSpeechDelivery = 'audited-signed-url-v1' | 'openai-native-webrtc-v1';

/**
 * Vue canonique de la configuration Bob Live. Les alias historiques ne sortent jamais de cette
 * frontière : le reste du runtime ne doit plus raisonner en termes de variables OPENAI_* pour
 * les quotas, les baux ou les secrets qui appartiennent à Bob.
 */
export interface ResolvedBobLiveEnv {
  enabled: boolean;
  provider: BobLiveProviderId;
  speechDelivery: BobLiveSpeechDelivery;
  providerModel: string;
  providerBaseUrl: string;
  providerTimeoutMs: number;
  controlTimeoutMs: number;
  maxSessionSeconds: number;
  subjectHmacSecret: string | null;
  subjectKeyVersion: number;
  subjectHmacKeyRing: ResolvedBobLiveSubjectHmacKeyRing | null;
  proofSecret: string | null;
  proofKeyVersion: number;
  proofKeyRing: ResolvedBobLiveProofKeyRing | null;
  usageHmacSecret: string | null;
  usageKeyVersion: number;
  controlEncryptionSecret: string | null;
  controlEncryptionKeyVersion: number;
  maxCallsPerMinute: number;
  maxCallsPerHour: number;
  maxTenantCallsPerMinute: number;
  maxTenantCallsPerHour: number;
  globalCapacity: Readonly<{
    providerId: BobLiveProviderId;
    providerModel: string;
    globalMaxSessions: number;
    providerMaxSessions: number;
    configVersion: number;
  }> | null;
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
  mistralV2TerminalReplayEnabled: boolean;
  mistralV2InitialBootstrapEnabled: boolean;
  mistralV2BootstrapReaperIntervalMs: number;
  mistralV2BootstrapReaperBatchSize: number;
  mistralV2BootstrapReaperMaxBatches: number;
}

export interface ResolvedMistralConversationPersistenceKeyRing {
  readonly currentVersion: number;
  /** Retourne toujours une copie : aucune dépendance ne peut muter le secret partagé. */
  secret(version: number): Uint8Array | null;
}

export interface ResolvedMistralV2IdentityEncryptionKeyRing {
  readonly currentVersion: number;
  /** Les chaînes sont immuables ; seules les versions explicitement retenues sont résolues. */
  secret(version: number): string | null;
}

export interface ResolvedBobLiveSubjectHmacKeyRing {
  readonly currentVersion: number;
  readonly versions: readonly number[];
  /** Les chaînes sont immuables ; seules les versions explicitement retenues sont résolues. */
  secret(version: number): string | null;
}

export interface ResolvedBobLiveProofKeyRing {
  readonly currentVersion: number;
  readonly versions: readonly number[];
  /** Chaine UTF-8 exacte transmise a createHmac ; aucune normalisation implicite. */
  secret(version: number): string | null;
}

function parseBobLiveSubjectHmacSecrets(raw: string): ReadonlyMap<number, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BOB_LIVE_SUBJECT_HMAC_KEYRING doit être un objet JSON valide.');
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
  ) throw new Error('BOB_LIVE_SUBJECT_HMAC_KEYRING doit être un objet JSON.');

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > BOB_LIVE_SUBJECT_MAX_VERSIONED_KEYS) {
    throw new Error(
      `BOB_LIVE_SUBJECT_HMAC_KEYRING doit contenir entre 1 et ${BOB_LIVE_SUBJECT_MAX_VERSIONED_KEYS} clés.`,
    );
  }
  const secrets = new Map<number, string>();
  const seenSecrets = new Set<string>();
  for (const [rawVersion, rawSecret] of entries) {
    const version = Number(rawVersion);
    if (
      !/^[1-9][0-9]{0,9}$/u.test(rawVersion)
      || !Number.isSafeInteger(version)
      || version > 2_147_483_647
      || typeof rawSecret !== 'string'
      || rawSecret.length < 32
      || rawSecret.length > 512
      || rawSecret.includes('[')
      || rawSecret.includes(']')
      || [...rawSecret].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x21 || codePoint > 0x7e;
      })
      || seenSecrets.has(rawSecret)
    ) throw new Error('BOB_LIVE_SUBJECT_HMAC_KEYRING contient une version ou une clé invalide.');
    secrets.set(version, rawSecret);
    seenSecrets.add(rawSecret);
  }
  return secrets;
}

export function resolveBobLiveSubjectHmacKeyRing(
  env: Env,
): ResolvedBobLiveSubjectHmacKeyRing | null {
  const currentVersion = env.BOB_LIVE_SUBJECT_KEY_VERSION;
  const legacyCurrentSecret =
    env.BOB_LIVE_SUBJECT_HMAC_SECRET ?? env.OPENAI_REALTIME_SAFETY_SECRET ?? null;
  const raw = env.BOB_LIVE_SUBJECT_HMAC_KEYRING;
  if (raw === undefined) {
    if (legacyCurrentSecret === null) return null;
    return Object.freeze({
      currentVersion,
      versions: Object.freeze([currentVersion]),
      secret: (version: number) => version === currentVersion ? legacyCurrentSecret : null,
    });
  }

  const secrets = parseBobLiveSubjectHmacSecrets(raw);
  const currentSecret = secrets.get(currentVersion);
  if (!currentSecret) {
    throw new Error('La version courante sujet Bob Live doit exister dans son keyring HMAC.');
  }
  if (legacyCurrentSecret !== null && legacyCurrentSecret !== currentSecret) {
    throw new Error(
      'BOB_LIVE_SUBJECT_HMAC_SECRET doit correspondre à la version courante du keyring sujet.',
    );
  }
  const versions = Object.freeze([...secrets.keys()].sort((left, right) => left - right));
  return Object.freeze({
    currentVersion,
    versions,
    secret: (version: number) => secrets.get(version) ?? null,
  });
}

function parseBobLiveProofSecrets(raw: string): ReadonlyMap<number, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BOB_LIVE_PROOF_KEYRING doit être un objet JSON valide.');
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
  ) throw new Error('BOB_LIVE_PROOF_KEYRING doit être un objet JSON.');

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > BOB_LIVE_PROOF_MAX_VERSIONED_KEYS) {
    throw new Error(
      `BOB_LIVE_PROOF_KEYRING doit contenir entre 1 et ${BOB_LIVE_PROOF_MAX_VERSIONED_KEYS} clés.`,
    );
  }
  const secrets = new Map<number, string>();
  const seenSecrets = new Set<string>();
  for (const [rawVersion, rawSecret] of entries) {
    const version = Number(rawVersion);
    if (
      !/^[1-9][0-9]{0,9}$/u.test(rawVersion)
      || !Number.isSafeInteger(version)
      || version > 2_147_483_647
      || typeof rawSecret !== 'string'
      || Buffer.byteLength(rawSecret, 'utf8') < 32
      || Buffer.byteLength(rawSecret, 'utf8') > 512
      || rawSecret.includes('[')
      || rawSecret.includes(']')
      || [...rawSecret].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x21 || codePoint > 0x7e;
      })
      || seenSecrets.has(rawSecret)
    ) throw new Error('BOB_LIVE_PROOF_KEYRING contient une version ou une clé invalide.');
    secrets.set(version, rawSecret);
    seenSecrets.add(rawSecret);
  }
  return secrets;
}

export function resolveBobLiveProofKeyRing(env: Env): ResolvedBobLiveProofKeyRing | null {
  const currentVersion = env.BOB_LIVE_PROOF_KEY_VERSION ?? env.OPENAI_REALTIME_PROOF_KEY_VERSION;
  const legacyCurrentSecret =
    env.BOB_LIVE_PROOF_SECRET ?? env.OPENAI_REALTIME_PROOF_SECRET ?? null;
  const raw = env.BOB_LIVE_PROOF_KEYRING;
  if (raw === undefined) {
    if (legacyCurrentSecret === null) return null;
    return Object.freeze({
      currentVersion,
      versions: Object.freeze([currentVersion]),
      secret: (version: number) => version === currentVersion ? legacyCurrentSecret : null,
    });
  }

  const secrets = parseBobLiveProofSecrets(raw);
  const versions = Object.freeze([...secrets.keys()].sort((left, right) => left - right));
  const currentSecret = secrets.get(currentVersion);
  if (!currentSecret) {
    throw new Error('La version courante preuve Bob Live doit exister dans son keyring HMAC.');
  }
  if (
    versions.at(-1) !== currentVersion
    || (versions.length === 2 && versions[1] !== versions[0]! + 1)
  ) {
    throw new Error('BOB_LIVE_PROOF_KEYRING doit contenir uniquement N-1/N avec N courant.');
  }
  if (legacyCurrentSecret !== null && legacyCurrentSecret !== currentSecret) {
    throw new Error(
      'BOB_LIVE_PROOF_SECRET doit correspondre à la version courante du keyring preuve.',
    );
  }
  return Object.freeze({
    currentVersion,
    versions,
    secret: (version: number) => secrets.get(version) ?? null,
  });
}

function parseMistralV2VersionedSecrets(
  raw: string,
  variableName:
    | 'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING'
    | 'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING',
): ReadonlyMap<number, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${variableName} doit être un objet JSON valide.`);
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error(`${variableName} doit être un objet JSON.`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MISTRAL_V2_MAX_VERSIONED_KEYS) {
    throw new Error(
      `${variableName} doit contenir entre 1 et ${MISTRAL_V2_MAX_VERSIONED_KEYS} clés.`,
    );
  }
  const secrets = new Map<number, string>();
  const seenSecrets = new Set<string>();
  for (const [rawVersion, rawSecret] of entries) {
    const version = Number(rawVersion);
    if (
      !/^[1-9][0-9]{0,9}$/u.test(rawVersion)
      || !Number.isSafeInteger(version)
      || version > 2_147_483_647
      || typeof rawSecret !== 'string'
      || !MISTRAL_V2_VERSIONED_SECRET.test(rawSecret)
      || seenSecrets.has(rawSecret)
    ) {
      throw new Error(`${variableName} contient une version ou une clé invalide.`);
    }
    const decoded = Buffer.from(rawSecret, 'base64url');
    if (decoded.byteLength !== 32 || decoded.toString('base64url') !== rawSecret) {
      throw new Error(`${variableName} exige des clés base64url canoniques de 32 octets.`);
    }
    secrets.set(version, rawSecret);
    seenSecrets.add(rawSecret);
  }
  return secrets;
}

function parseMistralConversationPersistenceSecrets(
  raw: string,
): ReadonlyMap<number, Uint8Array> {
  const secrets = new Map<number, Uint8Array>();
  for (const [version, rawSecret] of parseMistralV2VersionedSecrets(
    raw,
    'BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING',
  )) {
    const decoded = Buffer.from(rawSecret, 'base64url');
    secrets.set(version, Uint8Array.from(decoded));
  }
  return secrets;
}

function parseMistralV2IdentityEncryptionSecrets(raw: string): ReadonlyMap<number, string> {
  return parseMistralV2VersionedSecrets(
    raw,
    'BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING',
  );
}

export function resolveMistralConversationPersistenceKeyRing(
  env: Env,
): ResolvedMistralConversationPersistenceKeyRing | null {
  if (env.BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED !== 'true') return null;
  const currentVersion = env.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION;
  const raw = env.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING;
  if (currentVersion === undefined || raw === undefined) {
    throw new Error(
      'Replay terminal Mistral v2 activé mais keyring de persistance versionné incomplet.',
    );
  }
  const secrets = parseMistralConversationPersistenceSecrets(raw);
  if (!secrets.has(currentVersion)) {
    throw new Error('La version courante Mistral v2 doit exister dans le keyring de persistance.');
  }
  return Object.freeze({
    currentVersion,
    secret: (version: number) => {
      const secret = secrets.get(version);
      return secret ? Uint8Array.from(secret) : null;
    },
  });
}

export function resolveMistralV2IdentityEncryptionKeyRing(
  env: Env,
): ResolvedMistralV2IdentityEncryptionKeyRing | null {
  const currentVersion = env.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION;
  const raw = env.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING;
  if (currentVersion === undefined && raw === undefined) {
    if (env.BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED === 'true') {
      throw new Error(
        'Bootstrap initial Mistral v2 activé mais keyring de chiffrement identité incomplet.',
      );
    }
    return null;
  }
  if (currentVersion === undefined || raw === undefined) {
    throw new Error('Le keyring de chiffrement identité Mistral v2 est incomplet.');
  }
  const secrets = parseMistralV2IdentityEncryptionSecrets(raw);
  if (!secrets.has(currentVersion)) {
    throw new Error(
      'La version courante de chiffrement identité Mistral v2 doit exister dans son keyring.',
    );
  }
  return Object.freeze({
    currentVersion,
    secret: (version: number) => secrets.get(version) ?? null,
  });
}

export function resolveBobLiveEnv(env: Env): ResolvedBobLiveEnv {
  const provider = env.BOB_LIVE_PROVIDER;
  const providerModel =
    provider === 'mistral' ? env.MISTRAL_REALTIME_STT_MODEL : env.OPENAI_REALTIME_MODEL;
  const capacityValues = [
    env.BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS,
    env.BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS,
    env.BOB_LIVE_CAPACITY_CONFIG_VERSION,
  ] as const;
  const configuredCapacityValues = capacityValues.filter((value) => value !== undefined).length;
  if (configuredCapacityValues !== 0 && configuredCapacityValues !== capacityValues.length) {
    throw new Error(
      'Configuration capacité Bob Live partielle : plafond global, plafond fournisseur et version sont indissociables.',
    );
  }
  const globalCapacity = configuredCapacityValues === capacityValues.length
    ? Object.freeze({
        providerId: provider,
        providerModel,
        globalMaxSessions: env.BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS as number,
        providerMaxSessions: env.BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS as number,
        configVersion: env.BOB_LIVE_CAPACITY_CONFIG_VERSION as number,
      })
    : null;
  if (globalCapacity && globalCapacity.globalMaxSessions > globalCapacity.providerMaxSessions) {
    throw new Error('Le plafond global Bob Live ne peut pas dépasser le plafond du fournisseur.');
  }
  if (
    globalCapacity
    && provider === 'mistral'
    && globalCapacity.globalMaxSessions > env.BOB_LIVE_GATEWAY_MAX_CONNECTIONS
  ) {
    throw new Error('Le plafond global Bob Live ne peut pas dépasser la capacité du gateway Mistral.');
  }
  const proofKeyVersion = env.BOB_LIVE_PROOF_KEY_VERSION ?? env.OPENAI_REALTIME_PROOF_KEY_VERSION;
  const subjectHmacKeyRing = resolveBobLiveSubjectHmacKeyRing(env);
  const proofKeyRing = resolveBobLiveProofKeyRing(env);
  const proofSecret = proofKeyRing?.secret(proofKeyVersion) ?? null;
  return {
    enabled: (env.BOB_LIVE_ENABLED ?? env.OPENAI_REALTIME_ENABLED) === 'true',
    provider,
    speechDelivery: env.BOB_LIVE_SPEECH_DELIVERY,
    providerModel,
    providerBaseUrl:
      provider === 'mistral'
        ? env.MISTRAL_REALTIME_BASE_URL.replace(/\/$/u, '')
        : env.OPENAI_REALTIME_BASE_URL.replace(/\/$/u, ''),
    providerTimeoutMs: env.BOB_LIVE_PROVIDER_TIMEOUT_MS ?? env.OPENAI_REALTIME_PROVIDER_TIMEOUT_MS,
    controlTimeoutMs: env.BOB_LIVE_CONTROL_TIMEOUT_MS ?? env.OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS,
    maxSessionSeconds: env.BOB_LIVE_MAX_SESSION_SECONDS ?? env.OPENAI_REALTIME_MAX_SESSION_SECONDS,
    subjectHmacSecret: subjectHmacKeyRing?.secret(subjectHmacKeyRing.currentVersion) ?? null,
    subjectKeyVersion: env.BOB_LIVE_SUBJECT_KEY_VERSION,
    subjectHmacKeyRing,
    proofSecret,
    proofKeyVersion,
    proofKeyRing,
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
    globalCapacity,
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
    mistralV2TerminalReplayEnabled:
      env.BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED === 'true',
    mistralV2InitialBootstrapEnabled:
      env.BOB_LIVE_MISTRAL_V2_INITIAL_BOOTSTRAP_ENABLED === 'true',
    mistralV2BootstrapReaperIntervalMs:
      env.BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_INTERVAL_MS,
    mistralV2BootstrapReaperBatchSize:
      env.BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_BATCH_SIZE,
    mistralV2BootstrapReaperMaxBatches:
      env.BOB_LIVE_MISTRAL_V2_BOOTSTRAP_REAPER_MAX_BATCHES,
  };
}

/**
 * Sentry SaaS crée les organisations en région **US par défaut** : un DSN collé sans vigilance
 * exfiltrerait, en silence et sans erreur visible, les rapports de plantage d'une application
 * financière française hors UE. La posture souveraine actée (§B4, RGPD) exige la région UE —
 * cette garde est donc FAIL-CLOSED : un DSN non-UE refuse le démarrage, jamais un avertissement
 * qu'on finirait par ne plus lire. Elle s'applique dans TOUS les environnements : un poste de
 * développement qui pousserait vers une région US poserait exactement le même problème.
 */
export function assertSentryDsnIsEuRegion(dsn: string): void {
  const reason = sentryDsnRejectionReason(dsn);
  if (reason) throw new Error(`SENTRY_DSN ${reason}.`);
}

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Variables d'environnement invalides : ${parsed.error.toString()}`);
  }
  // Garde-fou de déploiement : même si ce flag ne contourne plus JWT/RLS, un serveur de production
  // doit certifier toutes ses dépendances externes au démarrage et ne jamais utiliser le profil de test.
  if (process.env.NODE_ENV === 'production' && parsed.data.DEMO_MODE !== 'false') {
    throw new Error(
      "Refus de démarrer : en production, DEMO_MODE doit valoir 'false' (profil de test interdit).",
    );
  }
  if (parsed.data.DEMO_MODE === 'false') {
    const required: Array<keyof Env> = [
      'DATABASE_URL',
      'SUPABASE_JWKS_URL',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'CABINET_INVITATION_TOKEN_ENCRYPTION_KEY',
      'SIGN_WEB_BASE_URL',
      'CABINET_INVITATION_WEB_BASE_URL',
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
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_LIVEMODE',
      'PAYMENT_RETURN_BASE_URL',
    ];
    const missingPayment = paymentRequired.filter((key) => !parsed.data[key]);
    // Early-access V1 (décision produit — SPEC pilier 2/PROGRAMME V1) : le paiement est
    // ABSENT tant que Stripe n'est pas provisionné. Config totalement vide = mode
    // early-access assumé (les CTA d'achat sont gelés côté UI). Une config ENTAMÉE mais
    // incomplète reste une erreur fatale : on ne démarre jamais avec un paiement à moitié
    // câblé.
    if (missingPayment.length > 0 && missingPayment.length < paymentRequired.length) {
      throw new Error(`Configuration paiement live incomplète : ${missingPayment.join(', ')}.`);
    }
    // Stripe totalement absent (accès anticipé) : aucune URL de retour à valider, le gateway est
    // inerte (`DisabledPaymentGateway`). Ne valider PAYMENT_RETURN_BASE_URL que lorsque Stripe est
    // effectivement provisionné — sinon `new URL(undefined)` ferait échouer le démarrage.
    if (missingPayment.length === 0) {
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
    }
    for (const [name, raw] of [
      ['SIGN_WEB_BASE_URL', parsed.data.SIGN_WEB_BASE_URL],
      ['CABINET_INVITATION_WEB_BASE_URL', parsed.data.CABINET_INVITATION_WEB_BASE_URL],
    ] as const) {
      const url = new URL(raw as string);
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
    const invitationUrl = new URL(parsed.data.CABINET_INVITATION_WEB_BASE_URL as string);
    if (invitationUrl.protocol !== 'https:' && invitationUrl.hostname !== 'localhost') {
      throw new Error('CABINET_INVITATION_WEB_BASE_URL doit utiliser HTTPS hors localhost.');
    }
  }
  // Crash reporting : dormant tant qu'aucun DSN n'est posé. Dès qu'il l'est, il est certifié
  // AVANT que le SDK ne soit chargé — un DSN hors UE ne doit jamais atteindre le réseau.
  if (parsed.data.SENTRY_DSN) assertSentryDsnIsEuRegion(parsed.data.SENTRY_DSN);
  if (!parsed.data.SENTRY_DSN && parsed.data.SENTRY_ENVIRONMENT !== undefined) {
    throw new Error('SENTRY_ENVIRONMENT ne doit pas être posé sans SENTRY_DSN (canal dormant).');
  }
  if (process.env.NODE_ENV === 'production' && parsed.data.CABINET_RELEASE_ENV === 'development') {
    throw new Error(
      "CABINET_RELEASE_ENV doit valoir 'staging' ou 'production' lorsque NODE_ENV=production.",
    );
  }
  const bobLive = resolveBobLiveEnv(parsed.data);
  if (bobLive.provider !== 'openai' && bobLive.speechDelivery !== 'audited-signed-url-v1') {
    throw new Error(
      'BOB_LIVE_SPEECH_DELIVERY=openai-native-webrtc-v1 exige BOB_LIVE_PROVIDER=openai.',
    );
  }
  if (
    bobLive.speechDelivery === 'openai-native-webrtc-v1'
    && !OPENAI_NATIVE_WEBRTC_RUNTIME_READY
  ) {
    throw new Error(
      'BOB_LIVE_SPEECH_DELIVERY=openai-native-webrtc-v1 est bloqué tant que le duplex natif n’est pas certifié.',
    );
  }
  if (
    bobLive.speechDelivery === 'openai-native-webrtc-v1'
    && parsed.data.BOB_LIVE_PROOF_KEYRING === undefined
  ) {
    throw new Error('La restitution OpenAI native exige BOB_LIVE_PROOF_KEYRING.');
  }
  const mistralV2PersistenceConfigured =
    parsed.data.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION !== undefined
    || parsed.data.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING !== undefined;
  const mistralV2IdentityEncryptionConfigured =
    parsed.data.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEY_VERSION !== undefined
    || parsed.data.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING !== undefined;
  if (!bobLive.mistralV2TerminalReplayEnabled && mistralV2PersistenceConfigured) {
    throw new Error(
      'Le keyring Mistral v2 ne peut pas être configuré lorsque le replay terminal est désactivé.',
    );
  }
  if (bobLive.mistralV2TerminalReplayEnabled) {
    if (!bobLive.enabled || bobLive.provider !== 'mistral') {
      throw new Error(
        'Le replay terminal Mistral v2 exige BOB_LIVE_ENABLED=true et BOB_LIVE_PROVIDER=mistral.',
      );
    }
    resolveMistralConversationPersistenceKeyRing(parsed.data);
    resolveMistralV2IdentityEncryptionKeyRing(parsed.data);
    if (parsed.data.BOB_LIVE_SUBJECT_HMAC_KEYRING === undefined) {
      throw new Error(
        'Le replay terminal Mistral v2 exige BOB_LIVE_SUBJECT_HMAC_KEYRING afin de préserver les reçus après rotation.',
      );
    }
  }
  if (
    bobLive.mistralV2InitialBootstrapEnabled
    && !bobLive.mistralV2TerminalReplayEnabled
  ) {
    throw new Error(
      'Le bootstrap initial Mistral v2 exige le replay terminal Mistral v2 actif.',
    );
  }
  if (!bobLive.mistralV2TerminalReplayEnabled && mistralV2IdentityEncryptionConfigured) {
    throw new Error(
      'Le keyring de chiffrement identité Mistral v2 ne peut pas être configuré lorsque le replay terminal est désactivé.',
    );
  }
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
      bobLive.globalCapacity === null ? 'BOB_LIVE_CAPACITY_CONFIG_GROUP' : null,
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
    const subjectHmacSecrets = bobLive.subjectHmacKeyRing?.versions.map((version) => {
      const secret = bobLive.subjectHmacKeyRing?.secret(version);
      if (!secret) throw new Error(`Clé HMAC sujet Bob Live ${version} indisponible.`);
      return secret;
    }) ?? [];
    const proofSecrets = bobLive.proofKeyRing?.versions.map((version) => {
      const secret = bobLive.proofKeyRing?.secret(version);
      if (!secret) throw new Error(`Clé HMAC preuve Bob Live ${version} indisponible.`);
      return secret;
    }) ?? [];
    const dedicatedSecrets = [
      ...subjectHmacSecrets,
      ...proofSecrets,
      bobLive.controlEncryptionSecret,
      ...(parsed.data.BOB_LIVE_USAGE_HMAC_SECRET ? [parsed.data.BOB_LIVE_USAGE_HMAC_SECRET] : []),
      ...(bobLive.localAuditToken ? [bobLive.localAuditToken] : []),
      ...(bobLive.mistralV2TerminalReplayEnabled
        ? [...parseMistralConversationPersistenceSecrets(
            parsed.data.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING as string,
          ).values()].map((secret) => Buffer.from(secret).toString('base64url'))
        : []),
      ...(parsed.data.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING
        ? [...parseMistralV2IdentityEncryptionSecrets(
            parsed.data.BOB_LIVE_MISTRAL_V2_IDENTITY_ENCRYPTION_KEYRING,
          ).values()]
        : []),
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
/**
 * Fail-closed : tout ce qui n'est pas exactement 'true' laisse le traçage vocal éteint. Lu à
 * CHAQUE tour (pas capturé au boot) pour qu'une coupure d'urgence prenne effet immédiatement.
 */
export const isVoiceTraceEnabled = (): boolean => process.env.VOICE_TRACE_ENABLED === 'true';
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

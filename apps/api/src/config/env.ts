import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DEMO_MODE: z.enum(['true', 'false']).default('true'),
  ANTHROPIC_API_KEY: z.string().optional(),
  GLM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_ENABLED: z.enum(['true', 'false']).default('false'),
  OPENAI_REALTIME_MODEL: z.string().trim().min(1).max(100).default('gpt-realtime-2.1'),
  OPENAI_REALTIME_VOICE: z.enum(['marin', 'cedar']).default('marin'),
  OPENAI_REALTIME_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_REALTIME_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(6_000).default(4_000),
  OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(5_000).default(3_000),
  OPENAI_REALTIME_MAX_SESSION_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
  OPENAI_REALTIME_SAFETY_SECRET: z.string().min(32).optional(),
  OPENAI_REALTIME_PROOF_SECRET: z.string().min(32).optional(),
  OPENAI_REALTIME_PROOF_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
  OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET: z.string().min(32).optional(),
  OPENAI_REALTIME_CONTROL_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
  OPENAI_REALTIME_MAX_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(20).default(3),
  OPENAI_REALTIME_MAX_CALLS_PER_HOUR: z.coerce.number().int().min(1).max(500).default(30),
  OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(5_000).default(50),
  OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(1_000),
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
  MISTRAL_TTS_MODEL: z.string().default('voxtral-mini-tts-2603'),
  MISTRAL_TTS_VOICE_ID: z.string().optional(),
  // OCR (A2-C14) : modèle OCR DÉDIÉ Mistral (≠ Voxtral/chat) + petit modèle d'extraction structurée.
  MISTRAL_OCR_MODEL: z.string().default('mistral-ocr-latest'),
  MISTRAL_OCR_EXTRACT_MODEL: z.string().default('mistral-small-latest'),
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('bob-documents'),
  SUPABASE_REALTIME_AUDIO_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).default('bob-live-audio'),
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
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Variables d'environnement invalides : ${parsed.error.toString()}`);
  }
  // Garde-fou : en production, le mode démo (auth pass-through) exposerait des endpoints sans token
  // et consommerait des ressources externes (API publiques) de façon anonyme. On refuse de démarrer.
  if (process.env.NODE_ENV === 'production' && parsed.data.DEMO_MODE !== 'false') {
    throw new Error("Refus de démarrer : en production, DEMO_MODE doit valoir 'false' (l'auth pass-through démo désactive la sécurité).");
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
    const hasCabinetIds = Boolean(parsed.data.JOB_CABINET_IDS);
    const hasWorker = Boolean(parsed.data.CABINET_INVITATION_WORKER_USER_ID);
    const workerEnabled = parsed.data.CABINET_INVITATION_WORKER_ENABLED === 'true';
    if (workerEnabled && (!hasCabinetIds || !hasWorker)) {
      throw new Error('Le worker Cabinet activé exige JOB_CABINET_IDS et CABINET_INVITATION_WORKER_USER_ID.');
    }
    if (!workerEnabled && (hasCabinetIds || hasWorker)) {
      throw new Error('Le worker Cabinet désactivé ne doit pas conserver de liste ou identité active.');
    }
    if (parsed.data.JOB_CABINET_IDS) parseJobCabinetIds(parsed.data.JOB_CABINET_IDS);
    for (const [name, secret] of [
      ['CABINET_INVITATION_TOKEN_ENCRYPTION_KEY', parsed.data.CABINET_INVITATION_TOKEN_ENCRYPTION_KEY],
      ['METRICS_TOKEN', parsed.data.METRICS_TOKEN],
    ] as const) {
      if (secret?.includes('[') || secret?.includes(']')) throw new Error(`${name} contient un placeholder.`);
    }
    const invitationUrl = new URL(parsed.data.CABINET_INVITATION_WEB_BASE_URL);
    if (invitationUrl.protocol !== 'https:' && invitationUrl.hostname !== 'localhost') {
      throw new Error('CABINET_INVITATION_WEB_BASE_URL doit utiliser HTTPS hors localhost.');
    }
  }
  if (process.env.NODE_ENV === 'production' && parsed.data.CABINET_RELEASE_ENV === 'development') {
    throw new Error("CABINET_RELEASE_ENV doit valoir 'staging' ou 'production' lorsque NODE_ENV=production.");
  }
  if (parsed.data.OPENAI_REALTIME_ENABLED === 'true') {
    const missing = [
      !parsed.data.OPENAI_API_KEY ? 'OPENAI_API_KEY' : null,
      !parsed.data.OPENAI_REALTIME_SAFETY_SECRET ? 'OPENAI_REALTIME_SAFETY_SECRET' : null,
      !parsed.data.OPENAI_REALTIME_PROOF_SECRET ? 'OPENAI_REALTIME_PROOF_SECRET' : null,
      !parsed.data.OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET
        ? 'OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET'
        : null,
    ].filter((value): value is string => value !== null);
    if (missing.length > 0) {
      throw new Error(`Bob Live activé mais configuration incomplète : ${missing.join(', ')}.`);
    }
    for (const [name, secret] of [
      ['OPENAI_REALTIME_SAFETY_SECRET', parsed.data.OPENAI_REALTIME_SAFETY_SECRET],
      ['OPENAI_REALTIME_PROOF_SECRET', parsed.data.OPENAI_REALTIME_PROOF_SECRET],
      [
        'OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET',
        parsed.data.OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET,
      ],
    ] as const) {
      if (secret?.includes('[') || secret?.includes(']')) {
        throw new Error(`${name} contient un placeholder.`);
      }
    }
    if (
      parsed.data.OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET
      === parsed.data.OPENAI_REALTIME_PROOF_SECRET
      || parsed.data.OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET
      === parsed.data.OPENAI_REALTIME_SAFETY_SECRET
    ) {
      throw new Error('La clé de chiffrement des contrôles Bob Live doit être dédiée.');
    }
    if (parsed.data.SUPABASE_REALTIME_AUDIO_BUCKET === parsed.data.SUPABASE_STORAGE_BUCKET) {
      throw new Error('Le bucket audio Bob Live doit être distinct du bucket documentaire.');
    }
    const realtimeUrl = new URL(parsed.data.OPENAI_REALTIME_BASE_URL);
    if (realtimeUrl.protocol !== 'https:') {
      throw new Error('OPENAI_REALTIME_BASE_URL doit utiliser HTTPS.');
    }
    if (process.env.NODE_ENV === 'production' && realtimeUrl.hostname !== 'api.openai.com') {
      throw new Error('OPENAI_REALTIME_BASE_URL doit cibler api.openai.com en production.');
    }
    if (
      parsed.data.OPENAI_REALTIME_PROVIDER_TIMEOUT_MS
      + parsed.data.OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS
      > 8_500
    ) {
      throw new Error('Le budget bootstrap Bob Live serveur doit rester inférieur ou égal à 8500 ms.');
    }
    const bootstrapBudgetMs = parsed.data.OPENAI_REALTIME_PROVIDER_TIMEOUT_MS
      + parsed.data.OPENAI_REALTIME_SIDEBAND_TIMEOUT_MS;
    if (parsed.data.OPENAI_REALTIME_RESERVATION_TTL_SECONDS * 1_000 < bootstrapBudgetMs + 1_000) {
      throw new Error('Le bail de réservation Bob Live doit dépasser le budget bootstrap d’au moins une seconde.');
    }
    if (parsed.data.OPENAI_REALTIME_MAX_CALLS_PER_HOUR < parsed.data.OPENAI_REALTIME_MAX_CALLS_PER_MINUTE) {
      throw new Error('Le quota Bob Live utilisateur horaire doit être supérieur ou égal au quota minute.');
    }
    if (
      parsed.data.OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE
      < parsed.data.OPENAI_REALTIME_MAX_CALLS_PER_MINUTE
      || parsed.data.OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR
      < parsed.data.OPENAI_REALTIME_MAX_CALLS_PER_HOUR
      || parsed.data.OPENAI_REALTIME_MAX_TENANT_CALLS_PER_HOUR
      < parsed.data.OPENAI_REALTIME_MAX_TENANT_CALLS_PER_MINUTE
    ) {
      throw new Error('Les quotas Bob Live tenant doivent couvrir les quotas utilisateur correspondants.');
    }
    if (parsed.data.OPENAI_REALTIME_HEARTBEAT_SECONDS >= parsed.data.OPENAI_REALTIME_ACTIVE_LEASE_SECONDS) {
      throw new Error('Le heartbeat Bob Live doit être plus court que le bail actif.');
    }
    if (parsed.data.OPENAI_REALTIME_ACTIVE_LEASE_SECONDS > parsed.data.OPENAI_REALTIME_MAX_SESSION_SECONDS) {
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
export const isDemoMode = (): boolean => process.env.DEMO_MODE !== 'false';

export function jobCompanyIds(): string[] {
  const raw = process.env.JOB_COMPANY_IDS;
  if (!raw) return [];
  return [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))];
}

export function jobCabinetIds(): string[] {
  if (process.env.CABINET_INVITATION_WORKER_ENABLED !== 'true') return [];
  return parseJobCabinetIds(process.env.JOB_CABINET_IDS);
}

export function parseJobCabinetIds(raw?: string): string[] {
  if (!raw) return [];
  const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))];
  if (ids.some((id) => !/^[A-Za-z0-9-]{1,64}$/.test(id))) {
    throw new Error('JOB_CABINET_IDS contient un identifiant invalide.');
  }
  if (ids.length > 100) throw new Error('JOB_CABINET_IDS est limité à 100 cabinets pilotes distincts.');
  return ids;
}

import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DEMO_MODE: z.enum(['true', 'false']).default('true'),
  ANTHROPIC_API_KEY: z.string().optional(),
  GLM_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
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
  SUPABASE_JWKS_URL: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('bob-documents'),
  JOB_COMPANY_IDS: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  BREVO_API_BASE_URL: z.string().url().default('https://api.brevo.com/v3'),
  BREVO_SENDER_EMAIL: z.string().email().optional(),
  BREVO_SENDER_NAME: z.string().default('Bob Pro'),
  SIGN_WEB_BASE_URL: z.string().url().default('https://demo.bobpro.fr'),
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

import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DEMO_MODE: z.enum(['true', 'false']).default('true'),
  ANTHROPIC_API_KEY: z.string().optional(),
  GLM_API_KEY: z.string().optional(),
  AI_ROUTER_DEFAULT: z.enum(['claude', 'glm']).default('claude'),
  DATABASE_URL: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().optional(),
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

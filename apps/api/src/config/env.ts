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
  return parsed.data;
}

export const hasClaudeKey = (): boolean => !!process.env.ANTHROPIC_API_KEY;
export const hasGlmKey = (): boolean => !!process.env.GLM_API_KEY;
export const isDemoMode = (): boolean => process.env.DEMO_MODE !== 'false';

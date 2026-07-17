import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from './env';

function validLiveEnv(): void {
  vi.stubEnv('DEMO_MODE', 'false');
  vi.stubEnv('BOB_LIVE_ENABLED', 'false');
  vi.stubEnv('DATABASE_URL', 'postgresql://bob_app:secret@db.example.test:5432/bob');
  vi.stubEnv('SUPABASE_JWKS_URL', 'https://project.supabase.co/auth/v1/.well-known/jwks.json');
  vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-tests');
  vi.stubEnv('CABINET_INVITATION_TOKEN_ENCRYPTION_KEY', 'c'.repeat(32));
  vi.stubEnv('BREVO_API_KEY', 'brevo-test-key');
  vi.stubEnv('BREVO_SENDER_EMAIL', 'bob@example.test');
  vi.stubEnv('METRICS_TOKEN', 'm'.repeat(32));
  vi.stubEnv('ERROR_REPORTER_WEBHOOK_URL', 'https://errors.example.test/hook');
  vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.bobpro.fr');
  vi.stubEnv('CABINET_INVITATION_WEB_BASE_URL', 'https://cabinet.bobpro.fr');
  vi.stubEnv('MISTRAL_API_KEY', 'mistral-live-key');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('GLM_API_KEY', '');
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_test');
  vi.stubEnv('STRIPE_PRICE_SOLO', 'price_solo');
  vi.stubEnv('STRIPE_PRICE_PRO', 'price_pro');
  vi.stubEnv('STRIPE_PRICE_BUSINESS', 'price_business');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', `whsec_${'w'.repeat(32)}`);
  vi.stubEnv('STRIPE_LIVEMODE', 'true');
  vi.stubEnv('PAYMENT_RETURN_BASE_URL', 'https://app.bobpro.fr');
}

describe('configuration live — capacités obligatoires sans fallback demo', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepte une composition live complète', () => {
    validLiveEnv();

    expect(loadEnv()).toMatchObject({
      DEMO_MODE: 'false',
      MISTRAL_API_KEY: 'mistral-live-key',
      STRIPE_SECRET_KEY: 'sk_live_test',
      STRIPE_LIVEMODE: 'true',
      PAYMENT_RETURN_BASE_URL: 'https://app.bobpro.fr',
    });
  });

  it('refuse le live sans réconciliation webhook signée et sans mode Stripe explicite', () => {
    validLiveEnv();
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    expect(() => loadEnv()).toThrow(/STRIPE_WEBHOOK_SECRET/u);

    vi.stubEnv('STRIPE_WEBHOOK_SECRET', `whsec_${'w'.repeat(32)}`);
    vi.stubEnv('STRIPE_LIVEMODE', '');
    expect(() => loadEnv()).toThrow(/STRIPE_LIVEMODE/u);
  });

  it('refuse le live sans fournisseur LLM', () => {
    validLiveEnv();
    vi.stubEnv('MISTRAL_API_KEY', '');

    expect(() => loadEnv()).toThrow(/au moins un fournisseur LLM est requis/u);
  });

  it('refuse le live sans moteur OCR même si un autre LLM existe', () => {
    validLiveEnv();
    vi.stubEnv('MISTRAL_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'openai-live-key');

    expect(() => loadEnv()).toThrow(/OCR indisponible/u);
  });

  it('refuse le live sans Stripe complet ou avec une origine de retour démo', () => {
    validLiveEnv();
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(() => loadEnv()).toThrow(/Configuration paiement live incomplète.*STRIPE_SECRET_KEY/u);

    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_test');
    vi.stubEnv('PAYMENT_RETURN_BASE_URL', 'https://demo.bobpro.fr');
    expect(() => loadEnv()).toThrow(/PAYMENT_RETURN_BASE_URL.*non démo/u);
  });

  it('refuse les surfaces web de démonstration dans une composition live', () => {
    validLiveEnv();
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://demo.bobpro.fr');

    expect(() => loadEnv()).toThrow(/SIGN_WEB_BASE_URL.*non démo/u);
  });

  it('conserve le harness sans clés uniquement sur DEMO_MODE=true', () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('MISTRAL_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('STRIPE_SECRET_KEY', '');

    expect(loadEnv().DEMO_MODE).toBe('true');
  });
});

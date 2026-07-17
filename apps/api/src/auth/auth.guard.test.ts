import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { getPrincipal, requestContext, type Principal } from '../observability/logger';
import { SupabaseAuthGuard } from './auth.guard';

// jose est mocké : on teste la POLITIQUE du guard (principal, liste blanche, 403 provisioning),
// pas la crypto — jwtVerify est piloté par chaque test.
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => async () => ({})),
  jwtVerify: vi.fn(),
}));
const jwtVerifyMock = vi.mocked(jwtVerify);

interface TestRequest {
  url: string;
  method?: string;
  headers: Record<string, string | undefined>;
}

function ctx(req: TestRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

/** Exécute canActivate dans un contexte de requête ALS et capture le Principal posé. */
async function activate(
  guard: SupabaseAuthGuard,
  req: TestRequest,
): Promise<{ allowed: boolean; principal: Principal | undefined }> {
  return requestContext.run({ correlationId: 'test' }, async () => {
    const allowed = await guard.canActivate(ctx(req));
    return { allowed, principal: getPrincipal() };
  });
}

const BEARER = { authorization: 'Bearer jwt-de-test' };

describe('SupabaseAuthGuard — prod (JWT Supabase, C24b provisioning)', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', 'false');
    vi.stubEnv('SUPABASE_JWKS_URL', 'https://exemple.supabase.co/auth/v1/.well-known/jwks.json');
    jwtVerifyMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function payload(companyId?: unknown): { payload: Record<string, unknown> } {
    return {
      payload: {
        sub: 'a1b2c3d4-0000-4000-8000-1234567890ab',
        ...(companyId !== undefined ? { app_metadata: { company_id: companyId } } : {}),
      },
    };
  }

  it('JWT valide AVEC company_id conforme : principal complet, accès tenant', async () => {
    jwtVerifyMock.mockResolvedValue(payload('company-a1b2') as never);
    const r = await activate(new SupabaseAuthGuard(), { url: '/quotes', method: 'GET', headers: BEARER });
    expect(r.allowed).toBe(true);
    expect(r.principal).toEqual({ userId: 'a1b2c3d4-0000-4000-8000-1234567890ab', companyId: 'company-a1b2' });
  });

  it('JWT valide SANS company_id sur un endpoint tenant : 403 PROVISIONING_REQUIRED — plus JAMAIS le tenant démo', async () => {
    jwtVerifyMock.mockResolvedValue(payload() as never);
    const guard = new SupabaseAuthGuard();
    await requestContext.run({ correlationId: 'test' }, async () => {
      let thrown: unknown = null;
      try {
        await guard.canActivate(ctx({ url: '/quotes', method: 'GET', headers: BEARER }));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as ForbiddenException).getResponse()).toMatchObject({ code: 'PROVISIONING_REQUIRED' });
      // Aucun principal Mercier posé en douce : le repli cross-tenant est mort.
      expect(getPrincipal()).toBeUndefined();
    });
  });

  it('company_id NON CONFORME (métacaractères) : traité comme absent → 403, jamais utilisé', async () => {
    jwtVerifyMock.mockResolvedValue(payload("mercier'; DROP TABLE companies;--") as never);
    const guard = new SupabaseAuthGuard();
    await expect(
      requestContext.run({ correlationId: 'test' }, () =>
        guard.canActivate(ctx({ url: '/customers', method: 'GET', headers: BEARER })),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('PUBLIC inscription : GET /company/lookup passe SANS Authorization (pas encore de compte à l’étape SIRET)', async () => {
    const guard = new SupabaseAuthGuard();

    const anonymous = await activate(guard, { url: '/company/lookup?siret=73282932000074', method: 'GET', headers: {} });
    expect(anonymous.allowed).toBe(true);
    expect(anonymous.principal).toBeUndefined(); // public : aucun principal, aucune donnée tenant derrière

    // Un Bearer statique/invalide (EXPO_PUBLIC_API_TOKEN de dev) ne doit PAS casser l'endpoint public :
    // la route est traitée AVANT toute vérification du header.
    jwtVerifyMock.mockRejectedValue(new Error('jamais appelé'));
    const staleBearer = await activate(guard, { url: '/company/lookup?siret=1', method: 'GET', headers: BEARER });
    expect(staleBearer.allowed).toBe(true);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('PUBLIC push : seul POST /public/push-revocations passe sans JWT', async () => {
    const guard = new SupabaseAuthGuard();
    const exact = await activate(guard, {
      url: '/public/push-revocations',
      method: 'POST',
      headers: {},
    });
    expect(exact.allowed).toBe(true);
    expect(exact.principal).toBeUndefined();

    await expect(activate(guard, {
      url: '/public/push-revocations/extra',
      method: 'POST',
      headers: {},
    })).resolves.toMatchObject({ allowed: false });
    await expect(activate(guard, {
      url: '/public/push-revocations',
      method: 'GET',
      headers: {},
    })).resolves.toMatchObject({ allowed: false });
    await expect(activate(guard, {
      url: '/public/push-revocations?revocationSecret=interdit',
      method: 'POST',
      headers: {},
    })).resolves.toMatchObject({ allowed: false });
  });

  it('liste blanche tenant-optionnel : POST /onboarding/company exige un JWT VALIDE, companyId null admis', async () => {
    jwtVerifyMock.mockResolvedValue(payload() as never);
    const guard = new SupabaseAuthGuard();

    const onboarding = await activate(guard, { url: '/onboarding/company', method: 'POST', headers: BEARER });
    expect(onboarding.allowed).toBe(true);
    expect(onboarding.principal).toEqual({ userId: 'a1b2c3d4-0000-4000-8000-1234567890ab', companyId: null });

    // SANS JWT : refus — le provisioning a besoin du userId signé (id déterministe + app_metadata).
    const anonymous = await activate(guard, { url: '/onboarding/company', method: 'POST', headers: {} });
    expect(anonymous.allowed).toBe(false);
  });

  it('routes Cabinet : JWT = identité seulement, company_id absent admis et claims cabinet/role ignorés', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'expert-1',
        email: 'EXPERT@EXAMPLE.COM',
        email_verified: true,
        app_metadata: { cabinet_id: 'cabinet-piege', role: 'admin' },
      },
    } as never);

    const result = await activate(new SupabaseAuthGuard(), {
      url: '/cabinet/v1/cabinets/cabinet-cible/members',
      method: 'GET',
      headers: BEARER,
    });

    expect(result.allowed).toBe(true);
    expect(result.principal).toEqual({
      userId: 'expert-1',
      companyId: null,
      email: 'expert@example.com',
      emailVerified: true,
    });
  });

  it('user_metadata.email_verified, contrôlable par le user, ne vaut jamais preuve de vérification', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'expert-1',
        email: 'expert@example.com',
        user_metadata: { email_verified: true },
      },
    } as never);
    const result = await activate(new SupabaseAuthGuard(), {
      url: '/cabinet/v1/cabinets',
      method: 'GET',
      headers: BEARER,
    });
    expect(result.allowed).toBe(true);
    expect(result.principal).toMatchObject({ email: 'expert@example.com', emailVerified: false });
  });

  it('les listes blanches sont STRICTES : autre méthode ou autre chemin → refus/403', async () => {
    jwtVerifyMock.mockResolvedValue(payload() as never);
    const guard = new SupabaseAuthGuard();
    // POST /company/lookup n'est PAS public (seul GET l'est) : JWT sans tenant → 403 provisioning.
    await expect(
      requestContext.run({ correlationId: 'test' }, () =>
        guard.canActivate(ctx({ url: '/company/lookup', method: 'POST', headers: BEARER })),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      requestContext.run({ correlationId: 'test' }, () =>
        guard.canActivate(ctx({ url: '/onboarding/company/extra', method: 'POST', headers: BEARER })),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('JWT invalide : refus simple (false ≠ 403 provisioning) ; Bearer absent : refus', async () => {
    jwtVerifyMock.mockRejectedValue(new Error('signature invalide'));
    const guard = new SupabaseAuthGuard();
    const bad = await activate(guard, { url: '/quotes', method: 'GET', headers: BEARER });
    expect(bad.allowed).toBe(false);
    expect(bad.principal).toBeUndefined();

    const missing = await activate(guard, { url: '/quotes', method: 'GET', headers: {} });
    expect(missing.allowed).toBe(false);
  });

  it('DEMO_MODE et les headers de harness ne contournent jamais le JWT', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const result = await activate(new SupabaseAuthGuard(), {
      url: '/quotes',
      method: 'GET',
      headers: {
        'x-company-id': 'company-piege',
        'x-demo-user-id': 'user-piege',
        'x-demo-user-email': 'piege@example.com',
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.principal).toBeUndefined();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('infra publique sans principal : /health et /public/sign/ seulement', async () => {
    const guard = new SupabaseAuthGuard();
    for (const url of ['/health', '/health/ready', '/public/sign/tok-1']) {
      const r = await activate(guard, { url, method: 'GET', headers: {} });
      expect(r.allowed).toBe(true);
      expect(r.principal).toBeUndefined();
    }
    expect((await activate(guard, { url: '/health-anything', method: 'GET', headers: {} })).allowed).toBe(false);
  });

  it('/metrics est fail-closed en live et accepte uniquement le secret dédié', async () => {
    const token = 'm'.repeat(40);
    vi.stubEnv('METRICS_TOKEN', token);
    const guard = new SupabaseAuthGuard();

    expect((await activate(guard, { url: '/metrics', method: 'GET', headers: {} })).allowed).toBe(false);
    expect(
      (await activate(guard, { url: '/metrics', method: 'GET', headers: { authorization: 'Bearer mauvais' } })).allowed,
    ).toBe(false);
    expect(
      (await activate(guard, { url: '/metrics', method: 'GET', headers: { authorization: `Bearer ${token}` } })).allowed,
    ).toBe(true);
  });
});

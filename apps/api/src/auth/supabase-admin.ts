import { type Provider } from '@nestjs/common';
import { AppLogger } from '../observability/logger';

export const SUPABASE_ADMIN = Symbol('SUPABASE_ADMIN');

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Port d'administration Supabase Auth (C24b — provisioning tenant).
 * Une seule capacité, volontairement étroite : rattacher un user à SON tenant fraîchement créé.
 */
export interface SupabaseAdminPort {
  /** Écrit app_metadata.company_id sur le user (les autres clés d'app_metadata sont préservées). */
  setUserCompanyId(userId: string, companyId: string): Promise<void>;
}

interface SupabaseAdminOptions {
  url: string;
  serviceRoleKey: string;
}

/**
 * Adapter GoTrue Admin API (clé service_role) : PUT /auth/v1/admin/users/{id}.
 * VÉRIFIÉ (gotrue models.User.UpdateAppMetaData) : le PUT FUSIONNE app_metadata clé par clé
 * (shallow merge, une valeur null supprime la clé) — poser { app_metadata: { company_id } }
 * préserve `provider`/`providers` et toute clé existante ; pas besoin d'un GET préalable.
 */
export class HttpSupabaseAdmin implements SupabaseAdminPort {
  constructor(
    private readonly logger: AppLogger,
    private readonly opts: SupabaseAdminOptions,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async setUserCompanyId(userId: string, companyId: string): Promise<void> {
    const base = this.opts.url.replace(/\/$/, '');
    const res = await this.fetchFn(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: {
        apikey: this.opts.serviceRoleKey,
        authorization: `Bearer ${this.opts.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ app_metadata: { company_id: companyId } }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Supabase admin HTTP ${res.status} (PUT app_metadata.company_id)`);
    this.logger.audit('auth.company_id_provisioned', { userId, companyId });
  }
}

/**
 * Env absente : CHAQUE provisioning échoue EXPLICITEMENT (pattern MisconfiguredEmailNotifier) —
 * jamais un faux succès silencieux. En démo le chemin provisioning n'est jamais atteint
 * (le guard pose toujours un tenant), donc pas d'implémentation « démo » qui masquerait un bug.
 */
export class MisconfiguredSupabaseAdmin implements SupabaseAdminPort {
  async setUserCompanyId(): Promise<void> {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants — provisioning du tenant impossible (configurer l’admin Supabase).',
    );
  }
}

export function buildSupabaseAdmin(logger: AppLogger): SupabaseAdminPort {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return new MisconfiguredSupabaseAdmin();
  return new HttpSupabaseAdmin(logger, { url, serviceRoleKey });
}

export const supabaseAdminProvider: Provider = {
  provide: SUPABASE_ADMIN,
  inject: [AppLogger],
  useFactory: buildSupabaseAdmin,
};

import { type Provider } from '@nestjs/common';
import { parseIanaTimeZone } from '@bob/core';
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
  /**
   * Écrit atomiquement la préférence conversationnelle confirmée et son binding tenant.
   * Optionnelle uniquement pour préserver les doubles de bounded contexts qui ne démarrent jamais
   * Bob Live ; l'orchestrateur échoue fermé si la capacité manque.
   */
  setUserConfirmedTimeZone?(
    userId: string,
    companyId: string,
    timeZone: string,
    confirmedAt: string,
  ): Promise<void>;
  /** Source serveur pour l'acceptation d'invitation ; null tant que l'email n'est pas confirmé. */
  getVerifiedEmail?(userId: string): Promise<string | null>;
  /** Enrichissement d'affichage uniquement ; ne participe jamais au RBAC. */
  getUserIdentity?(userId: string): Promise<{ email: string | null; displayName: string | null }>;
  /**
   * Clôture de compte (CloseAccount, Apple 5.1.1(v)) — supprime le user GoTrue : c'est LE point
   * où l'identité personnelle (email, téléphone, user_metadata.first_name…) disparaît réellement,
   * puisque Postgres ne stocke jamais ces données (cf. Company.closedAt). Idempotent côté appelant
   * (BackendService.closeAccount) : un 404 GoTrue (déjà supprimé) est traité comme un succès.
   */
  deleteUser(userId: string): Promise<void>;
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

  async setUserConfirmedTimeZone(
    userId: string,
    companyId: string,
    timeZone: string,
    confirmedAt: string,
  ): Promise<void> {
    const canonicalTimeZone = parseIanaTimeZone(timeZone);
    const parsedConfirmedAt = new Date(confirmedAt);
    if (
      canonicalTimeZone === null ||
      Number.isNaN(parsedConfirmedAt.getTime()) ||
      parsedConfirmedAt.toISOString() !== confirmedAt
    ) {
      throw new Error('Confirmation de fuseau invalide avant écriture Supabase Admin.');
    }

    const base = this.opts.url.replace(/\/$/, '');
    const res = await this.fetchFn(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: {
        apikey: this.opts.serviceRoleKey,
        authorization: `Bearer ${this.opts.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        app_metadata: {
          bob_time_zone: canonicalTimeZone,
          bob_time_zone_confirmed_at: confirmedAt,
          bob_time_zone_company_id: companyId,
        },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      throw new Error(`Supabase admin HTTP ${res.status} (PUT app_metadata.bob_time_zone)`);
    }
    this.logger.audit('auth.time_zone_confirmed', {
      userId,
      companyId,
      timeZone: canonicalTimeZone,
      confirmedAt,
    });
  }

  async getVerifiedEmail(userId: string): Promise<string | null> {
    const user = await this.getAdminUser(userId);
    if (typeof user.email !== 'string' || typeof user.email_confirmed_at !== 'string' || !user.email_confirmed_at) {
      return null;
    }
    return user.email.trim().toLowerCase();
  }

  async getUserIdentity(userId: string): Promise<{ email: string | null; displayName: string | null }> {
    const user = await this.getAdminUser(userId);
    const metadata = user.user_metadata && typeof user.user_metadata === 'object'
      ? user.user_metadata as Record<string, unknown>
      : {};
    const displayName = [metadata.full_name, metadata.name].find((value): value is string => typeof value === 'string');
    return {
      email: typeof user.email === 'string' ? user.email.trim().toLowerCase() : null,
      displayName: displayName?.trim() || null,
    };
  }

  /** DELETE /auth/v1/admin/users/{id} — best-effort côté appelant : un 404 (déjà supprimé, retry
   *  de provisioning idempotent) n'est PAS une erreur, tout le reste (401/403/5xx…) en est une. */
  async deleteUser(userId: string): Promise<void> {
    const base = this.opts.url.replace(/\/$/, '');
    const res = await this.fetchFn(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: {
        apikey: this.opts.serviceRoleKey,
        authorization: `Bearer ${this.opts.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Supabase admin HTTP ${res.status} (DELETE user)`);
    this.logger.audit('auth.user_deleted', { userId, alreadyGone: res.status === 404 });
  }

  private async getAdminUser(userId: string): Promise<{
    email?: unknown;
    email_confirmed_at?: unknown;
    user_metadata?: unknown;
  }> {
    const base = this.opts.url.replace(/\/$/, '');
    const res = await this.fetchFn(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: {
        apikey: this.opts.serviceRoleKey,
        authorization: `Bearer ${this.opts.serviceRoleKey}`,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Supabase admin HTTP ${res.status} (GET verified identity)`);
    return (await res.json()) as { email?: unknown; email_confirmed_at?: unknown; user_metadata?: unknown };
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
  async getVerifiedEmail(): Promise<string | null> {
    throw new Error('Supabase Admin non configuré — vérification serveur de l’email impossible.');
  }
  async setUserConfirmedTimeZone(): Promise<void> {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants — confirmation du fuseau impossible.',
    );
  }
  async getUserIdentity(): Promise<{ email: string | null; displayName: string | null }> {
    throw new Error('Supabase Admin non configuré — annuaire des identités indisponible.');
  }
  async deleteUser(): Promise<void> {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants — suppression du user impossible.');
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

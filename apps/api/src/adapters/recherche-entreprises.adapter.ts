import {
  frenchVatNumber,
  nafToTrade,
  natureJuridiqueToLegalForm,
  type CompanyLookupPort,
  type CompanyLookupResult,
} from '@bob/core';

/** Erreur de dépendance amont (API indisponible/throttlée) — distincte d'un « non trouvé » (null). */
export class CompanyLookupUnavailableError extends Error {
  constructor(cause: string) {
    super(cause);
    this.name = 'CompanyLookupUnavailableError';
  }
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // SIRET = clé stable -> cache long
const CACHE_MAX = 500;

/**
 * Adapter réel du CompanyLookupPort sur l'API publique Recherche d'entreprises (gratuite, sans clé).
 * https://recherche-entreprises.api.gouv.fr — 7 req/s par IP (429 + Retry-After).
 *
 * - Cache mémoire (TTL 24 h) des résultats trouvés : absorbe les hits répétés, protège le quota amont.
 * - Cooldown process-wide sur 429 (respecte Retry-After) : on cesse de marteler l'API pendant le throttle.
 * - Sémantique : `null` = entreprise introuvable (HTTP 200, 0 résultat) ; on LÈVE CompanyLookupUnavailableError
 *   en cas de panne amont (timeout, 429, 5xx, JSON corrompu) pour que l'app distingue « introuvable »
 *   d'« indisponible » (saisie manuelle).
 * - URL configurable (env) mais validée (https) au démarrage (anti-SSRF de configuration).
 */
export class RechercheEntreprisesAdapter implements CompanyLookupPort {
  private static cooldownUntil = 0;
  private static cache = new Map<string, { value: CompanyLookupResult; exp: number }>();

  constructor(
    private readonly baseUrl = process.env.RECHERCHE_ENTREPRISES_URL ?? 'https://recherche-entreprises.api.gouv.fr',
    private readonly timeoutMs = 5000,
  ) {
    let u: URL;
    try {
      u = new URL(this.baseUrl);
    } catch {
      throw new Error(`RECHERCHE_ENTREPRISES_URL invalide: ${this.baseUrl}`);
    }
    if (u.protocol !== 'https:') throw new Error(`RECHERCHE_ENTREPRISES_URL doit être en https: ${this.baseUrl}`);
  }

  /** #6 : le même endpoint /search accepte un SIREN — on confirme l'existence sans bloquer. */
  async verifySiren(siren: string): Promise<boolean | null> {
    const v = siren.replace(/\s/g, '');
    if (!/^\d{9}$/.test(v)) return false;
    try {
      const result = await this.lookupBySiret(v);
      if (result === null) return false;
      return result.siren === v || result.siret.startsWith(v);
    } catch {
      return null; // annuaire indisponible : on ne décide rien (le SIREN Luhn-valide reste)
    }
  }

  async lookupBySiret(siret: string): Promise<CompanyLookupResult | null> {
    const v = siret.replace(/\s/g, '');

    const cached = RechercheEntreprisesAdapter.cache.get(v);
    if (cached && cached.exp > nowMs()) return cached.value;

    if (nowMs() < RechercheEntreprisesAdapter.cooldownUntil)
      throw new CompanyLookupUnavailableError('Service entreprises temporairement indisponible (throttle).');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/search?q=${encodeURIComponent(v)}&per_page=1`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      throw new CompanyLookupUnavailableError(e instanceof Error ? e.message : 'réseau');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      RechercheEntreprisesAdapter.cooldownUntil = nowMs() + retryAfter * 1000;
      throw new CompanyLookupUnavailableError('Quota API entreprises atteint.');
    }
    if (!res.ok) throw new CompanyLookupUnavailableError(`HTTP ${res.status}`);

    let data: RechercheEntreprisesResponse;
    try {
      data = (await res.json()) as RechercheEntreprisesResponse;
    } catch {
      throw new CompanyLookupUnavailableError('Réponse amont illisible.');
    }

    const r = data.results?.[0];
    if (!r) return null; // 200 + 0 résultat = réellement introuvable

    const siege = r.siege ?? {};
    const naf = r.activite_principale ?? null;
    const line1 =
      [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(' ').trim() || (siege.adresse ?? '');
    const address =
      siege.code_postal && siege.libelle_commune ? { line1, zip: siege.code_postal, city: siege.libelle_commune } : null;
    const siren = r.siren ?? v.slice(0, 9);
    const tva = Array.isArray(r.tva) ? r.tva[0] : typeof r.tva === 'string' ? r.tva : null;
    // Fiche société COMPLÈTE (C24b) : nature_juridique (code INSEE, ex. 5710) + date_creation
    // (ISO) sont renvoyés par l'API réelle — on les remonte, mappés prudemment (code inconnu →
    // null, l'utilisateur choisit). PAS de dirigeants : minimisation RGPD, inutile pour facturer.
    const natureJuridique = typeof r.nature_juridique === 'string' && r.nature_juridique ? r.nature_juridique : null;
    const dateCreation =
      typeof r.date_creation === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.date_creation)
        ? r.date_creation.slice(0, 10)
        : null;
    const result: CompanyLookupResult = {
      siren,
      siret: siege.siret ?? v,
      denomination: r.nom_complet ?? r.nom_raison_sociale ?? `Entreprise ${siren}`,
      nafApe: naf,
      trade: nafToTrade(naf),
      natureJuridiqueCode: natureJuridique,
      legalForm: natureJuridiqueToLegalForm(natureJuridique),
      dateCreation,
      address,
      tvaIntracom: tva ?? (/^\d{9}$/.test(siren) ? frenchVatNumber(siren) : null),
      rge: Boolean(r.complements?.est_rge),
    };

    if (RechercheEntreprisesAdapter.cache.size >= CACHE_MAX)
      RechercheEntreprisesAdapter.cache.delete(RechercheEntreprisesAdapter.cache.keys().next().value as string);
    RechercheEntreprisesAdapter.cache.set(v, { value: result, exp: nowMs() + CACHE_TTL_MS });
    return result;
  }
}

function nowMs(): number {
  return new Date().getTime();
}

interface RechercheEntreprisesResponse {
  results?: Array<{
    siren?: string;
    nom_complet?: string;
    nom_raison_sociale?: string;
    activite_principale?: string;
    nature_juridique?: string;
    date_creation?: string;
    tva?: string[] | string | null;
    complements?: { est_rge?: boolean };
    siege?: {
      siret?: string;
      adresse?: string;
      code_postal?: string;
      libelle_commune?: string;
      numero_voie?: string;
      type_voie?: string;
      libelle_voie?: string;
    };
  }>;
}

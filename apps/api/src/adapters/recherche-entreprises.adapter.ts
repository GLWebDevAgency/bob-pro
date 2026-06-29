import { frenchVatNumber, nafToTrade, type CompanyLookupPort, type CompanyLookupResult } from '@bob/core';

/**
 * Adapter réel du CompanyLookupPort sur l'API publique Recherche d'entreprises (gratuite, sans clé).
 * https://recherche-entreprises.api.gouv.fr — 7 req/s par IP (429 + Retry-After).
 * URL configurable (env) pour pointer un miroir/cache si besoin. Dégradation gracieuse : renvoie null en cas d'échec.
 */
export class RechercheEntreprisesAdapter implements CompanyLookupPort {
  constructor(
    private readonly baseUrl = process.env.RECHERCHE_ENTREPRISES_URL ?? 'https://recherche-entreprises.api.gouv.fr',
    private readonly timeoutMs = 5000,
  ) {}

  async lookupBySiret(siret: string): Promise<CompanyLookupResult | null> {
    const v = siret.replace(/\s/g, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/search?q=${encodeURIComponent(v)}&per_page=1`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as RechercheEntreprisesResponse;
      const r = data.results?.[0];
      if (!r) return null;
      const siege = r.siege ?? {};
      const naf = r.activite_principale ?? null;
      const line1 =
        [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(' ').trim() ||
        (siege.adresse ?? '');
      const address =
        siege.code_postal && siege.libelle_commune
          ? { line1, zip: siege.code_postal, city: siege.libelle_commune }
          : null;
      const siren = r.siren ?? v.slice(0, 9);
      const tva = Array.isArray(r.tva) ? r.tva[0] : typeof r.tva === 'string' ? r.tva : null;
      return {
        siren,
        siret: siege.siret ?? v,
        denomination: r.nom_complet ?? r.nom_raison_sociale ?? `Entreprise ${siren}`,
        nafApe: naf,
        trade: nafToTrade(naf),
        address,
        tvaIntracom: tva ?? (/^\d{9}$/.test(siren) ? frenchVatNumber(siren) : null),
        rge: Boolean(r.complements?.est_rge),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface RechercheEntreprisesResponse {
  results?: Array<{
    siren?: string;
    nom_complet?: string;
    nom_raison_sociale?: string;
    activite_principale?: string;
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

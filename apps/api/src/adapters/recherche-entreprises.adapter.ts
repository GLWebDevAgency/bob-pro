import {
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
    const officialSiren = digitsOf(r.siren);
    const siegeSiret = digitsOf(siege.siret);

    // Identité EXACTE, jamais un à-peu-près. Le siège d'abord — chemin historique, inchangé :
    // requête à 9 chiffres = SIREN de l'entreprise, requête à 14 chiffres = SIRET du siège.
    const siegeMatches = v.length === 9 ? officialSiren === v : siegeSiret === v;

    // Sinon l'établissement SECONDAIRE : l'amont le publie dans `matching_etablissements`, le
    // tableau prévu pour les établissements correspondant à la requête. Ne comparer qu'au siège
    // rejetait en `null` (404) tout SIRET secondaire pourtant parfaitement connu de l'annuaire —
    // c'était le bug de production corrigé ici. Un SIREN (9 chiffres) ne s'y résout jamais : il
    // désigne l'entreprise, donc son siège.
    const secondaire =
      siegeMatches || v.length === 9
        ? null
        : ((r.matching_etablissements ?? []).find((e) => digitsOf(e.siret) === v) ?? null);

    // Aucune correspondance EXACTE nulle part = réellement introuvable. Une entreprise renvoyée
    // « à peu près » n'est jamais attribuée au compte.
    if (!siegeMatches && !secondaire) return null;

    const etablissement = secondaire ?? siege;
    const officialSiret = secondaire ? v : siegeSiret;

    if (!/^\d{9}$/u.test(officialSiren) || !/^\d{14}$/u.test(officialSiret)) {
      throw new CompanyLookupUnavailableError('Réponse amont incomplète : identité officielle absente.');
    }
    // Toute identité renvoyée doit être cohérente, y compris le siège. Une réponse amont qui
    // associe un SIRET à un autre SIREN est une panne NOMMÉE, jamais un « introuvable » ni une
    // identité appliquée à la fiche.
    if (!officialSiret.startsWith(officialSiren)) {
      throw new CompanyLookupUnavailableError('Réponse amont incohérente : établissement hors du SIREN annoncé.');
    }
    const denominationCandidate =
      typeof r.nom_complet === 'string'
        ? r.nom_complet
        : typeof r.nom_raison_sociale === 'string'
          ? r.nom_raison_sociale
          : '';
    const denomination = denominationCandidate.trim();
    if (!denomination) {
      throw new CompanyLookupUnavailableError('Réponse amont incomplète : raison sociale absente.');
    }
    // L'activité est celle de l'ÉTABLISSEMENT retenu. L'unité légale peut porter un NAF très
    // différent (ex. holding/commerçant vs établissement immobilier) : son NAF n'est qu'un
    // repli explicite lorsque l'amont omet celui de l'établissement.
    const nafCandidate = etablissement.activite_principale ?? r.activite_principale;
    const naf =
      typeof nafCandidate === 'string' && nafCandidate.trim() !== ''
        ? nafCandidate.trim()
        : null;
    // L'ADRESSE SUIT L'ÉTABLISSEMENT retenu : servir celle du siège pour un établissement
    // secondaire ferait facturer à la mauvaise adresse, en silence. Si l'amont ne publie pas
    // l'adresse de CET établissement, on rend `null` — on ne la remplace pas par celle du siège.
    const address = addressOf(etablissement);
    const siren = officialSiren;
    const firstTva = Array.isArray(r.tva) ? r.tva[0] : r.tva;
    const tva = typeof firstTva === 'string' && firstTva.trim() !== '' ? firstTva.trim() : null;
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
      siret: officialSiret,
      denomination,
      nafApe: naf,
      trade: nafToTrade(naf),
      natureJuridiqueCode: natureJuridique,
      legalForm: natureJuridiqueToLegalForm(natureJuridique),
      dateCreation,
      address,
      // L'algorithme de clé ne prouve pas qu'un numéro a été attribué. On conserve uniquement
      // la valeur réellement renvoyée par la source officielle ; absence = null.
      tvaIntracom: tva,
      // Un établissement FERMÉ n'est pas refusé (ce serait indiscernable d'un « introuvable »)
      // mais il est NOMMÉ, pour que l'appelant avertisse avant d'en faire un client.
      etatAdministratif: etatAdministratifOf(etablissement),
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

function digitsOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s/gu, '') : '';
}

/** Adresse d'un établissement quelconque (siège ou secondaire) — même forme amont, même lecture. */
function addressOf(e: RechercheEntreprisesEtablissement): { line1: string; zip: string; city: string } | null {
  const zip = typeof e.code_postal === 'string' ? e.code_postal.trim() : '';
  const city = typeof e.libelle_commune === 'string' ? e.libelle_commune.trim() : '';
  if (!zip || !city) return null;
  const structured = [e.numero_voie, e.type_voie, e.libelle_voie]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();
  // Le siège publie les champs de voie structurés ; `matching_etablissements`, NON — il ne donne
  // que `adresse`, une chaîne qui contient DÉJÀ le code postal et la commune. La recopier telle
  // quelle dans line1 imprimerait « 280 RUE DE PARIS 93100 MONTREUIL » PUIS « 93100 MONTREUIL »
  // sur la facture : on retire le suffixe redondant.
  const line1 =
    structured ||
    withoutZipCity(typeof e.adresse === 'string' ? e.adresse : '', zip, city);
  // Un code postal et une commune ne constituent pas une adresse de facturation. Retourner une
  // line1 vide ferait passer une adresse incomplète pour une adresse officielle disponible.
  if (!line1) return null;
  return { line1, zip, city };
}

/** Retire le « <cp> <commune> » final d'une adresse à plat, sans rien inventer si absent. */
function withoutZipCity(adresse: string, zip: string, city: string): string {
  const raw = adresse.replace(/\s+/gu, ' ').trim();
  const suffix = `${zip} ${city}`;
  return raw.toUpperCase().endsWith(suffix.toUpperCase()) ? raw.slice(0, raw.length - suffix.length).trim() : raw;
}

/** 'A' actif · 'F' fermé · null si la source ne le dit pas (on n'invente pas un état). */
function etatAdministratifOf(e: RechercheEntreprisesEtablissement): 'A' | 'F' | null {
  return e.etat_administratif === 'A' || e.etat_administratif === 'F' ? e.etat_administratif : null;
}

/**
 * Établissement tel que publié par l'amont. Le siège et les `matching_etablissements` partagent
 * la MÊME forme : c'est ce qui permet de faire suivre l'adresse et l'état à l'établissement
 * réellement demandé, sans code dupliqué.
 */
interface RechercheEntreprisesEtablissement {
  siret?: string;
  adresse?: string;
  code_postal?: string;
  libelle_commune?: string;
  numero_voie?: string;
  type_voie?: string;
  libelle_voie?: string;
  /** Activité principale de CET établissement, distincte de celle de l'unité légale. */
  activite_principale?: string;
  /** 'A' = actif · 'F' = fermé. */
  etat_administratif?: string;
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
    siege?: RechercheEntreprisesEtablissement;
    /**
     * Établissements correspondant à la requête. C'est ICI que l'amont place un SIRET
     * d'établissement SECONDAIRE : le champ était reçu et jamais lu, d'où le 404.
     */
    matching_etablissements?: RechercheEntreprisesEtablissement[];
  }>;
}

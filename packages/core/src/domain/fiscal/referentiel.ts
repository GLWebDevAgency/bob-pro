import { type DateOnly } from '../../shared-kernel/time';

/**
 * RÉFÉRENTIEL TEMPOREL du profil fiscal (SPEC_EXPERT_FISCAL.md §V2 point 3) — généralise le
 * pattern LATE_PENALTY_RATES/MICRO_SOCIAL_RATES (domain/dunning/late-penalties.ts,
 * domain/fiscal/micro-social.ts) à des DATES D'EFFET EXACTES plutôt qu'un simple millésime
 * annuel/semestriel : une clé (ex. « pfu_rate_pct ») porte plusieurs entrées, chacune valable sur
 * une fenêtre [effectiveFrom, effectiveTo[ (borne haute exclusive, absente = toujours en vigueur).
 *
 * V1 = seuils D'AFFICHAGE UNIQUEMENT (jamais une entrée dans un calcul monétaire — le moteur de
 * calcul viendra de Publicodes serveur, cf. SPIKE_PUBLICODES_20260715.md : « le LLM/le code Bob
 * n'invente jamais un taux, ne calcule jamais »). Les valeurs sont en EUROS ou en % selon la clé
 * (jamais en centimes) — documenté par clé ci-dessous.
 *
 * `resolveParameter(key, date)` ne renvoie JAMAIS une valeur inventée : hors de toute fenêtre
 * connue pour une clé, il retombe sur l'entrée connue la plus proche et signale `stale: true` —
 * exactement le contrat de resolveMicroSocialRates/resolvePenaltyRates.
 */

export interface TemporalParameterSource {
  readonly label: string;
  readonly url: string;
}

export interface TemporalParameter {
  readonly key: string;
  /** En euros ou en points de %, selon la clé — jamais en centimes (référentiel d'AFFICHAGE). */
  readonly value: number;
  readonly effectiveFrom: DateOnly;
  /** Borne EXCLUSIVE — absente = toujours en vigueur (dernière valeur connue pour cette clé). */
  readonly effectiveTo?: DateOnly;
  readonly source: TemporalParameterSource;
  /** Date de vérification humaine de cette entrée contre la source officielle citée. */
  readonly verifiedAt: DateOnly;
}

// ── Clés V1 ───────────────────────────────────────────────────────────────────
// Chaque clé documente son UNITÉ et sa SOURCE — aucune valeur ci-dessous n'est inventée.

/** Plafond de CA micro-BIC — vente de marchandises/hébergement (art. 50-0 CGI). Unité : euros. */
export const KEY_MICRO_CEILING_VENTE = 'micro_ceiling_vente_eur';
/** Plafond de CA micro-BIC/BNC — prestations de services (art. 50-0/102 ter CGI). Unité : euros. */
export const KEY_MICRO_CEILING_SERVICES = 'micro_ceiling_services_eur';
/** Seuil de BASE franchise TVA — ventes/hébergement (art. 293 B CGI). Unité : euros. */
export const KEY_VAT_FRANCHISE_BASE_VENTE = 'vat_franchise_base_vente_eur';
/** Seuil MAJORÉ franchise TVA — ventes/hébergement (art. 293 B CGI). Unité : euros. */
export const KEY_VAT_FRANCHISE_MAJORE_VENTE = 'vat_franchise_majore_vente_eur';
/** Seuil de BASE franchise TVA — services/professions libérales (art. 293 B CGI). Unité : euros. */
export const KEY_VAT_FRANCHISE_BASE_SERVICES = 'vat_franchise_base_services_eur';
/** Seuil MAJORÉ franchise TVA — services/professions libérales (art. 293 B CGI). Unité : euros. */
export const KEY_VAT_FRANCHISE_MAJORE_SERVICES = 'vat_franchise_majore_services_eur';
/** Taux du PFU (« flat tax ») sur les dividendes — IR 12,8 % + prélèvements sociaux. Unité : %. */
export const KEY_PFU_RATE = 'pfu_rate_pct';
/**
 * ACRE micro-entrepreneur — part du taux social PLEIN restant DUE pendant l'exonération
 * (= 100 % − exonération ; même grandeur que MICRO_ACRE_REDUCTION_STEPS.factor, domain/fiscal/
 * micro-social.ts — dupliquée ici pour l'affichage générique par clé du référentiel temporel ;
 * toute évolution DOIT mettre à jour les DEUX tables). Indexée sur la DATE DE DÉBUT D'ACTIVITÉ,
 * pas sur la date du jour — au même titre que resolveAcreReductionFactor. Unité : % du taux plein.
 */
export const KEY_ACRE_DUE_SHARE = 'acre_due_share_pct';

/**
 * Référentiel V1 — chaque entrée cite sa source officielle et sa date de vérification humaine.
 *
 * · Plafonds micro 2023-2025 puis 2026-2028 (revalorisation triennale +7,6 %, art. 50-0/102 ter
 *   CGI, loi de finances pour 2026) : ventes 188 700 € → 203 100 € ; services (BIC ET BNC,
 *   plafond commun) 77 700 € → 83 600 €. Sources vérifiées 2026-07-15 :
 *   https://www.legifiscal.fr/actualites-fiscales/4436-nouveaux-seuils-micro-entreprises-annee-2026.html
 *   https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/toutes-les-actualites/2026--modification-des-seuils-de.html
 * · Franchise TVA 2025-2026 (loi n° 2025-1044 du 3/11/2025 — suppression définitive du seuil
 *   unique 25 000 € envisagé, seuils historiques maintenus) : mêmes montants que
 *   domain/compliance/vat-thresholds.ts (VAT_FRANCHISE_THRESHOLDS_2025) — répétés ici en euros
 *   (le référentiel temporel est un référentiel d'AFFICHAGE, distinct du calcul de statut TVA).
 *   Source vérifiée 2026-07-15 : https://entreprendre.service-public.gouv.fr/actualites/A17995
 * · PFU 31,4 % au 01/01/2026 (art. 12, loi n° 2025-1403 du 30/12/2025 de financement de la
 *   sécurité sociale pour 2026 — CSG capital 9,2 %→10,6 %, IR 12,8 % inchangé) — avant : 30 %.
 *   Source vérifiée 2026-07-15 : https://entreprendre.service-public.gouv.fr/actualites/A18796
 * · ACRE micro : part due 50 %→75 % au 01/07/2026 (décret n° 2026-69 du 6/2/2026, JORF
 *   JORFTEXT000053449085, art. D.131-6-3 CSS) — même source que MICRO_ACRE_REDUCTION_STEPS.
 *   Source vérifiée 2026-07-15 (spike SPIKE_PUBLICODES_20260715.md) :
 *   https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000053449085
 */
export const FISCAL_TEMPORAL_PARAMETERS: readonly TemporalParameter[] = [
  {
    key: KEY_MICRO_CEILING_VENTE,
    value: 188_700,
    effectiveFrom: '2023-01-01',
    effectiveTo: '2026-01-01',
    source: { label: 'Seuils micro-entreprise 2023-2025 (art. 50-0 CGI)', url: 'https://www.legifiscal.fr/actualites-fiscales/4436-nouveaux-seuils-micro-entreprises-annee-2026.html' },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_MICRO_CEILING_VENTE,
    value: 203_100,
    effectiveFrom: '2026-01-01',
    source: {
      label: 'Seuils micro-entreprise 2026-2028, revalorisation triennale +7,6 % (art. 50-0 CGI, LF 2026)',
      url: 'https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/toutes-les-actualites/2026--modification-des-seuils-de.html',
    },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_MICRO_CEILING_SERVICES,
    value: 77_700,
    effectiveFrom: '2023-01-01',
    effectiveTo: '2026-01-01',
    source: { label: 'Seuils micro-entreprise 2023-2025 (art. 50-0/102 ter CGI)', url: 'https://www.legifiscal.fr/actualites-fiscales/4436-nouveaux-seuils-micro-entreprises-annee-2026.html' },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_MICRO_CEILING_SERVICES,
    value: 83_600,
    effectiveFrom: '2026-01-01',
    source: {
      label: 'Seuils micro-entreprise 2026-2028, revalorisation triennale +7,6 % (art. 50-0/102 ter CGI, LF 2026)',
      url: 'https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/toutes-les-actualites/2026--modification-des-seuils-de.html',
    },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_VAT_FRANCHISE_BASE_VENTE,
    value: 85_000,
    effectiveFrom: '2025-01-01',
    source: {
      label: 'Franchise TVA — seuil de base ventes/hébergement (art. 293 B CGI, loi n° 2025-1044)',
      url: 'https://entreprendre.service-public.gouv.fr/actualites/A17995',
    },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_VAT_FRANCHISE_MAJORE_VENTE,
    value: 93_500,
    effectiveFrom: '2025-01-01',
    source: {
      label: 'Franchise TVA — seuil majoré ventes/hébergement (art. 293 B CGI, loi n° 2025-1044)',
      url: 'https://entreprendre.service-public.gouv.fr/actualites/A17995',
    },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_VAT_FRANCHISE_BASE_SERVICES,
    value: 37_500,
    effectiveFrom: '2025-01-01',
    source: {
      label: 'Franchise TVA — seuil de base services/professions libérales (art. 293 B CGI, loi n° 2025-1044)',
      url: 'https://entreprendre.service-public.gouv.fr/actualites/A17995',
    },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_VAT_FRANCHISE_MAJORE_SERVICES,
    value: 41_250,
    effectiveFrom: '2025-01-01',
    source: {
      label: 'Franchise TVA — seuil majoré services/professions libérales (art. 293 B CGI, loi n° 2025-1044)',
      url: 'https://entreprendre.service-public.gouv.fr/actualites/A17995',
    },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_PFU_RATE,
    value: 30,
    effectiveFrom: '1970-01-01',
    effectiveTo: '2026-01-01',
    source: { label: 'PFU 30 % (avant LFSS 2026)', url: 'https://entreprendre.service-public.gouv.fr/actualites/A18796' },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_PFU_RATE,
    value: 31.4,
    effectiveFrom: '2026-01-01',
    source: {
      label: 'PFU 31,4 % — CSG capital 10,6 % (art. 12, loi n° 2025-1403 du 30/12/2025 LFSS 2026)',
      url: 'https://entreprendre.service-public.gouv.fr/actualites/A18796',
    },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_ACRE_DUE_SHARE,
    value: 50,
    effectiveFrom: '1970-01-01',
    effectiveTo: '2026-07-01',
    source: {
      label: 'ACRE micro — part due 50 % (créations avant le 1/7/2026, art. D.131-6-3 CSS)',
      url: 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000053449085',
    },
    verifiedAt: '2026-07-15',
  },
  {
    key: KEY_ACRE_DUE_SHARE,
    value: 75,
    effectiveFrom: '2026-07-01',
    source: {
      label: 'ACRE micro — part due 75 % (créations dès le 1/7/2026, décret n° 2026-69 du 6/2/2026)',
      url: 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000053449085',
    },
    verifiedAt: '2026-07-15',
  },
];

export interface ResolvedTemporalParameter {
  readonly value: number;
  /** true = `date` est hors de TOUTE fenêtre connue pour cette clé : la valeur renvoyée est la
   *  plus proche connue, JAMAIS inventée — l'appelant DOIT afficher l'avertissement. */
  readonly stale: boolean;
  readonly parameter: TemporalParameter;
}

/**
 * Résout la valeur d'une clé à une date donnée : fenêtre exacte si `date` y tombe ; sinon
 * l'entrée dont l'effectiveFrom est le plus proche (antérieur en priorité — la valeur restait en
 * vigueur ; à défaut la plus ancienne connue) — `stale: true` dans ce cas, jamais une valeur
 * inventée. Clé totalement inconnue du référentiel → erreur (bug d'appel, pas un trou de donnée).
 */
export function resolveParameter(key: string, date: DateOnly): ResolvedTemporalParameter {
  const entries = FISCAL_TEMPORAL_PARAMETERS.filter((p) => p.key === key);
  if (entries.length === 0) {
    throw new Error(`resolveParameter: clé inconnue « ${key} » — aucune entrée dans FISCAL_TEMPORAL_PARAMETERS.`);
  }

  const exact = entries.find((p) => p.effectiveFrom <= date && (p.effectiveTo === undefined || date < p.effectiveTo));
  if (exact !== undefined) return { value: exact.value, stale: false, parameter: exact };

  const known = [...entries].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  const before = [...known].reverse().find((p) => p.effectiveFrom <= date);
  const fallback = before ?? known[0];
  if (fallback === undefined) {
    // entries non vide (garde ci-dessus) : inatteignable, mais typé honnêtement.
    throw new Error(`resolveParameter: aucune entrée exploitable pour la clé « ${key} ».`);
  }
  return { value: fallback.value, stale: true, parameter: fallback };
}

export interface TemporalParameterOverlap {
  readonly a: TemporalParameter;
  readonly b: TemporalParameter;
}

/**
 * Détecte les fenêtres qui se chevauchent AU SEIN d'une même clé (chevauchement interdit : une
 * date ne doit jamais résoudre à deux valeurs distinctes en fenêtre exacte). Fonction PURE
 * réutilisable pour valider toute liste candidate, indépendamment de FISCAL_TEMPORAL_PARAMETERS —
 * la table réelle du module en est simplement un cas d'appel testé en intégrité structurelle.
 */
export function findOverlaps(parameters: readonly TemporalParameter[]): TemporalParameterOverlap[] {
  const byKey = new Map<string, TemporalParameter[]>();
  for (const p of parameters) {
    const list = byKey.get(p.key) ?? [];
    list.push(p);
    byKey.set(p.key, list);
  }

  const overlaps: TemporalParameterOverlap[] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a === undefined || b === undefined) continue;
      // a chevauche b si a n'a pas de fin (toujours en vigueur) OU si a se termine après le
      // début de b (bornes : effectiveTo exclusive, donc égalité = pas de chevauchement).
      if (a.effectiveTo === undefined || a.effectiveTo > b.effectiveFrom) {
        overlaps.push({ a, b });
      }
    }
  }
  return overlaps;
}

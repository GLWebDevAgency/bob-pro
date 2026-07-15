import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Instant, type DateOnly } from '../../shared-kernel/time';
import { type LegalForm, type Trade } from '../company/company';
import { microCategoryFromTrade } from './micro-social';

/**
 * PROFIL FISCAL (Phase 1A — SPEC_EXPERT_FISCAL.md §V2 point 2 « profil fiscal riche »).
 *
 * Le cœur de la spec : chaque donnée fiscale porte un STATUT — jamais un fait affiché comme
 * certain alors qu'il est déduit. « Bob simule et explique » (§V2 pt 4) commence ici : une
 * hypothèse dérivée de la forme juridique INSEE n'est PAS une confirmation utilisateur, et une
 * donnée absente ('manquant') ne porte AUCUNE valeur — jamais un champ inventé à zéro/false par
 * défaut silencieux (même philosophie que LATE_PENALTY_RATES/MICRO_SOCIAL_RATES : jamais un
 * chiffre inventé, ici étendu aux FAITS du profil).
 *
 * `legalForm` RÉUTILISE le type LegalForm de domain/company/company.ts (pas de duplication) —
 * mais reste enveloppé dans un FiscalDatum comme les autres champs : Company.legalForm est déjà
 * une donnée établie (INSEE/SIRET), donc la dérivation initiale la pose en 'source_fiable', alors
 * que les champs qui en sont SEULEMENT déduits (régime fiscal, statut social...) restent
 * 'hypothese' tant que l'utilisateur ne les a pas confirmés.
 */

// ── Statuts et enveloppe FiscalDatum ────────────────────────────────────────────

/**
 * · source_fiable — établi par une source externe fiable (INSEE/SIRET, import comptable).
 * · confirme_utilisateur — l'utilisateur a validé/saisi explicitement (voix ou formulaire).
 * · hypothese — dérivée prudemment (ex. forme juridique → régime probable), À CONFIRMER.
 * · manquant — aucune valeur : ne JAMAIS lire `value` sur ce statut (absent du type).
 */
export type FiscalDatumStatus = 'source_fiable' | 'confirme_utilisateur' | 'hypothese' | 'manquant';

/** D'où vient la valeur — traçabilité minimale (voix/formulaire/dérivation/source externe). */
export type FiscalDatumSource =
  | 'insee_siret'
  | 'user_voice'
  | 'user_form'
  | 'derived_legal_form'
  | 'derived_trade'
  | 'system_default';

/**
 * Enveloppe portant le STATUT de chaque champ du profil fiscal. 'manquant' n'a délibérément
 * AUCUN champ `value` (union discriminée) : impossible d'en lire une valeur inventée par erreur
 * de typage — le compilateur force l'appelant à traiter le cas absent.
 */
export type FiscalDatum<T> =
  | { readonly status: 'manquant' }
  | {
      readonly status: 'source_fiable' | 'confirme_utilisateur' | 'hypothese';
      readonly value: T;
      readonly updatedAt: Instant;
      readonly source?: FiscalDatumSource;
    };

export const manquant = <T>(): FiscalDatum<T> => ({ status: 'manquant' });
export const hypothese = <T>(value: T, updatedAt: Instant, source?: FiscalDatumSource): FiscalDatum<T> => ({
  status: 'hypothese',
  value,
  updatedAt,
  ...(source === undefined ? {} : { source }),
});
export const confirmeUtilisateur = <T>(
  value: T,
  updatedAt: Instant,
  source?: FiscalDatumSource,
): FiscalDatum<T> => ({
  status: 'confirme_utilisateur',
  value,
  updatedAt,
  ...(source === undefined ? {} : { source }),
});
export const sourceFiable = <T>(value: T, updatedAt: Instant, source?: FiscalDatumSource): FiscalDatum<T> => ({
  status: 'source_fiable',
  value,
  updatedAt,
  ...(source === undefined ? {} : { source }),
});

/** Valeur portée par un datum, ou `undefined` si 'manquant' — jamais une valeur inventée. */
export function datumValue<T>(datum: FiscalDatum<T>): T | undefined {
  return datum.status === 'manquant' ? undefined : datum.value;
}

// ── Champs métier du profil fiscal ──────────────────────────────────────────────

/** Régime fiscal — DISTINCT de LegalForm : une EI peut être au réel, une SASU est toujours IS. */
export type FiscalTaxRegime = 'micro' | 'reel_ir' | 'is' | 'option_ir';

/** Statut social du dirigeant — pilote le calcul de charges (TNS ≠ assimilé-salarié). */
export type FiscalSocialStatus = 'tns' | 'assimile_salarie';

/** Nature d'activité déclarée (distinct de Trade — nomenclature fiscale, pas métier Bob). */
export type FiscalActivityNature = 'bic_vente' | 'bic_service' | 'bnc' | 'bnc_cipav' | 'mixte';

/**
 * Régime TVA du profil fiscal — DISTINCT de company.VatRegime ('reel_simpl') : nomenclature non
 * abrégée, propre au profil fiscal, pas réutilisée pour ne pas coupler les deux évolutions.
 */
export type FiscalVatRegime = 'franchise' | 'reel_simplifie' | 'reel_normal';

/** ACRE (art. L.131-6-4 CSS) — accordée ou non, avec la date de début d'activité si accordée. */
export interface AcreInfo {
  readonly granted: boolean;
  /** Date de début d'activité déclarée — pilote le facteur de réduction (micro-social.ts). */
  readonly startDate?: DateOnly;
}

/** Date de clôture d'exercice — absente/null = année civile (31/12), la norme pour EI/micro. */
export interface FiscalYearEnd {
  /** 1-12. */
  readonly month: number;
  /** 1-31 (cohérence calendaire au mois non vérifiée ici — champ D'AFFICHAGE, pas de calcul). */
  readonly day: number;
}

export interface FiscalProfileProps {
  readonly companyId: string;
  readonly legalForm: FiscalDatum<LegalForm>;
  readonly taxRegime: FiscalDatum<FiscalTaxRegime>;
  readonly socialStatus: FiscalDatum<FiscalSocialStatus>;
  readonly activityNature: FiscalDatum<FiscalActivityNature>;
  readonly vatRegime: FiscalDatum<FiscalVatRegime>;
  readonly acre: FiscalDatum<AcreInfo>;
  readonly versementLiberatoire: FiscalDatum<boolean>;
  /** null = année civile assumée/confirmée ; 'manquant' = jamais posée. */
  readonly fiscalYearEnd: FiscalDatum<FiscalYearEnd | null>;
}

/** Un champ modifiable à la fois (UpdateFiscalProfileField, @bob/core application layer). */
export type FiscalProfileFieldPatch =
  | { readonly field: 'legalForm'; readonly value: LegalForm }
  | { readonly field: 'taxRegime'; readonly value: FiscalTaxRegime }
  | { readonly field: 'socialStatus'; readonly value: FiscalSocialStatus }
  | { readonly field: 'activityNature'; readonly value: FiscalActivityNature }
  | { readonly field: 'vatRegime'; readonly value: FiscalVatRegime }
  | { readonly field: 'acre'; readonly value: AcreInfo }
  | { readonly field: 'versementLiberatoire'; readonly value: boolean }
  | { readonly field: 'fiscalYearEnd'; readonly value: FiscalYearEnd | null };

export const FISCAL_PROFILE_FIELDS: readonly FiscalProfileFieldPatch['field'][] = [
  'legalForm',
  'taxRegime',
  'socialStatus',
  'activityNature',
  'vatRegime',
  'acre',
  'versementLiberatoire',
  'fiscalYearEnd',
];

const SASU_SAS_FORMS: ReadonlySet<LegalForm> = new Set(['SASU', 'SAS']);
const TNS_FORMS: ReadonlySet<LegalForm> = new Set(['EI', 'micro', 'EURL']);

/**
 * Invariants inter-champs (validés à la construction ET à chaque mutation, jamais un throw
 * sauvage — DomainResult, pattern des agrégats billing). Une règle ne se déclenche QUE si les
 * DEUX champs qu'elle compare sont connus (statut ≠ 'manquant') : une hypothèse partielle ne
 * peut pas être jugée incohérente sur un champ qu'on ignore encore.
 */
function validateFiscalProfileInvariants(p: FiscalProfileProps): DomainResult<void> {
  const legalForm = datumValue(p.legalForm);
  const taxRegime = datumValue(p.taxRegime);
  const socialStatus = datumValue(p.socialStatus);
  const versementLiberatoire = datumValue(p.versementLiberatoire);

  // Le régime micro n'existe que pour un entrepreneur individuel : toujours TNS, jamais assimilé
  // salarié (art. L613-1 CSS).
  if (taxRegime === 'micro' && socialStatus === 'assimile_salarie') {
    return err({
      code: 'FISCAL_PROFILE_INCONSISTENT',
      rule: 'micro_tax_regime_requires_tns',
      message: "Le régime micro impose le statut social TNS — incompatible avec « assimilé salarié ».",
    });
  }

  // SASU/SAS : le président est TOUJOURS assimilé salarié, quelle que soit sa participation au
  // capital (art. L311-3, 11° CSS) — jamais TNS sous ces formes.
  if (legalForm !== undefined && SASU_SAS_FORMS.has(legalForm) && socialStatus === 'tns') {
    return err({
      code: 'FISCAL_PROFILE_INCONSISTENT',
      rule: 'assimile_requires_sasu_or_sas',
      message: 'SASU et SAS imposent le statut social assimilé salarié — jamais TNS.',
    });
  }

  // EI, micro et EURL (gérant associé unique) : toujours TNS — jamais assimilé salarié.
  if (legalForm !== undefined && TNS_FORMS.has(legalForm) && socialStatus === 'assimile_salarie') {
    return err({
      code: 'FISCAL_PROFILE_INCONSISTENT',
      rule: 'tns_requires_ei_micro_eurl',
      message: 'EI, micro-entreprise et EURL (gérant) imposent le statut social TNS.',
    });
  }

  // Le versement libératoire de l'IR (art. 151-0 CGI) n'existe qu'au régime micro.
  if (versementLiberatoire === true && taxRegime !== undefined && taxRegime !== 'micro') {
    return err({
      code: 'FISCAL_PROFILE_INCONSISTENT',
      rule: 'versement_liberatoire_requires_micro',
      message: "Le versement libératoire de l'impôt sur le revenu n'existe qu'au régime micro.",
    });
  }

  // Forme juridique 'micro' ⇒ le régime fiscal ne peut être que 'micro' (une micro-entreprise
  // n'est jamais au réel ni à l'IS).
  if (legalForm === 'micro' && taxRegime !== undefined && taxRegime !== 'micro') {
    return err({
      code: 'FISCAL_PROFILE_INCONSISTENT',
      rule: 'micro_legal_form_requires_micro_tax_regime',
      message: 'Une micro-entreprise (forme juridique) implique un régime fiscal micro.',
    });
  }

  return ok(undefined);
}

export class FiscalProfile {
  private constructor(private readonly p: FiscalProfileProps) {}

  static of(p: FiscalProfileProps): DomainResult<FiscalProfile> {
    const check = validateFiscalProfileInvariants(p);
    if (!check.ok) return check;
    return ok(new FiscalProfile(p));
  }

  get companyId(): string {
    return this.p.companyId;
  }
  get legalForm(): FiscalDatum<LegalForm> {
    return this.p.legalForm;
  }
  get taxRegime(): FiscalDatum<FiscalTaxRegime> {
    return this.p.taxRegime;
  }
  get socialStatus(): FiscalDatum<FiscalSocialStatus> {
    return this.p.socialStatus;
  }
  get activityNature(): FiscalDatum<FiscalActivityNature> {
    return this.p.activityNature;
  }
  get vatRegime(): FiscalDatum<FiscalVatRegime> {
    return this.p.vatRegime;
  }
  get acre(): FiscalDatum<AcreInfo> {
    return this.p.acre;
  }
  get versementLiberatoire(): FiscalDatum<boolean> {
    return this.p.versementLiberatoire;
  }
  get fiscalYearEnd(): FiscalDatum<FiscalYearEnd | null> {
    return this.p.fiscalYearEnd;
  }

  /**
   * Applique UN patch de champ : statut forcé à 'confirme_utilisateur' (c'est la définition même
   * d'une mise à jour explicite — dérivations/imports utilisent les constructeurs FiscalDatum
   * directement, pas ce chemin), re-valide les invariants, rejette avec l'erreur domaine si le
   * profil devient incohérent (le champ n'est alors PAS modifié).
   */
  withField(patch: FiscalProfileFieldPatch, updatedAt: Instant, source?: FiscalDatumSource): DomainResult<FiscalProfile> {
    const datum = confirmeUtilisateur(patch.value, updatedAt, source);
    const next: FiscalProfileProps = { ...this.p, [patch.field]: datum };
    return FiscalProfile.of(next);
  }

  /** Snapshot de persistance/API (réhydratation via FiscalProfile.of). */
  toProps(): FiscalProfileProps {
    return { ...this.p };
  }
}

export type FiscalProfileView = FiscalProfileProps;

// ── Dérivation initiale (jamais 'confirme_utilisateur') ─────────────────────────

/** Entrée minimale requise pour dériver un profil initial — pas un couplage à la classe Company. */
export interface FiscalProfileDerivationInput {
  readonly id: string;
  readonly legalForm: LegalForm;
  readonly trade: Trade;
}

const MICRO_CATEGORY_TO_ACTIVITY_NATURE: Record<ReturnType<typeof microCategoryFromTrade>['category'], FiscalActivityNature> = {
  ventes: 'bic_vente',
  bic_prestations: 'bic_service',
  bnc: 'bnc',
  liberale_reglementee_cipav: 'bnc_cipav',
};

/**
 * Pose les HYPOTHÈSES initiales du profil fiscal à partir de la forme juridique (fiche INSEE/
 * SIRET, déjà 'source_fiable' sur Company) — JAMAIS 'confirme_utilisateur' : toute dérivation
 * reste une hypothèse à confirmer, sauf `legalForm` lui-même qui est recopié 'source_fiable'
 * (c'est une donnée DÉJÀ établie sur Company, pas une déduction propre au profil fiscal).
 *
 * Correspondances (prudentes, l'utilisateur confirme) :
 * · micro → régime micro, statut TNS, TVA franchise (hypothèse basse — la plupart des créateurs
 *   micro démarrent sous le seuil), activité dérivée du métier (microCategoryFromTrade).
 * · EI (hors micro) → régime réel IR (par défaut, art. 50-0 CGI a contrario), statut TNS.
 * · EURL → régime réel IR (régime par défaut du gérant associé unique, option IS possible),
 *   statut TNS (gérant associé unique).
 * · SASU → IS (régime par défaut des sociétés par actions), assimilé salarié (art. L311-3 CSS).
 * · SAS → IS, assimilé salarié (le président, quelle que soit la répartition du capital).
 * · SARL → IS (régime par défaut) ; statut social du gérant AMBIGU (majoritaire=TNS,
 *   minoritaire=assimilé) → 'manquant', jamais une hypothèse à 50/50.
 * `versementLiberatoire`/`acre`/`vatRegime`/`fiscalYearEnd` : jamais présumés positifs — 'manquant'
 * sauf quand une hypothèse prudente existe (micro : VL non présumé, franchise TVA présumée,
 * année civile présumée).
 */
export function buildInitialFiscalProfile(company: FiscalProfileDerivationInput, now: Instant): FiscalProfile {
  const base: Omit<FiscalProfileProps, 'taxRegime' | 'socialStatus' | 'activityNature' | 'vatRegime' | 'fiscalYearEnd'> = {
    companyId: company.id,
    legalForm: sourceFiable(company.legalForm, now, 'insee_siret'),
    acre: manquant(),
    versementLiberatoire: manquant(),
  };

  const derived = ((): Pick<FiscalProfileProps, 'taxRegime' | 'socialStatus' | 'activityNature' | 'vatRegime' | 'fiscalYearEnd'> => {
    const civilYearEnd = hypothese<FiscalYearEnd | null>(null, now, 'derived_legal_form');
    switch (company.legalForm) {
      case 'micro': {
        const guess = microCategoryFromTrade(company.trade);
        return {
          taxRegime: hypothese('micro', now, 'derived_legal_form'),
          socialStatus: hypothese('tns', now, 'derived_legal_form'),
          activityNature: hypothese(MICRO_CATEGORY_TO_ACTIVITY_NATURE[guess.category], now, 'derived_trade'),
          vatRegime: hypothese('franchise', now, 'derived_legal_form'),
          fiscalYearEnd: civilYearEnd,
        };
      }
      case 'EI':
        return {
          taxRegime: hypothese('reel_ir', now, 'derived_legal_form'),
          socialStatus: hypothese('tns', now, 'derived_legal_form'),
          activityNature: manquant(),
          vatRegime: manquant(),
          fiscalYearEnd: civilYearEnd,
        };
      case 'EURL':
        return {
          taxRegime: hypothese('reel_ir', now, 'derived_legal_form'),
          socialStatus: hypothese('tns', now, 'derived_legal_form'),
          activityNature: manquant(),
          vatRegime: manquant(),
          fiscalYearEnd: civilYearEnd,
        };
      case 'SASU':
        return {
          taxRegime: hypothese('is', now, 'derived_legal_form'),
          socialStatus: hypothese('assimile_salarie', now, 'derived_legal_form'),
          activityNature: manquant(),
          vatRegime: manquant(),
          fiscalYearEnd: civilYearEnd,
        };
      case 'SAS':
        return {
          taxRegime: hypothese('is', now, 'derived_legal_form'),
          socialStatus: hypothese('assimile_salarie', now, 'derived_legal_form'),
          activityNature: manquant(),
          vatRegime: manquant(),
          fiscalYearEnd: civilYearEnd,
        };
      case 'SARL':
        return {
          taxRegime: hypothese('is', now, 'derived_legal_form'),
          // Gérant majoritaire (TNS) vs minoritaire (assimilé salarié) : indérivable sans info
          // supplémentaire — jamais une hypothèse à 50/50, l'utilisateur confirme.
          socialStatus: manquant(),
          activityNature: manquant(),
          vatRegime: manquant(),
          fiscalYearEnd: civilYearEnd,
        };
    }
  })();

  const result = FiscalProfile.of({ ...base, ...derived });
  if (!result.ok) {
    // Dérivation interne incohérente : bug de mapping legalForm → hypothèses, jamais un cas
    // atteignable par une saisie utilisateur (même pattern que les référentiels « corrompus »).
    throw new Error(
      `buildInitialFiscalProfile: dérivation incohérente pour legalForm=${company.legalForm} (${result.error.code}/${
        'rule' in result.error ? result.error.rule : ''
      }) — bug interne.`,
    );
  }
  return result.value;
}

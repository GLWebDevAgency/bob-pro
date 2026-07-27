import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type Instant, type DateOnly } from '../../shared-kernel/time';
import { type LegalForm, type Trade, type VatRegime as CompanyVatRegime } from '../company/company';
import { nafToTrade } from '../company/naf-to-trade';
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

/**
 * D'où vient la valeur — traçabilité minimale (voix/formulaire/dérivation/source externe).
 * · derived_naf_ape — déduite du code NAF/APE INSEE (quand le métier Bob seul ne suffit pas).
 * · derived_date_creation — déduite de la date de création d'entreprise (ex. hypothèse ACRE).
 */
export type FiscalDatumSource =
  | 'insee_siret'
  | 'user_voice'
  | 'user_form'
  | 'derived_legal_form'
  | 'derived_trade'
  | 'derived_naf_ape'
  | 'derived_date_creation'
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

/** Nom d'un champ du profil fiscal (union stable, consommée par l'UI et fiscal-field-rules). */
export type FiscalProfileField = FiscalProfileFieldPatch['field'];

export const FISCAL_PROFILE_FIELDS: readonly FiscalProfileField[] = [
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

/**
 * Invalidation du marqueur « versement libératoire non applicable » à l'ENTRÉE en contexte micro.
 *
 * La dérivation initiale pose, hors contexte micro, versementLiberatoire = false en
 * 'source_fiable'/'derived_legal_form' : un simple marqueur « non applicable » (le VL n'existe
 * qu'au régime micro, art. 151-0 CGI) qui permet à l'UI de MASQUER le champ. Si le profil entre
 * ensuite en contexte micro (régime fiscal 'micro' ou forme 'micro'), ce marqueur devient un
 * MENSONGE juridique : pour un micro-entrepreneur, le VL est une OPTION ouverte (il a pu
 * l'exercer auprès de l'URSSAF), pas une interdiction légale — l'afficher « Non — imposé par la
 * loi » serait faux et exclurait la question. Le marqueur repasse donc à 'manquant' : la question
 * est posée, jamais une valeur présumée. Une valeur CONFIRMÉE par l'utilisateur n'est jamais
 * touchée (seul le marqueur dérivé — statut 'source_fiable' + source 'derived_legal_form' +
 * valeur false — est concerné). Idempotent, ne peut jamais rendre le profil invalide ('manquant'
 * ne déclenche aucun invariant).
 */
function invalidateVlNonApplicableEnMicro(p: FiscalProfileProps): FiscalProfileProps {
  const microContext = datumValue(p.legalForm) === 'micro' || datumValue(p.taxRegime) === 'micro';
  if (!microContext) return p;
  const vl = p.versementLiberatoire;
  const estMarqueurNonApplicable =
    vl.status === 'source_fiable' && vl.source === 'derived_legal_form' && vl.value === false;
  if (!estMarqueurNonApplicable) return p;
  return { ...p, versementLiberatoire: manquant() };
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
   * profil devient incohérent (le champ n'est alors PAS modifié). Le marqueur « VL non
   * applicable » est invalidé si le patch fait ENTRER le profil en contexte micro
   * (invalidateVlNonApplicableEnMicro) — la question du versement libératoire redevient posée.
   */
  withField(patch: FiscalProfileFieldPatch, updatedAt: Instant, source?: FiscalDatumSource): DomainResult<FiscalProfile> {
    const datum = confirmeUtilisateur(patch.value, updatedAt, source);
    const next: FiscalProfileProps = { ...this.p, [patch.field]: datum };
    return FiscalProfile.of(invalidateVlNonApplicableEnMicro(next));
  }

  /** Snapshot de persistance/API (réhydratation via FiscalProfile.of). */
  toProps(): FiscalProfileProps {
    return { ...this.p };
  }
}

export type FiscalProfileView = FiscalProfileProps;

// ── Dérivation initiale (jamais 'confirme_utilisateur') ─────────────────────────

/**
 * Entrée requise pour dériver un profil initial — pas un couplage à la classe Company.
 *
 * COMPAT ASCENDANTE DE CONTRAT (typage + appel) : seuls `id`/`legalForm`/`trade` sont requis —
 * tous les autres champs sont OPTIONNELS ; un appelant existant qui ne passe que le trio minimal
 * compile et dérive sans modification. ATTENTION, ce n'est PAS une compat de VALEURS : cette
 * version ENRICHIT volontairement la dérivation, y compris pour l'entrée minimale —
 * · statut social des formes sans ambiguïté posé 'source_fiable' (certitude juridique, avant :
 *   'hypothese') ;
 * · nature d'activité dérivée du métier pour TOUTES les formes (avant : seulement micro,
 *   'manquant' sinon) ;
 * · versement libératoire posé « non applicable » (false, 'source_fiable') hors contexte micro
 *   (avant : 'manquant').
 * Les valeurs restées identiques (régime fiscal, exercice, activité micro, TVA, ACRE sans date)
 * sont verrouillées par le bloc de test « compat ascendante » de fiscal-profile.test.ts ; les
 * enrichissements ont leurs propres tests. Les profils déjà persistés ne sont jamais re-dérivés.
 */
export interface FiscalProfileDerivationInput {
  readonly id: string;
  readonly legalForm: LegalForm;
  readonly trade: Trade;
  /**
   * Régime TVA choisi à l'ONBOARDING (nomenclature Company — orthographe abrégée 'reel_simpl',
   * convertie ici vers 'reel_simplifie'). Fourni → posé 'confirme_utilisateur' : c'est un CHOIX
   * explicite de l'utilisateur, pas une déduction.
   */
  readonly vatRegime?: CompanyVatRegime;
  /** Code NAF/APE INSEE (ex. '43.22A') — affine la nature d'activité quand le métier ne suffit pas. */
  readonly nafApe?: string;
  /** Date de création de l'entreprise (fiche annuaire) — pilote l'hypothèse ACRE (< 12 mois). */
  readonly dateCreation?: DateOnly;
  /**
   * N° TVA intracommunautaire — signal de CORROBORATION seulement, AUCUNE dérivation v1 : une
   * entreprise en franchise (art. 293 B CGI) peut détenir un n° intracom (acquisitions UE), en
   * déduire un régime réel serait une déduction hasardeuse. Conservé au point d'extension.
   */
  readonly tvaIntracom?: string;
}

const MICRO_CATEGORY_TO_ACTIVITY_NATURE: Record<ReturnType<typeof microCategoryFromTrade>['category'], FiscalActivityNature> = {
  ventes: 'bic_vente',
  bic_prestations: 'bic_service',
  bnc: 'bnc',
  liberale_reglementee_cipav: 'bnc_cipav',
};

/** Conversion d'orthographe Company → profil fiscal (nomenclatures volontairement découplées). */
const COMPANY_VAT_REGIME_TO_FISCAL: Record<CompanyVatRegime, FiscalVatRegime> = {
  franchise: 'franchise',
  reel_simpl: 'reel_simplifie',
  reel_normal: 'reel_normal',
};

/**
 * Conversion inverse profil fiscal → Company ('reel_simplifie' → 'reel_simpl') — SYNC Phase B :
 * Company.vatRegime pilote les échéances fiscales (deriveFiscalCalendar) ; quand l'utilisateur
 * confirme/corrige le régime TVA sur son profil, la fiche société doit refléter la même vérité
 * dans la même transaction tenant — une divergence durable entre les deux champs serait le bug
 * « états dupliqués ».
 */
export function companyVatRegimeFromFiscal(regime: FiscalVatRegime): CompanyVatRegime {
  const inverse: Record<FiscalVatRegime, CompanyVatRegime> = {
    franchise: 'franchise',
    reel_simplifie: 'reel_simpl',
    reel_normal: 'reel_normal',
  };
  return inverse[regime];
}

/**
 * Métier Bob → nature d'activité fiscale HORS régime micro (au réel/IS, la ventilation BIC/BNC
 * ne pilote plus l'impôt de la société mais reste utile — toujours 'hypothese', jamais
 * 'source_fiable'). Artisans du bâtiment : vente de matériaux + pose → 'mixte' PRUDENT (la
 * dominante ventes/services est inconnaissable sans la comptabilité — on ne tranche pas à sa
 * place). Métiers intellectuels (conseil, IT, photo, coaching) → BNC (l'hypothèse la plus
 * fréquente en indépendant — un NAF 62.x/70.x reste BIC possible, d'où le statut hypothèse).
 * 'autre' → null : aucune base prudente sans NAF (le repli BNC « taux le plus haut » du micro
 * est un raisonnement de PROVISION, sans objet hors micro).
 */
const TRADE_TO_ACTIVITY_NATURE_HORS_MICRO: Record<Trade, FiscalActivityNature | null> = {
  plombier: 'mixte',
  electricien: 'mixte',
  macon: 'mixte',
  peintre: 'mixte',
  paysagiste: 'mixte',
  // PR-10 — maintenance : fournitures (pièces, équipements) + prestations de pose/entretien.
  frigoriste: 'mixte',
  mainteneur: 'mixte',
  consultant: 'bnc',
  freelance_it: 'bnc',
  photographe: 'bnc',
  coach: 'bnc',
  autre: null,
};

/**
 * Division NAF (2 premiers chiffres) → nature d'activité, REPLI quand ni le métier Bob ni
 * nafToTrade ne concluent. Volontairement courte et prudente :
 * · 41/42/43 (construction) → mixte (fournitures + pose) ;
 * · 45/46/47 (commerce) → bic_vente ;
 * · 62/63 (informatique) et 69/70/71/73/74 (activités spécialisées, conseil) → bnc — « souvent
 *   BNC en EI, BIC possible » : c'est exactement pourquoi le statut reste 'hypothese'.
 */
const NAF_DIVISION_TO_ACTIVITY_NATURE: Readonly<Record<string, FiscalActivityNature>> = {
  '41': 'mixte',
  '42': 'mixte',
  '43': 'mixte',
  '45': 'bic_vente',
  '46': 'bic_vente',
  '47': 'bic_vente',
  '62': 'bnc',
  '63': 'bnc',
  '69': 'bnc',
  '70': 'bnc',
  '71': 'bnc',
  '73': 'bnc',
  '74': 'bnc',
};

/**
 * Métier EFFECTIF de la dérivation : le métier Bob déclaré s'il est spécifique, sinon celui que
 * le code NAF permet de reconnaître (nafToTrade). La source tracée suit le chemin réellement
 * emprunté ('derived_trade' vs 'derived_naf_ape') — traçabilité honnête, jamais décorative.
 */
function resolveEffectiveTrade(input: FiscalProfileDerivationInput): {
  readonly trade: Trade;
  readonly source: Extract<FiscalDatumSource, 'derived_trade' | 'derived_naf_ape'>;
} {
  if (input.trade !== 'autre') return { trade: input.trade, source: 'derived_trade' };
  const fromNaf = nafToTrade(input.nafApe);
  if (fromNaf !== null) return { trade: fromNaf, source: 'derived_naf_ape' };
  return { trade: 'autre', source: 'derived_trade' };
}

/**
 * Nature d'activité dérivée pour TOUTES les formes (plus seulement micro) :
 * · micro → nomenclature URSSAF via microCategoryFromTrade (inchangé — la provision micro-social
 *   en dépend), affinée par le NAF quand le métier est 'autre' ;
 * · autres formes → TRADE_TO_ACTIVITY_NATURE_HORS_MICRO, puis repli division NAF, sinon
 *   'manquant' (jamais une nature inventée).
 * TOUJOURS 'hypothese' : même en société, la ventilation BIC/BNC reste à confirmer.
 */
function deriveActivityNature(input: FiscalProfileDerivationInput, now: Instant): FiscalDatum<FiscalActivityNature> {
  const effective = resolveEffectiveTrade(input);
  if (input.legalForm === 'micro') {
    const guess = microCategoryFromTrade(effective.trade);
    return hypothese(MICRO_CATEGORY_TO_ACTIVITY_NATURE[guess.category], now, effective.source);
  }
  const fromTrade = TRADE_TO_ACTIVITY_NATURE_HORS_MICRO[effective.trade];
  if (fromTrade !== null) return hypothese(fromTrade, now, effective.source);
  const division = input.nafApe?.replace(/\s/g, '').slice(0, 2);
  const fromDivision = division === undefined ? undefined : NAF_DIVISION_TO_ACTIVITY_NATURE[division];
  if (fromDivision !== undefined) return hypothese(fromDivision, now, 'derived_naf_ape');
  return manquant();
}

/**
 * Régime TVA du profil : le CHOIX d'onboarding (Company.vatRegime) prime — 'confirme_utilisateur'
 * (l'utilisateur l'a explicitement sélectionné), orthographe convertie. À défaut : franchise en
 * hypothèse pour le micro (inchangé — la plupart des créateurs micro démarrent sous le seuil,
 * art. 293 B CGI), 'manquant' sinon.
 */
function deriveVatRegime(input: FiscalProfileDerivationInput, now: Instant): FiscalDatum<FiscalVatRegime> {
  if (input.vatRegime !== undefined) {
    return confirmeUtilisateur(COMPANY_VAT_REGIME_TO_FISCAL[input.vatRegime], now, 'user_form');
  }
  if (input.legalForm === 'micro') return hypothese('franchise', now, 'derived_legal_form');
  return manquant();
}

/**
 * « Moins de 12 mois » entre la date de création et maintenant — arithmétique calendaire pure
 * sur chaînes ISO (la borne exacte des 12 mois est traitée comme ≥ 12 mois : prudence).
 */
function isUnderTwelveMonths(dateCreation: DateOnly, now: Instant): boolean {
  const nowDate = now.slice(0, 10);
  const oneYearBefore = `${Number(nowDate.slice(0, 4)) - 1}${nowDate.slice(4)}`;
  return dateCreation > oneYearBefore;
}

/**
 * Hypothèse ACRE depuis la date de création (art. L.131-6-4 CSS) — nuance clé :
 * · l'ACRE est AUTOMATIQUE pour les créateurs hors micro (sociétés, EI au réel) éligibles depuis
 *   2019 → création < 12 mois : hypothese({granted: true, startDate}) ;
 * · elle est SUR DEMANDE pour les micro-entrepreneurs (formulaire dans les 45 jours) → jamais
 *   présumée accordée : 'manquant', la question est posée à l'utilisateur ;
 * · création ≥ 12 mois (toutes formes) : hypothese({granted: false}) — la fenêtre d'exonération
 *   (acreWindow, ≈ 12 mois max) est de toute façon échue.
 * Sans date de création : 'manquant' — jamais une hypothèse sans base.
 */
function deriveAcre(input: FiscalProfileDerivationInput, now: Instant): FiscalDatum<AcreInfo> {
  if (input.dateCreation === undefined) return manquant();
  if (isUnderTwelveMonths(input.dateCreation, now)) {
    if (input.legalForm === 'micro') return manquant();
    return hypothese({ granted: true, startDate: input.dateCreation }, now, 'derived_date_creation');
  }
  return hypothese({ granted: false }, now, 'derived_date_creation');
}

/**
 * Pose le profil fiscal INITIAL à partir de la fiche entreprise — JAMAIS 'confirme_utilisateur'
 * (sauf le régime TVA quand il vient du CHOIX d'onboarding : c'est une saisie utilisateur, pas
 * une déduction). Trois niveaux de certitude, jamais confondus :
 * · 'source_fiable' — recopie d'une donnée établie (legalForm, INSEE/SIRET) OU certitude
 *   JURIDIQUE découlant mécaniquement de la forme (une règle de droit, pas une probabilité) ;
 * · 'hypothese' — dérivation prudente à confirmer ;
 * · 'manquant' — aucune base pour dériver : la question sera posée, jamais une valeur inventée.
 *
 * Correspondances par forme :
 * · micro → régime micro (hypothèse — l'utilisateur confirme le couple forme+régime), TNS en
 *   SOURCE_FIABLE (l'entrepreneur individuel est toujours travailleur indépendant, art. L611-1/
 *   L613-1 CSS), TVA franchise (hypothèse basse) sauf choix d'onboarding fourni, activité
 *   dérivée du métier (microCategoryFromTrade, affinée par le NAF si le métier est 'autre').
 * · EI (au réel) → régime réel IR (hypothèse — par défaut, art. 50-0 CGI a contrario), TNS en
 *   SOURCE_FIABLE (même certitude que micro).
 * · EURL → régime réel IR (hypothèse — défaut du gérant associé unique, option IS possible),
 *   TNS en SOURCE_FIABLE (gérant associé unique = travailleur indépendant, art. L611-1 CSS).
 * · SASU/SAS → IS (hypothèse — régime par défaut, une option IR temporaire existe), assimilé
 *   salarié en SOURCE_FIABLE : le président de SAS/SASU est TOUJOURS assimilé salarié quelle que
 *   soit sa part au capital (art. L311-3, 11° CSS) — certitude juridique, pas une hypothèse.
 * · SARL → IS (hypothèse) ; statut social du gérant réellement AMBIGU (majoritaire=TNS,
 *   minoritaire=assimilé) → 'manquant', jamais une hypothèse à 50/50.
 * Champs transverses :
 * · vatRegime → deriveVatRegime (choix d'onboarding prioritaire, converti 'reel_simpl'→
 *   'reel_simplifie') ; activityNature → deriveActivityNature (toutes formes) ;
 * · acre → deriveAcre (date de création : automatique hors micro < 12 mois, SUR DEMANDE en
 *   micro → question posée) ;
 * · versementLiberatoire → hors forme micro : false en SOURCE_FIABLE ('derived_legal_form') —
 *   le VL n'existe qu'au régime micro (art. 151-0 CGI), poser « non applicable » permet à l'UI
 *   de MASQUER le champ (applicableFiscalFields) au lieu d'afficher « manquant ». Si le profil
 *   entre plus tard en contexte micro, withField repasse ce marqueur à 'manquant'
 *   (invalidateVlNonApplicableEnMicro) : le champ redevient une vraie question, jamais un
 *   faux « Non — imposé par la loi » ;
 * · fiscalYearEnd → année civile en hypothèse (inchangé).
 */
export function buildInitialFiscalProfile(company: FiscalProfileDerivationInput, now: Instant): FiscalProfile {
  const base: Omit<FiscalProfileProps, 'taxRegime' | 'socialStatus'> = {
    companyId: company.id,
    legalForm: sourceFiable(company.legalForm, now, 'insee_siret'),
    activityNature: deriveActivityNature(company, now),
    vatRegime: deriveVatRegime(company, now),
    acre: deriveAcre(company, now),
    versementLiberatoire:
      company.legalForm === 'micro' ? manquant<boolean>() : sourceFiable(false, now, 'derived_legal_form'),
    fiscalYearEnd: hypothese<FiscalYearEnd | null>(null, now, 'derived_legal_form'),
  };

  const derived = ((): Pick<FiscalProfileProps, 'taxRegime' | 'socialStatus'> => {
    switch (company.legalForm) {
      case 'micro':
        return {
          taxRegime: hypothese('micro', now, 'derived_legal_form'),
          socialStatus: sourceFiable('tns', now, 'derived_legal_form'),
        };
      case 'EI':
        return {
          taxRegime: hypothese('reel_ir', now, 'derived_legal_form'),
          socialStatus: sourceFiable('tns', now, 'derived_legal_form'),
        };
      case 'EURL':
        return {
          taxRegime: hypothese('reel_ir', now, 'derived_legal_form'),
          socialStatus: sourceFiable('tns', now, 'derived_legal_form'),
        };
      case 'SASU':
        return {
          taxRegime: hypothese('is', now, 'derived_legal_form'),
          socialStatus: sourceFiable('assimile_salarie', now, 'derived_legal_form'),
        };
      case 'SAS':
        return {
          taxRegime: hypothese('is', now, 'derived_legal_form'),
          socialStatus: sourceFiable('assimile_salarie', now, 'derived_legal_form'),
        };
      case 'SARL':
        return {
          taxRegime: hypothese('is', now, 'derived_legal_form'),
          // Gérant majoritaire (TNS) vs minoritaire (assimilé salarié) : indérivable sans info
          // supplémentaire — jamais une hypothèse à 50/50, l'utilisateur confirme.
          socialStatus: manquant(),
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

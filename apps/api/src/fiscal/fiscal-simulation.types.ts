import type { AcreInfo, DateOnly, FiscalActivityNature } from '@bob/core';

/** Version épinglée exacte (apps/api/package.json) — jamais un `^`, cf. SPIKE_PUBLICODES_20260715.md. */
export const PUBLICODES_RULES_VERSION = 'modele-social@11.0.0';

// ── Entrées V1 (façade — jamais un dottedName brut exposé au client) ──────────────

export interface MicroSimulationInput {
  readonly type: 'micro';
  /** Chiffre d'affaires ANNUEL encaissé projeté, en centimes (convention Money du repo). */
  readonly caAnnualCents: number;
  readonly activityNature: FiscalActivityNature;
  /** null/absent = ACRE non demandée. */
  readonly acre?: AcreInfo | null;
  readonly versementLiberatoire: boolean;
  /** Date d'ÉVALUATION (pilote la version des barèmes/l'ACRE 50↔75 %, etc.), "YYYY-MM-DD". */
  readonly date: DateOnly;
}

export interface AssimileSimulationInput {
  readonly type: 'assimile';
  /** Net mensuel CIBLE ("à payer avant impôt", cf. mon-entreprise) en centimes. */
  readonly netMensuelCibleCents: number;
  readonly date: DateOnly;
}

export type FiscalSimulationInput = MicroSimulationInput | AssimileSimulationInput;

// ── Traçabilité (« Comment Bob a calculé ça ? », SPEC_EXPERT_FISCAL.md §V2 pt.5) ──

export interface CalculationTraceReference {
  readonly label: string;
  readonly url: string;
}

/**
 * Vue NORMALISÉE et STABLE d'un nœud Publicodes évalué — jamais `rawNode`/`explanation`/AST bruts
 * (contre-revue GPT ④ : l'AST Publicodes n'est PAS couvert par le semver amont, cf. spike §6 :
 * « AST BREAKING CHANGE (AST change are not in semantic versioning) »). Construite uniquement à
 * partir de l'API publique documentée (`RuleNode.title`, `EvaluatedNode.nodeValue`/`unit` via
 * `serializeUnit`, `RuleNode.rawNode.références` — un simple dictionnaire libellé→URL).
 */
export interface CalculationTraceV1 {
  readonly ruleTitle: string;
  readonly valeur: number | boolean | string | null;
  readonly unite: string | null;
  readonly references: readonly CalculationTraceReference[];
}

/**
 * · certified — une valeur ET aucune variable manquante détectée par le moteur (rare en V1 : le
 *   référentiel officiel embarque un contexte très large — département, historique, etc.).
 * · estimated — une valeur exploitable MAIS obtenue avec des variables manquantes (hypothèses
 *   implicites du moteur sur ce que Bob ne lui a pas fourni) : JAMAIS annoncé comme un fait acquis.
 * · unsupported — le moteur n'a pas produit de valeur exploitable (« non applicable »/« non défini »)
 *   malgré une situation valide : zone de trou connue (cf. spike §6), jamais un nombre inventé.
 */
export type FiscalSimulationCoverage = 'certified' | 'estimated' | 'unsupported';

export interface FiscalSimulationWarning {
  readonly code: 'missing_variable' | 'experimental_rule' | 'inversion_fail' | 'engine_warning';
  readonly message: string;
}

export interface FiscalSimulationEnvelope<TResult> {
  readonly type: FiscalSimulationInput['type'];
  readonly rulesVersion: string;
  /** Date d'effet simulée (entrée `date`) — pilote quelle version du barème s'applique. */
  readonly effectiveDate: DateOnly;
  /** Horodatage RÉEL du calcul (reproductibilité §V2.3 — jamais confondu avec `effectiveDate`). */
  readonly calculatedAt: string;
  readonly coverage: FiscalSimulationCoverage;
  readonly missingVariablesCount: number;
  readonly warnings: readonly FiscalSimulationWarning[];
  readonly hypotheses: readonly string[];
  readonly traces: readonly CalculationTraceV1[];
  readonly result: TResult;
}

export interface MicroSimulationResult {
  /** Cotisations et contributions du mois (cotisations sociales + TFC + CFP), en centimes. */
  readonly cotisationsCentsPerMonth: number;
  /** Revenu net avant impôt de l'année, en centimes. */
  readonly revenuNetCentsPerYear: number;
  /** Dérivé (cotisationsCentsPerMonth × 12 / caAnnualCents) — PAS une règle Publicodes, un ratio. */
  readonly tauxEffectifPct: number;
}

export interface AssimileSimulationResult {
  readonly brutMensuelCents: number;
  readonly coutTotalEmployeurCents: number;
  /** true = le moteur a signalé un résidu de non-convergence sur l'inversion numérique net→brut. */
  readonly inversionFail: boolean;
}

export type FiscalSimulationResponse =
  | FiscalSimulationEnvelope<MicroSimulationResult>
  | FiscalSimulationEnvelope<AssimileSimulationResult>;

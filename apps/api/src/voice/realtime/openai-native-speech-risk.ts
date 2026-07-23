import {
  BOB_GENERIC_ASSISTANCE_SPEECH,
  type AgentRunKind,
  type CanonicalSpeechEnvelope,
} from '@bob/ai';

/** Provenance du texte retenu par l'adaptateur monobrain, jamais fournie par le provider. */
export type OpenAiNativeSpeechSource =
  | 'spoken_prompt'
  | 'natural_body'
  | 'card_body'
  | 'card_title';

/** Qualification structurée issue de l'AgentRun réel. Une valeur absente ferme le natif. */
export type OpenAiNativeSpeechPurpose =
  | 'generic_assistance'
  | 'business_answer'
  | 'structured_choice'
  | 'navigation'
  | 'action_proposal'
  | 'action_result';

export type OpenAiNativeEligibleSpeechScenario =
  | 'generic_help_v1'
  | 'generic_unknown_v1';

export type OpenAiNativeSpeechRiskReason =
  | 'allowlisted_generic'
  | 'preapproved_artifact'
  | 'unknown_semantics'
  | 'tenant_context'
  | 'business_fact'
  | 'action_or_control'
  | 'interactive_choice'
  | 'llm_naturalized'
  | 'mutation_result'
  | 'invalid_envelope';

export type OpenAiNativeSpeechRiskDecision =
  | {
      readonly version: 1;
      readonly mode: 'native_conversational';
      readonly scenarioId: OpenAiNativeEligibleSpeechScenario;
    }
  | {
      readonly version: 1;
      readonly mode: 'audited_exact';
      readonly reasons: readonly OpenAiNativeSpeechRiskReason[];
    };

export interface OpenAiNativeSpeechRiskInput {
  readonly envelope: Pick<
    CanonicalSpeechEnvelope,
    'version' | 'text' | 'canonicalText' | 'classification' | 'fixedPhraseId' | 'facts'
  >;
  readonly purpose: OpenAiNativeSpeechPurpose | null | undefined;
  readonly source: OpenAiNativeSpeechSource | null | undefined;
  readonly runKind: AgentRunKind | null | undefined;
  readonly hasTenantContext: boolean;
  /** Navigation, choix, proposition ou toute capacité opaque liée à la parole. */
  readonly hasControl: boolean;
}

/**
 * Allowlist versionnée et exacte. Une modification éditoriale rebascule automatiquement sur
 * `audited_exact` jusqu'à revue : aucun texte libre ne peut se déclarer générique lui-même.
 */
export const OPENAI_NATIVE_ELIGIBLE_SPEECH_V1 = Object.freeze({
  generic_help_v1: BOB_GENERIC_ASSISTANCE_SPEECH.help.replace(/\s+/gu, ' ').trim(),
  generic_unknown_v1: BOB_GENERIC_ASSISTANCE_SPEECH.unknown.replace(/\s+/gu, ' ').trim(),
} as const satisfies Record<OpenAiNativeEligibleSpeechScenario, string>);

function eligibleScenario(
  exactText: string,
): OpenAiNativeEligibleSpeechScenario | null {
  const match = Object.entries(OPENAI_NATIVE_ELIGIBLE_SPEECH_V1).find(
    ([, allowlistedText]) => allowlistedText === exactText,
  );
  return (match?.[0] as OpenAiNativeEligibleSpeechScenario | undefined) ?? null;
}

function validEnvelope(
  envelope: OpenAiNativeSpeechRiskInput['envelope'],
): boolean {
  if (
    envelope.version !== 1
    || typeof envelope.text !== 'string'
    || typeof envelope.canonicalText !== 'string'
    || envelope.canonicalText.length === 0
    || (envelope.classification !== 'fixed_safe'
      && envelope.classification !== 'dynamic_sensitive')
    || !Array.isArray(envelope.facts)
  ) return false;
  if (envelope.classification === 'fixed_safe') {
    return (envelope.fixedPhraseId === 'listening' || envelope.fixedPhraseId === 'checking')
      && envelope.facts.length === 0;
  }
  return envelope.fixedPhraseId === undefined;
}

function audited(...reasons: OpenAiNativeSpeechRiskReason[]): OpenAiNativeSpeechRiskDecision {
  return Object.freeze({ version: 1, mode: 'audited_exact', reasons: Object.freeze(reasons) });
}

/**
 * Décision déterministe du canal acoustique. Le transcript natif arrive après le RTP : il peut
 * révoquer une capacité mais ne peut pas effacer une phrase déjà entendue. L'absence d'un fait
 * extrait n'est donc jamais une autorisation ; seul un scénario exact et positivement allowlisté
 * passe en natif. Tout signal nouveau ou incohérent revient au chemin pré-audité.
 */
export function deriveOpenAiNativeSpeechRisk(
  input: OpenAiNativeSpeechRiskInput,
): OpenAiNativeSpeechRiskDecision {
  if (!validEnvelope(input.envelope)) return audited('invalid_envelope');
  // Ces deux phrases disposent déjà d'un artefact statique préapprouvé, plus sûr que le RTP.
  if (input.envelope.classification === 'fixed_safe') return audited('preapproved_artifact');
  if (input.hasControl || input.purpose === 'navigation' || input.purpose === 'action_proposal') {
    return audited('action_or_control');
  }
  if (input.purpose === 'structured_choice') return audited('interactive_choice');
  if (input.runKind === 'done' || input.purpose === 'action_result') {
    return audited('mutation_result');
  }
  if (input.source === 'natural_body') return audited('llm_naturalized');
  if (input.hasTenantContext) return audited('tenant_context');
  if (input.envelope.facts.length > 0) return audited('business_fact');
  if (
    input.purpose !== 'generic_assistance'
    || input.source !== 'card_body'
    || input.runKind !== 'answer'
  ) return audited('unknown_semantics');
  const scenarioId = eligibleScenario(input.envelope.text);
  if (scenarioId === null) return audited('unknown_semantics');
  return Object.freeze({ version: 1, mode: 'native_conversational', scenarioId });
}

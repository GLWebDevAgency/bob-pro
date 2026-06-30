import { type LlmPort, type LlmToolSpec } from '../llm/port';
import { type BobIntent, detectIntent, extractReference } from './intent';

/** Outils exposés au LLM pour la classification (params « humains » : référence, pas d'ID interne). */
export const LLM_TOOL_SPECS: LlmToolSpec[] = [
  {
    name: 'tresorerie_versement',
    description: "Calculer combien l'artisan peut se verser sans risque (trésorerie).",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'relance_brouillon',
    description: 'Rédiger un brouillon de relance pour la facture impayée la plus urgente (sans envoyer).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'factures_impayees',
    description: 'Lister les factures encore à encaisser.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'encaisser_facture',
    description: 'Marquer une facture comme encaissée (paiement reçu).',
    parameters: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Numéro de facture (ex. 2026-014) ou nom du client' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

const TOOL_TO_INTENT: Record<string, BobIntent> = {
  tresorerie_versement: 'payout',
  relance_brouillon: 'relance',
  factures_impayees: 'factures',
  encaisser_facture: 'encaisser',
};

/** Une étape résolue d'un plan (une intention + sa référence éventuelle). */
export interface PlanStep {
  intent: BobIntent;
  reference: string | null;
}

/** Plan = suite d'étapes (≥1) déduites de la demande, + modèle effectif. */
export interface ClassifiedPlan {
  steps: PlanStep[];
  model: string;
}

const SYSTEM_PROMPT =
  "Tu es Bob, copilote STRICTEMENT administratif et financier d'un artisan/indépendant français. " +
  "Ton périmètre se limite à : devis, factures, encaissements, trésorerie, relances, dépenses, conformité. " +
  "Choisis l'outil adapté à la demande. N'invente JAMAIS de montant ni d'information. " +
  "Pour TOUTE demande hors de ce périmètre (culture générale, code, autre domaine, conversation libre), " +
  "n'appelle AUCUN outil et ne tente pas d'y répondre — elle sera écartée poliment côté application.";

/** Classifie via le LLM (tool-calling) : un plan = TOUS les appels d'outils (multi-étapes possible).
 * En cas d'échec amont, lève — l'appelant retombe sur la regex. */
export async function classifyWithLlm(llm: LlmPort, message: string): Promise<ClassifiedPlan> {
  const res = await llm.complete([{ role: 'user', content: message }], {
    system: SYSTEM_PROMPT,
    tools: LLM_TOOL_SPECS,
    toolChoice: 'auto',
    temperature: 0,
  });
  const steps: PlanStep[] = [];
  for (const call of res.toolCalls) {
    const intent = TOOL_TO_INTENT[call.name];
    if (!intent) continue;
    const ref = call.arguments?.reference;
    steps.push({ intent, reference: typeof ref === 'string' && ref.trim() ? ref.trim() : null });
  }
  return { steps, model: res.model };
}

/** Classifie de façon déterministe (sans LLM) : toujours une seule étape. */
export function classifyWithRegex(message: string): ClassifiedPlan {
  return { steps: [{ intent: detectIntent(message), reference: extractReference(message) }], model: 'demo' };
}

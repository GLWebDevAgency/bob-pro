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

export interface Classification {
  intent: BobIntent;
  reference: string | null;
  model: string;
}

const SYSTEM_PROMPT =
  "Tu es Bob, copilote STRICTEMENT administratif et financier d'un artisan/indépendant français. " +
  "Ton périmètre se limite à : devis, factures, encaissements, trésorerie, relances, dépenses, conformité. " +
  "Choisis l'outil adapté à la demande. N'invente JAMAIS de montant ni d'information. " +
  "Pour TOUTE demande hors de ce périmètre (culture générale, code, autre domaine, conversation libre), " +
  "n'appelle AUCUN outil et ne tente pas d'y répondre — elle sera écartée poliment côté application.";

/** Classifie via le LLM (tool-calling). En cas d'échec amont, lève — l'appelant retombe sur la regex. */
export async function classifyWithLlm(llm: LlmPort, message: string): Promise<Classification> {
  const res = await llm.complete([{ role: 'user', content: message }], {
    system: SYSTEM_PROMPT,
    tools: LLM_TOOL_SPECS,
    toolChoice: 'auto',
    temperature: 0,
  });
  const call = res.toolCalls[0];
  const intent = call ? TOOL_TO_INTENT[call.name] : undefined;
  if (!call || !intent) return { intent: 'unknown', reference: null, model: res.model };
  const ref = call.arguments?.reference;
  return { intent, reference: typeof ref === 'string' && ref.trim() ? ref.trim() : null, model: res.model };
}

/** Classifie de façon déterministe (sans LLM). */
export function classifyWithRegex(message: string): Classification {
  return { intent: detectIntent(message), reference: extractReference(message), model: 'demo' };
}

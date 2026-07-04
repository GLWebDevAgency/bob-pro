import { type LlmPort, type LlmToolSpec } from '../llm/port';
import { redactPII } from '../guardrails/pii-redaction';
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
    description:
      'Rédiger un brouillon de relance pour une facture impayée (sans envoyer). Ciblable : facture ou client précis ; sans référence, la plus urgente.',
    parameters: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Numéro de facture (ex. 2026-014) ou nom du client à relancer' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'factures_impayees',
    description: 'Lister les factures encore à encaisser.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'documents_liste',
    description: 'Lister les documents archivés : factures PDF, XML Factur-X, reçus et justificatifs.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'envoyer_devis',
    description: 'Envoyer un devis au client pour signature.',
    parameters: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Numéro de devis, id ou nom du client' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'emettre_facture',
    description: 'Émettre une facture définitive avec numéro légal.',
    parameters: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Numéro de facture, id ou nom du client' },
      },
      required: [],
      additionalProperties: false,
    },
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
  {
    name: 'ouvrir_scan_recu',
    description: 'Ouvrir le scanner caméra (OCR) pour numériser un reçu, ticket ou justificatif de dépense.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'nouveau_devis',
    description: "Ouvrir l'écran de création d'un nouveau devis.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ouvrir_chantiers',
    description: 'Ouvrir la liste des chantiers.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ouvrir_cloture',
    description: 'Préparer le mois pour le comptable : anomalies, pièces manquantes, clôture.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ouvrir_diagnostic',
    description: 'Ouvrir le diagnostic de conformité 2026 (facturation électronique) : « suis-je prêt pour 2026 ? ».',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'echeances_fiscales',
    description: 'Lister les échéances fiscales à venir (TVA, URSSAF, IS, CFE, comptes annuels) : quoi payer ou déclarer, et quand.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'position_tva',
    description:
      'Position de TVA réelle : collectée sur les encaissements, déductible sur les achats, montant à provisionner ou crédit de TVA. Répond à « combien de TVA je dois ? ».',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'balance_agee',
    description:
      'Balance âgée clients : qui doit quoi, depuis combien de temps (tranches de retard, +90 jours = risque). Répond à « qui me doit de l’argent ? ».',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'payer_depense',
    description:
      'Régler une dépense fournisseur : passe la dépense en payée et écrit le décaissement au journal de banque (ex. « règle la dépense Leroy Merlin »).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const TOOL_TO_INTENT: Record<string, BobIntent> = {
  tresorerie_versement: 'payout',
  relance_brouillon: 'relance',
  factures_impayees: 'factures',
  documents_liste: 'documents',
  envoyer_devis: 'envoyer_devis',
  emettre_facture: 'emettre_facture',
  encaisser_facture: 'encaisser',
  ouvrir_scan_recu: 'scan',
  nouveau_devis: 'nouveau_devis',
  ouvrir_chantiers: 'voir_chantiers',
  ouvrir_cloture: 'cloture',
  ouvrir_diagnostic: 'diagnostic',
  echeances_fiscales: 'echeances',
  position_tva: 'tva',
  balance_agee: 'balance',
  payer_depense: 'payer_depense',
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
  // Minimisation RGPD : on masque le PII incident (email/tél/IBAN/SIREN) AVANT l'envoi au LLM cloud.
  // Les références métier (n° de facture, nom client) sont préservées — elles sont nécessaires à la résolution.
  const res = await llm.complete([{ role: 'user', content: redactPII(message) }], {
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

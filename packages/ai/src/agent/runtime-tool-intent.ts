import type { Tool } from '../tools/tool';
import type { BobIntent } from './intent';

export interface RuntimeToolIntentContract {
  /** Intention rendue dans la réponse après une exécution réussie. */
  readonly resultIntent: BobIntent;
  /**
   * Intentions dont l'autorité peut conduire à cet outil. Un resolver partagé déclare toutes
   * ses autorités possibles : dès qu'un MissionKind en absorbe une, le runtime historique
   * cesse de pouvoir l'invoquer sous cette policy.
   */
  readonly authorityIntents: readonly [BobIntent, ...BobIntent[]];
}

const contract = (
  resultIntent: BobIntent,
  ...authorityIntents: readonly [BobIntent, ...BobIntent[]]
): RuntimeToolIntentContract => Object.freeze({
  resultIntent,
  authorityIntents: Object.freeze([...authorityIntents]) as readonly [BobIntent, ...BobIntent[]],
});

/**
 * Contrat exhaustif de la surface runtime existante. Ce n'est pas un second registre métier :
 * l'ownership reste décidé exclusivement dans INTENT_OWNERSHIP ; cette table rattache seulement
 * chaque point d'effet historique à cette autorité canonique.
 */
export const RUNTIME_TOOL_INTENTS = Object.freeze({
  tresorerie_versement: contract('payout', 'payout'),
  relance_brouillon: contract('relance', 'relance'),
  factures_impayees: contract('factures', 'factures'),
  documents_liste: contract('documents', 'documents'),
  envoyer_devis: contract('envoyer_devis', 'envoyer_devis'),
  emettre_facture: contract('emettre_facture', 'emettre_facture'),
  encaisser_facture: contract('encaisser', 'encaisser'),
  creer_devis: contract('nouveau_devis', 'nouveau_devis'),
  scan_depense: contract('depense_dictee', 'depense_dictee'),
  generer_facture: contract('generer_facture', 'generer_facture'),
  facturer_situation: contract('facturer_situation', 'facturer_situation'),
  facture_directe: contract('facture_directe', 'facture_directe'),
  definir_conditions_paiement: contract('conditions_paiement', 'conditions_paiement'),
  programmer_encaissement_embargo: contract('generer_facture', 'generer_facture'),
  export_fec: contract('export_fec', 'export_fec'),
  envoyer_facture: contract('envoyer_facture', 'envoyer_facture'),
  envoyer_relance: contract('relance', 'relance'),
  relance_devis: contract('relance_devis', 'relance_devis'),
  marquer_facture_transmise: contract('declarer_transmission', 'declarer_transmission'),
  cadence_relances: contract('cadence_relances', 'cadence_relances'),
  regler_relances_auto: contract('cadence_relances', 'cadence_relances'),
  enregistrer_reglement_depense: contract('payer_depense', 'payer_depense'),
  lier_depense_chantier: contract('lier_depense_chantier', 'lier_depense_chantier'),
  marquer_notifications_lues: contract(
    'marquer_notifications_lues',
    'marquer_notifications_lues',
  ),
  echeances_fiscales: contract('echeances', 'echeances'),
  etat_abonnement: contract('abonnement', 'abonnement'),
  valider_document: contract('valider_document', 'valider_document'),
  classer_document: contract('classer_document', 'classer_document'),
  renommer_document: contract('renommer_document', 'renommer_document'),
  chercher_document: contract('chercher_document', 'chercher_document'),
  lier_bon_commande: contract('lier_bon_commande', 'lier_bon_commande'),
  creer_client: contract('creer_client', 'creer_client'),
  parc_du_site: contract('parc_equipements', 'parc_equipements'),
  ajouter_equipement: contract('ajouter_equipement', 'ajouter_equipement'),
  retirer_equipement: contract('retirer_equipement', 'retirer_equipement'),
  historique_equipement: contract('historique_equipement', 'historique_equipement'),
  statut_contrat: contract('statut_contrat', 'statut_contrat'),
  contrats_a_renouveler: contract('contrats_a_renouveler', 'contrats_a_renouveler'),
  preparer_facture_annuelle: contract('preparer_facture_annuelle', 'preparer_facture_annuelle'),
  creer_contrat_maintenance: contract(
    'creer_contrat_maintenance',
    'creer_contrat_maintenance',
  ),
  activer_contrat: contract('activer_contrat', 'activer_contrat'),
  resilier_contrat: contract('resilier_contrat', 'resilier_contrat'),
  renommer_contrat: contract('renommer_contrat', 'renommer_contrat'),
  passages_du_site: contract('passages_intervention', 'passages_intervention'),
  commencer_intervention: contract('commencer_intervention', 'commencer_intervention'),
  terminer_intervention: contract('terminer_intervention', 'terminer_intervention'),
  envoyer_fiche_passage: contract('envoyer_fiche_passage', 'envoyer_fiche_passage'),
  facturer_intervention: contract('facturer_intervention', 'facturer_intervention'),
  passages_a_facturer: contract('facturer_intervention', 'facturer_intervention'),
  reglages_fiche_passage: contract('reglages_intervention', 'reglages_intervention'),
  regler_fiche_passage: contract('reglages_intervention', 'reglages_intervention'),
} satisfies Readonly<Record<string, RuntimeToolIntentContract>>);

export type RuntimeToolName = keyof typeof RUNTIME_TOOL_INTENTS;

/** Outil construit par le registre Bob : son nom doit exister dans le contrat ci-dessus. */
export type RuntimeBobTool<In, Out> = Tool<In, Out> & {
  readonly name: RuntimeToolName;
};

export function runtimeToolIntentContract(
  tool: string,
): RuntimeToolIntentContract | null {
  return Object.hasOwn(RUNTIME_TOOL_INTENTS, tool)
    ? RUNTIME_TOOL_INTENTS[tool as RuntimeToolName]
    : null;
}

export function runtimeToolResultIntent(tool: string): BobIntent | null {
  return runtimeToolIntentContract(tool)?.resultIntent ?? null;
}

/**
 * Dérive les intentions réellement servies depuis les outils effectivement construits.
 *
 * Le registre omet déjà les actions optionnelles absentes. Cette projection réutilise donc sa
 * vérité runtime et le contrat canonique ci-dessus, sans entretenir une deuxième liste d'outils.
 */
export function runtimeIntentsForTools(
  tools: readonly Pick<Tool<unknown, unknown>, 'name'>[],
): ReadonlySet<BobIntent> {
  const intents = new Set<BobIntent>();
  for (const tool of tools) {
    const toolContract = runtimeToolIntentContract(tool.name);
    if (toolContract === null) continue;
    intents.add(toolContract.resultIntent);
    for (const intent of toolContract.authorityIntents) intents.add(intent);
  }
  return intents;
}

export type RuntimeToolOwnershipPreflight =
  | { readonly status: 'allowed' }
  | { readonly status: 'unknown_tool'; readonly tool: string }
  | {
      readonly status: 'mission_owned';
      readonly tool: string;
      readonly intent: BobIntent;
    };

/** Vérifie le lot entier avant le premier parse, journal ou effet. */
export function preflightRuntimeToolOwnership(
  tools: readonly string[],
  isIntentBlocked: (intent: BobIntent) => boolean,
): RuntimeToolOwnershipPreflight {
  for (const tool of tools) {
    const toolContract = runtimeToolIntentContract(tool);
    if (toolContract === null) return { status: 'unknown_tool', tool };
    const blocked = toolContract.authorityIntents.find(isIntentBlocked);
    if (blocked !== undefined) {
      return { status: 'mission_owned', tool, intent: blocked };
    }
  }
  return { status: 'allowed' };
}

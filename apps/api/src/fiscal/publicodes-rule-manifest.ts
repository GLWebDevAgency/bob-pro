import type { RègleModèleSocial } from 'modele-social';

/**
 * Manifeste ALLOWLISTÉ des dottedName Publicodes consommés par la façade Bob.
 *
 * SPIKE_PUBLICODES_20260715.md, réserve n°1 : « un renommage amont [de règle] doit devenir une
 * erreur de compilation ». Vérifié sur le `.d.ts` de `publicodes@1.10.1` (contre-revue GPT ③) :
 * `Engine<RuleNames>.evaluate(value: PublicodesExpression | ASTNode)` n'est PAS typé par
 * `RuleNames` (`PublicodesExpression = string | Record<string, unknown> | number`) — seuls
 * `getRule(dottedName: RuleNames)` et `setSituation(situation?: Situation<RuleNames>)` le sont.
 * Une chaîne brute passée à `evaluate()` peut donc compiler même après un renommage.
 *
 * Double garde-fou, donc :
 *  1. Ce manifeste est typé `satisfies Record<string, RègleModèleSocial>` : toute clé absente de
 *     l'union `Names` de `modele-social` fait échouer LE BUILD (tsc), pas seulement à l'exécution.
 *  2. `PublicodesEvaluationService.onModuleInit` appelle `engine.getRule(dottedName)` pour CHAQUE
 *     entrée AU BOOT : un renommage qui échapperait au (1) (ex. mise à jour de `modele-social`
 *     sans régénérer les types localement) fait échouer le DÉMARRAGE du process, jamais un calcul
 *     silencieusement faux.
 *
 * Découverte de due diligence (au-delà du spike, vérifiée empiriquement sur des scratch tests) :
 * `evaluate(<chaîne brute>)` peut, pour certaines règles, se résoudre INCORRECTEMENT (désambiguïsation
 * de référence différente de celle de `getRule()` pour un `evaluate()` de premier niveau — reproduit
 * sur `entreprise . activité . nature`, qui retombe systématiquement sur 'libérale' quelle que soit la
 * situation quand on l'évalue via une chaîne nue, alors que `evaluate(getRule(nom))` respecte
 * correctement la situation). `PublicodesEvaluationService.evaluateRule` n'utilise donc JAMAIS
 * `engine.evaluate(<string>)` directement : toujours `engine.evaluate(engine.getRule(name))`.
 */
export const PUBLICODES_RULE_MANIFEST = {
  // ── Bascules de branche + contexte requis (micro-entrepreneur) ──
  microEntrepreneur: "dirigeant . auto-entrepreneur",
  // CRITIQUE (trouvaille de due diligence, cf. publicodes-evaluation.service.ts) : sans cette
  // règle, le chiffre d'affaires se route silencieusement dans la mauvaise catégorie de
  // cotisation (Cipav/BNC au lieu de BIC vente/service) — jamais l'omettre.
  categorieJuridique: "entreprise . catégorie juridique",
  categorieJuridiqueEiAutoEntrepreneur: "entreprise . catégorie juridique . EI . auto-entrepreneur",
  activiteNature: "entreprise . activité . nature",
  activiteServiceOuVente: "entreprise . activités . service ou vente",
  activiteCipav: "dirigeant . auto-entrepreneur . Cipav",
  activiteRevenusMixtes: "entreprise . activité . revenus mixtes",
  chiffreAffaires: "dirigeant . auto-entrepreneur . chiffre d'affaires",
  acreToggle: "dirigeant . exonérations . ACRE",
  entrepriseDateCreation: "entreprise . date de création",
  versementLiberatoire: "dirigeant . auto-entrepreneur . impôt . versement libératoire",
  evaluationDate: "date",

  // ── Sorties micro-entrepreneur ──
  microCotisations: "dirigeant . auto-entrepreneur . cotisations et contributions",
  microRevenuNet: "dirigeant . auto-entrepreneur . revenu net",
  microTauxAcre: "dirigeant . auto-entrepreneur . Acre . taux Acre",

  // ── Assimilé salarié (SASU/SAS) ──
  regimeSocial: "dirigeant . régime social",
  netAPayerAvantImpot: "salarié . rémunération . net . à payer avant impôt",
  salaireBrut: "salarié . contrat . salaire brut",
  coutTotalEmployeur: "salarié . coût total employeur",
} as const satisfies Record<string, RègleModèleSocial>;

export type PublicodesRuleManifestKey = keyof typeof PUBLICODES_RULE_MANIFEST;
export type PublicodesRuleName = RègleModèleSocial;

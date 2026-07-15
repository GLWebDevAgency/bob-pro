import type Engine from 'publicodes';
import type { EvaluatedNode } from 'publicodes';
import type { PublicodesRuleName } from './publicodes-rule-manifest';

/**
 * Évalue une règle Publicodes en passant TOUJOURS par `getRule()` avant `evaluate()`.
 *
 * Trouvaille de due diligence (au-delà du spike, contre-revue GPT ③) : `Engine.evaluate(value:
 * PublicodesExpression | ASTNode)` n'est pas typé par `RuleNames` et, pire, un `evaluate(<chaîne
 * brute>)` de PREMIER NIVEAU peut se désambiguïser DIFFÉREMMENT de `getRule()` pour certaines
 * règles — reproduit sur `entreprise . activité . nature` : `engine.evaluate('entreprise . activité
 * . nature')` retombe systématiquement sur 'libérale' quelle que soit la situation (et même sans
 * situation, alors que le « par défaut » documenté est 'commerciale'), alors que
 * `engine.evaluate(engine.getRule('entreprise . activité . nature'))` respecte correctement la
 * situation. Toujours passer par le `RuleNode` (AST déjà résolu par nom exact, pas re-parsé comme
 * expression) élimine cette classe de désambiguïsation incorrecte — et donne, de surcroît, le
 * typage `RuleNames` que `evaluate()` seul n'offre pas (`getRule(dottedName: RuleNames)` est
 * strictement typé).
 *
 * Ne JAMAIS appeler `engine.evaluate(<string>)` directement ailleurs dans ce module — toujours
 * passer par cette fonction.
 */
export function evaluateRule(engine: Engine<PublicodesRuleName>, name: PublicodesRuleName): EvaluatedNode {
  return engine.evaluate(engine.getRule(name));
}

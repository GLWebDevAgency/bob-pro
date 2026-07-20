import { serializeUnit } from 'publicodes';
import type Engine from 'publicodes';
import type { CalculationTraceReference, CalculationTraceV1 } from './fiscal-simulation.types';
import type { PublicodesRuleName } from './publicodes-rule-manifest';
import { evaluateRule } from './publicodes-safe-eval';

function curatedReferences(rawReferences: Record<string, string> | undefined): CalculationTraceReference[] {
  if (!rawReferences) return [];
  return Object.entries(rawReferences).map(([label, url]) => ({ label, url }));
}

/**
 * Construit une trace NORMALISÉE et STABLE — jamais `rawNode`/`explanation`/AST bruts exposés
 * (contre-revue GPT ④ : l'AST Publicodes n'est pas couvert par le semver amont, spike §6). Puise
 * uniquement dans l'API publique documentée : `RuleNode.title`, `EvaluatedNode.nodeValue`/`.unit`
 * (sérialisé via `serializeUnit`, export public stable), `RuleNode.rawNode.références` (un simple
 * dictionnaire libellé→URL — la seule partie de `rawNode` consommée ici).
 */
export function buildCalculationTrace(engine: Engine<PublicodesRuleName>, name: PublicodesRuleName): CalculationTraceV1 {
  const rule = engine.getRule(name);
  const evaluated = evaluateRule(engine, name);
  const nodeValue = evaluated.nodeValue;
  return {
    ruleTitle: rule.title,
    valeur: nodeValue === undefined ? null : nodeValue,
    unite: serializeUnit(evaluated.unit) ?? null,
    references: curatedReferences(rule.rawNode.références),
  };
}

import { type Result, ok, err, type AppError } from '@bob/core';
import { ModelRouter, type ModelChoice } from '../router/model-router';
import { renderWithGuard } from '../guardrails/money-guard';
import { type BobCapabilities } from './capabilities';

export type BobIntent = 'payout' | 'relance' | 'unknown';

export interface ActionCard {
  title: string;
  body: string;
}

export interface AgentRun {
  intent: BobIntent;
  model: ModelChoice;
  plan: string[];
  card: ActionCard;
}

export function detectIntent(message: string): BobIntent {
  const m = message.toLowerCase();
  if (/(verser|me payer|me paye|combien|salaire|payer)/.test(m)) return 'payout';
  if (/(relanc|impay|en retard|rappel)/.test(m)) return 'relance';
  return 'unknown';
}

export interface BobAgentDeps {
  router: ModelRouter;
  caps: BobCapabilities;
}

/**
 * Orchestrateur agentique de Bob (mode démo déterministe).
 * Boucle : détecter l'intention -> annoncer le plan -> exécuter un use case (via capability)
 * -> rendre une carte d'action dont les montants viennent du domaine (garde-fou anti-hallucination).
 */
export class BobAgent {
  constructor(private readonly deps: BobAgentDeps) {}

  async ask(message: string): Promise<Result<AgentRun, AppError>> {
    const intent = detectIntent(message);
    const model = this.deps.router.route('agent.plan').model;

    if (intent === 'payout') {
      const r = await this.deps.caps.computePayout();
      if (!r.ok) return err(r.error);
      const guard = renderWithGuard(
        'Tu peux te verser {{payout}} sans risque. Je garderais le reste pour la TVA et les charges.',
        [{ token: 'payout', cents: r.value.payoutCents }],
      );
      if (!guard.ok) return err({ kind: 'dependency', port: 'money-guard', cause: guard.violations.join(', ') });
      return ok({
        intent,
        model,
        plan: ['Lire la trésorerie réelle', 'Calculer le versement sans risque', 'Préparer la réponse'],
        card: { title: 'Combien tu peux te verser', body: guard.rendered },
      });
    }

    if (intent === 'relance') {
      const r = await this.deps.caps.draftRelance();
      if (!r.ok) return err(r.error);
      return ok({
        intent,
        model,
        plan: ['Repérer la facture en retard', 'Choisir le ton adapté', 'Rédiger la relance'],
        card: { title: r.value.subject, body: r.value.body },
      });
    }

    return ok({
      intent: 'unknown',
      model,
      plan: ['Comprendre la demande'],
      card: {
        title: 'Bob',
        body: 'Je peux calculer ce que tu peux te verser, préparer des relances, et plus. Dis-moi ce qu’il te faut.',
      },
    });
  }
}

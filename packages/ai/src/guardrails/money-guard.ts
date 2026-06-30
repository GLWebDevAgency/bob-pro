import { formatEUR } from '@bob/core';

export interface ResolvedValue {
  token: string;
  cents: number;
}

export interface GuardResult {
  ok: boolean;
  rendered: string;
  violations: string[];
}

// Détecte un montant monétaire : chiffres + séparateurs (espaces normaux/insécables/fines) suivis de la devise.
const MONEY_RE = /\d[\d\s.,]*(?:€|EUR|euros?)/gi;
const stripWs = (s: string): string => s.replace(/[\s]/g, '');

/**
 * Substitue les placeholders {{token}} par des montants calculés par le domaine,
 * puis REJETTE tout montant monétaire du texte final absent de l'ensemble autorisé.
 * Garantit que le LLM n'a jamais « inventé » un chiffre.
 */
export function renderWithGuard(template: string, values: ResolvedValue[]): GuardResult {
  let rendered = template;
  for (const v of values) rendered = rendered.split(`{{${v.token}}}`).join(formatEUR(v.cents));
  const allowed = new Set(values.map((v) => stripWs(formatEUR(v.cents))));
  const found = rendered.match(MONEY_RE) ?? [];
  const violations = found.map((f) => f.trim()).filter((f) => !allowed.has(stripWs(f)));
  return { ok: violations.length === 0, rendered, violations };
}

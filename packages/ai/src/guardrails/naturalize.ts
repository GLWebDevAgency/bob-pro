/**
 * Naturalisation des réponses (LIVE-2) — Bob cesse de réciter des gabarits : le LLM
 * reformule les FAITS calculés par le domaine en langage parlé (ton ×3 humeurs), et un
 * GARDE-FOU FACTUEL rejette toute reformulation qui déforme, invente ou déplace un
 * montant, un pourcentage ou un numéro de pièce — dans ce cas, le gabarit source est
 * conservé tel quel (la voix ne ment jamais, même au prix du style).
 *
 * Principes non négociables :
 * · le LLM ne CALCULE rien : il met en mots un body déjà exact (source de vérité) ;
 * · tout fait chiffré présent dans la reformulation DOIT exister dans la source
 *   (l'omission est tolérée — condenser est un droit, déformer jamais) ;
 * · les actions PROPOSÉES (confirmations) ne sont JAMAIS naturalisées : la consigne de
 *   consentement explicite reste verbatim (plancher de sécurité).
 */
import { type LlmMessage, type LlmPort } from '../llm/port';

// Mêmes familles de faits que money-guard, élargies aux pièces et pourcentages.
const MONEY_RE = /\d[\d\s.,  ]*(?:€|EUR|euros?)/gi;
const PIECE_RE = /\b[DFA]-?\d{4}-\d{2,}\b/gi;
const PERCENT_RE = /\d+(?:[.,]\d+)?\s*%/g;

const stripWs = (s: string): string => s.replace(/[\s  ]/g, '').toLowerCase();

/** Faits chiffrés d'un texte, normalisés pour comparaison stricte. */
export function extractFacts(text: string): Set<string> {
  const facts = new Set<string>();
  for (const m of text.match(MONEY_RE) ?? []) facts.add(stripWs(m).replace(/euros?|eur/i, '€'));
  for (const m of text.match(PIECE_RE) ?? []) facts.add(stripWs(m));
  for (const m of text.match(PERCENT_RE) ?? []) facts.add(stripWs(m));
  return facts;
}

/** Faits de `natural` absents de `source` — une liste non vide invalide la reformulation. */
export function naturalizationViolations(source: string, natural: string): string[] {
  const allowed = extractFacts(source);
  return [...extractFacts(natural)].filter((fact) => !allowed.has(fact));
}

export type NaturalizeTone = 'pote' | 'pro' | 'direct';

const TONE_HINT: Record<NaturalizeTone, string> = {
  pote: 'Tutoie, chaleureux et direct, comme un pote de confiance qui est expert-comptable.',
  pro: 'Vouvoie, professionnel et posé, comme un expert-comptable attentif.',
  direct: 'Tutoie, ultra concis, phrases courtes, zéro fioriture.',
};

const MAX_NATURAL_LENGTH = 420;

export interface NaturalizeInput {
  /** Faits à transmettre — la SOURCE DE VÉRITÉ (title + body du run). */
  title: string;
  body: string;
  /** La demande de l'utilisateur (contexte de formulation). */
  userMessage: string;
  tone: NaturalizeTone;
  /** Derniers échanges (déjà expurgés par l'appelant si nécessaire) — le liant conversationnel. */
  history?: readonly LlmMessage[];
}

/**
 * Reformule pour l'oral — retourne null si le LLM échoue, déborde ou VIOLE les faits :
 * l'appelant garde alors le gabarit source (fallback inconditionnel, jamais bloquant).
 */
export async function naturalizeReply(llm: LlmPort, input: NaturalizeInput): Promise<string | null> {
  try {
    const r = await llm.generate([
      {
        role: 'system',
        content:
          `Tu es Bob, copilote comptable d'un indépendant français. Reformule les FAITS fournis en une réponse parlée naturelle (1 à 3 phrases courtes, pas de listes, pas de markdown, pas d'emoji). ${TONE_HINT[input.tone]} ` +
          'INTERDICTION ABSOLUE de modifier, arrondir, ajouter ou inventer un montant, un pourcentage, une date ou un numéro de pièce : reprends-les EXACTEMENT tels quels, ou omets-les. ' +
          'Réponds UNIQUEMENT avec la reformulation, rien d’autre.',
      },
      ...(input.history ?? []),
      {
        role: 'user',
        content: `Demande de l'utilisateur : ${input.userMessage}\nFaits à transmettre (source de vérité) : ${input.title}. ${input.body}`,
      },
    ]);
    const natural = r.text?.trim();
    if (!natural || natural.length > MAX_NATURAL_LENGTH) return null;
    if (naturalizationViolations(`${input.title} ${input.body}`, natural).length > 0) return null;
    return natural;
  } catch {
    return null; // le style n'est jamais bloquant — le gabarit reste
  }
}

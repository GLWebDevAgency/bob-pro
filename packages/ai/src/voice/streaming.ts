/**
 * PRIMITIVES BOB LIVE (P1) — le socle du streaming voix-à-voix (SPEC_BOB_LIVE.md).
 *
 * · `splitSpokenSentences` : découpe un texte FR en phrases PRONONÇABLES — Bob commence à
 *   parler dès la première phrase d'une réponse longue au lieu d'attendre tout le texte.
 *   Protège ce qui ressemble à une fin de phrase mais n'en est pas : abréviations (M., n°),
 *   décimaux (1,5), montants (1 386,00 €), numéros de pièce (2026-014), ellipses.
 * · `SentenceAccumulator` : la même découpe en FLUX (P2/P3) — on pousse des tokens LLM,
 *   il rend les phrases complètes au fil de l'eau, `flush()` livre le reste.
 * · `VoiceLatencyTrace` : mesure OBLIGATOIRE de chaque tour (fin de parole → 1er audio),
 *   agrégée en p50/p95 — on ne pilote que ce qu'on mesure (cibles : ≤900 ms p50 voix→voix).
 *
 * Tout est PUR (aucune horloge interne : les instants sont fournis par l'appelant).
 */

/** Abréviations FR fréquentes dont le point ne termine JAMAIS une phrase. */
const ABBREVIATIONS = new Set([
  'm', 'mme', 'mlle', 'dr', 'me', 'st', 'ste', 'art', 'ref', 'réf', 'no', 'n°', 'etc',
  'ex', 'cf', 'tel', 'tél', 'max', 'min', 'env',
]);

const SENTENCE_END = /[.!?…]/;

function endsWithAbbreviation(chunk: string): boolean {
  const m = /([A-Za-zÀ-ÿ°]+)\.$/.exec(chunk.trimEnd());
  if (!m || m[1] === undefined) return false;
  return ABBREVIATIONS.has(m[1].toLowerCase());
}

/** Vrai si la coupure à `index` (caractère de fin trouvé) termine réellement une phrase. */
function isRealSentenceEnd(text: string, index: number): boolean {
  const char = text[index]!;
  const before = text.slice(0, index + 1);
  const after = text.slice(index + 1);
  if (char === '.') {
    // Décimal ou numéro (1.5, 2026.14) : chiffre de part et d'autre.
    if (/\d$/.test(before.slice(0, -1)) && /^\d/.test(after)) return false;
    if (endsWithAbbreviation(before)) return false;
  }
  // La phrase ne finit que si la suite ouvre autre chose (espace + majuscule/chiffre/puce) ou rien.
  return after === '' || /^\s*$/.test(after) || /^\s+[A-ZÀ-Ý0-9•«"—-]/.test(after) || /^\s*\n/.test(after);
}

const MIN_SENTENCE_CHARS = 12;

/** Découpe un texte en phrases prononçables ; les fragments trop courts fusionnent avec la suivante. */
export function splitSpokenSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    current += char;
    if (char === '\n' && current.trim() !== '') {
      sentences.push(current.trim());
      current = '';
      continue;
    }
    if (SENTENCE_END.test(char) && isRealSentenceEnd(text, index)) {
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') sentences.push(current.trim());
  // Fusion des fragments trop courts (« OK. » seul n'est pas un tour de parole utile).
  const merged: string[] = [];
  for (const sentence of sentences) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.length < MIN_SENTENCE_CHARS) {
      merged[merged.length - 1] = `${previous} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }
  return merged.filter((sentence) => sentence !== '');
}

/** Découpe en FLUX : on pousse des tokens, il rend les phrases complètes au fil de l'eau. */
export class SentenceAccumulator {
  private buffer = '';

  /** Ajoute du texte ; retourne les phrases COMPLÈTES devenues disponibles. */
  push(tokenText: string): string[] {
    this.buffer += tokenText;
    // Dernière frontière RÉELLE de phrase dans le tampon brut — le reste (espaces compris)
    // reste en tampon tel quel : recoller « reste » + « pour » ne doit jamais manger l'espace.
    let lastEnd = -1;
    // Le DERNIER caractère du tampon n'est jamais une frontière en flux : « 1 386. » peut
    // être suivi de « 50 » au token suivant — on attend la confirmation (ou flush()).
    for (let index = 0; index < this.buffer.length - 1; index += 1) {
      const char = this.buffer[index]!;
      if ((SENTENCE_END.test(char) && isRealSentenceEnd(this.buffer, index)) || char === '\n') {
        lastEnd = index;
      }
    }
    if (lastEnd < 0) return [];
    const completeRaw = this.buffer.slice(0, lastEnd + 1);
    this.buffer = this.buffer.slice(lastEnd + 1);
    return splitSpokenSentences(completeRaw);
  }

  /** Fin de flux : livre ce qui reste. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest === '' ? [] : [rest];
  }
}

// ─────────────────────────── Latence (on ne pilote que ce qu'on mesure) ───────────────────────────

export interface VoiceLatencyTrace {
  /** Fin de la parole utilisateur (final ASR reçu). */
  sttFinalAt?: number;
  /** Départ de la demande vers le cerveau. */
  askSentAt?: number;
  /** Premier token/phrase reçu du cerveau (streaming) ou réponse complète (HTTP). */
  firstTokenAt?: number;
  /** Début de la synthèse du premier segment. */
  sayStartAt?: number;
  /** L'utilisateur a coupé Bob. */
  interruptedAt?: number;
  /** Bob s'est tu après interruption. */
  silencedAt?: number;
}

export interface VoiceLatencySummary {
  turns: number;
  /** Fin de parole → début du premier audio de Bob. */
  voiceToVoiceMsP50: number | null;
  voiceToVoiceMsP95: number | null;
  /** Interruption → silence de Bob. */
  interruptMsP50: number | null;
  interruptMsP95: number | null;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

export function voiceToVoiceMs(trace: VoiceLatencyTrace): number | null {
  return trace.sttFinalAt !== undefined && trace.sayStartAt !== undefined && trace.sayStartAt >= trace.sttFinalAt
    ? trace.sayStartAt - trace.sttFinalAt
    : null;
}

export function interruptMs(trace: VoiceLatencyTrace): number | null {
  return trace.interruptedAt !== undefined &&
    trace.silencedAt !== undefined &&
    trace.silencedAt >= trace.interruptedAt
    ? trace.silencedAt - trace.interruptedAt
    : null;
}

export function summarizeVoiceLatency(traces: readonly VoiceLatencyTrace[]): VoiceLatencySummary {
  const v2v = traces.map(voiceToVoiceMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const cut = traces.map(interruptMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  return {
    turns: traces.length,
    voiceToVoiceMsP50: percentile(v2v, 50),
    voiceToVoiceMsP95: percentile(v2v, 95),
    interruptMsP50: percentile(cut, 50),
    interruptMsP95: percentile(cut, 95),
  };
}

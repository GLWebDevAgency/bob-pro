/**
 * TRAÇAGE DU COMPORTEMENT VOCAL — règles pures (bêta-test fondateur).
 *
 * Objet : rendre COMPRÉHENSIBLE et REPRODUCTIBLE un tour de conversation vocale. Pas seulement
 * les pannes : ce qui a été dit, ce que Bob a compris, l'outil qu'il a choisi, ses paramètres,
 * l'issue, sa réponse et le temps passé à chaque étape.
 *
 * SOUVERAINETÉ. Ces traces restent dans NOTRE PostgreSQL, jamais chez un tiers. Un transcript
 * vocal porte les données les plus sensibles de l'app (noms de clients, montants, SIRET) —
 * elles sont déjà explicitement exclues de la télémétrie de plantage pour motif RGPD
 * (`telemetry-scrubbing.ts`). Les envoyer à un observateur LLM tiers créerait un sous-traitant
 * pour exactement ces données. Corollaire assumé : AUCUNE rédaction n'est appliquée ici — le
 * contenu brut EST l'objet du traçage. Ce qui borne le risque, c'est la rétention courte
 * (VOICE_TRACE_RETENTION_DAYS) et l'isolation tenant (RLS FORCE), pas le masquage.
 *
 * Fonctions pures et déterministes : aucune horloge, aucun accès base, aucun effet de bord.
 */

/* ------------------------------------------------------------------ constantes de politique */

/**
 * RÉTENTION — 30 jours. Ces traces sont du DEBUG de bêta-test, pas une archive légale : elles
 * ne portent aucune obligation de conservation (contrairement aux pièces comptables, 10 ans).
 * 30 jours couvre largement la boucle utile — le fondateur signale un comportement, Claude
 * rejoue la session, corrige — tout en bornant l'exposition d'un stock de transcripts en clair.
 * Plus court (7 j) perdrait les retours différés d'un testeur ; plus long accumulerait des
 * données sensibles sans usage de diagnostic.
 */
export const VOICE_TRACE_RETENTION_DAYS = 30;

/**
 * Fenêtre d'inactivité au-delà de laquelle un nouveau tour ouvre une NOUVELLE session vocale.
 * 5 minutes : au-delà, l'artisan a raccroché puis repris — recoller les deux dans un même fil
 * rendrait la lecture trompeuse.
 */
export const VOICE_TRACE_SESSION_IDLE_MS = 5 * 60_000;

/** Bornes de taille. Un tour anormalement gros ne doit ni saturer la base ni le terminal. */
export const VOICE_TRACE_TRANSCRIPT_MAX_CHARS = 2_000;
export const VOICE_TRACE_REPLY_MAX_CHARS = 4_000;
export const VOICE_TRACE_ARGS_MAX_CHARS = 4_000;

/** Marqueur explicite : une trace tronquée ne doit jamais passer pour une trace complète. */
export const VOICE_TRACE_TRUNCATION_MARK = '… [tronqué]';

/* ------------------------------------------------------------------ vocabulaire du tour */

/** Étapes chronométrées d'un tour. Les noms sont ceux affichés au lecteur du script. */
export type VoiceTraceStage = 'transcription' | 'planification' | 'execution' | 'synthese';

/**
 * Issue d'un tour.
 * - `heard`   : Bob a entendu, rien n'a suivi (l'artisan n'a pas envoyé la demande, ou l'app
 *               a coupé). État observable À PART ENTIÈRE — c'est un symptôme, pas un trou.
 * - `success` : la demande a abouti.
 * - `refused` : Bob a dit non POUR UNE BONNE RAISON (droit, entitlement, donnée absente).
 * - `error`   : anomalie réelle.
 */
export type VoiceTurnOutcome = 'heard' | 'success' | 'refused' | 'error';

/** Niveau d'alerte. `error` est le SEUL niveau qui remonte au canal d'incident. */
export type VoiceTraceLevel = 'info' | 'warn' | 'error';

/** Faits d'un AppError, réduits à ce qui est journalisable (jamais l'objet d'erreur brut). */
export interface VoiceTraceErrorFacts {
  readonly kind: string;
  readonly port?: string | undefined;
  readonly service?: string | undefined;
  readonly cause?: string | undefined;
  readonly reason?: string | undefined;
  readonly entity?: string | undefined;
  readonly issues?: ReadonlyArray<{ readonly field: string; readonly message: string }> | undefined;
}

export interface VoiceTurnClassification {
  readonly outcome: VoiceTurnOutcome;
  readonly level: VoiceTraceLevel;
  /** Remontée au canal d'incident (ErrorReporter → Sentry). Vrai uniquement pour `error`. */
  readonly reportable: boolean;
  /** Raison lisible du refus / de l'anomalie. `null` quand le tour a abouti. */
  readonly reason: string | null;
}

/**
 * Kinds qui décrivent un REFUS MÉTIER ATTENDU : Bob a délibérément dit non. Ce n'est pas une
 * panne — c'est le produit qui protège l'artisan (règle légale, offre insuffisante, pièce
 * introuvable, saisie incomplète). Niveau `warn` : cherchable et compté, jamais alarmant.
 */
const BUSINESS_REFUSAL_KINDS: ReadonlySet<string> = new Set([
  'validation',
  'forbidden',
  'not_found',
  'conflict',
  'domain',
]);

/**
 * Dégradation ASSUMÉE : le serveur a refusé de servir une donnée qu'il n'a pas. Même doctrine
 * que `exception.filter.ts` — `warn` SANS remontée : rien à réparer côté serveur.
 */
const ASSUMED_DEGRADATION_KIND = 'unavailable';

/**
 * Classe l'issue d'un tour selon les TROIS niveaux exigés par le bêta-test :
 *  (a) comportement normal → info ;
 *  (b) refus métier attendu → warn, avec sa raison, sans remontée ;
 *  (c) anomalie réelle → error, et celle-là SEULE remonte au canal d'incident.
 *
 * Aligné sur `apps/api/src/observability/exception.filter.ts` : `unavailable` = état assumé
 * (jamais remonté), `dependency` = un amont a RÉELLEMENT échoué (remonté). Nuance assumée sur
 * le NIVEAU : le filtre HTTP logue `dependency` en `warn` pour ne pas saturer le log d'accès ;
 * ici la trace vocale l'élève à `error`, parce qu'un tour vocal cassé par une panne amont est
 * exactement ce que le fondateur nous demande de voir en tête de liste.
 */
export function classifyVoiceTurn(error: VoiceTraceErrorFacts | null): VoiceTurnClassification {
  if (error === null) {
    return { outcome: 'success', level: 'info', reportable: false, reason: null };
  }
  const reason = describeVoiceTurnError(error);
  if (BUSINESS_REFUSAL_KINDS.has(error.kind) || error.kind === ASSUMED_DEGRADATION_KIND) {
    return { outcome: 'refused', level: 'warn', reportable: false, reason };
  }
  return { outcome: 'error', level: 'error', reportable: true, reason };
}

/**
 * Raison lisible d'un refus ou d'une anomalie. Concatène les faits STRUCTURÉS de l'AppError —
 * y compris les `issues` de validation, qui disent précisément quel champ manquait à Bob.
 * (Elles sont exclues de la télémétrie tierce ; ici on est dans notre base souveraine.)
 */
export function describeVoiceTurnError(error: VoiceTraceErrorFacts): string {
  const parts: string[] = [error.kind];
  for (const [label, value] of [
    ['service', error.service],
    ['port', error.port],
    ['entité', error.entity],
    ['motif', error.reason],
    ['cause', error.cause],
  ] as const) {
    if (typeof value === 'string' && value.length > 0) parts.push(`${label}=${value}`);
  }
  for (const issue of error.issues ?? []) {
    parts.push(`champ ${issue.field} : ${issue.message}`);
  }
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ continuité de session */

/** Position courante dans une session vocale, conservée entre deux tours. */
export interface VoiceSessionCursor {
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly lastActivityAtMs: number;
}

/**
 * Décide si le tour qui s'ouvre PROLONGE la session précédente ou en démarre une nouvelle.
 *
 * Le tour vocal traverse trois requêtes HTTP distinctes (/voice/transcribe → /ai/ask →
 * /voice/synthesize) : rien dans le protocole actuel ne les relie. La continuité est donc
 * reconstruite côté serveur par inactivité, et `candidateSessionId` n'est consommé que
 * lorsqu'une NOUVELLE session s'ouvre — jamais pour écraser une session en cours.
 *
 * Une horloge qui recule (`nowMs` < dernière activité) ouvre aussi une nouvelle session :
 * mieux vaut un fil coupé qu'un index de tour incohérent.
 */
export function resolveVoiceSessionCursor(
  previous: VoiceSessionCursor | null,
  nowMs: number,
  candidateSessionId: string,
  idleMs: number = VOICE_TRACE_SESSION_IDLE_MS,
): VoiceSessionCursor {
  const continues =
    previous !== null &&
    nowMs >= previous.lastActivityAtMs &&
    nowMs - previous.lastActivityAtMs <= idleMs;
  if (!continues) {
    return { sessionId: candidateSessionId, turnIndex: 1, lastActivityAtMs: nowMs };
  }
  return {
    sessionId: previous.sessionId,
    turnIndex: previous.turnIndex + 1,
    lastActivityAtMs: nowMs,
  };
}

/* ------------------------------------------------------------------ bornage des contenus */

/** Tronque en signalant la troncature. Une trace muette sur sa propre amputation ment. */
export function boundVoiceTraceText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}${VOICE_TRACE_TRUNCATION_MARK}`;
}

/**
 * Borne les paramètres d'outil destinés à la colonne JSON. Au-delà du plafond, la valeur est
 * remplacée par un aperçu EXPLICITEMENT marqué tronqué plutôt que par un objet mutilé dont on
 * ne saurait plus dire s'il reflète ce que Bob a réellement passé à l'outil.
 */
export function boundVoiceTraceArgs(
  args: unknown,
  maxChars: number = VOICE_TRACE_ARGS_MAX_CHARS,
): unknown {
  if (args === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? 'null';
  } catch {
    // Cycle ou valeur non sérialisable : on le DIT, on n'invente pas des paramètres.
    return { tronque: true, apercu: '[paramètres non sérialisables]' };
  }
  if (serialized.length <= maxChars) return args;
  return { tronque: true, apercu: serialized.slice(0, maxChars) };
}

/* ------------------------------------------------------------------ latences */

/** Latences par étape, en millisecondes. Une étape non franchie reste `null`, jamais 0. */
export interface VoiceTurnLatencies {
  readonly transcriptionMs: number | null;
  readonly planificationMs: number | null;
  readonly executionMs: number | null;
  readonly syntheseMs: number | null;
}

export const EMPTY_VOICE_TURN_LATENCIES: VoiceTurnLatencies = {
  transcriptionMs: null,
  planificationMs: null,
  executionMs: null,
  syntheseMs: null,
};

/** Somme des étapes RÉELLEMENT mesurées. Les étapes absentes ne comptent pas pour zéro. */
export function voiceTurnTotalMs(latencies: VoiceTurnLatencies): number {
  return (
    (latencies.transcriptionMs ?? 0) +
    (latencies.planificationMs ?? 0) +
    (latencies.executionMs ?? 0) +
    (latencies.syntheseMs ?? 0)
  );
}

/* ------------------------------------------------------------------ rétention */

/**
 * Échéance de purge d'une trace. Matérialisée EN COLONNE pour qu'une purge puisse s'exécuter
 * sans rejouer la politique : la ligne porte sa propre date de péremption.
 */
export function voiceTraceExpiryAt(
  startedAtIso: string,
  retentionDays: number = VOICE_TRACE_RETENTION_DAYS,
): string {
  const startedAtMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error('voiceTraceExpiryAt : date de début invalide.');
  }
  return new Date(startedAtMs + retentionDays * 24 * 60 * 60 * 1_000).toISOString();
}

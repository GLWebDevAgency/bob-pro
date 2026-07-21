/**
 * POLITIQUE DE MINIMISATION — télémétrie de plantage (crash reporting tiers, Sentry).
 *
 * Bob Pro est une application financière : un rapport de plantage ne doit JAMAIS transporter
 * une donnée client (nom, e-mail, SIRET, IBAN, montant), un corps de requête ni un transcript
 * vocal. Cette politique est appliquée sur le chemin `beforeSend`/`beforeBreadcrumb` du SDK,
 * c'est-à-dire APRÈS la construction de l'événement et AVANT toute sortie réseau.
 *
 * Deux principes non négociables :
 *
 * 1. LISTE BLANCHE STRUCTURELLE. `scrubTelemetryEvent` RECONSTRUIT l'événement à partir des
 *    seuls champs explicitement autorisés au lieu de supprimer les champs connus comme
 *    dangereux. Un champ ajouté demain par une nouvelle version du SDK (ou par une intégration
 *    activée par erreur) est donc écarté PAR DÉFAUT — jamais transmis parce qu'on aurait
 *    oublié de le blacklister.
 * 2. REDACTION DE DÉFENSE EN PROFONDEUR. Le texte qui survit à la liste blanche (message
 *    d'erreur, nom de transaction, ligne de source) passe par `redactTelemetryText`.
 *
 * Divergence ASSUMÉE avec `redactPII` (@bob/ai, minimisation avant appel LLM) : ce dernier
 * PRÉSERVE délibérément les montants et les références de pièces, parce que le classifieur
 * d'intention en a besoin pour résoudre la commande de l'artisan. La télémétrie n'a aucun
 * besoin équivalent : elle masque en plus les montants, les jetons porteurs et les numéros de
 * carte. Les deux politiques doivent pouvoir évoluer séparément — assouplir la minimisation
 * LLM ne doit jamais assouplir la télémétrie.
 *
 * Fonctions pures, déterministes, IDEMPOTENTES (aucun marqueur ne contient de motif détecté).
 */

/* ------------------------------------------------------------------ redaction texte */

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){10,30}\b/gu;
const PHONE_FR = /(?:\+33|0)[\s.-]?[1-9](?:[\s.-]?\d{2}){4}\b/gu;
const SIREN_SIRET = /\b\d{9}(?:\d{5})?\b/gu;
/** Jeton porteur : JWT Supabase, `Authorization: Bearer …`, clé de service. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/gu;
const BEARER = /\b(?:Bearer|Basic|token|api[_-]?key)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{12,}/giu;
/** PAN bancaire : 4 groupes de 4 chiffres, séparateur optionnel. */
const CARD = /\b\d{4}(?:[ -]?\d{4}){3}\b/gu;
/** Espaces fins et insécables utilisés par le formatage monétaire français. */
const NUMBER_GROUP = '\\d{1,12}(?:[ \\u00A0\\u202F]\\d{3})*(?:[.,]\\d{1,2})?';
const AMOUNT_SUFFIXED = new RegExp(`${NUMBER_GROUP}\\s?(?:€|EUR\\b)`, 'gu');
const AMOUNT_PREFIXED = new RegExp(`(?:€|EUR)\\s?${NUMBER_GROUP}`, 'gu');

/**
 * Masque tout ce qu'un rapport de plantage n'a pas le droit de transporter. L'ordre compte :
 * les motifs alphanumériques (jeton, IBAN) passent avant les motifs purement numériques, sinon
 * une sous-suite de chiffres serait consommée en premier et casserait la détection englobante.
 */
export function redactTelemetryText(text: string): string {
  if (!text) return text;
  return text
    .replace(JWT, '[jeton]')
    .replace(BEARER, '[jeton]')
    .replace(EMAIL, '[email]')
    .replace(IBAN, '[iban]')
    .replace(CARD, '[carte]')
    .replace(AMOUNT_SUFFIXED, '[montant]')
    .replace(AMOUNT_PREFIXED, '[montant]')
    .replace(PHONE_FR, '[tel]')
    .replace(SIREN_SIRET, '[siren]');
}

/** Borne dure : un message d'erreur kilométrique est un vecteur de fuite autant qu'un coût. */
const MAX_TEXT_CHARS = 500;

/**
 * Marge de LECTURE au-delà de la borne d'affichage. On masque AVANT de tronquer, sinon un secret
 * à cheval sur la coupe est amputé, ne correspond plus à son motif, et son début part EN CLAIR
 * (mesuré : `iban=FR7612548` survivait). La marge borne le coût sur une entrée démesurée tout en
 * couvrant largement le plus long motif détectable.
 */
const REDACTION_WINDOW_MARGIN_CHARS = 1_024;

function safeText(value: unknown, maxChars = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const window = value.slice(0, maxChars + REDACTION_WINDOW_MARGIN_CHARS);
  return redactTelemetryText(window).slice(0, maxChars);
}

/* ------------------------------------------------------------------ formes minimales */

/**
 * Vue MINIMALE de l'événement Sentry : uniquement les champs que cette politique manipule.
 * Volontairement structurelle plutôt qu'importée du SDK — la politique de confidentialité ne
 * doit dépendre d'aucun paquet tiers et doit rester testable sans lui.
 */
export interface TelemetryEvent {
  readonly [key: string]: unknown;
}

export interface TelemetryBreadcrumb {
  readonly [key: string]: unknown;
}

export interface TelemetryScrubOptions {
  /**
   * Contextes techniques conservés (`event.contexts`). Le serveur garde `runtime`/`os`/`app`,
   * le mobile y ajoute `device` (modèle et version d'OS : indispensables pour reproduire un
   * plantage terrain). Tout autre contexte est écarté.
   */
  readonly allowedContexts?: readonly string[];
}

/** Champs scalaires recopiés tels quels : aucun ne peut porter de donnée applicative. */
const VERBATIM_EVENT_KEYS = [
  'event_id',
  'timestamp',
  'platform',
  'level',
  'logger',
  'environment',
  'release',
  'dist',
  'sdk',
  'type',
] as const;

/**
 * Étiquettes autorisées. Elles sont soit posées par Bob (`correlationId` et le résumé
 * structuré d'AppError produit par le filtre d'exception), soit standard côté SDK. Toute
 * étiquette inconnue est écartée : c'est par les étiquettes qu'une donnée client se faufile
 * le plus facilement (un `customerName` posé « juste pour debug »).
 */
const ALLOWED_TAG_KEYS: ReadonlySet<string> = new Set([
  'correlationId',
  'kind',
  'service',
  'port',
  'cause',
  'entity',
  'reason',
  'screen',
  'level',
  'handled',
  'mechanism',
  'environment',
  'release',
  'runtime',
  'os',
]);

const DEFAULT_ALLOWED_CONTEXTS = ['runtime', 'os', 'app', 'trace'] as const;

/** Métadonnées d'une miette conservées telles quelles : ni texte libre, ni charge utile. */
const ALLOWED_BREADCRUMB_DATA_KEYS: ReadonlySet<string> = new Set([
  'method',
  'status_code',
  'from',
  'to',
]);

const MAX_BREADCRUMBS = 30;

/* ------------------------------------------------------------------ scrubbing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarOrUndefined(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return safeText(value, 200);
}

function scrubTags(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(raw)) return undefined;
  const tags: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_TAG_KEYS.has(key)) continue;
    const scalar = scalarOrUndefined(value);
    if (scalar !== undefined) tags[key] = scalar;
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function scrubContexts(raw: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const contexts: Record<string, unknown> = {};
  for (const name of allowed) {
    const context = raw[name];
    if (!isRecord(context)) continue;
    const kept: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(context)) {
      const scalar = scalarOrUndefined(value);
      if (scalar !== undefined) kept[key] = scalar;
    }
    if (Object.keys(kept).length > 0) contexts[name] = kept;
  }
  return Object.keys(contexts).length > 0 ? contexts : undefined;
}

function scrubFrame(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const frame: Record<string, unknown> = {};
  // `vars` (variables locales capturées par l'intégration localVariables) est LA fuite
  // majeure d'un rapport de plantage : la valeur d'un IBAN, d'un e-mail ou d'un montant s'y
  // trouve littéralement. Il n'est jamais recopié — la liste blanche ci-dessous l'exclut.
  for (const key of ['filename', 'function', 'module', 'lineno', 'colno', 'in_app'] as const) {
    const value = raw[key];
    if (typeof value === 'number' || typeof value === 'boolean') frame[key] = value;
    else {
      const text = safeText(value, 300);
      if (text !== undefined) frame[key] = text;
    }
  }
  // Les lignes de source viennent du dépôt (du code, pas de la donnée d'un client) et sont
  // décisives pour diagnostiquer un plantage terrain. Elles restent néanmoins redactées :
  // une valeur littérale ne doit pas sortir davantage qu'une variable.
  const contextLine = safeText(raw.context_line, 300);
  if (contextLine !== undefined) frame.context_line = contextLine;
  return Object.keys(frame).length > 0 ? frame : null;
}

function scrubStacktrace(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.frames)) return undefined;
  const frames = raw.frames.map(scrubFrame).filter((frame): frame is Record<string, unknown> => frame !== null);
  return frames.length > 0 ? { frames } : undefined;
}

function scrubExceptionValue(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const value: Record<string, unknown> = {};
  const type = safeText(raw.type, 200);
  if (type !== undefined) value.type = type;
  const message = safeText(raw.value);
  if (message !== undefined) value.value = message;
  if (isRecord(raw.mechanism)) {
    const mechanism: Record<string, unknown> = {};
    const mechanismType = safeText(raw.mechanism.type, 100);
    if (mechanismType !== undefined) mechanism.type = mechanismType;
    if (typeof raw.mechanism.handled === 'boolean') mechanism.handled = raw.mechanism.handled;
    if (Object.keys(mechanism).length > 0) value.mechanism = mechanism;
  }
  const stacktrace = scrubStacktrace(raw.stacktrace);
  if (stacktrace !== undefined) value.stacktrace = stacktrace;
  return Object.keys(value).length > 0 ? value : null;
}

function scrubException(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.values)) return undefined;
  const values = raw.values
    .map(scrubExceptionValue)
    .filter((value): value is Record<string, unknown> => value !== null);
  return values.length > 0 ? { values } : undefined;
}

/**
 * Miette de navigation minimisée. Le `message` est conservé (c'est lui qui raconte le chemin
 * jusqu'au plantage) mais redacté et tronqué ; la charge utile `data` est réduite à quelques
 * métadonnées de transport — jamais une URL complète, un corps de requête ni un transcript.
 */
export function scrubTelemetryBreadcrumb(breadcrumb: TelemetryBreadcrumb): TelemetryBreadcrumb | null {
  if (!isRecord(breadcrumb)) return null;
  const scrubbed: Record<string, unknown> = {};
  for (const key of ['type', 'category', 'level', 'timestamp'] as const) {
    const value = breadcrumb[key];
    if (typeof value === 'number') scrubbed[key] = value;
    else {
      const text = safeText(value, 100);
      if (text !== undefined) scrubbed[key] = text;
    }
  }
  const message = safeText(breadcrumb.message, 200);
  if (message !== undefined) scrubbed.message = message;
  if (isRecord(breadcrumb.data)) {
    const data: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(breadcrumb.data)) {
      if (!ALLOWED_BREADCRUMB_DATA_KEYS.has(key)) continue;
      const scalar = scalarOrUndefined(value);
      if (scalar !== undefined) data[key] = scalar;
    }
    if (Object.keys(data).length > 0) scrubbed.data = data;
  }
  return Object.keys(scrubbed).length > 0 ? scrubbed : null;
}

/**
 * Reconstruit l'événement à partir de la seule liste blanche. Sont donc écartés SANS avoir à
 * être nommés : `request` (URL, en-têtes, cookies, corps), `user` (identité, e-mail, IP),
 * `extra`, `server_name`, `modules`, `threads`, `spans`, `attachments`, `debug_meta`, et tout
 * champ futur.
 */
export function scrubTelemetryEvent(
  event: TelemetryEvent,
  options: TelemetryScrubOptions = {},
): TelemetryEvent {
  if (!isRecord(event)) return {};
  const scrubbed: Record<string, unknown> = {};
  for (const key of VERBATIM_EVENT_KEYS) {
    if (event[key] !== undefined) scrubbed[key] = event[key];
  }
  const exception = scrubException(event.exception);
  if (exception !== undefined) scrubbed.exception = exception;
  const tags = scrubTags(event.tags);
  if (tags !== undefined) scrubbed.tags = tags;
  const contexts = scrubContexts(event.contexts, options.allowedContexts ?? DEFAULT_ALLOWED_CONTEXTS);
  if (contexts !== undefined) scrubbed.contexts = contexts;
  const transaction = safeText(event.transaction, 200);
  if (transaction !== undefined) scrubbed.transaction = transaction;
  const message = isRecord(event.message)
    ? safeText(event.message.message)
    : safeText(event.message);
  if (message !== undefined) scrubbed.message = message;
  if (Array.isArray(event.breadcrumbs)) {
    const breadcrumbs = event.breadcrumbs
      .slice(-MAX_BREADCRUMBS)
      .map(scrubTelemetryBreadcrumb)
      .filter((breadcrumb): breadcrumb is TelemetryBreadcrumb => breadcrumb !== null);
    if (breadcrumbs.length > 0) scrubbed.breadcrumbs = breadcrumbs;
  }
  return scrubbed;
}

/**
 * Convertit le contexte technique passé par l'appelant (`{ correlationId }` du filtre
 * d'exception, par exemple) en étiquettes admissibles. Même liste blanche que l'événement :
 * un appelant ne peut pas élargir la surface en passant une clé arbitraire.
 */
export function telemetryTagsFrom(
  context: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!ALLOWED_TAG_KEYS.has(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const text = safeText(String(value), 200);
    if (text !== undefined) tags[key] = text;
  }
  return tags;
}

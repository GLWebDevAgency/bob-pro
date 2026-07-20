import { scrubTelemetryBreadcrumb, scrubTelemetryEvent, telemetryTagsFrom } from '@bob/core';
import type { ErrorReporter } from './error-reporter';
import type { AppLogger } from './logger';

/**
 * ADAPTATEUR SENTRY (serveur) — §B4 observabilité.
 *
 * État V1 : DORMANT. Sans `SENTRY_DSN`, `createSentryErrorReporter` renvoie `null` et le
 * paquet `@sentry/node` n'est même jamais chargé : aucun appel réseau, aucune instrumentation
 * OpenTelemetry en mémoire, aucun avertissement bruyant au démarrage.
 *
 * Ce canal ne REMPLACE pas `HttpErrorReporter` (webhook maison, canal d'alerte critique) :
 * les deux sont composés (`CompositeErrorReporter`). Sentry apporte la stack et le contexte
 * agrégé qui manquent au webhook — c'est exactement le trou constaté sur le plantage terrain
 * de l'écran profil fiscal, indiagnosticable à distance parce qu'aucune remontée n'existait.
 *
 * Toute la confidentialité est déléguée à la politique partagée `@bob/core`
 * (`telemetry-scrubbing`), branchée sur `beforeSend`/`beforeBreadcrumb` : c'est le dernier
 * point de passage avant la sortie réseau du SDK.
 */

/** Sous-ensemble du SDK réellement consommé — permet de tester sans charger `@sentry/node`. */
export interface SentrySdkLike {
  init(options: Record<string, unknown>): void;
  captureException(
    error: unknown,
    hint?: { readonly captureContext?: { readonly tags?: Record<string, string> } },
  ): unknown;
}

export interface SentryRuntimeConfig {
  readonly dsn: string;
  readonly environment: string;
  readonly tracesSampleRate: number;
  readonly release?: string | undefined;
}

/**
 * Contextes techniques conservés côté serveur : la version de Node, l'OS du conteneur et
 * l'identité de la trace. Jamais `state`, `response`, ni un contexte applicatif.
 */
const SERVER_ALLOWED_CONTEXTS = ['runtime', 'os', 'app', 'trace'] as const;

/**
 * Options d'initialisation. Chaque valeur non évidente est un choix de confidentialité :
 *
 * - `sendDefaultPii: false` — n'attache ni IP, ni cookies, ni en-têtes, ni corps de requête.
 * - `maxBreadcrumbs` bas — moins d'historique = moins de surface de fuite (et le scrubbing
 *   en garde de toute façon 30 au maximum).
 * - `integrations` filtré — `localVariables` capture la valeur des variables locales (donc un
 *   IBAN ou un e-mail littéral) et `requestData` reconstruit la requête HTTP : les deux sont
 *   retirés à la source, en plus d'être neutralisés par `beforeSend`. Défense en profondeur.
 * - `tracesSampleRate` — figé à 0 par la matrice des flags V1.
 */
export function buildSentryOptions(config: SentryRuntimeConfig): Record<string, unknown> {
  return {
    dsn: config.dsn,
    environment: config.environment,
    ...(config.release ? { release: config.release } : {}),
    sendDefaultPii: false,
    tracesSampleRate: config.tracesSampleRate,
    maxBreadcrumbs: 30,
    maxValueLength: 500,
    // Aucune donnée n'est utile hors de nos propres frames : une exception levée par une
    // extension ou un script tiers n'a pas de sens côté serveur.
    normalizeDepth: 3,
    integrations: (defaults: readonly { name: string }[]) =>
      defaults.filter(
        (integration) =>
          integration.name !== 'LocalVariables'
          && integration.name !== 'RequestData'
          && integration.name !== 'Console',
      ),
    beforeBreadcrumb: (breadcrumb: Record<string, unknown>) =>
      scrubTelemetryBreadcrumb(breadcrumb) as Record<string, unknown> | null,
    beforeSend: (event: Record<string, unknown>) =>
      scrubTelemetryEvent(event, { allowedContexts: SERVER_ALLOWED_CONTEXTS }) as Record<
        string,
        unknown
      >,
    // Les transactions de performance sont désactivées (échantillon 0) ; si elles étaient un
    // jour activées, elles passeraient par la même politique — jamais brutes.
    beforeSendTransaction: (event: Record<string, unknown>) =>
      scrubTelemetryEvent(event, { allowedContexts: SERVER_ALLOWED_CONTEXTS }) as Record<
        string,
        unknown
      >,
  };
}

export class SentryErrorReporter implements ErrorReporter {
  constructor(private readonly sdk: SentrySdkLike) {}

  captureException(error: unknown, context: Record<string, unknown> = {}): void {
    const tags = telemetryTagsFrom(context);
    this.sdk.captureException(
      error,
      Object.keys(tags).length > 0 ? { captureContext: { tags } } : undefined,
    );
  }
}

/**
 * Compose plusieurs canaux d'incident. Un canal mort (destination injoignable, SDK en erreur)
 * ne doit JAMAIS empêcher les autres de rapporter, ni remonter dans le filtre d'exception :
 * un rapporteur qui fait planter la gestion d'erreur transforme un incident en panne.
 */
export class CompositeErrorReporter implements ErrorReporter {
  constructor(private readonly reporters: readonly ErrorReporter[]) {}

  captureException(error: unknown, context: Record<string, unknown> = {}): void {
    for (const reporter of this.reporters) {
      try {
        reporter.captureException(error, context);
      } catch {
        // Silence volontaire : l'erreur d'origine est déjà journalisée localement par
        // exception.filter, et un canal cassé ne doit pas en masquer un autre.
      }
    }
  }
}

/**
 * Charge `@sentry/node` PARESSEUSEMENT. Appelé uniquement lorsqu'un DSN est présent : en mode
 * dormant (V1), le paquet et sa chaîne d'instrumentation ne sont jamais requis.
 */
function loadSentryNode(): SentrySdkLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@sentry/node') as SentrySdkLike;
}

/**
 * Construit le rapporteur Sentry, ou `null` si le canal est dormant (aucun DSN).
 *
 * Un échec de chargement ou d'initialisation du SDK est journalisé une fois puis absorbé : le
 * webhook maison reste opérationnel et le serveur démarre. La certification du DSN (région UE,
 * HTTPS, absence de placeholder) a déjà eu lieu au boot dans `loadEnv`.
 */
export function createSentryErrorReporter(
  config: SentryRuntimeConfig | null,
  logger: AppLogger,
  loadSdk: () => SentrySdkLike = loadSentryNode,
): ErrorReporter | null {
  if (!config) return null;
  try {
    const sdk = loadSdk();
    sdk.init(buildSentryOptions(config));
    logger.log(`Crash reporting Sentry actif (environnement ${config.environment}).`, 'Sentry');
    return new SentryErrorReporter(sdk);
  } catch (error) {
    logger.error(
      `Initialisation Sentry impossible : ${error instanceof Error ? error.name : 'erreur inconnue'}. `
        + 'Le canal webhook reste seul actif.',
      undefined,
      'Sentry',
    );
    return null;
  }
}

/**
 * Lit la configuration Sentry depuis l'environnement déjà validé par `loadEnv`. Renvoie `null`
 * — canal dormant — dès que `SENTRY_DSN` est absent, ce qui est la valeur figée V1.
 */
export function resolveSentryConfig(
  env: NodeJS.ProcessEnv = process.env,
): SentryRuntimeConfig | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0);
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.CABINET_RELEASE_ENV?.trim() || 'development',
    tracesSampleRate: Number.isFinite(rate) ? rate : 0,
    release: env.RAILWAY_DEPLOYMENT_ID?.trim() || undefined,
  };
}

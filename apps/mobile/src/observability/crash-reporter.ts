import {
  scrubTelemetryBreadcrumb,
  scrubTelemetryEvent,
  sentryDsnRejectionReason,
  telemetryTagsFrom,
} from '@bob/core';

/**
 * CRASH REPORTING MOBILE — §B4 observabilité.
 *
 * Pourquoi ce module existe : un plantage terrain (écran profil fiscal) est aujourd'hui
 * INDIAGNOSTICABLE à distance. Les logs serveur ont innocenté l'API (200) et l'appareil de
 * l'artisan ne remonte rien. Sentry comble exactement ce trou — mais uniquement à ces
 * conditions, non négociables pour une application financière :
 *
 * 1. DORMANT PAR DÉFAUT. Sans `EXPO_PUBLIC_SENTRY_DSN`, `@sentry/react-native` n'est jamais
 *    importé (import dynamique) et `init` n'est jamais appelé. Le module natif reste lié au
 *    binaire mais totalement inerte : aucune requête, aucun consentement implicite.
 * 2. LE FLAG EST OPTIONNEL. Son absence ne casse AUCUN build — contrairement aux
 *    `EXPO_PUBLIC_*` obligatoires certifiés par la garde `required()` de `app.config.ts`,
 *    ce flag n'y est pas déclaré et ne doit jamais l'être : un build EAS ne doit pas dépendre
 *    d'un canal d'observabilité.
 * 3. JAMAIS DE PLANTAGE INDUIT. Toute anomalie (DSN mal formé, région non conforme, SDK
 *    indisponible) désactive silencieusement le canal. Une garde de confidentialité ne doit
 *    jamais se transformer en panne pour l'artisan sur un chantier.
 *
 * La minimisation est déléguée à la politique partagée avec le serveur (`@bob/core`,
 * `telemetry-scrubbing`) : ni corps de requête, ni transcript vocal, ni donnée client.
 */

/**
 * Lu au scope module : Expo inline les `process.env.EXPO_PUBLIC_*` à la compilation, ce qui
 * exige un accès littéral (jamais `process.env[nom]`).
 */
const PUBLIC_SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
const PUBLIC_SENTRY_ENVIRONMENT = process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;

export interface CrashReporterConfig {
  readonly dsn: string;
  readonly environment: string;
}

/** Sous-ensemble du SDK réellement consommé — testable sans charger le module natif. */
export interface CrashReporterSdkLike {
  init(options: Record<string, unknown>): void;
  captureException(
    error: unknown,
    hint?: { readonly captureContext?: { readonly tags?: Record<string, string> } },
  ): unknown;
}

/**
 * Contextes conservés côté appareil. `device` et `os` sont ce qui manque cruellement pour
 * reproduire un plantage terrain (modèle, version d'Android) ; ils ne décrivent pas la
 * personne, seulement le matériel.
 */
const MOBILE_ALLOWED_CONTEXTS = ['device', 'os', 'app', 'runtime'] as const;

export function buildCrashReporterOptions(config: CrashReporterConfig): Record<string, unknown> {
  return {
    dsn: config.dsn,
    environment: config.environment,
    sendDefaultPii: false,
    // Aucune trace de performance ni rejeu de session : ce sont les deux fonctionnalités qui
    // capturent le plus de contenu d'écran, donc de donnée client.
    tracesSampleRate: 0,
    enableAutoPerformanceTracing: false,
    enableCaptureFailedRequests: false,
    maxBreadcrumbs: 30,
    maxValueLength: 500,
    normalizeDepth: 3,
    integrations: (defaults: readonly { name: string }[]) =>
      defaults.filter(
        (integration) =>
          // `Breadcrumbs`/`ReactNativeErrorHandlers` restent : ce sont eux qui racontent le
          // chemin jusqu'au plantage. `Http` et `Console` capturent en revanche les URLs
          // complètes et les lignes de log, qui peuvent porter la donnée d'un client.
          integration.name !== 'Http' && integration.name !== 'Console',
      ),
    beforeBreadcrumb: (breadcrumb: Record<string, unknown>) =>
      scrubTelemetryBreadcrumb(breadcrumb) as Record<string, unknown> | null,
    beforeSend: (event: Record<string, unknown>) =>
      scrubTelemetryEvent(event, { allowedContexts: MOBILE_ALLOWED_CONTEXTS }) as Record<
        string,
        unknown
      >,
  };
}

/**
 * Résout la configuration, ou `null` — canal dormant — si le DSN est absent ou non conforme
 * à la région UE. Le refus est journalisé une seule fois pour ne pas rester invisible en QA,
 * mais ne remonte jamais en exception.
 */
export function resolveCrashReporterConfig(
  dsn: string | undefined = PUBLIC_SENTRY_DSN,
  environment: string | undefined = PUBLIC_SENTRY_ENVIRONMENT,
): CrashReporterConfig | null {
  const trimmed = dsn?.trim();
  if (!trimmed) return null;
  const reason = sentryDsnRejectionReason(trimmed);
  if (reason) {
    console.warn(`Crash reporting désactivé : EXPO_PUBLIC_SENTRY_DSN ${reason}.`);
    return null;
  }
  return { dsn: trimmed, environment: environment?.trim() || 'production' };
}

let reporter: CrashReporterSdkLike | null = null;

/**
 * Import dynamique : sans DSN, `@sentry/react-native` n'est jamais évalué, donc aucun pont
 * natif n'est touché au démarrage.
 */
async function loadReactNativeSentry(): Promise<CrashReporterSdkLike> {
  return (await import('@sentry/react-native')) as unknown as CrashReporterSdkLike;
}

/**
 * Initialise le canal si — et seulement si — un DSN région UE est fourni. Idempotent :
 * un second appel ne réinitialise pas le SDK.
 */
export async function initCrashReporter(
  config: CrashReporterConfig | null = resolveCrashReporterConfig(),
  loadSdk: () => Promise<CrashReporterSdkLike> = loadReactNativeSentry,
): Promise<CrashReporterSdkLike | null> {
  if (!config || reporter) return reporter;
  try {
    const sdk = await loadSdk();
    sdk.init(buildCrashReporterOptions(config));
    reporter = sdk;
    return sdk;
  } catch {
    // Un canal d'observabilité indisponible ne doit jamais empêcher l'application de démarrer.
    reporter = null;
    return null;
  }
}

/**
 * Remonte une exception déjà rattrapée par l'interface (limite d'erreur d'écran, échec de
 * chargement). Sans canal actif, l'appel est un no-op strict.
 */
export function captureCrash(error: unknown, context: Readonly<Record<string, unknown>> = {}): void {
  if (!reporter) return;
  try {
    const tags = telemetryTagsFrom(context);
    reporter.captureException(
      error,
      Object.keys(tags).length > 0 ? { captureContext: { tags } } : undefined,
    );
  } catch {
    // Le rapport est un bonus : jamais une cause de plantage supplémentaire.
  }
}

/** Réservé aux suites de tests : remet le module dans son état dormant. */
export function resetCrashReporterForTests(): void {
  reporter = null;
}

/**
 * REGISTRE DES CODES COURTS D'ERREUR — autorité unique (SPEC_SYSTEME_ERREUR §2.3).
 *
 * Un code « BOB-<CONTEXTE>-<STATUT> » est la PROJECTION calculée d'un AppError : le statut vient
 * du kind (miroir exact du mapping serveur apps/api/src/http/result.ts::unwrap), le contexte
 * vient de la route appelée (table fermée ci-dessous). Le code n'est jamais stocké ni transmis
 * par le serveur — aucune dérive serveur/client possible. L'utilisateur peut le lire au
 * téléphone (« bob siret quatre cent quatre ») ; le développeur le traduit en grep-ant ce
 * fichier, puis grep-e Railway avec le correlationId.
 *
 * Registre FERMÉ : `error-codes.test.ts` verrouille la liste littérale complète, le patron,
 * l'unicité et les deux tables. Ajouter un contexte = éditer ce fichier + le test + la spec.
 */
import type { AppError } from '@bob/core';

/** Contextes fonctionnels fermés (v1) — voir la spec §2.3 pour le rituel d'extension. */
export const BOB_ERROR_CONTEXTS = ['API', 'SIRET', 'ADM', 'LIVE'] as const;
export type BobErrorContext = (typeof BOB_ERROR_CONTEXTS)[number];

/**
 * Statuts projetés des kinds (§2.1) + `500` réservé aux valeurs jetées qui ne sont PAS des
 * AppError (défaut de programmation) — un slot honnête, jamais un 502 déguisé.
 */
export const BOB_ERROR_STATUSES = [403, 404, 409, 410, 422, 429, 500, 502, 503] as const;
export type BobErrorStatus = (typeof BOB_ERROR_STATUSES)[number];

export type BobErrorCode = `BOB-${BobErrorContext}-${BobErrorStatus}`;

/** Matrice complète contexte × statut — la LISTE fermée que le test verrouille littéralement. */
export const BOB_ERROR_CODE_REGISTRY: readonly BobErrorCode[] = BOB_ERROR_CONTEXTS.flatMap(
  (context) => BOB_ERROR_STATUSES.map((status): BobErrorCode => `BOB-${context}-${status}`),
);

/**
 * kind → statut : MIROIR de `unwrap` (apps/api/src/http/result.ts). Toute divergence rendrait le
 * code menteur vis-à-vis du statut HTTP réellement servi — le test la détecterait.
 */
export function bobErrorStatus(error: unknown): BobErrorStatus {
  if (typeof error !== 'object' || error === null || !('kind' in error)) return 500;
  switch ((error as { kind: unknown }).kind) {
    case 'not_found':
      return 404;
    case 'gone':
      return 410;
    case 'conflict':
      return 409;
    case 'rate_limited':
      return 429;
    case 'unavailable':
      return 503;
    case 'forbidden':
      return 403;
    case 'validation':
    case 'domain':
      return 422;
    case 'dependency':
      return 502;
    default:
      return 500;
  }
}

interface RouteContextRule {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `exact` : le chemin doit être ÉGAL (l'admission est le POST de création, pas ses sous-routes). */
  readonly match: 'exact' | 'prefix';
  readonly path: string;
  readonly context: BobErrorContext;
}

/**
 * Route → contexte, PREMIÈRE règle gagnante. Fermée et testée : un écran n'invente jamais un
 * contexte en chaîne libre, il enregistre sa route ici (rituel spec §11).
 */
export const BOB_ERROR_ROUTE_CONTEXTS: readonly RouteContextRule[] = [
  // Admission Bob Live : l'ouverture de session EXACTE (cas terrain 3, « BOB-ADM-503 ») —
  // les sous-routes POST /voice/realtime/calls/<id>/… sont des opérations de session (LIVE).
  { method: 'POST', match: 'exact', path: '/voice/realtime/calls', context: 'ADM' },
  // Tout le reste du protocole temps réel (tours, feed acoustique, tickets, terminaison).
  { match: 'prefix', path: '/voice/realtime', context: 'LIVE' },
  // Lookup annuaire des entreprises (cas terrain 1, « BOB-SIRET-404 »).
  { match: 'prefix', path: '/company/lookup', context: 'SIRET' },
];

/** Contexte d'une route appelée — `API` par défaut, jamais d'échec. */
export function bobErrorContextForRoute(method: string, path: string): BobErrorContext {
  const normalizedMethod = method.toUpperCase();
  const pathOnly = path.split(/[?#]/, 1)[0] ?? '';
  for (const rule of BOB_ERROR_ROUTE_CONTEXTS) {
    if (rule.method !== undefined && rule.method !== normalizedMethod) continue;
    if (rule.match === 'exact' ? pathOnly === rule.path : pathOnly.startsWith(rule.path)) {
      return rule.context;
    }
  }
  return 'API';
}

/**
 * Le code court d'une erreur. Fonction TOTALE : une valeur non typée rend `BOB-<ctx>-500` —
 * l'écran a toujours quelque chose de référençable à afficher.
 */
export function bobErrorCode(error: unknown, context: BobErrorContext = 'API'): BobErrorCode {
  return `BOB-${context}-${bobErrorStatus(error)}`;
}

/**
 * Forme courte affichable d'un identifiant de corrélation : 8 premiers caractères — un préfixe
 * d'UUID suffit à grep Railway sans ambiguïté pratique.
 */
export function shortCorrelationId(correlationId: string): string {
  return correlationId.slice(0, 8);
}

const UUID_V4_TEMPLATE = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';

/**
 * Identifiant de corrélation généré CÔTÉ CLIENT (spec §3.1) — un par requête. `crypto.randomUUID`
 * quand le runtime l'offre ; sinon repli non cryptographique assumé : c'est un identifiant de
 * corrélation, pas un secret.
 */
export function newCorrelationId(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID();
  return UUID_V4_TEMPLATE.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Attache les métadonnées de transport à une erreur décodée (spec §2.2) — seule la frontière
 * HTTP cliente l'appelle. Ne remplace jamais un champ déjà présent par `undefined`.
 */
export function withErrorTransport(
  error: AppError,
  transport: { readonly code: BobErrorCode; readonly correlationId: string },
): AppError {
  return { ...error, code: transport.code, correlationId: transport.correlationId };
}

/** Adaptateur pur des réponses Expo : validation de route + déduplication cold-start/listener. */

export interface PushNotificationResponseLike {
  readonly notification: {
    readonly request: {
      readonly identifier: string;
      readonly content: { readonly data?: Record<string, unknown> | null };
    };
  };
}

export interface PushNotificationLike {
  readonly request: {
    readonly identifier: string;
    readonly content: { readonly data?: Record<string, unknown> | null };
  };
}

export type PushPayloadDecision = 'matched' | 'not_ready' | 'stale' | 'invalid';

export type PushResponseDispatchResult = 'navigated' | 'duplicate' | 'ignored';

export interface PushEventSubscription {
  remove(): void;
}

export interface PushEventBridgeDependencies {
  readonly subscribeToResponses: (
    listener: (response: PushNotificationResponseLike) => void,
  ) => PushEventSubscription;
  readonly getLastResponse: () => Promise<PushNotificationResponseLike | null>;
  readonly clearLastResponse: () => Promise<void>;
  readonly subscribeToForegroundNotifications: (
    listener: (notification: PushNotificationLike) => void,
  ) => PushEventSubscription;
  readonly matchPayload: (payload: unknown) => Promise<PushPayloadDecision>;
  readonly navigate: (route: string) => void;
  readonly onForegroundNotification: () => void;
  readonly log: (message: string, error?: unknown) => void;
}

const STATIC_PUSH_ROUTES = new Set(['/(tabs)', '/notifications', '/diagnostic']);
const ENTITY_PUSH_ROUTE_HEADS = new Set(['facture', 'devis', 'client', 'documents']);

function isSafeRouteSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 256) return false;
  try {
    const decoded = decodeURIComponent(segment);
    const hasControlCharacter = [...decoded].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    });
    return (
      decoded.length > 0 &&
      decoded.trim() === decoded &&
      decoded !== '.' &&
      decoded !== '..' &&
      !hasControlCharacter &&
      !/[\\/?#%]/u.test(decoded)
    );
  } catch {
    return false;
  }
}

function isAllowlistedPushRoute(route: string): boolean {
  if (route.length > 512 || route.includes('?') || route.includes('#')) return false;
  if (STATIC_PUSH_ROUTES.has(route)) return true;

  const parts = route.split('/');
  if (parts[0] !== '') return false;
  if (parts.length === 3) {
    const [, head, id] = parts;
    return (
      head !== undefined &&
      id !== undefined &&
      ENTITY_PUSH_ROUTE_HEADS.has(head) &&
      isSafeRouteSegment(id)
    );
  }
  if (parts.length === 4) {
    const [, head, child, id] = parts;
    return head === 'documents' && child === 'folder' && id !== undefined && isSafeRouteSegment(id);
  }
  return false;
}

/** Sas commun au push OS et au fil in-app : une route serveur reste une entrée non fiable. */
export function parseAllowlistedPushRoute(route: unknown): string | null {
  return typeof route === 'string' && isAllowlistedPushRoute(route) ? route : null;
}

export function extractInternalPushRoute(response: PushNotificationResponseLike): string | null {
  const route = response.notification.request.content.data?.route;
  // Une route interne arbitraire reste une entrée non fiable : seules les destinations métier
  // que le serveur de notifications est autorisé à produire franchissent ce sas.
  return parseAllowlistedPushRoute(route);
}

export class PushResponseDispatcher {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 64) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('capacity doit être un entier positif');
  }

  dispatch(
    response: PushNotificationResponseLike,
    navigate: (route: string) => void,
  ): PushResponseDispatchResult {
    const id = response.notification.request.identifier;
    const route = extractInternalPushRoute(response);
    if (id.length === 0 || route === null) return 'ignored';
    if (this.seen.has(id)) return 'duplicate';

    // Marquer avant la navigation protège la course listener ↔ getLastNotificationResponseAsync.
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    try {
      navigate(route);
    } catch (error) {
      // Le routeur peut ne pas être prêt pendant une restauration d'auth : permettre au cold
      // response de retenter au prochain montage au lieu de perdre définitivement le tap.
      this.seen.delete(id);
      const index = this.order.lastIndexOf(id);
      if (index >= 0) this.order.splice(index, 1);
      throw error;
    }
    return 'navigated';
  }
}

/**
 * Installe le pont complet dans un ordre sans trou : listener d'abord, cold response ensuite.
 * Le dispatcher partagé rend la course déterministe ; le cleanup empêche toute navigation après
 * démontage de l'AuthGate.
 */
export function installPushEventBridge(
  dependencies: PushEventBridgeDependencies,
  dispatcher: PushResponseDispatcher,
): () => void {
  let active = true;
  const consume = async (response: PushNotificationResponseLike): Promise<PushPayloadDecision> => {
    // `remove()` empêche les nouveaux callbacks natifs ; ce garde-fou couvre aussi un callback
    // déjà mis en file par le bridge natif au moment exact du teardown de l'AuthGate.
    if (!active) return 'not_ready';
    try {
      const decision = await dependencies.matchPayload(response.notification.request.content.data);
      if (!active || decision !== 'matched') return decision;
      dispatcher.dispatch(response, dependencies.navigate);
      return decision;
    } catch (error) {
      dependencies.log('navigation push indisponible', error);
      return 'not_ready';
    }
  };

  const responseSubscription = dependencies.subscribeToResponses((response) => {
    void consume(response);
  });
  const foregroundSubscription = dependencies.subscribeToForegroundNotifications((notification) => {
    void dependencies
      .matchPayload(notification.request.content.data)
      .then((decision) => {
        if (active && decision === 'matched') dependencies.onForegroundNotification();
      })
      .catch((error: unknown) => {
        dependencies.log('validation push premier plan indisponible', error);
      });
  });

  void dependencies
    .getLastResponse()
    .then(async (response) => {
      if (!active || response === null) return;
      const decision = await consume(response);
      // Une fence pas encore chargée reste disponible pour le prochain montage. Les réponses
      // invalides/stale sont, elles, définitivement purgées afin de ne jamais naviguer plus tard.
      if (active && decision !== 'not_ready') await dependencies.clearLastResponse();
    })
    .catch((error: unknown) => {
      dependencies.log('lecture de la réponse de démarrage indisponible', error);
    });

  return () => {
    active = false;
    responseSubscription.remove();
    foregroundSubscription.remove();
  };
}

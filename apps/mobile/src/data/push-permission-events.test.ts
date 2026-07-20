import { describe, expect, it, vi } from 'vitest';
import {
  PushResponseDispatcher,
  extractInternalPushRoute,
  installPushEventBridge,
  parseAllowlistedPushRoute,
  type PushNotificationLike,
  type PushNotificationResponseLike,
} from './push-permission-events';

function response(identifier: string, route: unknown): PushNotificationResponseLike {
  return {
    notification: {
      request: {
        identifier,
        content: { data: { route } },
      },
    },
  };
}

describe('extractInternalPushRoute', () => {
  it('accepte uniquement les destinations métier explicitement autorisées', () => {
    expect(extractInternalPushRoute(response('n-1', '/facture/inv-1'))).toBe('/facture/inv-1');
    expect(extractInternalPushRoute(response('n-1b', '/documents/folder/f-1'))).toBe(
      '/documents/folder/f-1',
    );
    expect(extractInternalPushRoute(response('n-1c', '/(tabs)'))).toBe('/(tabs)');
    expect(extractInternalPushRoute(response('n-2', 'https://evil.example'))).toBeNull();
    expect(extractInternalPushRoute(response('n-3', '//evil.example'))).toBeNull();
    expect(extractInternalPushRoute(response('n-4', '/facture\\evil'))).toBeNull();
    expect(extractInternalPushRoute(response('n-5', '/compte'))).toBeNull();
    expect(extractInternalPushRoute(response('n-6', '/auth/recovery'))).toBeNull();
    expect(extractInternalPushRoute(response('n-7', '/facture/%2F%2Fevil.example'))).toBeNull();
    expect(extractInternalPushRoute(response('n-8', '/facture/..'))).toBeNull();
    expect(extractInternalPushRoute(response('n-9', '/facture/inv-1?mode=edit'))).toBeNull();
    expect(
      extractInternalPushRoute(response('n-10', '/facture/%252F%252Fevil.example')),
    ).toBeNull();
  });

  it('réutilise le même sas pour les routes du fil in-app', () => {
    expect(parseAllowlistedPushRoute('/devis/q-1')).toBe('/devis/q-1');
    expect(parseAllowlistedPushRoute('/compte')).toBeNull();
    expect(parseAllowlistedPushRoute(42)).toBeNull();
  });
});

describe('PushResponseDispatcher', () => {
  it('déduplique la même réponse entre listener live et lecture cold-start', () => {
    const navigate = vi.fn();
    const dispatcher = new PushResponseDispatcher();
    const notification = response('request-1', '/notifications');

    expect(dispatcher.dispatch(notification, navigate)).toBe('navigated');
    expect(dispatcher.dispatch(notification, navigate)).toBe('duplicate');
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/notifications');
  });

  it('ignore une réponse malformée sans empoisonner les suivantes', () => {
    const navigate = vi.fn();
    const dispatcher = new PushResponseDispatcher();
    expect(dispatcher.dispatch(response('', '/notifications'), navigate)).toBe('ignored');
    expect(dispatcher.dispatch(response('valid', 42), navigate)).toBe('ignored');
    expect(dispatcher.dispatch(response('valid', '/notifications'), navigate)).toBe('navigated');
  });

  it('borne la mémoire de déduplication', () => {
    const navigate = vi.fn();
    const dispatcher = new PushResponseDispatcher(2);
    dispatcher.dispatch(response('a', '/facture/a'), navigate);
    dispatcher.dispatch(response('b', '/facture/b'), navigate);
    dispatcher.dispatch(response('c', '/facture/c'), navigate);
    expect(dispatcher.dispatch(response('a', '/facture/a'), navigate)).toBe('navigated');
    expect(navigate).toHaveBeenCalledTimes(4);
  });

  it('autorise un retry si le routeur n’était pas encore prêt', () => {
    const dispatcher = new PushResponseDispatcher();
    const notification = response('cold', '/notifications');
    expect(() =>
      dispatcher.dispatch(notification, () => {
        throw new Error('router not ready');
      }),
    ).toThrow('router not ready');
    const navigate = vi.fn();
    expect(dispatcher.dispatch(notification, navigate)).toBe('navigated');
    expect(navigate).toHaveBeenCalledOnce();
  });
});

describe('installPushEventBridge', () => {
  it('installe les listeners avant de lire, route le cold start puis efface la réponse', async () => {
    const events: string[] = [];
    const navigate = vi.fn();
    const clear = vi.fn(async () => {
      events.push('clear');
    });
    const cleanup = installPushEventBridge(
      {
        subscribeToResponses: () => {
          events.push('response-listener');
          return { remove: vi.fn() };
        },
        getLastResponse: async () => {
          events.push('get-last');
          return response('cold-1', '/facture/inv-1');
        },
        clearLastResponse: clear,
        subscribeToForegroundNotifications: () => {
          events.push('foreground-listener');
          return { remove: vi.fn() };
        },
        matchPayload: async () => 'matched',
        navigate,
        onForegroundNotification: vi.fn(),
        log: vi.fn(),
      },
      new PushResponseDispatcher(),
    );
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());

    expect(events.slice(0, 3)).toEqual(['response-listener', 'foreground-listener', 'get-last']);
    expect(navigate).toHaveBeenCalledWith('/facture/inv-1');
    cleanup();
  });

  it('déduplique une course listener/cold-start et rafraîchit le fil au premier plan', async () => {
    const listeners: {
      response?: (value: PushNotificationResponseLike) => void;
      foreground?: (value: PushNotificationLike) => void;
    } = {};
    let resolveLast!: (value: PushNotificationResponseLike | null) => void;
    const last = new Promise<PushNotificationResponseLike | null>((resolve) => {
      resolveLast = resolve;
    });
    const notification = response('same', '/notifications');
    const navigate = vi.fn();
    const invalidate = vi.fn();
    const clear = vi.fn(async () => undefined);
    const cleanup = installPushEventBridge(
      {
        subscribeToResponses: (listener) => {
          listeners.response = listener;
          return { remove: vi.fn() };
        },
        getLastResponse: () => last,
        clearLastResponse: clear,
        subscribeToForegroundNotifications: (listener) => {
          listeners.foreground = listener;
          return { remove: vi.fn() };
        },
        matchPayload: async () => 'matched',
        navigate,
        onForegroundNotification: invalidate,
        log: vi.fn(),
      },
      new PushResponseDispatcher(),
    );

    listeners.response?.(notification);
    resolveLast(notification);
    listeners.foreground?.(notification.notification);
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    cleanup();
  });

  it('ne navigue ni n’efface après démontage, pour permettre le retry au prochain AuthGate', async () => {
    let resolveLast!: (value: PushNotificationResponseLike | null) => void;
    const last = new Promise<PushNotificationResponseLike | null>((resolve) => {
      resolveLast = resolve;
    });
    const navigate = vi.fn();
    const clear = vi.fn(async () => undefined);
    const cleanup = installPushEventBridge(
      {
        subscribeToResponses: () => ({ remove: vi.fn() }),
        getLastResponse: () => last,
        clearLastResponse: clear,
        subscribeToForegroundNotifications: () => ({ remove: vi.fn() }),
        matchPayload: async () => 'matched',
        navigate,
        onForegroundNotification: vi.fn(),
        log: vi.fn(),
      },
      new PushResponseDispatcher(),
    );
    cleanup();
    resolveLast(response('late', '/notifications'));
    await Promise.resolve();
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('ignore aussi les callbacks natifs déjà en file au moment du teardown', () => {
    let liveResponse!: (value: PushNotificationResponseLike) => void;
    let foreground!: (value: PushNotificationLike) => void;
    const navigate = vi.fn();
    const invalidate = vi.fn();
    const cleanup = installPushEventBridge(
      {
        subscribeToResponses: (listener) => {
          liveResponse = listener;
          return { remove: vi.fn() };
        },
        getLastResponse: async () => null,
        clearLastResponse: vi.fn(async () => undefined),
        subscribeToForegroundNotifications: (listener) => {
          foreground = listener;
          return { remove: vi.fn() };
        },
        matchPayload: async () => 'matched',
        navigate,
        onForegroundNotification: invalidate,
        log: vi.fn(),
      },
      new PushResponseDispatcher(),
    );

    cleanup();
    liveResponse(response('queued-after-cleanup', '/notifications'));
    foreground(response('queued-foreground', '/notifications').notification);

    expect(navigate).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ne navigue ni ne rafraîchit pour un payload stale', async () => {
    let liveResponse!: (value: PushNotificationResponseLike) => void;
    let foreground!: (value: PushNotificationLike) => void;
    const navigate = vi.fn();
    const invalidate = vi.fn();
    const cleanup = installPushEventBridge(
      {
        subscribeToResponses: (listener) => {
          liveResponse = listener;
          return { remove: vi.fn() };
        },
        getLastResponse: async () => null,
        clearLastResponse: vi.fn(async () => undefined),
        subscribeToForegroundNotifications: (listener) => {
          foreground = listener;
          return { remove: vi.fn() };
        },
        matchPayload: async () => 'stale',
        navigate,
        onForegroundNotification: invalidate,
        log: vi.fn(),
      },
      new PushResponseDispatcher(),
    );

    const stale = response('stale-a', '/notifications');
    liveResponse(stale);
    foreground(stale.notification);
    await Promise.resolve();
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    cleanup();
  });

  it('conserve une réponse cold not_ready pour la reprise après réconciliation', async () => {
    const clear = vi.fn(async () => undefined);
    const cleanup = installPushEventBridge(
      {
        subscribeToResponses: () => ({ remove: vi.fn() }),
        getLastResponse: async () => response('cold-not-ready', '/notifications'),
        clearLastResponse: clear,
        subscribeToForegroundNotifications: () => ({ remove: vi.fn() }),
        matchPayload: async () => 'not_ready',
        navigate: vi.fn(),
        onForegroundNotification: vi.fn(),
        log: vi.fn(),
      },
      new PushResponseDispatcher(),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(clear).not.toHaveBeenCalled();
    cleanup();
  });

  it('n’efface pas la réponse cold si le teardown survient pendant la validation de fence', async () => {
    let resolveMatch!: (decision: 'matched') => void;
    const deferredMatch = new Promise<'matched'>((resolve) => {
      resolveMatch = resolve;
    });
    const matchPayload = vi.fn(async () => deferredMatch);
    const clear = vi.fn(async () => undefined);
    const navigate = vi.fn();
    const cleanup = installPushEventBridge(
      {
        subscribeToResponses: () => ({ remove: vi.fn() }),
        getLastResponse: async () => response('cold-deferred', '/notifications'),
        clearLastResponse: clear,
        subscribeToForegroundNotifications: () => ({ remove: vi.fn() }),
        matchPayload,
        navigate,
        onForegroundNotification: vi.fn(),
        log: vi.fn(),
      },
      new PushResponseDispatcher(),
    );
    await vi.waitFor(() => expect(matchPayload).toHaveBeenCalledOnce());

    cleanup();
    resolveMatch('matched');
    await Promise.resolve();
    await Promise.resolve();

    expect(navigate).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});

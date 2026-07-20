import { describe, expect, it, vi } from 'vitest';
import {
  PushPermissionCoordinator,
  classifyPushAuthorization,
  derivePushConsentSurface,
  shouldRevokePushBindingForPermission,
  type NativePushPermissionSnapshot,
  type PushPermissionDependencies,
  type PushPermissionState,
} from './push-permission';

function permission(
  status: 'granted' | 'denied' | 'undetermined',
  options: { canAskAgain?: boolean; iosStatus?: number } = {},
): NativePushPermissionSnapshot {
  return {
    status,
    granted: status === 'granted',
    canAskAgain: options.canAskAgain ?? status !== 'denied',
    ...(options.iosStatus === undefined ? {} : { ios: { status: options.iosStatus } }),
  };
}

function state(overrides: Partial<PushPermissionState>): PushPermissionState {
  return {
    initialized: true,
    authorization: 'not_determined',
    operation: 'idle',
    registration: 'idle',
    preference: 'unseen',
    canAskAgain: true,
    androidChannelEnabled: null,
    failure: null,
    ...overrides,
  };
}

function harness(
  overrides: Partial<PushPermissionDependencies> = {},
): PushPermissionDependencies & { events: string[] } {
  const events: string[] = [];
  return {
    platform: 'ios',
    getPermission: vi.fn(async () => {
      events.push('get');
      return permission('undetermined', { iosStatus: 0 });
    }),
    requestPermission: vi.fn(async () => {
      events.push('request');
      return permission('granted', { iosStatus: 2 });
    }),
    ensureAndroidChannel: vi.fn(async () => {
      events.push('channel');
    }),
    getAndroidChannelEnabled: vi.fn(async () => null),
    getExpoPushToken: vi.fn(async () => {
      events.push('token');
      return 'ExponentPushToken[test]';
    }),
    registerDevice: vi.fn(async () => {
      events.push('register');
    }),
    unregisterDevice: vi.fn(async () => {
      events.push('unregister');
    }),
    openSystemSettings: vi.fn(async () => {
      events.push('settings');
    }),
    now: () => 1_000,
    preferenceStore: {
      readDismissed: vi.fn(async () => false),
      writeDismissed: vi.fn(async () => undefined),
    },
    events,
    ...overrides,
  };
}

describe('classifyPushAuthorization', () => {
  it('distingue les statuts iOS autorisé, provisoire, éphémère et bloqué', () => {
    expect(classifyPushAuthorization('ios', permission('granted', { iosStatus: 2 }))).toBe(
      'granted',
    );
    expect(classifyPushAuthorization('ios', permission('denied', { iosStatus: 3 }))).toBe(
      'provisional',
    );
    expect(classifyPushAuthorization('ios', permission('denied', { iosStatus: 4 }))).toBe(
      'ephemeral',
    );
    expect(
      classifyPushAuthorization('ios', permission('denied', { iosStatus: 1, canAskAgain: false })),
    ).toBe('blocked');
  });

  it('respecte canAskAgain sur Android et neutralise le web', () => {
    expect(classifyPushAuthorization('android', permission('denied', { canAskAgain: true }))).toBe(
      'denied',
    );
    expect(classifyPushAuthorization('android', permission('denied', { canAskAgain: false }))).toBe(
      'blocked',
    );
    expect(classifyPushAuthorization('web', permission('granted'))).toBe('unsupported');
  });
});

describe('derivePushConsentSurface', () => {
  it('affiche le primer une seule fois puis une présence compacte après « pas maintenant »', () => {
    expect(derivePushConsentSurface(state({}))).toBe('primer');
    expect(derivePushConsentSurface(state({ preference: 'dismissed' }))).toBe('dismissed');
  });

  it('route les refus définitifs, le provisoire et les pannes vers leurs surfaces honnêtes', () => {
    expect(derivePushConsentSurface(state({ authorization: 'blocked' }))).toBe('settings');
    expect(derivePushConsentSurface(state({ authorization: 'provisional' }))).toBe('provisional');
    expect(
      derivePushConsentSurface(
        state({ authorization: 'unavailable', failure: 'permission_check' }),
      ),
    ).toBe('recovery');
    expect(
      derivePushConsentSurface(state({ authorization: 'granted', registration: 'failed' })),
    ).toBe('recovery');
    expect(
      derivePushConsentSurface(state({ authorization: 'granted', registration: 'registered' })),
    ).toBe('hidden');
  });
});

describe('shouldRevokePushBindingForPermission', () => {
  it('ne confond jamais une panne de lecture native avec un retrait de permission', () => {
    expect(shouldRevokePushBindingForPermission(state({ authorization: 'unknown' }))).toBe(false);
    expect(
      shouldRevokePushBindingForPermission(
        state({
          authorization: 'unavailable',
          failure: 'permission_check',
        }),
      ),
    ).toBe(false);
  });

  it('reconnaît uniquement les refus OS et le canal Android explicitement coupé', () => {
    expect(shouldRevokePushBindingForPermission(state({ authorization: 'not_determined' }))).toBe(
      true,
    );
    expect(shouldRevokePushBindingForPermission(state({ authorization: 'denied' }))).toBe(true);
    expect(shouldRevokePushBindingForPermission(state({ authorization: 'blocked' }))).toBe(true);
    expect(
      shouldRevokePushBindingForPermission(
        state({
          authorization: 'granted',
          androidChannelEnabled: false,
        }),
      ),
    ).toBe(true);
    expect(shouldRevokePushBindingForPermission(state({ authorization: 'granted' }))).toBe(false);
  });
});

describe('PushPermissionCoordinator', () => {
  it('ne demande jamais la permission au boot quand elle est indéterminée', async () => {
    const deps = harness();
    const coordinator = new PushPermissionCoordinator(deps);

    await coordinator.bootstrapSilently();

    expect(deps.getPermission).toHaveBeenCalledOnce();
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.ensureAndroidChannel).not.toHaveBeenCalled();
    expect(deps.getExpoPushToken).not.toHaveBeenCalled();
    expect(deps.registerDevice).not.toHaveBeenCalled();
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('primer');
  });

  it('enregistre silencieusement un Android déjà autorisé dans le bon ordre', async () => {
    const deps = harness({
      platform: 'android',
      getPermission: vi.fn(async () => {
        deps.events.push('get');
        return permission('granted');
      }),
    });
    const coordinator = new PushPermissionCoordinator(deps);

    await coordinator.bootstrapSilently();

    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.events.filter((event) => event !== 'read')).toEqual([
      'get',
      'channel',
      'token',
      'register',
    ]);
    expect(deps.registerDevice).toHaveBeenCalledWith('ExponentPushToken[test]', 'android');
    expect(coordinator.getSnapshot().registration).toBe('registered');
  });

  it('traite une autorisation provisoire comme enregistrable sans afficher de prompt au boot', async () => {
    const deps = harness({
      getPermission: vi.fn(async () => permission('denied', { iosStatus: 3, canAskAgain: true })),
    });
    const coordinator = new PushPermissionCoordinator(deps);

    await coordinator.bootstrapSilently();

    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.registerDevice).toHaveBeenCalledOnce();
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('provisional');
  });

  it('persiste uniquement le refus du primer et ne déclenche aucun appel natif', async () => {
    let dismissed = false;
    const preferenceStore = {
      readDismissed: vi.fn(async () => dismissed),
      writeDismissed: vi.fn(async () => {
        dismissed = true;
      }),
    };
    const firstDeps = harness({ preferenceStore });
    const first = new PushPermissionCoordinator(firstDeps);
    await first.bootstrapSilently();
    await first.dismissPrimer();

    expect(firstDeps.requestPermission).not.toHaveBeenCalled();
    expect(preferenceStore.writeDismissed).toHaveBeenCalledOnce();

    const secondDeps = harness({ preferenceStore });
    const second = new PushPermissionCoordinator(secondDeps);
    await second.bootstrapSilently();
    expect(derivePushConsentSurface(second.getSnapshot())).toBe('dismissed');
    expect(secondDeps.requestPermission).not.toHaveBeenCalled();
  });

  it('crée le canal Android avant le prompt puis le token, après un geste explicite', async () => {
    const deps = harness({
      platform: 'android',
      getPermission: vi.fn(async () => {
        deps.events.push('get');
        return permission('undetermined');
      }),
      requestPermission: vi.fn(async () => {
        deps.events.push('request');
        return permission('granted');
      }),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();
    deps.events.length = 0;

    const outcome = await coordinator.requestFromUser();

    expect(outcome).toBe('registered');
    expect(deps.events).toEqual(['get', 'channel', 'request', 'token', 'register']);
    expect(deps.ensureAndroidChannel).toHaveBeenCalledOnce();
  });

  it('déduplique les doubles taps et l’enregistrement associé', async () => {
    let resolveRequest!: (value: NativePushPermissionSnapshot) => void;
    const requestResult = new Promise<NativePushPermissionSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    const deps = harness({
      requestPermission: vi.fn(async () => requestResult),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();

    const first = coordinator.requestFromUser();
    const second = coordinator.requestFromUser();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(deps.requestPermission).toHaveBeenCalledOnce());
    resolveRequest(permission('granted', { iosStatus: 2 }));

    await expect(Promise.all([first, second])).resolves.toEqual(['registered', 'registered']);
    expect(deps.getExpoPushToken).toHaveBeenCalledOnce();
    expect(deps.registerDevice).toHaveBeenCalledOnce();
  });

  it('empêche un refresh AppState de réécrire le résultat d’un prompt en vol', async () => {
    let resolveRequest!: (value: NativePushPermissionSnapshot) => void;
    const requestResult = new Promise<NativePushPermissionSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    const deps = harness({
      requestPermission: vi.fn(async () => requestResult),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();

    const explicitRequest = coordinator.requestFromUser();
    await vi.waitFor(() => expect(deps.requestPermission).toHaveBeenCalledOnce());
    const appStateRefresh = coordinator.refreshSilently();
    // bootstrap + pré-check explicite ; le refresh ne lance pas une troisième lecture stale.
    expect(deps.getPermission).toHaveBeenCalledTimes(2);

    resolveRequest(permission('granted', { iosStatus: 2 }));
    await Promise.all([explicitRequest, appStateRefresh]);
    expect(coordinator.getSnapshot()).toMatchObject({
      authorization: 'granted',
      registration: 'registered',
      operation: 'idle',
    });
    expect(deps.getPermission).toHaveBeenCalledTimes(2);
  });

  it('permet à une autorisation provisoire de demander explicitement les alertes complètes', async () => {
    const deps = harness({
      getPermission: vi.fn(async () => permission('denied', { iosStatus: 3, canAskAgain: true })),
      requestPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();

    await coordinator.requestFromUser();

    expect(deps.requestPermission).toHaveBeenCalledOnce();
    // Le même token est idempotent dans le coordinateur : pas de second POST serveur.
    expect(deps.registerDevice).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().authorization).toBe('granted');
  });

  it('ne prétend pas avoir obtenu le plein consentement si iOS reste provisoire', async () => {
    const deps = harness({
      getPermission: vi.fn(async () => permission('denied', { iosStatus: 3, canAskAgain: true })),
      requestPermission: vi.fn(async () =>
        permission('denied', { iosStatus: 3, canAskAgain: true }),
      ),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();

    await expect(coordinator.requestFromUser()).resolves.toBe('provisional');
    expect(coordinator.getSnapshot().authorization).toBe('provisional');
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('provisional');
  });

  it('ouvre les réglages, sans re-prompt, pour un provisoire non redemandable', async () => {
    const deps = harness({
      getPermission: vi.fn(async () => permission('denied', { iosStatus: 3, canAskAgain: false })),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();

    await expect(coordinator.requestFromUser()).resolves.toBe('blocked');
    expect(deps.requestPermission).not.toHaveBeenCalled();
    await coordinator.openSettingsFromUser();
    expect(deps.openSystemSettings).toHaveBeenCalledOnce();
  });

  it('n’ouvre jamais les réglages automatiquement après un refus définitif', async () => {
    const deps = harness({
      getPermission: vi.fn(async () => permission('denied', { iosStatus: 1, canAskAgain: false })),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();

    await expect(coordinator.requestFromUser()).resolves.toBe('blocked');
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.openSystemSettings).not.toHaveBeenCalled();

    await expect(coordinator.openSettingsFromUser()).resolves.toBe('settings_opened');
    expect(deps.openSystemSettings).toHaveBeenCalledOnce();
  });

  it('resynchronise le statut au retour des réglages sans nouveau prompt', async () => {
    let current = permission('denied', { iosStatus: 1, canAskAgain: false });
    const deps = harness({
      getPermission: vi.fn(async () => current),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();
    current = permission('granted', { iosStatus: 2 });

    await coordinator.refreshSilently();

    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.registerDevice).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().authorization).toBe('granted');
  });

  it('rend une panne de token simulateur récupérable par un retry explicite', async () => {
    let tokenAvailable = false;
    const deps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
      getExpoPushToken: vi.fn(async () => {
        if (!tokenAvailable) throw new Error('physical device required');
        return 'ExponentPushToken[recovered]';
      }),
    });
    const coordinator = new PushPermissionCoordinator(deps);

    await coordinator.bootstrapSilently();
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('recovery');
    expect(coordinator.getSnapshot().failure).toBe('token');

    tokenAvailable = true;
    await expect(coordinator.retryFromUser()).resolves.toBe('registered');
    expect(coordinator.getSnapshot().registration).toBe('registered');
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('hidden');
  });

  it('réessaie silencieusement une inscription réseau selon un backoff borné sur AppState', async () => {
    let now = 1_000;
    let networkAvailable = false;
    const deps = harness({
      now: () => now,
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
      getExpoPushToken: vi.fn(async () => {
        if (!networkAvailable) throw new Error('offline');
        return 'ExponentPushToken[online]';
      }),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();
    expect(deps.getExpoPushToken).toHaveBeenCalledOnce();

    now = 5_999;
    await coordinator.refreshSilently();
    expect(deps.getExpoPushToken).toHaveBeenCalledOnce();

    networkAvailable = true;
    now = 6_000;
    await coordinator.refreshSilently();
    expect(deps.getExpoPushToken).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot().registration).toBe('registered');
  });

  it('réconcilie périodiquement le token avec le serveur même s’il est inchangé', async () => {
    let now = 0;
    const deps = harness({
      now: () => now,
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();
    expect(deps.registerDevice).toHaveBeenCalledOnce();

    now = 24 * 60 * 60_000 - 1;
    await coordinator.refreshSilently();
    expect(deps.registerDevice).toHaveBeenCalledOnce();

    now = 24 * 60 * 60_000;
    await coordinator.refreshSilently();
    expect(deps.registerDevice).toHaveBeenCalledTimes(2);
  });

  it('expose un canal Android désactivé sans envoyer ni conserver un token inutilement', async () => {
    const deps = harness({
      platform: 'android',
      getPermission: vi.fn(async () => permission('granted')),
      getAndroidChannelEnabled: vi.fn(async () => false),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();

    expect(coordinator.getSnapshot().androidChannelEnabled).toBe(false);
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('settings');
    expect(deps.getExpoPushToken).not.toHaveBeenCalled();
    expect(deps.registerDevice).not.toHaveBeenCalled();
  });

  it('force un rebind immédiat après la réactivation d’un canal Android révoqué', async () => {
    let channelEnabled = true;
    const owner = { tenant: 'a' };
    const deps = harness({
      platform: 'android',
      getPermission: vi.fn(async () => permission('granted')),
      getAndroidChannelEnabled: vi.fn(async () => channelEnabled),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    coordinator.setRegistrationContext(owner);
    await coordinator.bootstrapSilently();
    expect(deps.registerDevice).toHaveBeenCalledOnce();

    channelEnabled = false;
    await coordinator.refreshSilently();
    expect(coordinator.invalidateRegistrationAfterRevocation(owner)).toBe(true);
    channelEnabled = true;
    await coordinator.refreshSilently();

    expect(deps.registerDevice).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot().registration).toBe('registered');
  });

  it('refuse qu’un ancien contexte invalide le cache du nouvel owner', async () => {
    const deps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    const oldOwner = { tenant: 'a' };
    const currentOwner = { tenant: 'b' };
    coordinator.setRegistrationContext(currentOwner);
    await coordinator.bootstrapSilently();

    expect(coordinator.invalidateRegistrationAfterRevocation(oldOwner)).toBe(false);
    await coordinator.refreshSilently();
    expect(deps.registerDevice).toHaveBeenCalledOnce();
  });

  it('n’inscrit rien si un prompt se termine après le démontage de la session', async () => {
    let resolveRequest!: (value: NativePushPermissionSnapshot) => void;
    const requestResult = new Promise<NativePushPermissionSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    const deps = harness({ requestPermission: vi.fn(async () => requestResult) });
    const coordinator = new PushPermissionCoordinator(deps);
    coordinator.setRegistrationContext({ tenant: 'a' });
    await coordinator.bootstrapSilently();
    const pending = coordinator.requestFromUser();
    await vi.waitFor(() => expect(deps.requestPermission).toHaveBeenCalledOnce());

    coordinator.setRegistrationContext(null);
    resolveRequest(permission('granted', { iosStatus: 2 }));
    await expect(pending).resolves.toBe('unavailable');
    expect(deps.registerDevice).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().registration).toBe('idle');
  });

  it('rend les erreurs prompt, canal, réglages et serveur explicites et récupérables', async () => {
    const promptDeps = harness({
      requestPermission: vi.fn(async () => {
        throw new Error('prompt failed');
      }),
    });
    const prompt = new PushPermissionCoordinator(promptDeps);
    await prompt.bootstrapSilently();
    await expect(prompt.requestFromUser()).resolves.toBe('unavailable');
    expect(prompt.getSnapshot().failure).toBe('permission_request');

    const channelDeps = harness({
      platform: 'android',
      ensureAndroidChannel: vi.fn(async () => {
        throw new Error('channel failed');
      }),
    });
    const channel = new PushPermissionCoordinator(channelDeps);
    await channel.bootstrapSilently();
    await expect(channel.requestFromUser()).resolves.toBe('unavailable');
    expect(channelDeps.requestPermission).not.toHaveBeenCalled();
    expect(channel.getSnapshot().failure).toBe('android_channel');

    const settingsDeps = harness({
      openSystemSettings: vi.fn(async () => {
        throw new Error('settings failed');
      }),
    });
    const settings = new PushPermissionCoordinator(settingsDeps);
    await expect(settings.openSettingsFromUser()).resolves.toBe('unavailable');
    expect(settings.getSnapshot().failure).toBe('settings');

    const serverDeps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
      registerDevice: vi.fn(async () => {
        throw new Error('server offline');
      }),
    });
    const server = new PushPermissionCoordinator(serverDeps);
    await server.bootstrapSilently();
    expect(server.getSnapshot().failure).toBe('device_registration');
  });

  it('respecte « pas maintenant » même si la persistance locale échoue', async () => {
    const deps = harness({
      preferenceStore: {
        readDismissed: vi.fn(async () => false),
        writeDismissed: vi.fn(async () => {
          throw new Error('storage full');
        }),
      },
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();
    await coordinator.dismissPrimer();
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('dismissed');
  });

  it('récupère après une erreur de lecture sans transformer « réessayer » en prompt natif', async () => {
    let available = false;
    const deps = harness({
      getPermission: vi.fn(async () => {
        if (!available) throw new Error('native module unavailable');
        return permission('undetermined', { iosStatus: 0 });
      }),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('recovery');
    expect(deps.requestPermission).not.toHaveBeenCalled();

    available = true;
    await expect(coordinator.retryFromUser()).resolves.toBe('refreshed');
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(derivePushConsentSurface(coordinator.getSnapshot())).toBe('primer');

    await coordinator.requestFromUser();
    expect(deps.requestPermission).toHaveBeenCalledOnce();
  });

  it('ré-enregistre un même token pour un nouveau contexte sans le persister', async () => {
    const deps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    const tenantA = {};
    const tenantB = {};
    coordinator.setRegistrationContext(tenantA);
    await coordinator.bootstrapSilently();
    coordinator.setRegistrationContext(tenantB);
    await coordinator.refreshSilently();

    expect(deps.registerDevice).toHaveBeenCalledTimes(2);
  });

  it('déduplique la révocation pré-logout et purge toujours le cache local', async () => {
    let resolveUnregister!: () => void;
    const pendingUnregister = new Promise<void>((resolve) => {
      resolveUnregister = resolve;
    });
    const deps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
      unregisterDevice: vi.fn(async () => pendingUnregister),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    coordinator.setRegistrationContext({ tenant: 'a' });
    await coordinator.bootstrapSilently();

    const first = coordinator.revokeRegistrationBeforeSignOut();
    const second = coordinator.revokeRegistrationBeforeSignOut();
    expect(first).toBe(second);
    expect(deps.unregisterDevice).toHaveBeenCalledOnce();
    resolveUnregister();
    await Promise.all([first, second]);
    expect(coordinator.getSnapshot()).toMatchObject({
      registration: 'idle',
      operation: 'idle',
      failure: null,
    });
  });

  it('séquence strictement un POST en vol avant le DELETE de déconnexion', async () => {
    let resolveRegistration!: () => void;
    const pendingRegistration = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    const events: string[] = [];
    const deps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
      registerDevice: vi.fn(async () => {
        events.push('post:start');
        await pendingRegistration;
        events.push('post:done');
      }),
    });
    const unregister = vi.fn(async (token: string) => {
      events.push(`delete:${token}`);
    });
    const coordinator = new PushPermissionCoordinator(deps);
    coordinator.setRegistrationContext({ tenant: 'a' });

    const bootstrap = coordinator.bootstrapSilently();
    await vi.waitFor(() => expect(deps.registerDevice).toHaveBeenCalledOnce());
    const revoke = coordinator.revokeRegistrationBeforeSignOut(unregister);

    expect(events).toEqual(['post:start']);
    expect(unregister).not.toHaveBeenCalled();
    // Le teardown React peut survenir pendant le cleanup : le token connu reste attaché à
    // l'ancienne opération jusqu'au DELETE et aucun refresh ne peut réinscrire le device.
    coordinator.setRegistrationContext(null);
    await coordinator.refreshSilently();
    expect(deps.registerDevice).toHaveBeenCalledOnce();

    resolveRegistration();
    await Promise.all([bootstrap, revoke]);

    expect(events).toEqual(['post:start', 'post:done', 'delete:ExponentPushToken[test]']);
    expect(unregister).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot()).toMatchObject({
      registration: 'idle',
      operation: 'idle',
      failure: null,
    });
  });

  it('ferme le robinet avant qu’un prompt en vol puisse inscrire le device', async () => {
    let resolveRequest!: (value: NativePushPermissionSnapshot) => void;
    const requestResult = new Promise<NativePushPermissionSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    const deps = harness({ requestPermission: vi.fn(async () => requestResult) });
    const coordinator = new PushPermissionCoordinator(deps);
    coordinator.setRegistrationContext({ tenant: 'a' });
    await coordinator.bootstrapSilently();
    const request = coordinator.requestFromUser();
    await vi.waitFor(() => expect(deps.requestPermission).toHaveBeenCalledOnce());

    await coordinator.revokeRegistrationBeforeSignOut();
    resolveRequest(permission('granted', { iosStatus: 2 }));

    await expect(request).resolves.toBe('unavailable');
    expect(deps.getExpoPushToken).not.toHaveBeenCalled();
    expect(deps.registerDevice).not.toHaveBeenCalled();
  });

  it('déduplique aussi la continuation tardive après la borne de déconnexion', async () => {
    vi.useFakeTimers();
    try {
      let resolveRegistration!: () => void;
      const pendingRegistration = new Promise<void>((resolve) => {
        resolveRegistration = resolve;
      });
      const deps = harness({
        getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
        registerDevice: vi.fn(async () => pendingRegistration),
      });
      const unregister = vi.fn(async () => undefined);
      const coordinator = new PushPermissionCoordinator(deps);
      coordinator.setRegistrationContext({ tenant: 'a' });

      const bootstrap = coordinator.bootstrapSilently();
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.registerDevice).toHaveBeenCalledOnce();

      const first = coordinator.revokeRegistrationBeforeSignOut(unregister);
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      const duplicate = coordinator.revokeRegistrationBeforeSignOut(unregister);

      expect(duplicate).toBe(first);
      expect(unregister).not.toHaveBeenCalled();

      resolveRegistration();
      await bootstrap;
      await vi.advanceTimersByTimeAsync(0);
      expect(unregister).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('termine sur le binding du nouveau compte même si le POST de l’ancien finit en dernier', async () => {
    vi.useFakeTimers();
    try {
      let resolveOldRegistration!: () => void;
      const oldRegistration = new Promise<void>((resolve) => {
        resolveOldRegistration = resolve;
      });
      const events: string[] = [];
      let tokenCalls = 0;
      const deps = harness({
        getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
        getExpoPushToken: vi.fn(async () => {
          tokenCalls += 1;
          return tokenCalls === 1 ? 'ExponentPushToken[old]' : 'ExponentPushToken[new]';
        }),
        registerDevice: vi.fn(async (token) => {
          if (token === 'ExponentPushToken[old]') {
            events.push('post:old:start');
            await oldRegistration;
            events.push('post:old:done');
            return;
          }
          events.push('post:new');
        }),
      });
      const unregister = vi.fn(async (token: string) => {
        events.push(`delete:${token}`);
      });
      const coordinator = new PushPermissionCoordinator(deps);
      coordinator.setRegistrationContext({ tenant: 'a' });

      const oldBootstrap = coordinator.bootstrapSilently();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['post:old:start']);

      const revoke = coordinator.revokeRegistrationBeforeSignOut(unregister);
      await vi.advanceTimersByTimeAsync(1_000);
      await revoke;

      coordinator.setRegistrationContext({ tenant: 'b' });
      await coordinator.refreshSilently();
      expect(events).toEqual(['post:old:start', 'post:new']);

      resolveOldRegistration();
      await oldBootstrap;
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toEqual([
        'post:old:start',
        'post:new',
        'post:old:done',
        'delete:ExponentPushToken[old]',
        'post:new',
      ]);
      expect(coordinator.getSnapshot().registration).toBe('registered');
    } finally {
      vi.useRealTimers();
    }
  });

  it('force le rebind B après la course A → B avec le même token Expo réel', async () => {
    vi.useFakeTimers();
    try {
      let resolveOldRegistration!: () => void;
      const oldRegistration = new Promise<void>((resolve) => {
        resolveOldRegistration = resolve;
      });
      let activeTenant: 'a' | 'b' = 'a';
      const events: string[] = [];
      const sharedToken = 'ExponentPushToken[shared-device]';
      const deps = harness({
        getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
        getExpoPushToken: vi.fn(async () => sharedToken),
        registerDevice: vi.fn(async () => {
          // Comme l'adapter réel `activeClient`, le contexte est capturé au départ du POST.
          const requestTenant = activeTenant;
          if (requestTenant === 'a') {
            events.push('post:a:start');
            await oldRegistration;
            events.push('post:a:done');
            return;
          }
          events.push('post:b');
        }),
      });
      const unregisterA = vi.fn(async (token: string) => {
        events.push(`delete:a:${token}`);
      });
      const coordinator = new PushPermissionCoordinator(deps);
      coordinator.setRegistrationContext({ tenant: 'a' });

      const oldBootstrap = coordinator.bootstrapSilently();
      await vi.advanceTimersByTimeAsync(0);
      const revoke = coordinator.revokeRegistrationBeforeSignOut(unregisterA);
      await vi.advanceTimersByTimeAsync(1_000);
      await revoke;

      activeTenant = 'b';
      coordinator.setRegistrationContext({ tenant: 'b' });
      await coordinator.refreshSilently();
      expect(events).toEqual(['post:a:start', 'post:b']);

      resolveOldRegistration();
      await oldBootstrap;
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toEqual([
        'post:a:start',
        'post:b',
        'post:a:done',
        `delete:a:${sharedToken}`,
        'post:b',
      ]);
      expect(deps.registerDevice).toHaveBeenCalledTimes(3);
      expect(deps.getExpoPushToken).toHaveBeenCalledTimes(3);
      expect(coordinator.getSnapshot().registration).toBe('registered');
    } finally {
      vi.useRealTimers();
    }
  });

  it('attend la réponse B en retard puis émet un POST B frais après DELETE A', async () => {
    vi.useFakeTimers();
    try {
      let resolveOldRegistration!: () => void;
      const oldRegistration = new Promise<void>((resolve) => {
        resolveOldRegistration = resolve;
      });
      let resolveFirstBResponse!: () => void;
      const firstBResponse = new Promise<void>((resolve) => {
        resolveFirstBResponse = resolve;
      });
      let activeTenant: 'a' | 'b' = 'a';
      let bCalls = 0;
      const events: string[] = [];
      const sharedToken = 'ExponentPushToken[shared-response-race]';
      const deps = harness({
        getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
        getExpoPushToken: vi.fn(async () => sharedToken),
        registerDevice: vi.fn(async () => {
          const requestTenant = activeTenant;
          if (requestTenant === 'a') {
            events.push('post:a:server-pending');
            await oldRegistration;
            events.push('post:a:server-applied');
            return;
          }
          bCalls += 1;
          events.push(`post:b:${bCalls}:server-applied`);
          if (bCalls === 1) {
            // Le serveur a muté B, mais la réponse HTTP reste suspendue.
            await firstBResponse;
            events.push('post:b:1:response');
          }
        }),
      });
      const unregisterA = vi.fn(async () => {
        events.push('delete:a');
      });
      const coordinator = new PushPermissionCoordinator(deps);
      coordinator.setRegistrationContext({ tenant: 'a' });

      const oldBootstrap = coordinator.bootstrapSilently();
      await vi.advanceTimersByTimeAsync(0);
      const revoke = coordinator.revokeRegistrationBeforeSignOut(unregisterA);
      await vi.advanceTimersByTimeAsync(1_000);
      await revoke;

      activeTenant = 'b';
      coordinator.setRegistrationContext({ tenant: 'b' });
      const firstBRegistration = coordinator.refreshSilently();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['post:a:server-pending', 'post:b:1:server-applied']);

      resolveOldRegistration();
      await oldBootstrap;
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual([
        'post:a:server-pending',
        'post:b:1:server-applied',
        'post:a:server-applied',
        'delete:a',
      ]);
      expect(deps.registerDevice).toHaveBeenCalledTimes(2);

      resolveFirstBResponse();
      await firstBRegistration;
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toEqual([
        'post:a:server-pending',
        'post:b:1:server-applied',
        'post:a:server-applied',
        'delete:a',
        'post:b:1:response',
        'post:b:2:server-applied',
      ]);
      expect(deps.registerDevice).toHaveBeenCalledTimes(3);
      expect(coordinator.getSnapshot().registration).toBe('registered');
    } finally {
      vi.useRealTimers();
    }
  });

  it('purge le cache après une révocation réseau KO sans effacer une reconnexion plus récente', async () => {
    let rejectOld!: (error: Error) => void;
    const oldUnregister = new Promise<void>((_resolve, reject) => {
      rejectOld = reject;
    });
    const deps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
      unregisterDevice: vi.fn(async () => oldUnregister),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    coordinator.setRegistrationContext({ tenant: 'a' });
    await coordinator.bootstrapSilently();
    const lateRevoke = coordinator.revokeRegistrationBeforeSignOut();

    coordinator.setRegistrationContext({ tenant: 'b' });
    await coordinator.refreshSilently();
    expect(coordinator.getSnapshot().registration).toBe('registered');
    rejectOld(new Error('offline'));
    await lateRevoke;
    expect(coordinator.getSnapshot().registration).toBe('registered');
  });

  it('abandonne proprement un token suspendu lorsque le tenant change', async () => {
    let resolveFirstToken!: (token: string) => void;
    const firstToken = new Promise<string>((resolve) => {
      resolveFirstToken = resolve;
    });
    let tokenCalls = 0;
    const deps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
      getExpoPushToken: vi.fn(async () => {
        tokenCalls += 1;
        return tokenCalls === 1 ? firstToken : 'ExponentPushToken[new-tenant]';
      }),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    coordinator.setRegistrationContext({ tenant: 'a' });

    const staleBootstrap = coordinator.bootstrapSilently();
    await vi.waitFor(() => expect(deps.getExpoPushToken).toHaveBeenCalledOnce());
    coordinator.setRegistrationContext({ tenant: 'b' });
    expect(coordinator.getSnapshot().operation).toBe('idle');
    expect(coordinator.getSnapshot().registration).toBe('idle');

    resolveFirstToken('ExponentPushToken[old-tenant]');
    await staleBootstrap;
    expect(deps.registerDevice).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().operation).toBe('idle');

    await coordinator.refreshSilently();
    expect(deps.registerDevice).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().registration).toBe('registered');
  });

  it('la fin tardive d’un POST ancien ne peut écraser l’état du nouveau tenant', async () => {
    let resolveOldRegistration!: () => void;
    const oldRegistration = new Promise<void>((resolve) => {
      resolveOldRegistration = resolve;
    });
    let registrationCalls = 0;
    const deps = harness({
      getPermission: vi.fn(async () => permission('granted', { iosStatus: 2 })),
      registerDevice: vi.fn(async () => {
        registrationCalls += 1;
        if (registrationCalls === 1) await oldRegistration;
      }),
    });
    const coordinator = new PushPermissionCoordinator(deps);
    coordinator.setRegistrationContext({ tenant: 'a' });

    const staleBootstrap = coordinator.bootstrapSilently();
    await vi.waitFor(() => expect(deps.registerDevice).toHaveBeenCalledOnce());
    coordinator.setRegistrationContext({ tenant: 'b' });
    const freshRegistration = coordinator.refreshSilently();
    await vi.waitFor(() => expect(deps.registerDevice).toHaveBeenCalledTimes(2));
    await freshRegistration;
    expect(coordinator.getSnapshot().registration).toBe('registered');

    resolveOldRegistration();
    await staleBootstrap;
    expect(coordinator.getSnapshot()).toMatchObject({
      operation: 'idle',
      registration: 'registered',
      failure: null,
    });
  });

  it('reste un no-op complet sur le web', async () => {
    const deps = harness({ platform: 'web' });
    const coordinator = new PushPermissionCoordinator(deps);
    await coordinator.bootstrapSilently();

    expect(coordinator.getSnapshot().authorization).toBe('unsupported');
    expect(deps.getPermission).not.toHaveBeenCalled();
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.getExpoPushToken).not.toHaveBeenCalled();
  });
});

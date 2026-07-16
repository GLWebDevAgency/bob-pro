/**
 * Permission push : politique pure + coordinateur testable.
 *
 * Invariants :
 * - le statut natif reste l'unique source de vérité ;
 * - le boot ne demande jamais une permission ;
 * - seul le choix UX « pas maintenant » est persisté (jamais le token Expo) ;
 * - toute ouverture des réglages ou demande native provient d'un geste explicite ;
 * - les opérations concurrentes sont dédupliquées.
 */

export type PushPlatform = 'ios' | 'android' | 'web';

export type PushAuthorization =
  | 'unknown'
  | 'not_determined'
  | 'granted'
  | 'provisional'
  | 'ephemeral'
  | 'denied'
  | 'blocked'
  | 'unsupported'
  | 'unavailable';

export type PushOperation = 'idle' | 'checking' | 'requesting' | 'registering' | 'opening_settings';
export type PushRegistration = 'idle' | 'registering' | 'registered' | 'failed';
export type PushPrimerPreference = 'unseen' | 'dismissed';

export type PushFailureStage =
  | 'permission_check'
  | 'permission_request'
  | 'android_channel'
  | 'token'
  | 'device_registration'
  | 'settings';

export interface NativePushPermissionSnapshot {
  readonly granted: boolean;
  readonly status: string;
  readonly canAskAgain: boolean;
  readonly ios?: { readonly status: number };
}

export interface PushPermissionState {
  readonly initialized: boolean;
  readonly authorization: PushAuthorization;
  readonly operation: PushOperation;
  readonly registration: PushRegistration;
  readonly preference: PushPrimerPreference;
  readonly canAskAgain: boolean | null;
  readonly androidChannelEnabled: boolean | null;
  /** Erreur opérationnelle affichable. Les erreurs de persistance UX restent non bloquantes. */
  readonly failure: PushFailureStage | null;
}

export type PushConsentSurface =
  'hidden' | 'primer' | 'dismissed' | 'denied' | 'settings' | 'provisional' | 'recovery';

export type PushConsentOutcome =
  | 'registered'
  | 'granted'
  | 'provisional'
  | 'denied'
  | 'blocked'
  | 'unsupported'
  | 'unavailable'
  | 'dismissed'
  | 'refreshed'
  | 'settings_opened';

export interface PushConsentPreferenceStore {
  readDismissed(): Promise<boolean>;
  writeDismissed(): Promise<void>;
}

export interface PushPermissionDependencies {
  readonly platform: PushPlatform;
  readonly getPermission: () => Promise<NativePushPermissionSnapshot>;
  readonly requestPermission: () => Promise<NativePushPermissionSnapshot>;
  /** Android 13 exige qu'un canal existe avant le prompt et avant l'obtention du token. */
  readonly ensureAndroidChannel: () => Promise<void>;
  readonly getAndroidChannelEnabled: () => Promise<boolean | null>;
  readonly getExpoPushToken: () => Promise<string>;
  readonly registerDevice: (token: string, platform: 'ios' | 'android') => Promise<void>;
  readonly unregisterDevice: (token: string) => Promise<void>;
  readonly openSystemSettings: () => Promise<void>;
  readonly now: () => number;
  readonly preferenceStore: PushConsentPreferenceStore;
  readonly log?: (message: string, error?: unknown) => void;
}

const IOS_AUTHORIZATION = {
  notDetermined: 0,
  denied: 1,
  authorized: 2,
  provisional: 3,
  ephemeral: 4,
} as const;

const INITIAL_STATE: PushPermissionState = {
  initialized: false,
  authorization: 'unknown',
  operation: 'idle',
  registration: 'idle',
  preference: 'unseen',
  canAskAgain: null,
  androidChannelEnabled: null,
  failure: null,
};

const REGISTRATION_RETRY_BASE_MS = 5_000;
const REGISTRATION_RETRY_MAX_MS = 5 * 60_000;
const REGISTRATION_RECONCILE_MS = 24 * 60 * 60_000;
/** Reste sous la borne globale de 1,5 s de session-cleanup, pour laisser le DELETE démarrer. */
const SIGN_OUT_REGISTRATION_WAIT_MS = 1_000;

export function classifyPushAuthorization(
  platform: PushPlatform,
  permission: NativePushPermissionSnapshot,
): PushAuthorization {
  if (platform === 'web') return 'unsupported';

  if (platform === 'ios' && permission.ios !== undefined) {
    switch (permission.ios.status) {
      case IOS_AUTHORIZATION.authorized:
        return 'granted';
      case IOS_AUTHORIZATION.provisional:
        return 'provisional';
      case IOS_AUTHORIZATION.ephemeral:
        return 'ephemeral';
      case IOS_AUTHORIZATION.notDetermined:
        return 'not_determined';
      case IOS_AUTHORIZATION.denied:
        return permission.canAskAgain ? 'denied' : 'blocked';
    }
  }

  if (permission.granted || permission.status === 'granted') return 'granted';
  if (permission.status === 'undetermined') return 'not_determined';
  return permission.canAskAgain ? 'denied' : 'blocked';
}

export function canRegisterPush(authorization: PushAuthorization): boolean {
  return (
    authorization === 'granted' || authorization === 'provisional' || authorization === 'ephemeral'
  );
}

/**
 * Seuls les constats OS autoritatifs ferment un binding existant. Une panne transitoire du
 * module natif (`unavailable`) ou un état encore inconnu ne constitue jamais un retrait de
 * consentement et ne doit pas détruire un binding sain.
 */
export function shouldRevokePushBindingForPermission(state: PushPermissionState): boolean {
  return (
    state.androidChannelEnabled === false ||
    state.authorization === 'not_determined' ||
    state.authorization === 'denied' ||
    state.authorization === 'blocked'
  );
}

export function derivePushConsentSurface(state: PushPermissionState): PushConsentSurface {
  if (!state.initialized || state.authorization === 'unknown' || state.operation === 'checking')
    return 'hidden';
  if (
    state.failure !== null ||
    state.authorization === 'unavailable' ||
    state.registration === 'failed'
  ) {
    return 'recovery';
  }
  if (state.androidChannelEnabled === false) return 'settings';
  if (
    state.authorization === 'unsupported' ||
    state.authorization === 'granted' ||
    state.authorization === 'ephemeral'
  ) {
    return 'hidden';
  }
  if (state.authorization === 'provisional') return 'provisional';
  if (state.authorization === 'blocked') return 'settings';
  if (state.authorization === 'denied') return 'denied';
  return state.preference === 'dismissed' ? 'dismissed' : 'primer';
}

/**
 * Petit coordinateur sans dépendance React/Expo : les adapters natifs vivent dans push.tsx.
 * Le snapshot est immutable afin d'être consommé directement par useSyncExternalStore.
 */
export class PushPermissionCoordinator {
  private state: PushPermissionState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private preferencePromise: Promise<void> | null = null;
  private checkPromise: Promise<PushAuthorization> | null = null;
  private requestPromise: Promise<PushConsentOutcome> | null = null;
  private registerPromise: Promise<PushConsentOutcome> | null = null;
  private unregisterPromise: Promise<void> | null = null;
  private settingsPromise: Promise<PushConsentOutcome> | null = null;
  private channelPromise: Promise<void> | null = null;
  private channelReady = false;
  private registrationContext: unknown = null;
  private registrationContextWasConfigured = false;
  private registrationEpoch = 0;
  private visibleRegistrationEpoch: number | null = null;
  private registeredToken: string | null = null;
  private knownToken: string | null = null;
  private registeredAtMs: number | null = null;
  private registrationFailureCount = 0;
  private nextAutomaticRetryAtMs = 0;
  private signingOut = false;

  constructor(private readonly dependencies: PushPermissionDependencies) {}

  readonly getSnapshot = (): PushPermissionState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Un nouveau client/tenant doit ré-enregistrer le token, sans le persister côté mobile. */
  setRegistrationContext(context: unknown): void {
    if (this.registrationContext === context) return;
    const previousEpoch = this.registrationEpoch;
    const preserveForPendingSignOut = context === null && this.signingOut;
    this.registrationContext = context;
    this.registrationContextWasConfigured = true;
    this.registrationEpoch += 1;
    if (!preserveForPendingSignOut) {
      this.signingOut = false;
      this.registeredToken = null;
      this.knownToken = null;
      this.registeredAtMs = null;
      this.registrationFailureCount = 0;
      this.nextAutomaticRetryAtMs = 0;
    }
    // Le démontage de l'AuthGate arrive après la borne de cleanup. Pendant une révocation
    // tardive, conserver les deux promesses garantit qu'un second cleanup ne peut ni doubler
    // le DELETE ni perdre la référence du POST qui doit impérativement le précéder.
    if (!preserveForPendingSignOut) {
      this.registerPromise = null;
      this.unregisterPromise = null;
    }
    this.abandonStaleRegistration(previousEpoch);
    this.patch({
      registration: 'idle',
      ...(this.state.registration === 'failed' ? { failure: null } : {}),
    });
  }

  /**
   * Le store durable vient de neutraliser le binding courant (permission/canal coupé). Purger
   * cette optimisation mémoire force un POST immédiat lors du prochain off→on, sans attendre
   * la réconciliation périodique de 24 h. La comparaison de contexte ferme les callbacks ABA.
   */
  invalidateRegistrationAfterRevocation(context: unknown): boolean {
    if (this.registrationContext !== context) return false;
    const previousEpoch = this.registrationEpoch;
    this.registrationEpoch += 1;
    this.registeredToken = null;
    this.knownToken = null;
    this.registeredAtMs = null;
    this.registrationFailureCount = 0;
    this.nextAutomaticRetryAtMs = 0;
    this.registerPromise = null;
    this.abandonStaleRegistration(previousEpoch);
    this.patch({ operation: 'idle', registration: 'idle', failure: null });
    return true;
  }

  /** Boot racine : lecture silencieuse puis enregistrement uniquement si déjà autorisé. */
  async bootstrapSilently(): Promise<PushPermissionState> {
    // Un changement AppState/client ne doit jamais lancer un getPermissions concurrent au
    // prompt natif : une lecture ancienne pourrait sinon écraser la réponse de l'utilisateur.
    if (this.requestPromise !== null) {
      await this.requestPromise;
      return this.state;
    }
    // Une métadonnée UX locale ne doit jamais retarder l'enregistrement d'une permission
    // déjà accordée. Sa lecture continue en parallèle et mettra le snapshot à jour au besoin.
    const preference = this.loadPreference();
    const authorization = await this.inspectPermission(false);
    if (canRegisterPush(authorization) && this.state.androidChannelEnabled !== false) {
      await this.reconcileGrantedRegistration();
    }
    await preference;
    return this.state;
  }

  /** Retour au premier plan / focus : aucune demande native, jamais. */
  async refreshSilently(): Promise<PushPermissionState> {
    if (this.requestPromise !== null) {
      await this.requestPromise;
      return this.state;
    }
    const authorization = await this.inspectPermission(false);
    if (canRegisterPush(authorization) && this.state.androidChannelEnabled !== false) {
      await this.reconcileGrantedRegistration();
    }
    return this.state;
  }

  /** Geste explicite sur « Activer ». */
  requestFromUser(): Promise<PushConsentOutcome> {
    if (this.requestPromise !== null) return this.requestPromise;
    const operation = this.requestFromUserInternal().finally(() => {
      if (this.requestPromise === operation) this.requestPromise = null;
    });
    this.requestPromise = operation;
    return operation;
  }

  /** Geste explicite sur « Pas maintenant » ; n'ouvre jamais le prompt système. */
  async dismissPrimer(): Promise<PushConsentOutcome> {
    this.patch({ preference: 'dismissed' });
    try {
      await this.dependencies.preferenceStore.writeDismissed();
    } catch (error) {
      // Le choix reste respecté pendant la session ; l'app ne devient jamais inutilisable.
      this.log('impossible de persister le choix « pas maintenant »', error);
    }
    return 'dismissed';
  }

  /** Geste explicite uniquement, utilisé lorsque canAskAgain=false. */
  openSettingsFromUser(): Promise<PushConsentOutcome> {
    if (this.settingsPromise !== null) return this.settingsPromise;
    const operation = this.openSettingsInternal().finally(() => {
      if (this.settingsPromise === operation) this.settingsPromise = null;
    });
    this.settingsPromise = operation;
    return operation;
  }

  /** Relance explicite après une panne device/simulateur/serveur. */
  async retryFromUser(): Promise<PushConsentOutcome> {
    this.patch({
      failure: null,
      registration: this.state.registration === 'failed' ? 'idle' : this.state.registration,
    });
    const authorization = await this.inspectPermission(true);
    if (canRegisterPush(authorization)) return this.registerGrantedDevice(true);
    if (authorization === 'blocked') return 'blocked';
    if (authorization === 'unsupported') return 'unsupported';
    if (authorization === 'unavailable') return 'unavailable';
    // « Réessayer » répare seulement le check/enregistrement. Si l'OS n'a pas encore été
    // sollicité, on revient au primer : seul « Activer les alertes » ouvre le prompt natif.
    return 'refreshed';
  }

  /**
   * Révocation best-effort appelée tant que l'ancien JWT est encore valide. Le token ne sort
   * jamais des arguments chiffrés du client HTTP et le cache local est purgé même hors-ligne.
   */
  revokeRegistrationBeforeSignOut(
    unregisterDevice: (token: string) => Promise<void> = this.dependencies.unregisterDevice,
  ): Promise<void> {
    if (this.unregisterPromise !== null) return this.unregisterPromise;
    this.signingOut = true;
    const epoch = this.registrationEpoch;
    const pendingRegistration = this.registerPromise;
    // Snapshot immuable de l'ancienne session. Une reconnexion peut ensuite remplacer
    // `knownToken` ; le DELETE tardif ne doit jamais emprunter le token du compte suivant.
    const tokenAtSignOut = this.knownToken ?? this.registeredToken;
    let handedToLateContinuation = false;
    const operation = (async () => {
      if (pendingRegistration !== null) {
        const completed = await this.waitForRegistrationBeforeSignOut(pendingRegistration);
        if (!completed) {
          handedToLateContinuation = true;
          // Le cleanup global peut poursuivre la déconnexion, mais l'ordre reste POST → DELETE
          // si le POST se termine tard. Le callback fourni par le bridge capture l'ancien client.
          void pendingRegistration
            .catch((error: unknown) => {
              // Les adapters normaux sont convertis en outcome, mais ce garde-fou empêche une
              // exception inattendue de court-circuiter la révocation ou de devenir non gérée.
              this.log("fin d'inscription push pré-déconnexion inattendue", error);
            })
            .then(() => this.revokeToken(tokenAtSignOut, unregisterDevice))
            // Si un autre compte s'est reconnecté pendant le POST A tardif, l'ordre réseau
            // peut être POST B → POST A → DELETE A. Un dernier rebind B rétablit alors la
            // propriété finale du token, sans attendre la réconciliation TTL.
            .then(() => this.rebindCurrentContextAfterLateSignOut(epoch))
            .catch((error: unknown) => {
              // Dernier filet : une exception de listener/adaptateur ne devient jamais une
              // rejection globale non gérée pendant la destruction de la session.
              this.log('continuation push post-déconnexion inattendue', error);
            })
            .finally(() => {
              this.clearRegistrationCacheAfterSignOut(epoch);
              // Garder l'opération sentinelle jusqu'à la fin tardive : un second cleanup après
              // le timeout obtient le même no-op résolu au lieu d'émettre un second DELETE.
              if (this.unregisterPromise === operation) this.unregisterPromise = null;
            });
          return;
        }
      }
      await this.revokeToken(tokenAtSignOut, unregisterDevice);
    })().finally(() => {
      if (!handedToLateContinuation) this.clearRegistrationCacheAfterSignOut(epoch);
      if (!handedToLateContinuation && this.unregisterPromise === operation)
        this.unregisterPromise = null;
    });
    this.unregisterPromise = operation;
    return operation;
  }

  private async requestFromUserInternal(): Promise<PushConsentOutcome> {
    // Le geste explicite de l'utilisateur prime sur une lecture AsyncStorage éventuellement
    // lente : la préférence n'est pas une autorité de permission.
    void this.loadPreference();
    const current = await this.inspectPermission(true);
    if (current === 'granted' || current === 'ephemeral') return this.registerGrantedDevice(true);
    if (current === 'provisional' && this.state.canAskAgain === false) return 'blocked';
    if (current === 'blocked') return 'blocked';
    if (current === 'unsupported') return 'unsupported';
    if (current === 'unavailable') return 'unavailable';

    // Un canal doit précéder le prompt Android 13 ; on ne le crée qu'après le geste utilisateur.
    try {
      await this.ensureAndroidChannel();
    } catch (error) {
      this.fail('android_channel', error);
      return 'unavailable';
    }

    this.patch({ operation: 'requesting', failure: null });
    let permission: NativePushPermissionSnapshot;
    try {
      permission = await this.dependencies.requestPermission();
    } catch (error) {
      this.fail('permission_request', error);
      return 'unavailable';
    }

    const authorization = classifyPushAuthorization(this.dependencies.platform, permission);
    const androidChannelEnabled =
      this.dependencies.platform === 'android' && canRegisterPush(authorization)
        ? await this.readAndroidChannelState()
        : null;
    this.applyPermissionSnapshot(permission, authorization, androidChannelEnabled);
    if (canRegisterPush(authorization)) {
      const registered = await this.registerGrantedDevice(true);
      if (registered === 'unavailable') return registered;
      return authorization === 'provisional' ? 'provisional' : registered;
    }
    return authorization === 'blocked' ? 'blocked' : 'denied';
  }

  private async openSettingsInternal(): Promise<PushConsentOutcome> {
    this.patch({ operation: 'opening_settings', failure: null });
    try {
      await this.dependencies.openSystemSettings();
      this.patch({ operation: 'idle' });
      return 'settings_opened';
    } catch (error) {
      this.fail('settings', error);
      return 'unavailable';
    }
  }

  private inspectPermission(explicitRetry: boolean): Promise<PushAuthorization> {
    if (this.dependencies.platform === 'web') {
      this.patch({
        initialized: true,
        authorization: 'unsupported',
        canAskAgain: false,
        operation: 'idle',
        failure: null,
      });
      return Promise.resolve('unsupported');
    }
    if (this.checkPromise !== null) return this.checkPromise;

    this.patch({ operation: 'checking', ...(explicitRetry ? { failure: null } : {}) });
    const operation = this.dependencies
      .getPermission()
      .then(async (permission) => {
        const authorization = classifyPushAuthorization(this.dependencies.platform, permission);
        const androidChannelEnabled =
          this.dependencies.platform === 'android' && canRegisterPush(authorization)
            ? await this.readAndroidChannelState()
            : null;
        this.applyPermissionSnapshot(permission, authorization, androidChannelEnabled);
        return authorization;
      })
      .catch((error: unknown) => {
        this.fail('permission_check', error);
        return 'unavailable' as const;
      })
      .finally(() => {
        if (this.checkPromise === operation) this.checkPromise = null;
      });
    this.checkPromise = operation;
    return operation;
  }

  private registerGrantedDevice(
    explicitRetry: boolean,
    forceServerRebind = false,
  ): Promise<PushConsentOutcome> {
    if (!canRegisterPush(this.state.authorization)) return Promise.resolve('unavailable');
    if (this.state.androidChannelEnabled === false) return Promise.resolve('unavailable');
    if (this.signingOut) return Promise.resolve('unavailable');
    if (this.registrationContextWasConfigured && this.registrationContext === null) {
      return Promise.resolve('unavailable');
    }
    if (this.registerPromise !== null) return this.registerPromise;
    if (this.state.registration === 'failed' && !explicitRetry)
      return Promise.resolve('unavailable');

    const operation = this.registerGrantedDeviceInternal(forceServerRebind).finally(() => {
      if (this.registerPromise === operation) this.registerPromise = null;
    });
    this.registerPromise = operation;
    return operation;
  }

  private async registerGrantedDeviceInternal(
    forceServerRebind: boolean,
  ): Promise<PushConsentOutcome> {
    const epoch = this.registrationEpoch;
    this.visibleRegistrationEpoch = epoch;
    this.patch({ operation: 'registering', registration: 'registering', failure: null });
    try {
      await this.ensureAndroidChannel();
    } catch (error) {
      if (this.isStaleRegistration(epoch)) return 'unavailable';
      this.failRegistration('android_channel', error);
      return 'unavailable';
    }
    if (this.isStaleRegistration(epoch)) return 'unavailable';

    let token: string;
    try {
      token = await this.dependencies.getExpoPushToken();
    } catch (error) {
      if (this.isStaleRegistration(epoch)) return 'unavailable';
      this.failRegistration('token', error);
      return 'unavailable';
    }

    if (this.isStaleRegistration(epoch)) return 'unavailable';
    if (token.length === 0) {
      this.failRegistration('token', new Error('token Expo vide'));
      return 'unavailable';
    }
    this.knownToken = token;
    if (this.signingOut) return 'unavailable';
    // Un changement de session pendant l'obtention du token ne doit jamais enregistrer
    // le device sur le nouveau tenant avec une opération initiée par l'ancien.
    if (token === this.registeredToken && !forceServerRebind) {
      this.visibleRegistrationEpoch = null;
      this.patch({ operation: 'idle', registration: 'registered', failure: null });
      return 'registered';
    }

    try {
      await this.dependencies.registerDevice(
        token,
        this.dependencies.platform === 'ios' ? 'ios' : 'android',
      );
    } catch (error) {
      if (this.isStaleRegistration(epoch)) return 'unavailable';
      this.failRegistration('device_registration', error);
      return 'unavailable';
    }
    if (this.isStaleRegistration(epoch)) return 'unavailable';
    this.registeredToken = token;
    this.registeredAtMs = this.dependencies.now();
    this.registrationFailureCount = 0;
    this.nextAutomaticRetryAtMs = 0;
    this.visibleRegistrationEpoch = null;
    this.patch({ operation: 'idle', registration: 'registered', failure: null });
    return 'registered';
  }

  private ensureAndroidChannel(): Promise<void> {
    if (this.dependencies.platform !== 'android') return Promise.resolve();
    if (this.channelReady) return Promise.resolve();
    if (this.channelPromise !== null) return this.channelPromise;
    const operation = this.dependencies
      .ensureAndroidChannel()
      .then(() => {
        this.channelReady = true;
      })
      .finally(() => {
        if (this.channelPromise === operation) this.channelPromise = null;
      });
    this.channelPromise = operation;
    return operation;
  }

  private loadPreference(): Promise<void> {
    if (this.preferencePromise !== null) return this.preferencePromise;
    const operation = this.dependencies.preferenceStore
      .readDismissed()
      .then((dismissed) => {
        if (dismissed) this.patch({ preference: 'dismissed' });
      })
      .catch((error: unknown) => {
        // Métadonnée UX uniquement : une panne storage ne bloque ni le fil ni le push natif.
        this.log('impossible de lire la préférence de consentement', error);
      });
    this.preferencePromise = operation;
    return operation;
  }

  private fail(stage: PushFailureStage, error: unknown): void {
    this.log(`échec ${stage}`, error);
    this.patch({
      initialized: true,
      authorization: 'unavailable',
      operation: 'idle',
      failure: stage,
    });
  }

  private failRegistration(stage: PushFailureStage, error: unknown): void {
    this.log(`échec ${stage}`, error);
    this.visibleRegistrationEpoch = null;
    this.registrationFailureCount += 1;
    const delay = Math.min(
      REGISTRATION_RETRY_BASE_MS * 2 ** Math.max(0, this.registrationFailureCount - 1),
      REGISTRATION_RETRY_MAX_MS,
    );
    this.nextAutomaticRetryAtMs = this.dependencies.now() + delay;
    this.patch({ operation: 'idle', registration: 'failed', failure: stage });
  }

  private async reconcileGrantedRegistration(): Promise<void> {
    if (this.state.registration === 'idle') {
      await this.registerGrantedDevice(false);
      return;
    }
    if (this.state.registration === 'failed') {
      if (this.dependencies.now() >= this.nextAutomaticRetryAtMs)
        await this.registerGrantedDevice(true);
      return;
    }
    if (
      this.state.registration === 'registered' &&
      this.registeredAtMs !== null &&
      this.dependencies.now() - this.registeredAtMs >= REGISTRATION_RECONCILE_MS
    ) {
      await this.registerGrantedDevice(true, true);
    }
  }

  private async readAndroidChannelState(): Promise<boolean | null> {
    try {
      const enabled = await this.dependencies.getAndroidChannelEnabled();
      // null au premier boot laisse channelReady=false et force sa création. Juste après
      // setNotificationChannelAsync, certains OEM le rendent visible avec retard : conserver
      // alors channelReady=true évite une seconde création avant le token.
      if (enabled !== null) this.channelReady = true;
      return enabled;
    } catch (error) {
      // Une lecture OEM défaillante ne doit pas désactiver un push par ailleurs autorisé.
      this.log('lecture du canal Android indisponible', error);
      return null;
    }
  }

  private applyPermissionSnapshot(
    permission: NativePushPermissionSnapshot,
    authorization: PushAuthorization,
    androidChannelEnabled: boolean | null,
  ): void {
    const becameRegisterable =
      !canRegisterPush(this.state.authorization) && canRegisterPush(authorization);
    if (becameRegisterable) {
      // Une transition refusé → autorisé force un POST idempotent, même si le token est inchangé.
      this.registeredToken = null;
      this.registeredAtMs = null;
    }
    this.patch({
      initialized: true,
      authorization,
      canAskAgain: permission.canAskAgain,
      androidChannelEnabled,
      operation: 'idle',
      ...(becameRegisterable ? { registration: 'idle' as const } : {}),
      failure: null,
    });
  }

  private async revokeToken(
    token: string | null,
    unregisterDevice: (token: string) => Promise<void>,
  ): Promise<void> {
    if (token === null) return;
    try {
      await unregisterDevice(token);
    } catch (error) {
      this.log('révocation push pré-déconnexion indisponible', error);
    }
  }

  private async rebindCurrentContextAfterLateSignOut(signOutEpoch: number): Promise<void> {
    if (!this.canRebindCurrentContext(signOutEpoch)) return;
    const targetEpoch = this.registrationEpoch;
    const targetContext = this.registrationContext;

    // Une Promise B peut encore attendre sa réponse alors que le serveur a déjà appliqué POST B.
    // La dédupliquer ici serait incorrect : POST A a pu gagner ensuite, puis DELETE A vider le
    // binding. On attend donc la réponse B, puis on émet *toujours* une requête B entièrement neuve.
    const currentRegistration = this.registerPromise;
    if (currentRegistration !== null) await currentRegistration;
    if (
      !this.canRebindCurrentContext(signOutEpoch) ||
      targetEpoch !== this.registrationEpoch ||
      targetContext !== this.registrationContext
    ) {
      return;
    }

    this.registeredToken = null;
    this.registeredAtMs = null;
    this.patch({ operation: 'idle', registration: 'idle', failure: null });
    await this.registerGrantedDevice(true, true);
  }

  private canRebindCurrentContext(signOutEpoch: number): boolean {
    return (
      signOutEpoch !== this.registrationEpoch &&
      !this.signingOut &&
      this.registrationContext !== null &&
      canRegisterPush(this.state.authorization)
    );
  }

  private async waitForRegistrationBeforeSignOut(
    registration: Promise<PushConsentOutcome>,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), SIGN_OUT_REGISTRATION_WAIT_MS);
    });
    const completed = registration.then(
      () => true as const,
      (error: unknown) => {
        this.log("attente d'inscription push pré-déconnexion inattendue", error);
        return true as const;
      },
    );
    const result = await Promise.race([completed, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  private clearRegistrationCacheAfterSignOut(epoch: number): void {
    // Après un timeout, l'AuthGate peut déjà être démonté (epoch suivant, contexte null). En
    // revanche une vraie reconnexion remet signingOut=false et ne doit jamais être effacée.
    if (!this.signingOut) return;
    if (epoch !== this.registrationEpoch && this.registrationContext !== null) return;
    this.registeredToken = null;
    this.knownToken = null;
    this.registeredAtMs = null;
    this.registrationFailureCount = 0;
    this.nextAutomaticRetryAtMs = 0;
    this.patch({ operation: 'idle', registration: 'idle', failure: null });
  }

  private isStaleRegistration(epoch: number): boolean {
    if (epoch === this.registrationEpoch) return false;
    this.abandonStaleRegistration(epoch);
    return true;
  }

  /** Une ancienne opération ne peut normaliser que le snapshot qu'elle avait elle-même publié. */
  private abandonStaleRegistration(epoch: number): void {
    if (this.visibleRegistrationEpoch !== epoch) return;
    this.visibleRegistrationEpoch = null;
    this.patch({
      operation: this.state.operation === 'registering' ? 'idle' : this.state.operation,
      registration: 'idle',
      failure: null,
    });
  }

  private log(message: string, error?: unknown): void {
    this.dependencies.log?.(message, error);
  }

  private patch(next: Partial<PushPermissionState>): void {
    const state = { ...this.state, ...next };
    if (
      state.initialized === this.state.initialized &&
      state.authorization === this.state.authorization &&
      state.operation === this.state.operation &&
      state.registration === this.state.registration &&
      state.preference === this.state.preference &&
      state.canAskAgain === this.state.canAskAgain &&
      state.androidChannelEnabled === this.state.androidChannelEnabled &&
      state.failure === this.state.failure
    ) {
      return;
    }
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

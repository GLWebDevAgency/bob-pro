/**
 * Autorité locale durable du binding push v2.
 *
 * Le KV concret DOIT être chiffré par le Keychain/Keystore. Ce module reste pur/testable : il
 * garantit le write-ahead de chaque génération et tombstone avant de rendre une capacité réseau.
 */

export const PUSH_INSTALLATION_STATE_KEY = 'bob.push.installation.v1';
export const PUSH_TOMBSTONE_MIN_RETENTION_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_BINDING_GENERATION = 2_147_483_647;
const MAX_PENDING_REVOCATIONS = 4;
const REPLAY_FAILURE_BASE_MS = 15_000;
const REPLAY_FAILURE_MAX_MS = 6 * 60 * 60 * 1_000;
const REPLAY_UNPROVEN_SUCCESS_DELAYS_MS = [
  15_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_HEX = /^[0-9a-f]{64}$/u;
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,64}\]$/u;

export interface PushInstallationKv {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PushInstallationGenerators {
  uuidV4(): string;
  secretHex(): string;
  sha256Hex(value: string): Promise<string>;
}

export interface PushBindingCandidate {
  readonly installationId: string;
  readonly revocationSecret: string;
  readonly ownerKey: string;
  readonly expoPushToken: string;
  readonly expoPushTokenFingerprint: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly confirmed: boolean;
}

export interface PushRevocationCapability {
  readonly installationId: string;
  readonly throughGeneration: number;
  readonly revocationSecret: string;
}

/** Référence sans secret ni token permettant de neutraliser uniquement le binding observé. */
export interface PushActiveBindingFence {
  readonly installationId: string;
  readonly ownerKey: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
}

interface ActiveBindingV1 {
  ownerKey: string;
  expoPushTokenFingerprint: string;
  bindingId: string;
  generation: number;
  status: 'prepared' | 'confirmed';
}

interface PendingRevocationV1 {
  installationId: string;
  revocationSecret: string;
  throughGeneration: number;
  createdAtMs: number;
  failureAttempt: number;
  unprovenAcceptedAttempt: number;
  nextAttemptAtMs: number;
}

export interface PushInstallationStateV1 {
  version: 1;
  installationId: string;
  revocationSecret: string;
  generation: number;
  active: ActiveBindingV1 | null;
  pendingRevocations: PendingRevocationV1[];
}

export interface PushInstallationLoadResult {
  readonly state: PushInstallationStateV1;
  readonly recoveredFromCorruption: boolean;
  readonly quarantineKey: string | null;
}

export type PushPayloadMatch = 'matched' | 'not_ready' | 'stale' | 'invalid';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isGeneration(value: unknown, allowZero = false): value is number {
  return (
    Number.isInteger(value) &&
    typeof value === 'number' &&
    value >= (allowZero ? 0 : 1) &&
    value <= MAX_BINDING_GENERATION
  );
}

function parsePayloadGeneration(value: unknown): number | null {
  // Expo data values are strings on the wire. Requiring the canonical decimal form prevents
  // coercion surprises (`01`, exponent notation, floats) at the capability boundary.
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/u.test(value)) return null;
  const parsed = Number(value);
  return isGeneration(parsed) ? parsed : null;
}

function isSafeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeActive(value: unknown): ActiveBindingV1 | null | undefined {
  if (value === null) return null;
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'ownerKey',
      'expoPushTokenFingerprint',
      'bindingId',
      'generation',
      'status',
    ])
  )
    return undefined;
  if (
    typeof value.ownerKey !== 'string' ||
    value.ownerKey.length < 1 ||
    value.ownerKey.length > 512 ||
    typeof value.expoPushTokenFingerprint !== 'string' ||
    !SECRET_HEX.test(value.expoPushTokenFingerprint) ||
    typeof value.bindingId !== 'string' ||
    !UUID_V4.test(value.bindingId) ||
    !isGeneration(value.generation) ||
    (value.status !== 'prepared' && value.status !== 'confirmed')
  )
    return undefined;
  return {
    ownerKey: value.ownerKey,
    expoPushTokenFingerprint: value.expoPushTokenFingerprint,
    bindingId: value.bindingId,
    generation: value.generation,
    status: value.status,
  };
}

function decodePending(value: unknown): PendingRevocationV1 | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'installationId',
      'revocationSecret',
      'throughGeneration',
      'createdAtMs',
      'failureAttempt',
      'unprovenAcceptedAttempt',
      'nextAttemptAtMs',
    ])
  )
    return null;
  if (
    typeof value.installationId !== 'string' ||
    !UUID_V4.test(value.installationId) ||
    typeof value.revocationSecret !== 'string' ||
    !SECRET_HEX.test(value.revocationSecret) ||
    !isGeneration(value.throughGeneration) ||
    !isSafeTime(value.createdAtMs) ||
    !isGeneration(value.failureAttempt, true) ||
    !isGeneration(value.unprovenAcceptedAttempt, true) ||
    !isSafeTime(value.nextAttemptAtMs)
  )
    return null;
  return {
    installationId: value.installationId,
    revocationSecret: value.revocationSecret,
    throughGeneration: value.throughGeneration,
    createdAtMs: value.createdAtMs,
    failureAttempt: value.failureAttempt,
    unprovenAcceptedAttempt: value.unprovenAcceptedAttempt,
    nextAttemptAtMs: value.nextAttemptAtMs,
  };
}

export function decodePushInstallationState(raw: string): PushInstallationStateV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'version',
      'installationId',
      'revocationSecret',
      'generation',
      'active',
      'pendingRevocations',
    ])
  )
    return null;
  const active = decodeActive(value.active);
  if (
    value.version !== 1 ||
    typeof value.installationId !== 'string' ||
    !UUID_V4.test(value.installationId) ||
    typeof value.revocationSecret !== 'string' ||
    !SECRET_HEX.test(value.revocationSecret) ||
    !isGeneration(value.generation, true) ||
    active === undefined ||
    !Array.isArray(value.pendingRevocations) ||
    value.pendingRevocations.length > MAX_PENDING_REVOCATIONS
  )
    return null;
  const pending = value.pendingRevocations.map(decodePending);
  if (pending.some((entry) => entry === null)) return null;
  const state: PushInstallationStateV1 = {
    version: 1,
    installationId: value.installationId,
    revocationSecret: value.revocationSecret,
    generation: value.generation,
    active,
    pendingRevocations: pending as PendingRevocationV1[],
  };
  if (active !== null && active.generation > state.generation) return null;
  const identities = new Set<string>();
  for (const entry of state.pendingRevocations) {
    if (identities.has(entry.installationId)) return null;
    identities.add(entry.installationId);
    if (
      entry.installationId === state.installationId &&
      entry.revocationSecret !== state.revocationSecret
    )
      return null;
  }
  return state;
}

function cloneState(state: PushInstallationStateV1): PushInstallationStateV1 {
  return {
    ...state,
    active: state.active === null ? null : { ...state.active },
    pendingRevocations: state.pendingRevocations.map((entry) => ({ ...entry })),
  };
}

function toCandidate(
  state: PushInstallationStateV1,
  expoPushToken: string,
): PushBindingCandidate | null {
  const active = state.active;
  if (active === null) return null;
  return {
    installationId: state.installationId,
    revocationSecret: state.revocationSecret,
    ownerKey: active.ownerKey,
    expoPushToken,
    expoPushTokenFingerprint: active.expoPushTokenFingerprint,
    bindingId: active.bindingId,
    bindingGeneration: active.generation,
    confirmed: active.status === 'confirmed',
  };
}

function validateGenerators(generators: PushInstallationGenerators): void {
  // Validation effective à chaque création : cette fonction borne seulement l'API injectée.
  if (
    typeof generators.uuidV4 !== 'function' ||
    typeof generators.secretHex !== 'function' ||
    typeof generators.sha256Hex !== 'function'
  ) {
    throw new Error('Générateurs push invalides.');
  }
}

export class PushInstallationStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly kv: PushInstallationKv,
    private readonly generators: PushInstallationGenerators,
    private readonly now: () => number,
    private readonly stateKey = PUSH_INSTALLATION_STATE_KEY,
  ) {
    validateGenerators(generators);
  }

  load(): Promise<PushInstallationLoadResult> {
    return this.exclusive(() => this.loadInternal());
  }

  snapshot(): Promise<PushInstallationStateV1> {
    return this.exclusive(async () => cloneState((await this.loadInternal()).state));
  }

  prepareBinding(ownerKey: string, expoPushToken: string): Promise<PushBindingCandidate> {
    if (ownerKey.length < 1 || ownerKey.length > 512)
      return Promise.reject(new Error('ownerKey push invalide.'));
    if (!EXPO_TOKEN.test(expoPushToken))
      return Promise.reject(new Error('Token Expo push invalide.'));
    return this.exclusive(async () => {
      const loaded = await this.loadInternal();
      const state = loaded.state;
      const tokenFingerprint = await this.fingerprint(expoPushToken);
      if (
        state.active?.ownerKey === ownerKey &&
        state.active.expoPushTokenFingerprint === tokenFingerprint
      )
        return toCandidate(state, expoPushToken)!;

      const now = this.safeNow();
      let pending = state.pendingRevocations;
      if (state.active !== null) {
        pending = this.upsertPending(
          pending,
          state.installationId,
          state.revocationSecret,
          state.active.generation,
          now,
        );
      }
      if (state.generation >= MAX_BINDING_GENERATION) {
        throw new Error('Génération push épuisée : rotation d’installation requise.');
      }
      const bindingId = this.newUuid();
      const next: PushInstallationStateV1 = {
        ...state,
        generation: state.generation + 1,
        active: {
          ownerKey,
          expoPushTokenFingerprint: tokenFingerprint,
          bindingId,
          generation: state.generation + 1,
          status: 'prepared',
        },
        pendingRevocations: pending,
      };
      await this.persist(next);
      return toCandidate(next, expoPushToken)!;
    });
  }

  confirmBinding(candidate: PushBindingCandidate): Promise<boolean> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      const tokenFingerprint = await this.fingerprint(candidate.expoPushToken);
      if (!this.isExactActive(state, candidate, tokenFingerprint)) return false;
      const next: PushInstallationStateV1 = {
        ...state,
        active: { ...state.active!, status: 'confirmed' },
        // Un bind serveur G>N est la preuve qui permet enfin de compacter le tombstone courant :
        // tout POST <=N est désormais rejeté par le high-water serveur.
        pendingRevocations: state.pendingRevocations.filter(
          (entry) =>
            !(
              entry.installationId === state.installationId &&
              entry.throughGeneration < candidate.bindingGeneration
            ),
        ),
      };
      await this.persist(next);
      return true;
    });
  }

  prepareRevocation(ownerKey: string | null = null): Promise<PushRevocationCapability | null> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      const activeMatches =
        state.active !== null && (ownerKey === null || state.active.ownerKey === ownerKey);
      const currentPending = state.pendingRevocations.find(
        (entry) => entry.installationId === state.installationId,
      );
      if (!activeMatches) {
        return currentPending === undefined ? null : this.toRevocation(currentPending);
      }
      const now = this.safeNow();
      const pending = this.upsertPending(
        state.pendingRevocations,
        state.installationId,
        state.revocationSecret,
        state.active!.generation,
        now,
      );
      const next: PushInstallationStateV1 = { ...state, active: null, pendingRevocations: pending };
      // Write-ahead obligatoire : aucun appel réseau ni destruction de JWT avant ce commit local.
      await this.persist(next);
      return this.toRevocation(
        pending.find((entry) => entry.installationId === state.installationId)!,
      );
    });
  }

  /** Révoque seulement la candidate exacte : protège une candidate plus récente du même owner. */
  prepareRevocationIfExact(
    candidate: PushBindingCandidate,
  ): Promise<PushRevocationCapability | null> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      const tokenFingerprint = await this.fingerprint(candidate.expoPushToken);
      if (!this.isExactActive(state, candidate, tokenFingerprint)) return null;
      const now = this.safeNow();
      const pending = this.upsertPending(
        state.pendingRevocations,
        state.installationId,
        state.revocationSecret,
        state.active!.generation,
        now,
      );
      const next: PushInstallationStateV1 = { ...state, active: null, pendingRevocations: pending };
      await this.persist(next);
      return this.toRevocation(
        pending.find((entry) => entry.installationId === state.installationId)!,
      );
    });
  }

  /**
   * Variante utilisée par les réconciliations de cycle de vie : entre le snapshot et cette
   * écriture, un autre owner peut avoir publié une nouvelle candidate. La fence complète évite
   * qu'un callback ancien révoque ce binding plus récent, y compris lors d'un ABA même owner.
   */
  prepareRevocationIfActiveFence(
    fence: PushActiveBindingFence,
  ): Promise<PushRevocationCapability | null> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      if (
        state.installationId !== fence.installationId ||
        state.active === null ||
        state.active.ownerKey !== fence.ownerKey ||
        state.active.bindingId !== fence.bindingId ||
        state.active.generation !== fence.bindingGeneration
      )
        return null;
      const now = this.safeNow();
      const pending = this.upsertPending(
        state.pendingRevocations,
        state.installationId,
        state.revocationSecret,
        state.active.generation,
        now,
      );
      const next: PushInstallationStateV1 = { ...state, active: null, pendingRevocations: pending };
      await this.persist(next);
      return this.toRevocation(
        pending.find((entry) => entry.installationId === state.installationId)!,
      );
    });
  }

  /** Rotation de récupération après `status=superseded`, sans perdre le tombstone précédent. */
  rotateAfterSuperseded(candidate: PushBindingCandidate): Promise<PushBindingCandidate | null> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      const tokenFingerprint = await this.fingerprint(candidate.expoPushToken);
      if (!this.isExactActive(state, candidate, tokenFingerprint)) return null;
      const next: PushInstallationStateV1 = {
        version: 1,
        installationId: this.newUuid(),
        revocationSecret: this.newSecret(),
        generation: 1,
        active: {
          ownerKey: candidate.ownerKey,
          expoPushTokenFingerprint: tokenFingerprint,
          bindingId: this.newUuid(),
          generation: 1,
          status: 'prepared',
        },
        // `superseded` prouve déjà que le serveur connaît un high-water >= G. Créer ici une
        // révocation G pourrait neutraliser un binding légitime concurrent à égalité (DoS).
        // Seuls les tombstones réellement write-ahead avant cette réponse sont conservés.
        pendingRevocations: state.pendingRevocations,
      };
      await this.persist(next);
      return toCandidate(next, candidate.expoPushToken);
    });
  }

  dueRevocations(force = false): Promise<PushRevocationCapability[]> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      const now = this.safeNow();
      return state.pendingRevocations
        .filter((entry) => force || entry.nextAttemptAtMs <= now)
        .map((entry) => this.toRevocation(entry));
    });
  }

  nextReplayDelayMs(): Promise<number | null> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      if (state.pendingRevocations.length === 0) return null;
      const nextAt = Math.min(...state.pendingRevocations.map((entry) => entry.nextAttemptAtMs));
      return Math.max(0, nextAt - this.safeNow());
    });
  }

  /** Un 202 public ne supprime JAMAIS le tombstone; il ne fait que planifier son prochain replay. */
  recordReplayAttempt(capability: PushRevocationCapability, succeeded: boolean): Promise<boolean> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      const index = state.pendingRevocations.findIndex(
        (entry) =>
          entry.installationId === capability.installationId &&
          entry.revocationSecret === capability.revocationSecret &&
          entry.throughGeneration === capability.throughGeneration,
      );
      if (index < 0) return false;
      const entry = state.pendingRevocations[index]!;
      const failureAttempt = succeeded
        ? 0
        : Math.min(entry.failureAttempt + 1, MAX_BINDING_GENERATION);
      const unprovenAcceptedAttempt = succeeded
        ? Math.min(entry.unprovenAcceptedAttempt + 1, MAX_BINDING_GENERATION)
        : 0;
      const exponential = REPLAY_FAILURE_BASE_MS * 2 ** Math.min(failureAttempt - 1, 20);
      // Le 202 public est volontairement sans oracle et ne prouve donc PAS qu'un fence existait.
      // Rejouer rapidement ferme la fenêtre absent→202→POST retardé, puis ralentit jusqu'à 24 h.
      const delay = succeeded
        ? REPLAY_UNPROVEN_SUCCESS_DELAYS_MS[
            Math.min(unprovenAcceptedAttempt - 1, REPLAY_UNPROVEN_SUCCESS_DELAYS_MS.length - 1)
          ]!
        : Math.min(exponential, REPLAY_FAILURE_MAX_MS);
      const pendingRevocations = state.pendingRevocations.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? {
              ...candidate,
              failureAttempt,
              unprovenAcceptedAttempt,
              nextAttemptAtMs: this.safeNow() + delay,
            }
          : candidate,
      );
      await this.persist({ ...state, pendingRevocations });
      return true;
    });
  }

  /**
   * Une révocation authentifiée `accepted=true` est une preuve de fence durable côté serveur :
   * contrairement au 202 public, elle autorise donc la suppression locale de la capacité.
   */
  confirmAuthenticatedRevocation(capability: PushRevocationCapability): Promise<boolean> {
    return this.exclusive(async () => {
      const state = (await this.loadInternal()).state;
      const pendingRevocations = state.pendingRevocations.filter(
        (entry) =>
          !(
            entry.installationId === capability.installationId &&
            entry.revocationSecret === capability.revocationSecret &&
            entry.throughGeneration === capability.throughGeneration
          ),
      );
      if (pendingRevocations.length === state.pendingRevocations.length) return false;
      await this.persist({ ...state, pendingRevocations });
      return true;
    });
  }

  matchesPayload(payload: unknown): Promise<PushPayloadMatch> {
    return this.exclusive(async () => {
      if (
        !isPlainObject(payload) ||
        !hasExactKeys(payload, [
          'pushContract',
          'route',
          'recipientBindingId',
          'recipientBindingGeneration',
        ])
      )
        return 'invalid';
      const generation = parsePayloadGeneration(payload.recipientBindingGeneration);
      if (
        payload.pushContract !== '2' ||
        payload.route !== '/notifications' ||
        typeof payload.recipientBindingId !== 'string' ||
        !UUID_V4.test(payload.recipientBindingId) ||
        generation === null
      )
        return 'invalid';
      const state = (await this.loadInternal()).state;
      if (state.active === null) return 'stale';
      const exact =
        state.active.bindingId === payload.recipientBindingId &&
        state.active.generation === generation;
      if (!exact) return 'stale';
      return state.active.status === 'confirmed' ? 'matched' : 'not_ready';
    });
  }

  private async loadInternal(): Promise<PushInstallationLoadResult> {
    const raw = await this.kv.getItem(this.stateKey);
    if (raw === null) {
      const state = this.newState();
      await this.persist(state);
      return { state: cloneState(state), recoveredFromCorruption: false, quarantineKey: null };
    }
    const decoded = decodePushInstallationState(raw);
    if (decoded !== null) {
      return { state: cloneState(decoded), recoveredFromCorruption: false, quarantineKey: null };
    }

    // Jamais de purge silencieuse : la preuve brute est conservée avant la rotation fail-closed.
    const quarantineKey = `${this.stateKey}.quarantine.${this.safeNow()}.${this.newUuid()}`;
    await this.kv.setItem(quarantineKey, raw);
    const state = this.newState();
    await this.persist(state);
    return { state: cloneState(state), recoveredFromCorruption: true, quarantineKey };
  }

  private newState(): PushInstallationStateV1 {
    return {
      version: 1,
      installationId: this.newUuid(),
      revocationSecret: this.newSecret(),
      generation: 0,
      active: null,
      pendingRevocations: [],
    };
  }

  private async persist(state: PushInstallationStateV1): Promise<void> {
    await this.kv.setItem(this.stateKey, JSON.stringify(state));
  }

  private upsertPending(
    pending: PendingRevocationV1[],
    installationId: string,
    revocationSecret: string,
    throughGeneration: number,
    now: number,
  ): PendingRevocationV1[] {
    const existing = pending.find((entry) => entry.installationId === installationId);
    if (existing === undefined && pending.length >= MAX_PENDING_REVOCATIONS) {
      // Ne jamais supprimer silencieusement une capacité non prouvée. La désactivation du push
      // est préférable à une croissance secrète infinie ou à la réactivation d'un ancien compte.
      throw new Error('Trop de révocations push non confirmées; synchronisation serveur requise.');
    }
    const compacted: PendingRevocationV1 =
      existing === undefined
        ? {
            installationId,
            revocationSecret,
            throughGeneration,
            createdAtMs: now,
            failureAttempt: 0,
            unprovenAcceptedAttempt: 0,
            nextAttemptAtMs: now,
          }
        : {
            ...existing,
            revocationSecret,
            throughGeneration: Math.max(existing.throughGeneration, throughGeneration),
            nextAttemptAtMs: Math.min(existing.nextAttemptAtMs, now),
          };
    return [...pending.filter((entry) => entry.installationId !== installationId), compacted];
  }

  private toRevocation(entry: PendingRevocationV1): PushRevocationCapability {
    return {
      installationId: entry.installationId,
      throughGeneration: entry.throughGeneration,
      revocationSecret: entry.revocationSecret,
    };
  }

  private isExactActive(
    state: PushInstallationStateV1,
    candidate: PushBindingCandidate,
    tokenFingerprint: string,
  ): boolean {
    return (
      state.installationId === candidate.installationId &&
      state.revocationSecret === candidate.revocationSecret &&
      state.active?.ownerKey === candidate.ownerKey &&
      candidate.expoPushTokenFingerprint === tokenFingerprint &&
      state.active.expoPushTokenFingerprint === tokenFingerprint &&
      state.active.bindingId === candidate.bindingId &&
      state.active.generation === candidate.bindingGeneration
    );
  }

  private newUuid(): string {
    const value = this.generators.uuidV4().toLowerCase();
    if (!UUID_V4.test(value))
      throw new Error('Le générateur UUID push a produit une valeur invalide.');
    return value;
  }

  private newSecret(): string {
    const value = this.generators.secretHex().toLowerCase();
    if (!SECRET_HEX.test(value))
      throw new Error('Le générateur de secret push doit produire 256 bits.');
    return value;
  }

  private async fingerprint(expoPushToken: string): Promise<string> {
    const value = (await this.generators.sha256Hex(expoPushToken)).toLowerCase();
    if (!SECRET_HEX.test(value))
      throw new Error('Le fingerprint du token push doit être un SHA-256.');
    return value;
  }

  private safeNow(): number {
    const value = this.now();
    if (!isSafeTime(value)) throw new Error('Horloge push invalide.');
    return value;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

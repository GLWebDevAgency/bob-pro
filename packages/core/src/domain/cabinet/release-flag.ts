import { AggregateRoot } from '../../shared-kernel/aggregate';
import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';

export const RELEASE_FLAG_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type ReleaseFlagEnvironment = (typeof RELEASE_FLAG_ENVIRONMENTS)[number];

export const RELEASE_FLAG_SUBJECT_TYPES = ['user', 'cabinet'] as const;
export type ReleaseFlagSubjectType = (typeof RELEASE_FLAG_SUBJECT_TYPES)[number];

export interface ReleaseFlagSubjectOverride {
  subjectType: ReleaseFlagSubjectType;
  subjectId: string;
  enabled: boolean;
}

export interface ReleaseFlagSnapshot {
  id: string;
  key: string;
  environment: ReleaseFlagEnvironment;
  globallyEnabled: boolean;
  killSwitchActive: boolean;
  subjectOverrides: ReleaseFlagSubjectOverride[];
  version: number;
  createdAt: Instant;
  updatedAt: Instant;
  updatedByUserId: string;
}

export interface ReleaseFlagEvaluationContext {
  userId?: string;
  cabinetId?: string;
}

export type ReleaseFlagDecisionSource = 'kill_switch' | 'user' | 'cabinet' | 'global';

export interface ReleaseFlagDecision {
  enabled: boolean;
  source: ReleaseFlagDecisionSource;
  flagVersion: number;
}

function required(value: string, field: string): DomainResult<string> {
  const normalized = value.trim();
  return normalized.length > 0
    ? ok(normalized)
    : err({ code: 'VALIDATION', field, message: `${field} is required.` });
}

function normalizeKey(raw: string): DomainResult<string> {
  const key = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(key) || key.length > 80) {
    return err({ code: 'VALIDATION', field: 'key', message: 'Invalid release flag key.' });
  }
  return ok(key);
}

export class ReleaseFlag extends AggregateRoot<string> {
  private _globallyEnabled: boolean;
  private _killSwitchActive: boolean;
  private _subjectOverrides: ReleaseFlagSubjectOverride[];
  private _version: number;
  private _updatedAt: Instant;
  private _updatedByUserId: string;

  private constructor(private readonly base: {
    id: string;
    key: string;
    environment: ReleaseFlagEnvironment;
    createdAt: Instant;
  }, state: {
    globallyEnabled: boolean;
    killSwitchActive: boolean;
    subjectOverrides: ReleaseFlagSubjectOverride[];
    version: number;
    updatedAt: Instant;
    updatedByUserId: string;
  }) {
    super(base.id);
    this._globallyEnabled = state.globallyEnabled;
    this._killSwitchActive = state.killSwitchActive;
    this._subjectOverrides = state.subjectOverrides.map((override) => ({ ...override }));
    this._version = state.version;
    this._updatedAt = state.updatedAt;
    this._updatedByUserId = state.updatedByUserId;
  }

  static create(input: {
    id: string;
    key: string;
    environment: ReleaseFlagEnvironment;
    createdAt: Instant;
    createdByUserId: string;
  }): DomainResult<ReleaseFlag> {
    const id = required(input.id, 'releaseFlagId');
    if (!id.ok) return id;
    const key = normalizeKey(input.key);
    if (!key.ok) return key;
    if (!RELEASE_FLAG_ENVIRONMENTS.includes(input.environment)) {
      return err({ code: 'VALIDATION', field: 'environment', message: 'Unknown release flag environment.' });
    }
    const createdByUserId = required(input.createdByUserId, 'createdByUserId');
    if (!createdByUserId.ok) return createdByUserId;
    const flag = new ReleaseFlag({
      id: id.value,
      key: key.value,
      environment: input.environment,
      createdAt: input.createdAt,
    }, {
      globallyEnabled: false,
      killSwitchActive: false,
      subjectOverrides: [],
      version: 1,
      updatedAt: input.createdAt,
      updatedByUserId: createdByUserId.value,
    });
    flag.record({ type: 'ReleaseFlagCreated', occurredAt: input.createdAt, version: flag._version });
    return ok(flag);
  }

  static rehydrate(snapshot: ReleaseFlagSnapshot): ReleaseFlag {
    return new ReleaseFlag({
      id: snapshot.id,
      key: snapshot.key,
      environment: snapshot.environment,
      createdAt: snapshot.createdAt,
    }, {
      globallyEnabled: snapshot.globallyEnabled,
      killSwitchActive: snapshot.killSwitchActive,
      subjectOverrides: snapshot.subjectOverrides,
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
      updatedByUserId: snapshot.updatedByUserId,
    });
  }

  get key(): string {
    return this.base.key;
  }

  get environment(): ReleaseFlagEnvironment {
    return this.base.environment;
  }

  get version(): number {
    return this._version;
  }

  evaluate(context: ReleaseFlagEvaluationContext): ReleaseFlagDecision {
    if (this._killSwitchActive) {
      return { enabled: false, source: 'kill_switch', flagVersion: this._version };
    }
    if (context.userId) {
      const user = this._subjectOverrides.find(
        (override) => override.subjectType === 'user' && override.subjectId === context.userId,
      );
      if (user) return { enabled: user.enabled, source: 'user', flagVersion: this._version };
    }
    if (context.cabinetId) {
      const cabinet = this._subjectOverrides.find(
        (override) => override.subjectType === 'cabinet' && override.subjectId === context.cabinetId,
      );
      if (cabinet) return { enabled: cabinet.enabled, source: 'cabinet', flagVersion: this._version };
    }
    return { enabled: this._globallyEnabled, source: 'global', flagVersion: this._version };
  }

  setGlobal(input: { enabled: boolean; actorUserId: string; changedAt: Instant }): DomainResult<void> {
    if (this._globallyEnabled === input.enabled) return ok(undefined);
    const actorUserId = required(input.actorUserId, 'actorUserId');
    if (!actorUserId.ok) return actorUserId;
    this._globallyEnabled = input.enabled;
    this.changed(input.changedAt, actorUserId.value, 'ReleaseFlagGlobalChanged');
    return ok(undefined);
  }

  setKillSwitch(input: { active: boolean; actorUserId: string; changedAt: Instant }): DomainResult<void> {
    if (this._killSwitchActive === input.active) return ok(undefined);
    const actorUserId = required(input.actorUserId, 'actorUserId');
    if (!actorUserId.ok) return actorUserId;
    this._killSwitchActive = input.active;
    this.changed(input.changedAt, actorUserId.value, 'ReleaseFlagKillSwitchChanged');
    return ok(undefined);
  }

  setSubjectOverride(input: {
    subjectType: ReleaseFlagSubjectType;
    subjectId: string;
    enabled: boolean;
    actorUserId: string;
    changedAt: Instant;
  }): DomainResult<void> {
    if (!RELEASE_FLAG_SUBJECT_TYPES.includes(input.subjectType)) {
      return err({ code: 'VALIDATION', field: 'subjectType', message: 'Unknown release flag subject.' });
    }
    const subjectId = required(input.subjectId, 'subjectId');
    if (!subjectId.ok) return subjectId;
    const actorUserId = required(input.actorUserId, 'actorUserId');
    if (!actorUserId.ok) return actorUserId;
    const index = this._subjectOverrides.findIndex(
      (override) => override.subjectType === input.subjectType && override.subjectId === subjectId.value,
    );
    if (index >= 0 && this._subjectOverrides[index]?.enabled === input.enabled) return ok(undefined);
    const override = { subjectType: input.subjectType, subjectId: subjectId.value, enabled: input.enabled };
    if (index >= 0) this._subjectOverrides[index] = override;
    else this._subjectOverrides.push(override);
    this.changed(input.changedAt, actorUserId.value, 'ReleaseFlagSubjectChanged');
    return ok(undefined);
  }

  removeSubjectOverride(input: {
    subjectType: ReleaseFlagSubjectType;
    subjectId: string;
    actorUserId: string;
    changedAt: Instant;
  }): DomainResult<void> {
    const next = this._subjectOverrides.filter(
      (override) => !(override.subjectType === input.subjectType && override.subjectId === input.subjectId),
    );
    if (next.length === this._subjectOverrides.length) return ok(undefined);
    const actorUserId = required(input.actorUserId, 'actorUserId');
    if (!actorUserId.ok) return actorUserId;
    this._subjectOverrides = next;
    this.changed(input.changedAt, actorUserId.value, 'ReleaseFlagSubjectRemoved');
    return ok(undefined);
  }

  private changed(at: Instant, actorUserId: string, eventType: string): void {
    this._version += 1;
    this._updatedAt = at;
    this._updatedByUserId = actorUserId;
    this.record({ type: eventType, occurredAt: at, version: this._version });
  }

  toSnapshot(): ReleaseFlagSnapshot {
    return {
      id: this.id,
      key: this.base.key,
      environment: this.base.environment,
      globallyEnabled: this._globallyEnabled,
      killSwitchActive: this._killSwitchActive,
      subjectOverrides: this._subjectOverrides.map((override) => ({ ...override })),
      version: this._version,
      createdAt: this.base.createdAt,
      updatedAt: this._updatedAt,
      updatedByUserId: this._updatedByUserId,
    };
  }
}

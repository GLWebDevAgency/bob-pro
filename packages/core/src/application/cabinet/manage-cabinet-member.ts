import { canManageCabinetRole, type CabinetRole } from '../../domain/cabinet/cabinet-permissions';
import { type Result } from '../../shared-kernel/result';
import { type CabinetRepository } from '../ports/cabinet-repository';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { type AppError, appDomain, appForbidden, appNotFound } from '../result';
import { abortCabinetOperation, runCabinetOperation } from './cabinet-operation';
import { cabinetMemberToView, type CabinetMemberView } from './cabinet-view';

interface ManageCabinetMemberDeps {
  cabinets: CabinetRepository;
  clock: ClockPort;
  uow: UnitOfWorkPort;
}

interface CabinetMemberMutationInput {
  cabinetId: string;
  actorUserId: string;
  memberId: string;
}

async function loadAuthorizedMember(
  deps: ManageCabinetMemberDeps,
  input: CabinetMemberMutationInput,
  nextRole?: CabinetRole,
) {
  const cabinet = await deps.cabinets.lockById(input.cabinetId);
  if (!cabinet) abortCabinetOperation(appNotFound('cabinet', input.cabinetId));
  const actor = cabinet.activeMemberForUser(input.actorUserId);
  // Parité RLS + anti-oracle : l'autorisation de l'acteur se joue AVANT l'existence de la cible.
  // Un non-membre (ou un cabinet suspendu, invisible sous cabinet_select en prod) reçoit le même
  // 404 cabinet qu'un id inconnu et ne peut pas sonder les memberIds.
  if (!actor || cabinet.status !== 'active') {
    abortCabinetOperation(appNotFound('cabinet', input.cabinetId));
  }
  const target = cabinet.memberById(input.memberId);
  if (!target) abortCabinetOperation(appNotFound('cabinet_member', input.memberId));
  if (
    !canManageCabinetRole(actor.role, target.role)
    || (nextRole && !canManageCabinetRole(actor.role, nextRole))
  ) {
    abortCabinetOperation(appForbidden('cabinet.members.manage'));
  }
  return { cabinet, target };
}

export class ChangeCabinetMemberRole {
  constructor(private readonly deps: ManageCabinetMemberDeps) {}

  execute(input: CabinetMemberMutationInput & { role: CabinetRole }): Promise<Result<CabinetMemberView, AppError>> {
    return runCabinetOperation(this.deps.uow, async () => {
      const { cabinet } = await loadAuthorizedMember(this.deps, input, input.role);
      const expectedVersion = cabinet.version;
      const changed = cabinet.changeMemberRole({
        actorUserId: input.actorUserId,
        memberId: input.memberId,
        role: input.role,
        changedAt: this.deps.clock.now(),
      });
      if (!changed.ok) abortCabinetOperation(appDomain(changed.error));
      if (cabinet.version !== expectedVersion) await this.deps.cabinets.save(cabinet, expectedVersion);
      return cabinetMemberToView(changed.value);
    });
  }
}

export class RevokeCabinetMember {
  constructor(private readonly deps: ManageCabinetMemberDeps) {}

  execute(input: CabinetMemberMutationInput): Promise<Result<CabinetMemberView, AppError>> {
    return runCabinetOperation(this.deps.uow, async () => {
      const { cabinet } = await loadAuthorizedMember(this.deps, input);
      const expectedVersion = cabinet.version;
      const revoked = cabinet.revokeMember({
        actorUserId: input.actorUserId,
        memberId: input.memberId,
        revokedAt: this.deps.clock.now(),
      });
      if (!revoked.ok) abortCabinetOperation(appDomain(revoked.error));
      if (cabinet.version !== expectedVersion) await this.deps.cabinets.save(cabinet, expectedVersion);
      return cabinetMemberToView(revoked.value);
    });
  }
}

export class SuspendCabinetMember {
  constructor(private readonly deps: ManageCabinetMemberDeps) {}

  execute(input: CabinetMemberMutationInput): Promise<Result<CabinetMemberView, AppError>> {
    return runCabinetOperation(this.deps.uow, async () => {
      const { cabinet } = await loadAuthorizedMember(this.deps, input);
      const expectedVersion = cabinet.version;
      const suspended = cabinet.suspendMember({
        actorUserId: input.actorUserId,
        memberId: input.memberId,
        suspendedAt: this.deps.clock.now(),
      });
      if (!suspended.ok) abortCabinetOperation(appDomain(suspended.error));
      if (cabinet.version !== expectedVersion) await this.deps.cabinets.save(cabinet, expectedVersion);
      return cabinetMemberToView(suspended.value);
    });
  }
}

export class RestoreCabinetMember {
  constructor(private readonly deps: ManageCabinetMemberDeps) {}

  execute(input: CabinetMemberMutationInput): Promise<Result<CabinetMemberView, AppError>> {
    return runCabinetOperation(this.deps.uow, async () => {
      const { cabinet } = await loadAuthorizedMember(this.deps, input);
      const expectedVersion = cabinet.version;
      const restored = cabinet.restoreMember({
        actorUserId: input.actorUserId,
        memberId: input.memberId,
        restoredAt: this.deps.clock.now(),
      });
      if (!restored.ok) abortCabinetOperation(appDomain(restored.error));
      if (cabinet.version !== expectedVersion) await this.deps.cabinets.save(cabinet, expectedVersion);
      return cabinetMemberToView(restored.value);
    });
  }
}

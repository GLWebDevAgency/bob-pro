import { canInviteCabinetRole } from '../../domain/cabinet/cabinet-permissions';
import { type Result } from '../../shared-kernel/result';
import { type CabinetInvitationRepository } from '../ports/cabinet-invitation-repository';
import { type CabinetRepository } from '../ports/cabinet-repository';
import { type ClockPort, type UnitOfWorkPort } from '../ports/services';
import { type AppError, appDomain, appForbidden, appNotFound } from '../result';
import { abortCabinetOperation, runCabinetOperation } from './cabinet-operation';
import { cabinetInvitationToView, type CabinetInvitationView } from './cabinet-view';

export interface RevokeCabinetInvitationDeps {
  cabinets: CabinetRepository;
  invitations: CabinetInvitationRepository;
  clock: ClockPort;
  uow: UnitOfWorkPort;
}

export class RevokeCabinetInvitation {
  constructor(private readonly deps: RevokeCabinetInvitationDeps) {}

  execute(input: {
    cabinetId: string;
    invitationId: string;
    actorUserId: string;
  }): Promise<Result<CabinetInvitationView, AppError>> {
    return runCabinetOperation(this.deps.uow, async () => {
      // Même ordre de verrous que invite/accept : invitation puis cabinet.
      const invitation = await this.deps.invitations.lockById(input.invitationId);
      if (!invitation || invitation.cabinetId !== input.cabinetId) {
        abortCabinetOperation(appNotFound('cabinet_invitation', input.invitationId));
      }
      const cabinet = await this.deps.cabinets.lockById(input.cabinetId);
      if (!cabinet) abortCabinetOperation(appNotFound('cabinet', input.cabinetId));
      const actor = cabinet.activeMemberForUser(input.actorUserId);
      // Parité RLS : sous cabinet_invitation_select, un non-membre (ou un membre d'un cabinet
      // suspendu) ne voit pas l'invitation — même 404 qu'un invitationId inconnu, pas d'oracle.
      if (!actor || cabinet.status !== 'active') {
        abortCabinetOperation(appNotFound('cabinet_invitation', input.invitationId));
      }
      if (!canInviteCabinetRole(actor.role, invitation.role)) {
        abortCabinetOperation(appForbidden('cabinet.invitations.revoke'));
      }
      const expectedVersion = invitation.version;
      const now = this.deps.clock.now();
      const revoked = invitation.revoke({ actorMemberId: actor.id, revokedAt: now });
      if (!revoked.ok) abortCabinetOperation(appDomain(revoked.error));
      if (invitation.version !== expectedVersion) await this.deps.invitations.save(invitation, expectedVersion);
      return cabinetInvitationToView(invitation, now);
    });
  }
}

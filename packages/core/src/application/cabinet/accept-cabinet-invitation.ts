import { type Result, err } from '../../shared-kernel/result';
import { type CabinetInvitationRepository } from '../ports/cabinet-invitation-repository';
import { type CabinetInvitationTokenPort } from '../ports/cabinet-invitation-token';
import { type CabinetRepository } from '../ports/cabinet-repository';
import { type ClockPort, type IdGeneratorPort, type UnitOfWorkPort } from '../ports/services';
import { type AppError, appDomain, appNotFound } from '../result';
import { abortCabinetOperation, runCabinetOperation } from './cabinet-operation';
import { cabinetMemberToView, type CabinetMemberView } from './cabinet-view';

export interface AcceptCabinetInvitationDeps {
  cabinets: CabinetRepository;
  invitations: CabinetInvitationRepository;
  tokens: CabinetInvitationTokenPort;
  ids: IdGeneratorPort;
  clock: ClockPort;
  uow: UnitOfWorkPort;
}

export interface AcceptCabinetInvitationInput {
  rawToken: string;
  authenticatedUserId: string;
  verifiedEmail: string;
}

export class AcceptCabinetInvitation {
  constructor(private readonly deps: AcceptCabinetInvitationDeps) {}

  async execute(input: AcceptCabinetInvitationInput): Promise<Result<CabinetMemberView, AppError>> {
    if (input.rawToken.trim().length === 0) {
      return err({ kind: 'validation', issues: [{ field: 'token', message: 'Invitation token is required.' }] });
    }
    const tokenHash = await this.deps.tokens.hash(input.rawToken);
    const now = this.deps.clock.now();

    return runCabinetOperation(this.deps.uow, async () => {
      const invitation = await this.deps.invitations.lockByTokenHash(tokenHash);
      if (!invitation) abortCabinetOperation(appNotFound('cabinet_invitation', 'redacted'));
      const invitationVersion = invitation.version;
      const accepted = invitation.accept({
        userId: input.authenticatedUserId,
        verifiedEmail: input.verifiedEmail,
        acceptedAt: now,
      });
      if (!accepted.ok) abortCabinetOperation(appDomain(accepted.error));

      const cabinet = await this.deps.cabinets.lockById(invitation.cabinetId);
      if (!cabinet) abortCabinetOperation(appNotFound('cabinet', invitation.cabinetId));
      const cabinetVersion = cabinet.version;
      const joined = cabinet.addMemberFromInvitation({
        memberId: this.deps.ids.newId(),
        userId: input.authenticatedUserId,
        role: invitation.role,
        invitationId: invitation.id,
        joinedAt: now,
      });
      if (!joined.ok) abortCabinetOperation(appDomain(joined.error));

      await this.deps.invitations.save(invitation, invitationVersion);
      await this.deps.cabinets.save(cabinet, cabinetVersion);
      return cabinetMemberToView(joined.value);
    });
  }
}

import {
  CabinetInvitation,
  CabinetInvitationEmail,
} from '../../domain/cabinet/cabinet-invitation';
import { canInviteCabinetRole, type CabinetRole } from '../../domain/cabinet/cabinet-permissions';
import { type Result, err } from '../../shared-kernel/result';
import { type CabinetInvitationDispatchPort } from '../ports/cabinet-invitation-dispatch';
import { type CabinetInvitationRepository } from '../ports/cabinet-invitation-repository';
import { type CabinetInvitationTokenPort } from '../ports/cabinet-invitation-token';
import { type CabinetRepository } from '../ports/cabinet-repository';
import { type ClockPort, type IdGeneratorPort, type UnitOfWorkPort } from '../ports/services';
import {
  type AppError,
  appConflict,
  appDomain,
  appForbidden,
  appNotFound,
} from '../result';
import { abortCabinetOperation, runCabinetOperation } from './cabinet-operation';
import { cabinetInvitationToView, type CabinetInvitationView } from './cabinet-view';

export const CABINET_INVITATION_TTL_HOURS = 72;

function addHours(instant: string, hours: number): string {
  return new Date(Date.parse(instant) + hours * 60 * 60 * 1_000).toISOString();
}

export interface InviteCabinetMemberDeps {
  cabinets: CabinetRepository;
  invitations: CabinetInvitationRepository;
  tokens: CabinetInvitationTokenPort;
  dispatch: CabinetInvitationDispatchPort;
  ids: IdGeneratorPort;
  clock: ClockPort;
  uow: UnitOfWorkPort;
}

export interface InviteCabinetMemberInput {
  cabinetId: string;
  actorUserId: string;
  email: string;
  role: CabinetRole;
}

export class InviteCabinetMember {
  constructor(private readonly deps: InviteCabinetMemberDeps) {}

  async execute(input: InviteCabinetMemberInput): Promise<Result<CabinetInvitationView, AppError>> {
    const email = CabinetInvitationEmail.of(input.email);
    if (!email.ok) return err(appDomain(email.error));
    const now = this.deps.clock.now();

    return runCabinetOperation(this.deps.uow, async () => {
      // Toutes les opérations qui touchent une invitation verrouillent invitation → cabinet.
      // Cet ordre commun avec accept/revoke évite un cycle invitation↔cabinet concurrent.
      const pending = await this.deps.invitations.lockPendingByCabinetAndEmail(input.cabinetId, email.value.value);
      const cabinet = await this.deps.cabinets.lockById(input.cabinetId);
      if (!cabinet) abortCabinetOperation(appNotFound('cabinet', input.cabinetId));
      const actor = cabinet.activeMemberForUser(input.actorUserId);
      // Parité RLS : pour un non-membre (ou un cabinet suspendu, invisible sous cabinet_select),
      // un cabinet existant est indistinguable d'un cabinet inconnu — pas d'oracle d'existence.
      if (!actor || cabinet.status !== 'active') {
        abortCabinetOperation(appNotFound('cabinet', input.cabinetId));
      }
      if (!canInviteCabinetRole(actor.role, input.role)) {
        abortCabinetOperation(appForbidden('cabinet.members.invite'));
      }
      if (pending?.effectiveStatus(now) === 'pending') {
        abortCabinetOperation(appConflict('cabinet_invitation', 'already_pending'));
      }
      if (pending) {
        // Matrice RBAC sur l'invitation PENDANTE, pas seulement sur le rôle demandé : un manager
        // ne matérialise jamais l'expiration d'une invitation admin/manager (la policy
        // cabinet_invitation_update la lui filtre déjà en prod — même règle ici, avant mutation).
        if (!canInviteCabinetRole(actor.role, pending.role)) {
          abortCabinetOperation(appForbidden('cabinet.members.invite'));
        }
        const pendingVersion = pending.version;
        const expired = pending.expire(now);
        if (!expired.ok) abortCabinetOperation(appDomain(expired.error));
        await this.deps.invitations.save(pending, pendingVersion);
      }

      const issuedToken = await this.deps.tokens.issue();
      const invitation = CabinetInvitation.issue({
        id: this.deps.ids.newId(),
        cabinetId: cabinet.id,
        email: email.value.value,
        role: input.role,
        tokenHash: issuedToken.tokenHash,
        invitedByMemberId: actor.id,
        createdAt: now,
        expiresAt: addHours(now, CABINET_INVITATION_TTL_HOURS),
      });
      if (!invitation.ok) abortCabinetOperation(appDomain(invitation.error));

      await this.deps.invitations.save(invitation.value, null);
      await this.deps.dispatch.enqueue({
        invitationId: invitation.value.id,
        cabinetId: cabinet.id,
        cabinetName: cabinet.name,
        email: invitation.value.email,
        role: invitation.value.role,
        expiresAt: invitation.value.expiresAt,
        rawToken: issuedToken.rawToken,
      });
      return cabinetInvitationToView(invitation.value, now);
    });
  }
}

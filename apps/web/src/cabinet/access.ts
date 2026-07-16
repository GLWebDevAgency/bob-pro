export type CabinetRole = 'admin' | 'manager' | 'collaborator';

export interface CabinetAccessSummary {
  readonly id: string;
  readonly name: string;
  readonly role: CabinetRole;
}

export interface CabinetTeamTransport {
  readonly listMembers: (
    cabinetId: string,
    cursor?: string,
  ) => Promise<import('./api').CabinetMemberPage>;
  readonly inviteMember: (cabinetId: string, email: string, role: CabinetRole) => Promise<import('./api').CabinetInvitationSummary>;
  readonly listInvitations: (
    cabinetId: string,
    cursor?: string,
  ) => Promise<import('./api').CabinetInvitationPage>;
  readonly revokeInvitation: (cabinetId: string, invitationId: string) => Promise<void>;
  readonly updateMember: (
    cabinetId: string,
    memberId: string,
    input: { readonly role?: CabinetRole; readonly status?: import('./api').CabinetMemberStatus },
  ) => Promise<import('./api').CabinetMemberSummary>;
}

export type CabinetAccessContext =
  | {
      readonly mode: 'local';
    }
  | {
      readonly mode: 'authenticated';
      readonly cabinets: readonly CabinetAccessSummary[];
      readonly selectedCabinet: CabinetAccessSummary;
      readonly team: CabinetTeamTransport;
      readonly userEmail: string;
      readonly onSelectCabinet: (cabinetId: string) => void;
      readonly onSignOut: () => void | Promise<void>;
    };

export function isLocalCabinetAccess(
  access: CabinetAccessContext,
): access is Extract<CabinetAccessContext, { readonly mode: 'local' }> {
  return access.mode === 'local';
}

export function canEditCabinetMemberRole(
  actorRole: CabinetRole,
  memberStatus: import('./api').CabinetMemberStatus,
): boolean {
  return actorRole === 'admin' && memberStatus === 'active';
}

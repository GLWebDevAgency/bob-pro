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

export interface CabinetDossierTransport {
  readonly listDossiers: (
    cabinetId: string,
    cursor?: string,
  ) => Promise<import('./api').CabinetDossierPage>;
  readonly getDossier: (
    cabinetId: string,
    siren: string,
  ) => Promise<import('./api').CabinetDossierDetail>;
  readonly saveDossier: (
    cabinetId: string,
    input: import('./api').CabinetDossierWrite,
  ) => Promise<import('./api').CabinetDossierDetail>;
  readonly deleteDossier: (
    cabinetId: string,
    siren: string,
    expectedRevision: number,
  ) => Promise<void>;
}

/**
 * Contexte de production de l'Espace Cabinet. Il n'existe volontairement aucun mode local :
 * sans session, API ou membership actif, le gateway reste fermé.
 */
export interface CabinetAccessContext {
  readonly mode: 'authenticated';
  readonly cabinets: readonly CabinetAccessSummary[];
  readonly selectedCabinet: CabinetAccessSummary;
  readonly dossiers: CabinetDossierTransport;
  readonly team: CabinetTeamTransport;
  readonly userEmail: string;
  readonly onSelectCabinet: (cabinetId: string) => void;
  readonly onSignOut: () => void | Promise<void>;
}

export function canDeleteCabinetDossier(actorRole: CabinetRole): boolean {
  return actorRole === 'admin';
}

export function canEditCabinetMemberRole(
  actorRole: CabinetRole,
  memberStatus: import('./api').CabinetMemberStatus,
): boolean {
  return actorRole === 'admin' && memberStatus === 'active';
}

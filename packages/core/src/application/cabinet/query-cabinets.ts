import { type Cabinet } from '../../domain/cabinet/cabinet';
import { type Result, err, ok } from '../../shared-kernel/result';
import { type CabinetInvitationRepository } from '../ports/cabinet-invitation-repository';
import { type CabinetRepository } from '../ports/cabinet-repository';
import { type ClockPort } from '../ports/services';
import { type AppError, appForbidden, appNotFound } from '../result';
import {
  cabinetActorToView,
  cabinetInvitationToView,
  cabinetMemberToView,
  cabinetToView,
  type CabinetActorView,
  type CabinetInvitationView,
  type CabinetMemberView,
  type CabinetView,
} from './cabinet-view';

export class ListCabinetsForUser {
  constructor(private readonly cabinets: CabinetRepository) {}

  async execute(input: { userId: string }): Promise<Result<CabinetView[], AppError>> {
    const cabinets = await this.cabinets.listByUserId(input.userId);
    return ok(cabinets
      .map((cabinet) => cabinetToView(cabinet, input.userId))
      .filter((view): view is CabinetView => view !== null));
  }
}

// Parité RLS (pas d'oracle d'existence inter-tenant) : en prod, cabinet_select cache un cabinet
// aux non-membres, aux membres non actifs et quand le cabinet est suspendu — findById renvoie null
// et l'API répond 404. Les chemins sans RLS (démo/in-memory) doivent produire exactement la même
// réponse : not_found masque forbidden tant que l'acteur n'est pas une membership active d'un
// cabinet actif. Le forbidden ne subsiste que pour un membre actif sans la permission fine.
function cabinetVisibleToActor(cabinet: Cabinet, actorUserId: string): boolean {
  return cabinet.status === 'active' && cabinet.activeMemberForUser(actorUserId) !== null;
}

export class GetCabinet {
  constructor(private readonly cabinets: CabinetRepository) {}

  async execute(input: { cabinetId: string; actorUserId: string }): Promise<Result<CabinetView, AppError>> {
    const cabinet = await this.cabinets.findById(input.cabinetId);
    if (!cabinet || !cabinetVisibleToActor(cabinet, input.actorUserId)) {
      return err(appNotFound('cabinet', input.cabinetId));
    }
    const view = cabinetToView(cabinet, input.actorUserId);
    return view ? ok(view) : err(appNotFound('cabinet', input.cabinetId));
  }
}

export class ResolveCabinetActor {
  constructor(private readonly cabinets: CabinetRepository) {}

  async execute(input: { cabinetId: string; authenticatedUserId: string }): Promise<Result<CabinetActorView, AppError>> {
    const cabinet = await this.cabinets.findById(input.cabinetId);
    if (!cabinet) return err(appNotFound('cabinet', input.cabinetId));
    const actor = cabinetActorToView(cabinet, input.authenticatedUserId);
    return actor ? ok(actor) : err(appNotFound('cabinet', input.cabinetId));
  }
}

export class ListCabinetMembers {
  constructor(private readonly cabinets: CabinetRepository) {}

  async execute(input: { cabinetId: string; actorUserId: string }): Promise<Result<CabinetMemberView[], AppError>> {
    const cabinet = await this.cabinets.findById(input.cabinetId);
    if (!cabinet || !cabinetVisibleToActor(cabinet, input.actorUserId)) {
      return err(appNotFound('cabinet', input.cabinetId));
    }
    if (!cabinet.actorHasPermission(input.actorUserId, 'cabinet.members.read')) {
      return err(appForbidden('cabinet.members.read'));
    }
    return ok(cabinet.members.map(cabinetMemberToView));
  }
}

export class ListCabinetInvitations {
  constructor(private readonly deps: {
    cabinets: CabinetRepository;
    invitations: CabinetInvitationRepository;
    clock: ClockPort;
  }) {}

  async execute(input: { cabinetId: string; actorUserId: string }): Promise<Result<CabinetInvitationView[], AppError>> {
    const cabinet = await this.deps.cabinets.findById(input.cabinetId);
    if (!cabinet || !cabinetVisibleToActor(cabinet, input.actorUserId)) {
      return err(appNotFound('cabinet', input.cabinetId));
    }
    if (!cabinet.actorHasPermission(input.actorUserId, 'cabinet.members.invite_basic')) {
      return err(appForbidden('cabinet.members.invite_basic'));
    }
    const now = this.deps.clock.now();
    const invitations = await this.deps.invitations.listByCabinet(cabinet.id);
    return ok(invitations.map((invitation) => cabinetInvitationToView(invitation, now)));
  }
}

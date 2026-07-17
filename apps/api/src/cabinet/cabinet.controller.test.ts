import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CabinetApiService } from './cabinet-api.service';
import { CabinetController, dossierExpectedRevision } from './cabinet.controller';

function setup() {
  const service = {
    createCabinet: vi.fn(),
    inviteMember: vi.fn(),
    updateMember: vi.fn(),
    acceptInvitation: vi.fn(),
    listMembers: vi.fn(),
    listInvitations: vi.fn(),
    listDossiers: vi.fn(),
    getDossier: vi.fn(),
    saveDossier: vi.fn(),
    deleteDossier: vi.fn(),
  };
  return { service, controller: new CabinetController(service as unknown as CabinetApiService) };
}

describe('CabinetController DTO validation', () => {
  it.each([
    ['null', null],
    ['mauvais type', { name: 42 }],
    ['champ inconnu', { name: 'Cabinet Atlas', isAdmin: true }],
  ])('rejette un body create %s avant le service', async (_label, body) => {
    const { controller, service } = setup();
    expect(() => controller.createCabinet(body)).toThrow(HttpException);
    try { controller.createCabinet(body); } catch (error) {
      expect(error).toMatchObject({ status: 422 });
    }
    expect(service.createCabinet).not.toHaveBeenCalled();
  });

  it('rejette les statuts/roles inconnus et les mutations doubles', () => {
    const { controller, service } = setup();
    expect(() => controller.updateMember('cab', 'member', { status: 'banana' })).toThrow(HttpException);
    expect(() => controller.updateMember('cab', 'member', { status: 'active', role: 'admin' })).toThrow(HttpException);
    expect(service.updateMember).not.toHaveBeenCalled();
  });

  it('borne et verrouille les query params de pagination', () => {
    const { controller, service } = setup();
    expect(() => controller.listMembers('cab', { limit: '101' })).toThrow(HttpException);
    expect(() => controller.listInvitations('cab', { limit: '10', extra: 'x' })).toThrow(HttpException);
    expect(service.listMembers).not.toHaveBeenCalled();
    expect(service.listInvitations).not.toHaveBeenCalled();
  });

  it('impose un prérequis CAS HTTP exact pour les mutations dossier', () => {
    expect(dossierExpectedRevision(undefined, '*')).toBeNull();
    expect(dossierExpectedRevision('"12"', undefined)).toBe(12);
    expect(() => dossierExpectedRevision(undefined, undefined)).toThrowError(
      expect.objectContaining({ status: 428 }),
    );
    expect(() => dossierExpectedRevision('12', undefined)).toThrowError(
      expect.objectContaining({ status: 422 }),
    );
    expect(() => dossierExpectedRevision('"1"', '*')).toThrowError(
      expect.objectContaining({ status: 422 }),
    );
  });

  it('refuse un SIREN body/path divergent et toute révision injectée dans le JSON', () => {
    const { controller, service } = setup();
    expect(() => controller.saveDossier(
      'cabinet-1',
      '552100554',
      undefined,
      '*',
      { siren: '732829320' },
    )).toThrow(HttpException);
    expect(() => controller.saveDossier(
      'cabinet-1',
      '552100554',
      '"1"',
      undefined,
      { siren: '552100554', expectedRevision: 99 },
    )).toThrow(HttpException);
    expect(service.saveDossier).not.toHaveBeenCalled();
  });

  it('transmet la révision de suppression uniquement depuis If-Match', () => {
    const { controller, service } = setup();
    controller.deleteDossier('cabinet-1', '552100554', '"3"', undefined);
    expect(service.deleteDossier).toHaveBeenCalledWith('cabinet-1', '552100554', 3);
    expect(() => controller.deleteDossier('cabinet-1', '552100554', undefined, '*')).toThrow(HttpException);
  });
});

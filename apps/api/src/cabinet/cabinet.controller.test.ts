import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CabinetApiService } from './cabinet-api.service';
import { CabinetController } from './cabinet.controller';

function setup() {
  const service = {
    createCabinet: vi.fn(),
    inviteMember: vi.fn(),
    updateMember: vi.fn(),
    acceptInvitation: vi.fn(),
    listMembers: vi.fn(),
    listInvitations: vi.fn(),
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
});

import { describe, expect, it } from 'vitest';
import type { Persistence } from './persistence';
import { InMemoryPersistence } from './persistence.testing';
import { PrismaPersistence } from './prisma/prisma-persistence';
import type { PrismaService } from './prisma/prisma.service';
import {
  DisabledOpenAiNativeSpeechDeliveryRepository,
  type OpenAiNativeSpeechDeliveryRepositoryPort,
} from '../voice/realtime/openai-native-speech-delivery';
import { PrismaOpenAiNativeSpeechDeliveryRepository } from '../voice/realtime/openai-native-speech-delivery.prisma';
import { PrismaOpenAiNativeKeyVersionAuthority } from '../voice/realtime/openai-native-proof-key-version.prisma';

type NativeDeliveryFactory = Pick<Persistence, 'createOpenAiNativeSpeechDeliveryRepository'>;

function createFrom(factory: NativeDeliveryFactory): OpenAiNativeSpeechDeliveryRepositoryPort {
  return factory.createOpenAiNativeSpeechDeliveryRepository();
}

describe('Persistence — parité de la factory OpenAI native request-time', () => {
  it('branche l’adapter Prisma durable sur le client de la Persistence', () => {
    const prisma = {} as PrismaService;
    const persistence = {
      prisma,
      createOpenAiNativeSpeechDeliveryRepository:
        PrismaPersistence.prototype.createOpenAiNativeSpeechDeliveryRepository,
    } as unknown as NativeDeliveryFactory;

    const repository = createFrom(persistence);

    expect(repository).toBeInstanceOf(PrismaOpenAiNativeSpeechDeliveryRepository);
    expect((repository as unknown as { prisma: PrismaService }).prisma).toBe(prisma);
  });

  it('la Persistence de test échoue ferme au lieu de fabriquer une livraison', async () => {
    const repository = createFrom(new InMemoryPersistence());

    expect(repository).toBeInstanceOf(DisabledOpenAiNativeSpeechDeliveryRepository);
    await expect(repository.read({
      companyId: 'company-test',
      deliveryId: '00000000-0000-4000-8000-000000000001',
    })).resolves.toEqual({ status: 'unavailable' });
  });
});

describe('Persistence — autorité de boot des keyrings OpenAI natifs', () => {
  const subjectKeys = Object.freeze({
    currentVersion: 1,
    versions: Object.freeze([1]),
    secret: (version: number) => version === 1 ? 's'.repeat(32) : null,
  });
  const proofKeys = Object.freeze({
    currentVersion: 1,
    versions: Object.freeze([1]),
    secret: (version: number) => version === 1 ? 'p'.repeat(32) : null,
  });

  it('branche l’autorité Prisma combinée sur le client réel', () => {
    const prisma = {} as PrismaService;
    const persistence = {
      prisma,
      createOpenAiNativeKeyVersionAuthority:
        PrismaPersistence.prototype.createOpenAiNativeKeyVersionAuthority,
    } as unknown as Pick<Persistence, 'createOpenAiNativeKeyVersionAuthority'>;

    const authority = persistence.createOpenAiNativeKeyVersionAuthority(subjectKeys, proofKeys);

    expect(authority).toBeInstanceOf(PrismaOpenAiNativeKeyVersionAuthority);
  });

  it('refuse tout double in-memory au boot au lieu de simuler le registre', () => {
    expect(new InMemoryPersistence().createOpenAiNativeKeyVersionAuthority(
      subjectKeys,
      proofKeys,
    )).toBeNull();
  });
});

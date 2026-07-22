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

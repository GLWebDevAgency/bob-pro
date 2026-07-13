import { Module, type Provider } from '@nestjs/common';
import { PERSISTENCE, type Persistence, InMemoryPersistence } from './persistence';
import { PrismaService } from './prisma/prisma.service';
import { PrismaPersistence } from './prisma/prisma-persistence';

const persistenceProvider: Provider = {
  provide: PERSISTENCE,
  useFactory: async (): Promise<Persistence> => {
    const live = process.env.DEMO_MODE === 'false';
    if (live && !process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when DEMO_MODE=false; refusing an in-memory live fallback.');
    }
    const useDb = live;
    const persistence: Persistence = useDb ? new PrismaPersistence(new PrismaService()) : new InMemoryPersistence();
    await persistence.seed();
    return persistence;
  },
};

@Module({
  providers: [persistenceProvider],
  exports: [PERSISTENCE],
})
export class PersistenceModule {}

import { Module, type Provider } from '@nestjs/common';
import { PERSISTENCE, type Persistence, InMemoryPersistence } from './persistence';
import { PrismaService } from './prisma/prisma.service';
import { PrismaPersistence } from './prisma/prisma-persistence';

const persistenceProvider: Provider = {
  provide: PERSISTENCE,
  useFactory: async (): Promise<Persistence> => {
    const useDb = !!process.env.DATABASE_URL && process.env.DEMO_MODE === 'false';
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

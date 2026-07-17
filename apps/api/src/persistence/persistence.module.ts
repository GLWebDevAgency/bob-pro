import { Module, type Provider } from '@nestjs/common';
import type { Persistence } from './persistence';
import { PERSISTENCE } from './persistence-token';
import { PrismaService } from './prisma/prisma.service';
import { PrismaPersistence } from './prisma/prisma-persistence';

const persistenceProvider: Provider = {
  provide: PERSISTENCE,
  useFactory: (): Persistence => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required; the API has no in-memory business-data runtime.');
    }
    return new PrismaPersistence(new PrismaService());
  },
};

@Module({
  providers: [persistenceProvider],
  exports: [PERSISTENCE],
})
export class PersistenceModule {}

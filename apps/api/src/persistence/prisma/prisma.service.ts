import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * RLS : exécute `fn` dans une transaction avec le GUC tenant (app.current_company_id) posé.
   * En prod, l'app se connecte via un rôle NON-superuser et toutes les requêtes tenant passent ici
   * → la base applique les politiques de prisma/rls.sql (défense en profondeur).
   */
  withTenant<T>(companyId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_company_id = '${companyId.replace(/'/g, "''")}'`);
      return fn(tx);
    });
  }
}

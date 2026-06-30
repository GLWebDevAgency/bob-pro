import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

/** Transaction interactive courante (par requête) — les repos passant par client() y participent. */
const txStorage = new AsyncLocalStorage<Prisma.TransactionClient>();

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /** Client actif : la transaction courante si on est dans runInTransaction, sinon le client de base. */
  client(): PrismaClient | Prisma.TransactionClient {
    return txStorage.getStore() ?? this;
  }

  inTransaction(): boolean {
    return txStorage.getStore() !== undefined;
  }

  /**
   * Exécute `fn` dans une transaction interactive ; tout repo passant par `client()` y participe.
   * Si `fn` lève, la transaction est annulée (rollback). Réentrant : si déjà en transaction, réutilise.
   */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction()) return fn();
    return this.$transaction((tx) => txStorage.run(tx, fn));
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

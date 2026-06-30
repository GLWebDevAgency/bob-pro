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
   * RLS (défense en profondeur, EN PLUS de la garde applicative IDOR déjà en place) : exécute `fn`
   * dans une transaction avec le GUC tenant (app.current_company_id) posé, pour que la base applique
   * les politiques de prisma/rls.sql.
   *
   * ⚠️ ACTIVATION (non branchée par défaut) : pour enrôler TOUTES les requêtes tenant, il faut
   *   1) connecter l'app via un rôle Postgres NON-superuser (sinon FORCE RLS est ignoré),
   *   2) rendre tous les `save` repo tx-aware (cf. inTransaction()) pour ne pas imbriquer de $transaction,
   *   3) wrapper la requête (interceptor) dans withTenant.
   * À déployer + valider sur une vraie base (charge/locks) avant activation — le garde applicatif
   * (ownedQuote/ownedInvoice, vérifié cross-tenant → 404) reste la protection runtime primaire.
   */
  withTenant<T>(companyId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_company_id = '${companyId.replace(/'/g, "''")}'`);
      return fn(tx);
    });
  }
}

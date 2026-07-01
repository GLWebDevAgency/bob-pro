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
   * Branchée via TenantPersistenceInterceptor. À valider en prod avec un rôle Postgres NON-superuser
   * (sinon FORCE RLS est ignoré) ; le garde applicatif ownedQuote/ownedInvoice reste la première ligne.
   */
  withTenant<T>(companyId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (this.inTransaction()) {
      const tx = this.client() as Prisma.TransactionClient;
      return tx
        .$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`
        .then(() => fn(tx));
    }
    return this.$transaction(async (tx) => {
      // set_config(name, value, is_local=true) : équivalent à SET LOCAL mais PARAMÉTRÉ (pas d'interpolation
      // de chaîne) -> élimine le vecteur d'injection dans le GUC tenant (vs $executeRawUnsafe).
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      return txStorage.run(tx, () => fn(tx));
    });
  }

  /** Lookup publique limitée à UN hash de token, pour résoudre le tenant avant d'appliquer la RLS métier. */
  withPublicAccessTokenHash<T>(tokenHash: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (this.inTransaction()) {
      const tx = this.client() as Prisma.TransactionClient;
      return tx
        .$executeRaw`SELECT set_config('app.public_access_token_hash', ${tokenHash}, true)`
        .then(() => fn(tx));
    }
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.public_access_token_hash', ${tokenHash}, true)`;
      return txStorage.run(tx, () => fn(tx));
    });
  }
}

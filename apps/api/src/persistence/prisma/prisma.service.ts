import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

/** Transaction interactive courante (par requête) — les repos passant par client() y participent. */
const txStorage = new AsyncLocalStorage<Prisma.TransactionClient>();
const NOTIFICATION_OUTBOX_VERSION = '2';

export interface IsolatedTransactionOptions {
  readonly maxWaitMs: number;
  readonly timeoutMs: number;
}

export interface IsolatedOwnerTransactionOptions extends IsolatedTransactionOptions {
  readonly readOnly: boolean;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  // PRISMA_TRANSACTION_TIMEOUT_MS : les certifications du rituel de release s'exécutent
  // contre la base DISTANTE (latence WAN) — le défaut Prisma de 5 s y produit des P2028
  // sans aucun drift. Absente en runtime Railway : comportement inchangé.
  constructor(options?: ConstructorParameters<typeof PrismaClient>[0]) {
    const timeoutMs = Number(process.env.PRISMA_TRANSACTION_TIMEOUT_MS ?? 0);
    super(
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? {
            ...options,
            transactionOptions: {
              timeout: timeoutMs,
              maxWait: Math.min(timeoutMs, 10_000),
            },
          }
        : options,
    );
  }

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
      return this.setCompanyContext(tx, companyId).then(() => fn(tx));
    }
    return this.$transaction(async (tx) => {
      // set_config(name, value, is_local=true) : équivalent à SET LOCAL mais PARAMÉTRÉ (pas d'interpolation
      // de chaîne) -> élimine le vecteur d'injection dans le GUC tenant (vs $executeRawUnsafe).
      await this.setCompanyContext(tx, companyId);
      return txStorage.run(tx, () => fn(tx));
    });
  }

  /**
   * Ouvre toujours une transaction tenantée indépendante, même depuis une transaction ambiante.
   *
   * Réservé aux autorités durables qui doivent absorber leur propre échec sans empoisonner la
   * transaction HTTP appelante (leases, CAS, accusés de réception). L'appelant ne doit donc jamais
   * dépendre d'une écriture non commitée de la transaction ambiante.
   */
  withIsolatedTenant<T>(
    companyId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: IsolatedTransactionOptions,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await this.setCompanyContext(tx, companyId);
      return txStorage.run(tx, () => fn(tx));
    }, options === undefined ? undefined : {
      maxWait: options.maxWaitMs,
      timeout: options.timeoutMs,
    });
  }

  /**
   * Transaction isolée société + propriétaire pour une autorité durable owner-scopée.
   *
   * Le mode lecture pose `SET TRANSACTION READ ONLY` AVANT la première requête. Les GUC sont
   * ensuite paramétrés dans cette même transaction ; aucun repository ne peut changer de client
   * Prisma au milieu d'une mission.
   */
  withIsolatedOwner<T>(
    companyId: string,
    ownerUserId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: IsolatedOwnerTransactionOptions,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      if (options.readOnly) {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      }
      await this.setCompanyContext(tx, companyId);
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
      return txStorage.run(tx, () => fn(tx));
    }, {
      maxWait: options.maxWaitMs,
      timeout: options.timeoutMs,
    });
  }

  /**
   * Ouvre une transaction globale indépendante sans poser d'identité tenant.
   *
   * Réservé aux capacités globales minimales qui installent elles-mêmes leurs timeouts SQL avant
   * toute lecture. Le callback reçoit seulement le client transactionnel : aucun repository
   * tenanté ne doit être appelé depuis cette autorité.
   */
  withIsolatedGlobal<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: IsolatedTransactionOptions,
  ): Promise<T> {
    return this.$transaction(fn, options === undefined ? undefined : {
      maxWait: options.maxWaitMs,
      timeout: options.timeoutMs,
    });
  }

  private async setCompanyContext(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
    await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    // Fence de protocole, pas une autorisation : les policies vérifient toujours companyId.
    // Son absence bloque une révision N-1 qui ignorerait les leases lors d'un rolling rollback.
    await tx.$executeRaw`SELECT set_config('app.notification_outbox_version', ${NOTIFICATION_OUTBOX_VERSION}, true)`;
  }

  /**
   * Écriture DÉTACHÉE de la transaction de requête, avec le GUC tenant posé.
   *
   * Réservé aux écritures d'OBSERVATION (traçage vocal). Motif : une écriture qui échoue DANS la
   * transaction de requête l'avorte entièrement — même attrapée, la transaction est empoisonnée
   * et les écritures métier qui suivent échouent. Une trace de debug ne doit JAMAIS pouvoir
   * casser la conversation qu'elle observe : elle prend donc sa propre connexion, réussit ou
   * échoue seule, et n'est jamais inscrite dans le `txStorage` de la requête appelante.
   *
   * `txStorage.run` interne : les repos passant par `client()` voient CETTE transaction, quel
   * que soit le contexte asynchrone d'où le drain est déclenché.
   */
  detachedWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    return this.withIsolatedTenant(companyId, () => fn());
  }

  /** Pose uniquement l'identité authentifiée. Utile pour lister les memberships de l'utilisateur. */
  withIdentity<T>(userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (this.inTransaction()) {
      const tx = this.client() as Prisma.TransactionClient;
      return tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`.then(() => fn(tx));
    }
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return txStorage.run(tx, () => fn(tx));
    });
  }

  /** Contexte tenant Cabinet. Le GUC n'accorde rien : chaque policy revalide la membership en base. */
  withCabinet<T>(
    userId: string,
    cabinetId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.withIdentity(userId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_cabinet_id', ${cabinetId}, true)`;
      return fn(tx);
    });
  }

  /** Lookup d'une invitation par capacité exacte : hash + email JWT vérifié, jamais par id public. */
  withCabinetInvitation<T>(
    userId: string,
    verifiedEmail: string,
    tokenHash: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.withIdentity(userId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_email', ${verifiedEmail}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_invitation_token_hash', ${tokenHash}, true)`;
      return fn(tx);
    });
  }

  /** À appeler uniquement dans une transaction d'invitation déjà authentifiée. */
  async selectCabinetInCurrentTransaction(cabinetId: string): Promise<void> {
    if (!this.inTransaction()) throw new Error('Cabinet selection requires an active transaction.');
    const tx = this.client() as Prisma.TransactionClient;
    await tx.$executeRaw`SELECT set_config('app.current_cabinet_id', ${cabinetId}, true)`;
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

import {
  parisDateOnly,
  type CashMovement,
  type CashMovementProjectionPort,
} from '@bob/core';
import type { PrismaService } from './prisma.service';

/**
 * Adapter PostgreSQL du port de projection des mouvements de trésorerie. Deux requêtes tenantées
 * (FORCE RLS + `companyId` explicite) unionnées : les encaissements de factures et les règlements
 * de dépenses.
 *
 * ⚠️ `observedAt` n'est ici qu'une BORNE D'OPTIMISATION SQL, jamais la règle métier. Le filtrage
 * qui fait foi (comparaison STRICTE pour les instants, jour Europe/Paris STRICTEMENT postérieur
 * pour les dates seules) est réappliqué en mémoire par `deriveCashPosition`. D'où les `>=` et la
 * descente au jour Paris : l'adapter doit ramener un SUR-ensemble de ce que le use case retiendra.
 * Filtrer plus strictement ici ferait silencieusement disparaître un mouvement légitime — exactement
 * le bug que cette lane répare.
 */
export class PrismaCashMovementProjection implements CashMovementProjectionPort {
  constructor(private readonly prisma: PrismaService) {}

  async listSinceObservation(input: {
    companyId: string;
    observedAt: string;
  }): Promise<readonly CashMovement[]> {
    const client = this.prisma.client();

    // Borne basse des dépenses : MINUIT du jour Europe/Paris de l'observation, exprimé comme la
    // colonne `@db.Date` l'est en base (minuit UTC du jour civil). Un règlement daté du jour même
    // franchit donc le SQL puis se fait écarter en mémoire — c'est voulu : le use case, lui seul,
    // sait qu'une date sans heure ne prouve pas la postériorité.
    const observedDayFloor = new Date(`${parisDateOnly(input.observedAt)}T00:00:00.000Z`);

    const [payments, expenses] = await Promise.all([
      client.payment.findMany({
        where: { companyId: input.companyId, receivedAt: { gte: new Date(input.observedAt) } },
        select: { id: true, companyId: true, amount: true, receivedAt: true },
      }),
      client.expense.findMany({
        where: {
          companyId: input.companyId,
          // Une dépense n'est un DÉCAISSEMENT que réglée ET datée : `status: 'paid'` sans preuve
          // (ligne historique `paymentEvidenceLegacyUnverified`) n'a pas de date de sortie, donc
          // aucune façon honnête de la situer par rapport à l'observation. Elle reste dehors.
          status: 'paid',
          paymentPaidOn: { not: null, gte: observedDayFloor },
        },
        select: { id: true, companyId: true, totalTtcCents: true, paymentPaidOn: true },
      }),
    ]);

    const movements: CashMovement[] = [];

    for (const payment of payments) {
      movements.push({
        id: payment.id,
        companyId: payment.companyId,
        source: 'invoice_payment',
        direction: 'in',
        amountCents: payment.amount,
        // `toISOString()` obligatoire : la validation du use case exige un ISO CANONIQUE
        // (`new Date(v).toISOString() === v`) ; toute autre sérialisation ferait échouer le calcul.
        occurredAt: { precision: 'instant', value: payment.receivedAt.toISOString() },
      });
    }

    for (const expense of expenses) {
      // Le `not: null` du WHERE ne se propage pas au type Prisma : garde explicite, jamais de `!`.
      const paidOn = expense.paymentPaidOn;
      if (paidOn === null) continue;
      movements.push({
        id: expense.id,
        companyId: expense.companyId,
        source: 'expense_settlement',
        direction: 'out',
        // La sortie de trésorerie est le TTC : c'est ce que la banque a réellement débité,
        // pas le HT comptable.
        amountCents: expense.totalTtcCents,
        // `@db.Date` : Prisma restitue minuit UTC du jour civil — la tranche est le jour lui-même,
        // sans heure inventée. La précision `date` dit au use case de rester prudent.
        occurredAt: { precision: 'date', value: paidOn.toISOString().slice(0, 10) },
      });
    }

    return movements;
  }
}

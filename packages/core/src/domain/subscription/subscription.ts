import { AggregateRoot } from '../../shared-kernel/aggregate';
import { type DomainResult, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type PlanTier, type Feature, type AddOn, planCan } from './plan';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

export class Subscription extends AggregateRoot<string> {
  private constructor(
    id: string,
    readonly companyId: string,
    private _tier: PlanTier,
    private _status: SubscriptionStatus,
    private _currentPeriodEnd: Instant | null,
    private _stripeCustomerId: string | null,
    private _addOns: AddOn[],
  ) {
    super(id);
  }

  static start(p: {
    id: string;
    companyId: string;
    tier: PlanTier;
    status?: SubscriptionStatus;
    currentPeriodEnd?: Instant;
    stripeCustomerId?: string;
    addOns?: AddOn[];
  }): DomainResult<Subscription> {
    return ok(
      new Subscription(
        p.id,
        p.companyId,
        p.tier,
        p.status ?? 'trialing',
        p.currentPeriodEnd ?? null,
        p.stripeCustomerId ?? null,
        p.addOns ?? [],
      ),
    );
  }

  get tier(): PlanTier {
    return this._tier;
  }
  get addOns(): readonly AddOn[] {
    return this._addOns;
  }
  hasAddOn(addOn: AddOn): boolean {
    return this._addOns.includes(addOn);
  }
  addAddOn(addOn: AddOn): void {
    if (!this._addOns.includes(addOn)) this._addOns.push(addOn);
  }
  get status(): SubscriptionStatus {
    return this._status;
  }
  get currentPeriodEnd(): Instant | null {
    return this._currentPeriodEnd;
  }
  get stripeCustomerId(): string | null {
    return this._stripeCustomerId;
  }

  changePlan(tier: PlanTier): void {
    this._tier = tier;
  }
  activate(periodEnd: Instant): void {
    this._status = 'active';
    this._currentPeriodEnd = periodEnd;
  }
  markPastDue(): void {
    this._status = 'past_due';
  }
  cancel(): void {
    this._status = 'canceled';
  }
  linkStripeCustomer(id: string): void {
    this._stripeCustomerId = id;
  }

  isActive(): boolean {
    return this._status === 'active' || this._status === 'trialing';
  }
  /** Capacité ouverte = abonnement actif ET incluse dans l'offre. */
  can(feature: Feature): boolean {
    return this.isActive() && planCan(this._tier, feature);
  }
}

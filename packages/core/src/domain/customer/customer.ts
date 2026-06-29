import { type DomainResult, ok } from '../../shared-kernel/result';
import { type Address } from '../../shared-kernel/contact';
import { Score, type ScoreBand } from './score';

export type CustomerType = 'b2c' | 'b2b' | 'b2g';

export interface CustomerProps {
  id: string;
  type: CustomerType;
  name: string;
  siren?: string;
  address: Address;
  email?: string;
  phone?: string;
  paymentTermsLabel?: string;
  score: number;
  avgDelayDays: number;
  outstanding: number;
  isInternational?: boolean;
  isSubcontractingBtp?: boolean;
}

export class Customer {
  private constructor(
    private readonly p: CustomerProps,
    private readonly scoreVo: Score,
  ) {}

  static of(p: CustomerProps): DomainResult<Customer> {
    const s = Score.of(p.score);
    if (!s.ok) return s;
    return ok(new Customer(p, s.value));
  }

  get id(): string {
    return this.p.id;
  }
  get type(): CustomerType {
    return this.p.type;
  }
  get name(): string {
    return this.p.name;
  }
  get siren(): string | undefined {
    return this.p.siren;
  }
  get outstanding(): number {
    return this.p.outstanding;
  }
  get avgDelayDays(): number {
    return this.p.avgDelayDays;
  }
  get score(): number {
    return this.scoreVo.value;
  }
  get isSubcontractingBtp(): boolean {
    return this.p.isSubcontractingBtp === true;
  }
  isInternational(): boolean {
    return this.p.isInternational === true;
  }
  requiresSirenForEinvoice(): boolean {
    return this.p.type === 'b2b' || this.p.type === 'b2g';
  }
  scoreBand(): ScoreBand {
    return this.scoreVo.band();
  }
}

import { type Instant } from './time';

export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Instant;
  readonly version: number;
}

export abstract class AggregateRoot<TId> {
  private _events: DomainEvent[] = [];
  protected constructor(readonly id: TId) {}
  protected record(e: DomainEvent): void {
    this._events.push(e);
  }
  pullEvents(): DomainEvent[] {
    const e = this._events;
    this._events = [];
    return e;
  }
}

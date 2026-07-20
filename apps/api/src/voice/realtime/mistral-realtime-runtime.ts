import type { Server as HttpServer } from 'node:http';
import type { MistralRealtimeUpgradeAdapter } from './mistral-realtime-upgrade';

/** Cycle de vie Nest/HTTP du gateway WSS, séparé du noyau de session et testable sans réseau. */
export interface MistralRealtimeIngressRuntime {
  readonly enabled: boolean;
  attach(server: HttpServer): void;
  shutdown(): Promise<void>;
  onApplicationShutdown(): Promise<void>;
}

export class DisabledMistralRealtimeIngressRuntime implements MistralRealtimeIngressRuntime {
  readonly enabled = false;

  attach(_server: HttpServer): void {}

  async shutdown(): Promise<void> {}

  async onApplicationShutdown(): Promise<void> {}
}

export class ActiveMistralRealtimeIngressRuntime implements MistralRealtimeIngressRuntime {
  readonly enabled = true;

  constructor(private readonly adapter: MistralRealtimeUpgradeAdapter) {}

  attach(server: HttpServer): void {
    this.adapter.attach(server);
  }

  shutdown(): Promise<void> {
    return this.adapter.shutdown();
  }

  onApplicationShutdown(): Promise<void> {
    return this.shutdown();
  }
}

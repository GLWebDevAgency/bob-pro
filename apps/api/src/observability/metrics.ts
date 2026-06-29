import { Injectable } from '@nestjs/common';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

/** Registre Prometheus + signaux RED (HTTP) et observabilité métier de l'IA. */
@Injectable()
export class Metrics {
  readonly registry = new Registry();
  readonly httpRequests: Counter<string>;
  readonly httpDuration: Histogram<string>;
  readonly aiRequests: Counter<string>;
  readonly aiDuration: Histogram<string>;
  readonly aiGuardViolations: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Nombre de requêtes HTTP',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Durée des requêtes HTTP',
      labelNames: ['method', 'route'],
      registers: [this.registry],
    });
    this.aiRequests = new Counter({
      name: 'ai_requests_total',
      help: 'Requêtes à l’assistant Bob',
      labelNames: ['model', 'intent', 'outcome'],
      registers: [this.registry],
    });
    this.aiDuration = new Histogram({
      name: 'ai_request_duration_seconds',
      help: 'Durée des requêtes IA',
      labelNames: ['model', 'intent'],
      registers: [this.registry],
    });
    this.aiGuardViolations = new Counter({
      name: 'ai_money_guard_violations_total',
      help: 'Montants hallucinés rejetés par le garde-fou (doit rester à 0)',
      registers: [this.registry],
    });
  }
}

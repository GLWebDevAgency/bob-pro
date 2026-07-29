import { Injectable } from '@nestjs/common';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

/** Registre Prometheus + signaux RED (HTTP) et observabilité métier de l'IA. */
@Injectable()
export class Metrics {
  readonly registry = new Registry();
  readonly httpRequests: Counter<string>;
  readonly httpDuration: Histogram<string>;
  readonly aiRequests: Counter<string>;
  readonly aiDuration: Histogram<string>;
  readonly aiGuardViolations: Counter<string>;
  readonly bobLiveBootstrapRequests: Counter<string>;
  readonly bobLiveBootstrapDuration: Histogram<string>;
  readonly bobLiveProviderErrors: Counter<string>;
  readonly bobLiveRateLimited: Counter<string>;
  readonly bobLiveSidebandConnections: Counter<string>;
  readonly bobLiveSessionsActive: Gauge<string>;
  /** Jauges PostgreSQL globales : agréger par max entre répliques, jamais par somme. */
  readonly bobLiveCapacityUsed: Gauge<string>;
  readonly bobLiveCapacityGlobalLimit: Gauge<string>;
  readonly bobLiveCapacityProviderLimit: Gauge<string>;
  readonly bobLiveCapacityConfigVersion: Gauge<string>;
  readonly bobLiveCapacitySnapshotAge: Gauge<string>;
  readonly bobLiveCapacityInspections: Counter<string>;
  readonly bobLiveSecurityRejections: Counter<string>;
  readonly bobLiveTurns: Counter<string>;
  readonly bobLiveBrainDuration: Histogram<string>;
  readonly bobLiveRenderDispatchDuration: Histogram<string>;
  readonly bobLiveVoiceToVoiceDuration: Histogram<string>;
  readonly bobLiveBargeInDuration: Histogram<string>;
  readonly bobLiveContextUpdates: Counter<string>;
  readonly bobLiveOutputAudits: Counter<string>;
  readonly bobLiveUsageUnits: Counter<string>;
  readonly bobLiveFallbacks: Counter<string>;
  readonly bobLiveEntitlementChecks: Counter<string>;
  readonly agentMissionNegotiations: Counter<string>;
  readonly agentMissionCapabilityRejections: Counter<string>;
  readonly agentMissionForegroundContentions: Counter<string>;
  readonly agentMissionBootstrapReceipts: Counter<string>;
  readonly agentMissionScreenAcks: Counter<string>;
  readonly cabinetOperations: Counter<string>;
  readonly cabinetAuthorizationDenials: Counter<string>;
  readonly cabinetFlagEvaluations: Counter<string>;
  readonly cabinetInvitationDeliveries: Counter<string>;
  readonly cabinetInvitationOldestEncryptedSeconds: Gauge<string>;
  readonly cabinetInvitationWorkerLastSuccess: Gauge<string>;

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
    this.bobLiveBootstrapRequests = new Counter({
      name: 'bob_live_bootstrap_total',
      help: 'Résultats de création des appels WebRTC Bob Live',
      labelNames: ['model', 'outcome'],
      registers: [this.registry],
    });
    this.bobLiveBootstrapDuration = new Histogram({
      name: 'bob_live_bootstrap_duration_seconds',
      help: 'Durée de négociation serveur du bootstrap WebRTC Bob Live',
      labelNames: ['model', 'outcome'],
      buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8],
      registers: [this.registry],
    });
    this.bobLiveProviderErrors = new Counter({
      name: 'bob_live_provider_errors_total',
      help: 'Erreurs bornées du fournisseur Realtime, sans contenu ni identifiant sensible',
      labelNames: ['class'],
      registers: [this.registry],
    });
    this.bobLiveRateLimited = new Counter({
      name: 'bob_live_rate_limited_total',
      help: 'Admissions Bob Live refusées par portée',
      labelNames: ['scope'],
      registers: [this.registry],
    });
    this.bobLiveSidebandConnections = new Counter({
      name: 'bob_live_sideband_connections_total',
      help: 'Résultats de connexion du canal de contrôle Bob Live côté serveur',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.bobLiveSessionsActive = new Gauge({
      name: 'bob_live_sessions_active',
      help: 'Sessions Bob Live actives observées par leur canal de contrôle serveur',
      labelNames: ['transport'],
      registers: [this.registry],
    });
    this.bobLiveCapacityUsed = new Gauge({
      name: 'bob_live_capacity_durable_used',
      help: 'Leases Bob Live durables comptées par PostgreSQL ; agréger les répliques par max.',
      registers: [this.registry],
    });
    this.bobLiveCapacityGlobalLimit = new Gauge({
      name: 'bob_live_capacity_global_limit',
      help: 'Plafond global Bob Live attesté par PostgreSQL ; agréger les répliques par max.',
      registers: [this.registry],
    });
    this.bobLiveCapacityProviderLimit = new Gauge({
      name: 'bob_live_capacity_provider_limit',
      help: 'Quota fournisseur déclaré et attesté ; agréger les répliques par max.',
      registers: [this.registry],
    });
    this.bobLiveCapacityConfigVersion = new Gauge({
      name: 'bob_live_capacity_config_version',
      help: 'Version de configuration capacité attestée par PostgreSQL.',
      registers: [this.registry],
    });
    this.bobLiveCapacitySnapshotAge = new Gauge({
      name: 'bob_live_capacity_snapshot_age_seconds',
      help: 'Âge de la dernière mutation du compteur durable, sans identité métier.',
      registers: [this.registry],
    });
    this.bobLiveCapacityInspections = new Counter({
      name: 'bob_live_capacity_inspections_total',
      help: 'Résultat des inspections de cohérence de la capacité globale.',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.bobLiveSecurityRejections = new Counter({
      name: 'bob_live_security_rejections_total',
      help: 'Événements Bob Live rejetés par la politique serveur',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.bobLiveTurns = new Counter({
      name: 'bob_live_turns_total',
      help: 'Tours Bob Live terminés par résultat public, sans contenu ni identifiant',
      labelNames: ['outcome', 'kind'],
      registers: [this.registry],
    });
    this.bobLiveBrainDuration = new Histogram({
      name: 'bob_live_brain_duration_seconds',
      help: 'Transcription finale vers résultat canonique du cerveau Bob',
      labelNames: ['outcome'],
      buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8],
      registers: [this.registry],
    });
    this.bobLiveRenderDispatchDuration = new Histogram({
      name: 'bob_live_render_dispatch_duration_seconds',
      help: 'Résultat canonique vers acquittement response.created du moteur vocal',
      labelNames: ['outcome'],
      buckets: [0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.4, 0.75, 1],
      registers: [this.registry],
    });
    this.bobLiveVoiceToVoiceDuration = new Histogram({
      name: 'bob_live_voice_to_voice_seconds',
      help: 'Fin de parole utilisateur vers premier paquet audio Bob, rapporté par le transport mobile',
      labelNames: ['transport'],
      buckets: [0.25, 0.4, 0.6, 0.75, 0.9, 1.2, 1.5, 1.8, 2.5, 4, 8],
      registers: [this.registry],
    });
    this.bobLiveBargeInDuration = new Histogram({
      name: 'bob_live_barge_in_to_silence_seconds',
      help: 'Début de reprise de parole vers accusé de purge audio, rapporté par le transport mobile',
      labelNames: ['transport'],
      buckets: [0.05, 0.1, 0.15, 0.25, 0.35, 0.5, 0.75, 1, 2],
      registers: [this.registry],
    });
    this.bobLiveContextUpdates = new Counter({
      name: 'bob_live_context_updates_total',
      help: 'Publications de contexte écran Bob Live par résultat monotone',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.bobLiveOutputAudits = new Counter({
      name: 'bob_live_output_audits_total',
      help: 'Audits du transcript audio Bob contre la réponse canonique',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.bobLiveUsageUnits = new Counter({
      name: 'bob_live_usage_units_total',
      help: 'Unités d’usage Realtime remontées par le provider ; table de prix appliquée hors métrique',
      labelNames: ['model', 'kind'],
      registers: [this.registry],
    });
    this.bobLiveFallbacks = new Counter({
      name: 'bob_live_fallbacks_total',
      help: 'Basculements du transport Bob Live vers un mode dégradé',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.bobLiveEntitlementChecks = new Counter({
      name: 'bob_live_entitlement_checks_total',
      help: 'Décisions serveur d’accès à Bob Live par plan, avant admission et coût fournisseur.',
      labelNames: ['outcome', 'plan'] as const,
      registers: [this.registry],
    });
    this.agentMissionNegotiations = new Counter({
      name: 'bob_agent_mission_negotiations_total',
      help: 'Négociations du protocole Mission, sans identité ni contenu métier.',
      labelNames: ['requested', 'outcome', 'provider', 'transport'] as const,
      registers: [this.registry],
    });
    this.agentMissionCapabilityRejections = new Counter({
      name: 'bob_agent_mission_capability_rejections_total',
      help: 'Capabilities Mission refusées selon une taxonomie bornée, sans secret ni hash.',
      labelNames: ['operation', 'reason'] as const,
      registers: [this.registry],
    });
    this.agentMissionForegroundContentions = new Counter({
      name: 'bob_agent_mission_foreground_contentions_total',
      help: 'Indisponibilités transactionnelles bornées du premier plan Mission, sans identité.',
      labelNames: ['operation', 'reason'] as const,
      registers: [this.registry],
    });
    this.agentMissionBootstrapReceipts = new Counter({
      name: 'bob_agent_mission_bootstrap_receipts_total',
      help: 'Résultats du reçu applicatif one-shot du bootstrap Mission.',
      labelNames: ['outcome'] as const,
      registers: [this.registry],
    });
    this.agentMissionScreenAcks = new Counter({
      name: 'bob_agent_mission_screen_ack_total',
      help: 'Résultats des ACK écran Mission, sans route libre ni identifiant.',
      labelNames: ['outcome'] as const,
      registers: [this.registry],
    });
    this.cabinetOperations = new Counter({
      name: 'cabinet_operations_total',
      help: 'Opérations de l’Espace Cabinet par résultat',
      labelNames: ['operation', 'outcome'],
      registers: [this.registry],
    });
    this.cabinetAuthorizationDenials = new Counter({
      name: 'cabinet_authorization_denials_total',
      help: 'Refus RBAC/RLS observés sur les routes Cabinet',
      labelNames: ['operation', 'reason'],
      registers: [this.registry],
    });
    this.cabinetFlagEvaluations = new Counter({
      name: 'cabinet_release_flag_evaluations_total',
      help: 'Décisions des release flags Cabinet, y compris les fermetures sur panne',
      labelNames: ['key', 'source', 'enabled'],
      registers: [this.registry],
    });
    this.cabinetInvitationDeliveries = new Counter({
      name: 'cabinet_invitation_delivery_total',
      help: 'Résultats de traitement de l’outbox des invitations cabinet',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.cabinetInvitationOldestEncryptedSeconds = new Gauge({
      name: 'cabinet_invitation_oldest_encrypted_seconds',
      help: 'Âge du plus ancien secret chiffré non terminal dans l’outbox du cabinet pilote',
      labelNames: ['cabinet_id'],
      registers: [this.registry],
    });
    this.cabinetInvitationWorkerLastSuccess = new Gauge({
      name: 'cabinet_invitation_worker_last_success_unixtime',
      help: 'Dernier sweep outbox réussi par cabinet pilote, en secondes Unix',
      labelNames: ['cabinet_id'],
      registers: [this.registry],
    });
  }
}

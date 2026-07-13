import { Module, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BackendService } from '../../backend.service';
import { loadEnv } from '../../config/env';
import { AppLogger } from '../../observability/logger';
import { Metrics } from '../../observability/metrics';
import { ScheduledTenantDirectory } from '../../jobs/tenant-directory';
import { PersistenceModule } from '../../persistence/persistence.module';
import { PERSISTENCE, type Persistence } from '../../persistence/persistence';
import { OpenAiRealtimeCallAdapter } from './openai-realtime-call.adapter';
import { realtimeAdmissionPolicyFromEnv } from './realtime-admission';
import { RealtimeVoiceController } from './realtime.controller';
import {
  REALTIME_REAPER_TENANT_DIRECTORY,
  RealtimeAdmissionReaperScheduler,
} from './realtime-reaper.scheduler';
import { RealtimeSidebandManager } from './realtime-sideband';
import { RealtimeVoiceService } from './realtime.service';
import { RealtimeBobAgentTurnAdapter } from './realtime-agent-turn';
import { RealtimeBackendEntitlementAdapter } from './realtime-entitlement';
import {
  OPENAI_REALTIME_CALL_PROVIDER,
  REALTIME_ADMISSION,
  REALTIME_AGENT_TURN,
  REALTIME_ENTITLEMENT,
  REALTIME_SIDEBAND,
  REALTIME_VOICE_SETTINGS,
} from './realtime.tokens';
import {
  realtimeVoiceSettingsFromEnv,
  type OpenAiRealtimeCallProvider,
  type RealtimeVoiceSettings,
} from './realtime.types';

const settingsProvider: Provider = {
  provide: REALTIME_VOICE_SETTINGS,
  useFactory: (): RealtimeVoiceSettings => realtimeVoiceSettingsFromEnv(loadEnv()),
};

const openAiProvider: Provider = {
  provide: OPENAI_REALTIME_CALL_PROVIDER,
  inject: [REALTIME_VOICE_SETTINGS],
  useFactory: (settings: RealtimeVoiceSettings) => new OpenAiRealtimeCallAdapter(settings),
};

const admissionProvider: Provider = {
  provide: REALTIME_ADMISSION,
  inject: [PERSISTENCE],
  useFactory: (persistence: Persistence) => persistence.createRealtimeAdmission(
    realtimeAdmissionPolicyFromEnv(loadEnv()),
  ),
};

const sidebandProvider: Provider = {
  provide: REALTIME_SIDEBAND,
  inject: [REALTIME_VOICE_SETTINGS, OPENAI_REALTIME_CALL_PROVIDER, Metrics, AppLogger],
  useFactory: (
    settings: RealtimeVoiceSettings,
    callProvider: OpenAiRealtimeCallProvider,
    metrics: Metrics,
    logger: AppLogger,
  ) => new RealtimeSidebandManager(settings, callProvider, metrics, logger),
};

const realtimeAgentTurnProvider: Provider = {
  provide: REALTIME_AGENT_TURN,
  inject: [PERSISTENCE, ModuleRef],
  useFactory: (persistence: Persistence, moduleRef: ModuleRef) => new RealtimeBobAgentTurnAdapter(
    persistence,
    // Résolution tardive : RealtimeVoiceModule est enfant d'AppModule, qui possède BackendService.
    // `strict:false` traverse le conteneur sans introduire un cycle de modules Nest.
    () => moduleRef.get(BackendService, { strict: false }),
  ),
};

const realtimeEntitlementProvider: Provider = {
  provide: REALTIME_ENTITLEMENT,
  inject: [PERSISTENCE, ModuleRef],
  useFactory: (persistence: Persistence, moduleRef: ModuleRef) => new RealtimeBackendEntitlementAdapter(
    persistence,
    () => moduleRef.get(BackendService, { strict: false }),
  ),
};

const reaperTenantDirectoryProvider: Provider = {
  provide: REALTIME_REAPER_TENANT_DIRECTORY,
  inject: [PERSISTENCE, AppLogger],
  useFactory: (persistence: Persistence, logger: AppLogger) => new ScheduledTenantDirectory(persistence, logger),
};

@Module({
  imports: [PersistenceModule],
  controllers: [RealtimeVoiceController],
  providers: [
    settingsProvider,
    openAiProvider,
    admissionProvider,
    realtimeAgentTurnProvider,
    realtimeEntitlementProvider,
    sidebandProvider,
    reaperTenantDirectoryProvider,
    RealtimeAdmissionReaperScheduler,
    RealtimeVoiceService,
  ],
})
export class RealtimeVoiceModule {}

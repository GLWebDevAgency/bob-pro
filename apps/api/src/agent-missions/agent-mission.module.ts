import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { realtimeVoiceSettingsProvider } from '../voice/realtime/realtime-settings.provider';
import { AgentMissionController } from './agent-mission.controller';
import { agentMissionFingerprintProvider } from './agent-mission-fingerprint.provider';
import { agentMissionHttpAuthorityProvider } from './agent-mission-http-authority';
import { AgentMissionService } from './agent-mission.service';

/**
 * Tranche verticale isolée et compilable. AppModule ne recopie aucun de ses providers : la DI
 * testée ici est donc exactement celle du runtime.
 */
@Module({
  imports: [ObservabilityModule, PersistenceModule],
  controllers: [AgentMissionController],
  providers: [
    AgentMissionService,
    realtimeVoiceSettingsProvider,
    agentMissionHttpAuthorityProvider,
    agentMissionFingerprintProvider,
  ],
})
export class AgentMissionModule {}

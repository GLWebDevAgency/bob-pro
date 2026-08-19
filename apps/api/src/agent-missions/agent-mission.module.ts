import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { realtimeVoiceSettingsProvider } from '../voice/realtime/realtime-settings.provider';
import { AgentMissionController } from './agent-mission.controller';
import {
  AGENT_MISSION_FINGERPRINTS,
  agentMissionFingerprintProvider,
} from './agent-mission-fingerprint.provider';
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
  // AGENT_MISSION_FINGERPRINTS est EXPORTÉ : le vertical Jarvis (U1-d) signe ses reçus avec CE
  // keyring, jamais avec un second. Un token non exporté resterait invisible à son module et
  // ferait échouer le boot — une deuxième instance ferait pire : deux vérités de signature.
  exports: [AgentMissionService, AGENT_MISSION_FINGERPRINTS],
})
export class AgentMissionModule {}

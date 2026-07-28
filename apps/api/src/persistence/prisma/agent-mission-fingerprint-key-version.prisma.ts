import { Prisma } from '@prisma/client';
import {
  canonicalAgentMissionFingerprintKeyBindings,
  type AgentMissionFingerprintKeyBinding,
  type AgentMissionFingerprintKeyVersionAuthority,
} from '../../agent-missions/agent-mission-fingerprint-key-version';
import type { PrismaService } from './prisma.service';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_READINESS_ROWS = 65;
const MAX_RETAINED_VERSIONS = 32;

function readinessQuery(configuredVersions: readonly number[]): Prisma.Sql {
  return Prisma.sql`
    SELECT readiness."keyVersion",
           readiness."keyFingerprint",
           readiness.retained,
           readiness."minimumWriterVersion",
           readiness."highestWriterVersion",
           readiness."writerEnabled"
      FROM public.agent_mission_fingerprint_key_readiness(
        ARRAY[${Prisma.join(configuredVersions)}]::INTEGER[]
      ) AS readiness
     ORDER BY readiness."keyVersion"
  `;
}

/**
 * Readiness globale minimale. Le rôle runtime n'obtient aucun SELECT hors tenant :
 * la fonction SECURITY DEFINER expose uniquement version, engagement SHA-256 et bit de rétention.
 */
export class PrismaAgentMissionFingerprintKeyVersionAuthority
implements AgentMissionFingerprintKeyVersionAuthority {
  private readonly configuredBindings: ReadonlyMap<number, string>;
  private readonly configuredVersions: readonly number[];

  constructor(
    private readonly prisma: PrismaService,
    configuredBindings: readonly AgentMissionFingerprintKeyBinding[],
    private readonly currentVersion: number,
  ) {
    const canonical = canonicalAgentMissionFingerprintKeyBindings(configuredBindings);
    if (canonical === null) {
      throw new Error('AgentMission fingerprint HMAC key bindings are invalid.');
    }
    this.configuredBindings = new Map(
      canonical.map(({ keyVersion, keyFingerprint }) => [keyVersion, keyFingerprint]),
    );
    this.configuredVersions = Object.freeze(
      canonical.map(({ keyVersion }) => keyVersion),
    );
    if (!this.configuredBindings.has(currentVersion)) {
      throw new Error('AgentMission fingerprint current HMAC key version is invalid.');
    }
  }

  async assertKeyBindings(): Promise<void> {
    if (this.prisma.inTransaction()) {
      throw new Error('AgentMission fingerprint readiness requires a root transaction.');
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
      // Les SET de la fonction SECURITY DEFINER commencent après le statement appelant et ne
      // bornent donc pas ce statement lui-même. Le caller arme explicitement les deux délais.
      await transaction.$executeRaw`SET LOCAL lock_timeout = '1s'`;
      await transaction.$executeRaw`SET LOCAL statement_timeout = '3s'`;
      const rows = await transaction.$queryRaw<Array<{
        keyVersion: number;
        keyFingerprint: string | null;
        retained: boolean;
        minimumWriterVersion: number | null;
        highestWriterVersion: number | null;
        writerEnabled: boolean | null;
      }>>(readinessQuery(this.configuredVersions));
      if (
        rows.length < this.configuredVersions.length
        || rows.length > MAX_READINESS_ROWS
        || new Set(rows.map(({ keyVersion }) => keyVersion)).size !== rows.length
        || rows.some(({
          keyVersion,
          keyFingerprint,
          retained,
          minimumWriterVersion,
          highestWriterVersion,
          writerEnabled,
        }) => (
          !Number.isSafeInteger(keyVersion)
          || keyVersion < 1
          || keyVersion > 2_147_483_647
          || (
            keyFingerprint !== null
            && (typeof keyFingerprint !== 'string' || !SHA256.test(keyFingerprint))
          )
          || typeof retained !== 'boolean'
          || !Number.isSafeInteger(minimumWriterVersion)
          || !Number.isSafeInteger(highestWriterVersion)
          || typeof writerEnabled !== 'boolean'
          || (minimumWriterVersion as number) < 1
          || (highestWriterVersion as number) < (minimumWriterVersion as number)
          || (highestWriterVersion as number) > (minimumWriterVersion as number) + 1
        ))
        || rows.filter(({ retained }) => retained).length > MAX_RETAINED_VERSIONS
      ) {
        throw new Error('AgentMission fingerprint key readiness output is invalid.');
      }
      const floors = new Set(rows.map(({
        minimumWriterVersion,
        highestWriterVersion,
        writerEnabled,
      }) => `${minimumWriterVersion}:${highestWriterVersion}:${writerEnabled}`));
      const first = rows[0]!;
      if (
        floors.size !== 1
        || first.minimumWriterVersion === null
        || first.highestWriterVersion === null
        || first.writerEnabled !== true
        || this.currentVersion < first.minimumWriterVersion
        || this.currentVersion > first.highestWriterVersion
        || !this.configuredBindings.has(first.minimumWriterVersion)
        || !this.configuredBindings.has(first.highestWriterVersion)
      ) {
        throw new Error('AgentMission fingerprint writer key floor is not ready.');
      }

      const observed = new Map(rows.map((row) => [row.keyVersion, row] as const));
      for (const [keyVersion, configuredFingerprint] of this.configuredBindings) {
        const binding = observed.get(keyVersion);
        if (binding?.keyFingerprint !== configuredFingerprint) {
          throw new Error(
            `AgentMission fingerprint HMAC key material does not match durable version ${keyVersion}.`,
          );
        }
      }
      for (const { keyVersion, keyFingerprint, retained } of rows) {
        if (!retained) continue;
        const configuredFingerprint = this.configuredBindings.get(keyVersion);
        if (configuredFingerprint === undefined) {
          throw new Error(
            `AgentMission fingerprint HMAC key version ${keyVersion} is retained but unavailable.`,
          );
        }
        if (keyFingerprint !== configuredFingerprint) {
          throw new Error(
            `AgentMission fingerprint HMAC retained binding ${keyVersion} is inconsistent.`,
          );
        }
      }
    });
  }
}

import { describe, expect, it } from 'vitest';
import {
  buildArchiveAuditSafeEnvelope,
  buildExternalValidatorEnvironment,
  buildProtocolV2VerifiedReport,
  buildValidatorSandboxArguments,
  finalizeArchiveAuditRun,
  parseArchiveAuditRuntimeConfig,
  SupabaseArchiveAuditStorage,
} from './document-archive-audit.main';

describe('finalizeArchiveAuditRun', () => {
  it('publie seulement après la fin du travail et la libération de toutes les ressources', async () => {
    const events: string[] = [];

    const outcome = await finalizeArchiveAuditRun({
      work: async () => {
        events.push('work');
        return { ready: true };
      },
      cleanup: async () => {
        events.push('cleanup');
      },
      publish: () => {
        events.push('publish');
      },
    });

    expect(outcome).toEqual({ ready: true });
    expect(events).toEqual(['work', 'cleanup', 'publish']);
  });

  it('ne publie pas quand la libération échoue après un travail committé', async () => {
    const events: string[] = [];
    const cleanupError = new Error('disconnect failed');

    await expect(
      finalizeArchiveAuditRun({
        work: async () => {
          events.push('work');
          return { ready: true };
        },
        cleanup: async () => {
          events.push('cleanup');
          throw cleanupError;
        },
        publish: () => {
          events.push('publish');
        },
      }),
    ).rejects.toBe(cleanupError);
    expect(events).toEqual(['work', 'cleanup']);
  });

  it('préserve l’erreur métier initiale tout en tentant toujours le nettoyage', async () => {
    const workError = new Error('audit failed');
    const events: string[] = [];

    await expect(
      finalizeArchiveAuditRun({
        work: async () => {
          events.push('work');
          throw workError;
        },
        cleanup: async () => {
          events.push('cleanup');
          throw new Error('disconnect failed too');
        },
        publish: () => {
          events.push('publish');
        },
      }),
    ).rejects.toBe(workError);
    expect(events).toEqual(['work', 'cleanup']);
  });
});

function protocolV2ByteAudit() {
  return {
    schemaVersion: 1 as const,
    auditedAt: '2026-07-21T12:00:00.000Z',
    releaseSha: 'a'.repeat(40),
    databaseFingerprint: 'd'.repeat(64),
    databaseSnapshotDigest: 'e'.repeat(64),
    storageBucket: 'bob-documents',
    inventoryDigest: 'f'.repeat(64),
    protocolVersion: 2,
    mode: 'audit' as const,
    validators: {
      representationDetector: 1 as const,
      mustang: '2.24.0' as const,
      fnfe: '1.4.0.02' as const,
    },
    readyForActivation: true,
    counts: {
      generatedLegalDocuments: 3,
      objectsRead: 3,
      existingAttestations: 2,
      appliedAttestations: 0,
      externallyValidatedProfessionalInvoices: 1,
      storageOrphans: 0,
      missingStoredObjects: 0,
      p0Issues: 0,
    },
    issues: [],
  };
}

function protocolV2RelationalState(overrides = {}) {
  return {
    databaseIdentity: '123e4567-e89b-42d3-a456-426614174000',
    activatedAt: new Date('2026-07-21T11:00:00.000Z'),
    activatedByReleaseSha: 'b'.repeat(40),
    generatedLegalDocuments: 3,
    invalidGeneratedLegalDocuments: 0,
    existingAttestations: 2,
    invalidArchiveJobs: 0,
    storageOrphans: 0,
    missingStoredObjects: 0,
    suspiciousStorageMutations: 0,
    postScanSnapshotDigest: 'e'.repeat(64),
    baseline: {
      inventoryDigest: '1'.repeat(64),
      reportSha256: '2'.repeat(64),
      validatorEvidenceDigest: '3'.repeat(64),
      validatorVersions: {
        representationDetector: 1,
        mustang: '2.24.0',
        fnfe: '1.4.0.02',
      },
      storageBucket: 'bob-documents',
    },
    ...overrides,
  };
}

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    DIRECT_URL: 'postgresql://authority.invalid/bob',
    DATABASE_URL: 'postgresql://runtime.invalid/bob',
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co/',
    DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
    SUPABASE_STORAGE_BUCKET: 'bob-documents',
    SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-role',
    DOCUMENT_ARCHIVE_AUDIT_OUTPUT: './evidence/archive.json',
    DOCUMENT_ARCHIVE_AUDIT_DEPLOYMENT_ID: '123e4567-e89b-42d3-a456-426614174000',
    DOCUMENT_ARCHIVE_MUSTANG_JAR: '/opt/validators/mustang.jar',
    DOCUMENT_ARCHIVE_FNFE_BUNDLE: '/opt/validators/fnfe',
    DOCUMENT_ARCHIVE_VALIDATOR_SANDBOX: '/usr/bin/bwrap',
    RELEASE_SHA: 'a'.repeat(40),
  };
}

describe('parseArchiveAuditRuntimeConfig', () => {
  it('reste en lecture seule par défaut et normalise les paramètres sans inventer de secret', () => {
    const config = parseArchiveAuditRuntimeConfig(validEnvironment());

    expect(config).toMatchObject({
      applyAttestations: false,
      bucket: 'bob-documents',
      maxObjectBytes: 64 * 1024 * 1024,
      releaseSha: 'a'.repeat(40),
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      deploymentId: '123e4567-e89b-42d3-a456-426614174000',
      mustangJarPath: '/opt/validators/mustang.jar',
      fnfeBundlePath: '/opt/validators/fnfe',
      validatorSandboxPath: '/usr/bin/bwrap',
    });
    expect(config.outputPath).toMatch(/evidence\/archive\.json$/u);
  });

  it('exige un opt-in canonique et un SHA de release complet', () => {
    expect(() =>
      parseArchiveAuditRuntimeConfig({
        ...validEnvironment(),
        DOCUMENT_ARCHIVE_AUDIT_APPLY_ATTESTATIONS: 'yes',
      }),
    ).toThrow(/true ou false/u);
    expect(() =>
      parseArchiveAuditRuntimeConfig({
        ...validEnvironment(),
        RELEASE_SHA: 'abc123',
      }),
    ).toThrow(/SHA Git complet/u);
    expect(() =>
      parseArchiveAuditRuntimeConfig({
        ...validEnvironment(),
        DOCUMENT_ARCHIVE_AUDIT_DEPLOYMENT_ID: 'not-a-uuid',
      }),
    ).toThrow(/UUID canonique/u);
  });

  it('refuse une configuration partielle et une limite mémoire non bornée', () => {
    const withoutRuntime = validEnvironment();
    delete withoutRuntime.DATABASE_URL;
    expect(() => parseArchiveAuditRuntimeConfig(withoutRuntime)).toThrow(/DATABASE_URL/u);
    const withoutBucket = validEnvironment();
    delete withoutBucket.SUPABASE_STORAGE_BUCKET;
    expect(() => parseArchiveAuditRuntimeConfig(withoutBucket)).toThrow(/SUPABASE_STORAGE_BUCKET/u);
    expect(() =>
      parseArchiveAuditRuntimeConfig({
        ...validEnvironment(),
        DOCUMENT_ARCHIVE_AUDIT_MAX_OBJECT_BYTES: String(513 * 1024 * 1024),
      }),
    ).toThrow(/536870912/u);
  });

  it('ne transmet la service-role qu’au projet Supabase explicitement épinglé', () => {
    expect(() =>
      parseArchiveAuditRuntimeConfig({
        ...validEnvironment(),
        SUPABASE_URL: 'https://evil.invalid',
      }),
    ).toThrow(/SUPABASE_PROJECT_REF/u);
    expect(() =>
      parseArchiveAuditRuntimeConfig({
        ...validEnvironment(),
        SUPABASE_URL: 'https://otherprojectref0000.supabase.co',
      }),
    ).toThrow(/SUPABASE_PROJECT_REF/u);
  });
});

describe('buildValidatorSandboxArguments', () => {
  it('isole le réseau, les processus et l’environnement du validateur', () => {
    const arguments_ = buildValidatorSandboxArguments({
      repositoryRoot: '/repo',
      workDirectory: '/tmp/audit-123',
      command: '/usr/bin/java',
      arguments: ['-jar', '/opt/validator.jar'],
      additionalEnvironment: { FNFE_RUN_SENTINEL: 'true' },
    });

    expect(arguments_).toContain('--unshare-net');
    expect(arguments_).toContain('--unshare-pid');
    expect(arguments_).toContain('--clearenv');
    expect(arguments_).toContain('FNFE_RUN_SENTINEL');
    expect(arguments_.join(' ')).not.toMatch(/DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY/u);
  });

  it('refuse toute variable additionnelle non explicitement autorisée', () => {
    expect(() =>
      buildValidatorSandboxArguments({
        repositoryRoot: '/repo',
        workDirectory: '/tmp/audit-123',
        command: '/usr/bin/java',
        arguments: [],
        additionalEnvironment: { DATABASE_URL: 'secret' },
      }),
    ).toThrow(/Variable non autorisée/u);
  });
});

describe('SupabaseArchiveAuditStorage', () => {
  it('rejoue une erreur transitoire puis relit les octets bornés', async () => {
    const payload = new TextEncoder().encode('archive-pdf');
    const responses = [
      new Response('temporary', { status: 503 }),
      new Response(payload, {
        status: 200,
        headers: {
          'content-length': String(payload.byteLength),
          'content-type': 'application/pdf',
        },
      }),
    ];
    const delays: number[] = [];
    const fetchImpl: typeof globalThis.fetch = async () =>
      responses.shift() ?? new Response(null, { status: 500 });
    const storage = new SupabaseArchiveAuditStorage(
      'https://storage.invalid',
      'secret',
      'bob-documents',
      1_024,
      fetchImpl,
      async (milliseconds) => {
        delays.push(milliseconds);
      },
    );

    const loaded = await storage.load(
      'company-1',
      'companies/company-1/documents/document-1/v1/a.pdf',
    );

    expect(loaded?.bytes).toEqual(payload);
    expect(loaded?.contentType).toBe('application/pdf');
    expect(delays).toEqual([250]);
  });

  it('retourne absent sur 404 sans rejouer et refuse les clés hors tenant', async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response('{"statusCode":"404"}', { status: 404 });
    };
    const storage = new SupabaseArchiveAuditStorage(
      'https://storage.invalid',
      'secret',
      'bob-documents',
      1_024,
      fetchImpl,
      async () => undefined,
    );

    await expect(
      storage.load('company-1', 'companies/company-1/documents/missing/v1/a.pdf'),
    ).resolves.toBeNull();
    await expect(
      storage.load('company-1', 'companies/company-2/documents/leak/v1/a.pdf'),
    ).rejects.toThrow(/hors du périmètre tenant/u);
    expect(calls).toBe(1);
  });
});

describe('buildArchiveAuditSafeEnvelope', () => {
  it('ne conserve que la corrélation, les digests, versions et compteurs', () => {
    const envelope = buildArchiveAuditSafeEnvelope({
      deploymentId: '123e4567-e89b-42d3-a456-426614174000',
      reportSha256: 'b'.repeat(64),
      validatorEvidenceSeed: 'c'.repeat(64),
      report: {
        schemaVersion: 1,
        auditedAt: '2026-07-21T12:00:00.000Z',
        releaseSha: 'a'.repeat(40),
        databaseFingerprint: 'd'.repeat(64),
        databaseSnapshotDigest: 'f'.repeat(64),
        storageBucket: 'bob-documents',
        inventoryDigest: 'e'.repeat(64),
        protocolVersion: 1,
        mode: 'apply-attestations',
        validators: { representationDetector: 1, mustang: '2.24.0', fnfe: '1.4.0.02' },
        readyForActivation: true,
        counts: {
          generatedLegalDocuments: 2,
          objectsRead: 2,
          existingAttestations: 2,
          appliedAttestations: 0,
          externallyValidatedProfessionalInvoices: 1,
          storageOrphans: 0,
          missingStoredObjects: 0,
          p0Issues: 0,
        },
        issues: [],
      },
    });

    expect(envelope).toMatchObject({
      deploymentId: '123e4567-e89b-42d3-a456-426614174000',
      releaseSha: 'a'.repeat(40),
      readyForActivation: true,
      reportSha256: 'b'.repeat(64),
      issueCodes: [],
    });
    expect(envelope).not.toHaveProperty('storageBucket');
    expect(envelope).not.toHaveProperty('issues');
    expect(envelope.validatorEvidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('buildProtocolV2VerifiedReport', () => {
  it('conserve les preuves octet et validateurs dans l’unique rapport V2', () => {
    const report = buildProtocolV2VerifiedReport({
      byteAudit: protocolV2ByteAudit(),
      relational: protocolV2RelationalState(),
      auditedAt: new Date('2026-07-21T12:00:00.000Z'),
      releaseSha: 'a'.repeat(40),
      storageBucket: 'bob-documents',
    });

    expect(report).toMatchObject({
      mode: 'protocol-v2-verified',
      readyForActivation: true,
      counts: {
        objectsRead: 3,
        externallyValidatedProfessionalInvoices: 1,
        appliedAttestations: 0,
        p0Issues: 0,
      },
      issues: [],
    });
    expect(report.inventoryDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.inventoryDigest).not.toBe(protocolV2ByteAudit().inventoryDigest);
  });

  it('refuse une course SQL/Storage ou une tentative d’attestation tardive', () => {
    const byteAudit = protocolV2ByteAudit();
    byteAudit.counts.appliedAttestations = 1;
    const report = buildProtocolV2VerifiedReport({
      byteAudit,
      relational: protocolV2RelationalState({ postScanSnapshotDigest: '9'.repeat(64) }),
      auditedAt: new Date('2026-07-21T12:00:00.000Z'),
      releaseSha: 'a'.repeat(40),
      storageBucket: 'bob-documents',
    });

    expect(report.readyForActivation).toBe(false);
    expect(report.counts.appliedAttestations).toBe(0);
    expect(report.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'ARCHIVE_PROTOCOL_V2_SCAN_RACE_DETECTED',
        'ARCHIVE_PROTOCOL_V2_LATE_ATTESTATION_WRITE',
      ]),
    );
  });
});

describe('buildExternalValidatorEnvironment', () => {
  it('ne transmet aucun secret Bob aux processus Mustang, Saxon, curl ou xmllint', () => {
    const childEnvironment = buildExternalValidatorEnvironment(
      {
        PATH: '/trusted/bin',
        DATABASE_URL: 'postgresql://secret',
        DIRECT_URL: 'postgresql://authority-secret',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
        OPENAI_API_KEY: 'provider-secret',
        NODE_OPTIONS: '--require /tmp/untrusted.js',
        JAVA_TOOL_OPTIONS: '-javaagent:/tmp/untrusted.jar',
      },
      '/tmp/validator-home',
    );

    expect(childEnvironment).toEqual({
      PATH: '/trusted/bin',
      HOME: '/tmp/validator-home',
      TMPDIR: '/tmp/validator-home',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      CI: 'true',
    });
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260719082000_mistral_conversation_terminal_receipts/migration.sql',
  ),
  'utf8',
);
const retentionMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260719090000_mistral_conversation_ordered_retention/migration.sql',
  ),
  'utf8',
);
const release = readFileSync(resolve(process.cwd(), 'scripts/release.sh'), 'utf8');
const certification = readFileSync(
  resolve(process.cwd(), 'scripts/certify-mistral-conversation-authority.sh'),
  'utf8',
);

describe('Mistral conversation terminal receipt migration', () => {
  it('installe la capture sous verrou DDL avant tout backfill idempotent', () => {
    const trigger = migration.indexOf(
      'CREATE TRIGGER realtime_mistral_conversation_00_terminal_receipt',
    );
    const backfill = migration.indexOf(
      '\nINSERT INTO "realtime_mistral_conversation_terminal_receipts" (',
      trigger,
    );

    expect(trigger).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(trigger);
    expect(migration.slice(backfill)).toContain(
      'ON CONFLICT ("companyId", "sessionHandle") DO NOTHING;',
    );
  });

  it('ferme les deux purges derrière un owner NOLOGIN et des ACL EXECUTE exactes', () => {
    expect(retentionMigration.match(/SECURITY DEFINER/gu)).toHaveLength(2);
    expect(retentionMigration.match(/SET search_path = pg_catalog/gu)).toHaveLength(2);
    expect(retentionMigration.match(/SET row_security = on/gu)).toHaveLength(2);
    expect(retentionMigration).toContain(
      'REVOKE ALL ON FUNCTION purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER) FROM PUBLIC;',
    );
    expect(retentionMigration).toContain(
      'REVOKE ALL ON FUNCTION purge_realtime_mistral_conversation_retention(INTEGER) FROM PUBLIC;',
    );

    for (const provisioning of [release, certification]) {
      expect(provisioning).toContain(
        "SET createrole_self_grant = 'set'",
      );
      expect(provisioning).toContain(
        'bob_mistral_bootstrap_reaper is not available through implicit SET membership',
      );
      expect(provisioning).toContain(
        'membership.set_option',
      );
      expect(provisioning).toContain(
        'NOT membership.inherit_option',
      );
      expect(provisioning).not.toMatch(
        /GRANT\s+(?:%I|bob_mistral_bootstrap_reaper)\s+TO\s+CURRENT_USER/iu,
      );
      expect(provisioning).toContain(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
      );
      expect(provisioning).toContain(
        'Mistral retention function ACL contains an unexpected grant',
      );
      expect(provisioning).toContain(
        'REVOKE CREATE ON SCHEMA public FROM bob_mistral_bootstrap_reaper',
      );
      expect(provisioning).toContain('FROM PUBLIC CASCADE');
      expect(provisioning).toContain(
        'Mistral retention scoped table or column ACL exposes PUBLIC',
      );
      expect(provisioning).not.toContain('DROP OWNED BY bob_mistral_bootstrap_reaper');
    }
    expect(release).not.toContain(
      'GRANT bob_mistral_bootstrap_reaper TO :"app_role"',
    );
    expect(certification).not.toContain(
      'GRANT bob_mistral_bootstrap_reaper TO :"runtime_role"',
    );
  });
});

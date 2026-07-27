import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M1B_ACTIVE_EVIDENCE_SQL,
  M1B_CANCELLATION_RECOVERY_EVIDENCE_SQL,
  M1B_CLEAN_EVIDENCE_SQL,
  M1B_FINAL_EVIDENCE_SQL,
  M1B_NEGATIVE_FINAL_EVIDENCE_SQL,
  M1B_START_RECOVERY_EVIDENCE_SQL,
  certifyM1BActiveEvidence,
  certifyM1BCancellationRecoveryEvidence,
  certifyM1BCleanEvidence,
  certifyM1BFinalEvidence,
  certifyM1BNegativeFinalEvidence,
  certifyM1BStartRecoveryEvidence,
  decodeM1BActiveEvidence,
  decodeM1BCancellationRecoveryEvidence,
  decodeM1BCleanEvidence,
  decodeM1BFinalEvidence,
  decodeM1BNegativeFinalEvidence,
  decodeM1BStartRecoveryEvidence,
  parseM1BStagingEvidenceEnvironment,
} from './agent-mission-m1b-staging-evidence.mjs';

const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const START_COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const ACK_COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const CANCEL_COMMAND_ID = '55555555-5555-4555-8555-555555555555';

function environment(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://bob_app:secret@db.example.test/postgres',
    APP_DATABASE_ROLE: 'bob_app',
    BOB_M1B_STAGING_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
    BOB_M1B_STAGING_COMPANY_ID: 'company-staging',
    BOB_M1B_STAGING_USER_ID: '66666666-6666-4666-8666-666666666666',
    ...overrides,
  };
}

function activeInput(overrides = {}) {
  return {
    missionId: MISSION_ID,
    sessionId: SESSION_ID,
    startCommandId: START_COMMAND_ID,
    ackCommandId: ACK_COMMAND_ID,
    missionRevision: 2,
    contextRevision: 1,
    contextDigest: 'a'.repeat(64),
    screenInstanceId: 'devis-new:m1b-staging',
    draftSessionId: 'draft-m1b-staging',
    draftSlotRevision: 1,
    draftContentRevision: 0,
    ...overrides,
  };
}

function activeProof(overrides = {}) {
  return {
    roleMatches: true,
    roleSafe: true,
    missionCount: 1,
    missionMatches: true,
    eventCount: 2,
    eventsMatch: true,
    draftCount: 1,
    draftMatches: true,
    leaseCount: 1,
    leaseMatches: true,
    sentinelMissionCount: 0,
    sentinelEventCount: 0,
    sentinelDraftCount: 0,
    sentinelLeaseCount: 0,
    ...overrides,
  };
}

function finalProof(overrides = {}) {
  return {
    roleMatches: true,
    roleSafe: true,
    missionCount: 1,
    missionCancelled: true,
    eventCount: 3,
    eventsMatch: true,
    draftCount: 0,
    leaseCount: 0,
    activeMissionCount: 0,
    ...overrides,
  };
}

function cleanProof(overrides = {}) {
  return {
    roleMatches: true,
    roleSafe: true,
    activeMissionCount: 0,
    draftCount: 0,
    protocolLeaseCount: 0,
    ...overrides,
  };
}

function startRecoveryProof(overrides = {}) {
  return {
    roleMatches: true,
    roleSafe: true,
    recoveryCount: 1,
    recoveryMatches: true,
    activeMissionCount: 1,
    draftCount: 1,
    missionId: MISSION_ID,
    missionRevision: 1,
    draftSessionId: 'draft-m1b-staging',
    draftSlotRevision: 1,
    draftContentRevision: 0,
    ...overrides,
  };
}

function cancellationRecoveryProof(overrides = {}) {
  return {
    roleMatches: true,
    roleSafe: true,
    recoveryCount: 1,
    recoveryMatches: true,
    missionId: MISSION_ID,
    missionRevision: 3,
    terminalAt: '2026-07-27T12:00:00.000Z',
    ...overrides,
  };
}

function negativeFinalProof(overrides = {}) {
  return {
    roleMatches: true,
    roleSafe: true,
    sessionLeaseCount: 0,
    activeMissionCount: 0,
    draftCount: 0,
    ...overrides,
  };
}

test('exige DATABASE_URL connecté comme le rôle runtime attendu', () => {
  assert.equal(parseM1BStagingEvidenceEnvironment(environment()).appRole, 'bob_app');
  assert.equal(
    parseM1BStagingEvidenceEnvironment(environment({
      DATABASE_URL:
        'postgresql://bob_app.abcdefghijklmnopqrst:secret@pooler.example.test/postgres',
    })).appRole,
    'bob_app',
  );
  assert.throws(
    () => parseM1BStagingEvidenceEnvironment(environment({
      DATABASE_URL: 'postgresql://postgres:secret@db.example.test/postgres',
    })),
    /connect as APP_DATABASE_ROLE/u,
  );
  assert.throws(
    () => parseM1BStagingEvidenceEnvironment(environment({
      BOB_M1B_STAGING_USER_ID: 'user-staging',
    })),
    /must be a UUID/u,
  );
});

test('preuve active exige mission, événements, brouillon, lease et RLS exacts', () => {
  assert.deepEqual(decodeM1BActiveEvidence(activeProof()), {
    stage: 'active',
    passed: true,
  });
  assert.throws(
    () => decodeM1BActiveEvidence(activeProof({ sentinelLeaseCount: 1 })),
    /did not pass exactly/u,
  );
  assert.throws(
    () => decodeM1BActiveEvidence({ ...activeProof(), rawId: MISSION_ID }),
    /shape is invalid/u,
  );
});

test('préflight runtime refuse mission, brouillon ou lease V1 préexistants', () => {
  assert.deepEqual(decodeM1BCleanEvidence(cleanProof()), {
    stage: 'clean',
    passed: true,
  });
  assert.throws(
    () => decodeM1BCleanEvidence(cleanProof({ protocolLeaseCount: 1 })),
    /account\/tenant is not clean/u,
  );
});

test('récupération start lie le commandId à l’unique mission et brouillon vides', () => {
  assert.deepEqual(
    decodeM1BStartRecoveryEvidence(startRecoveryProof()),
    {
      stage: 'start-recovered',
      passed: true,
      mission: {
        id: MISSION_ID,
        status: 'active',
        actionable: true,
        phase: 'awaiting_quote_screen',
        revision: 1,
        currentBinding: null,
        payload: {
          draft: {
            sessionId: 'draft-m1b-staging',
            slotRevision: 1,
            contentRevision: 0,
          },
        },
      },
    },
  );
  assert.throws(
    () => decodeM1BStartRecoveryEvidence(startRecoveryProof({
      activeMissionCount: 2,
    })),
    /start response-loss recovery proof/u,
  );
});

test('récupération cancel exige la transition terminale exacte et horodatée', () => {
  assert.deepEqual(
    decodeM1BCancellationRecoveryEvidence(cancellationRecoveryProof()),
    {
      stage: 'cancellation-recovered',
      passed: true,
      mission: {
        id: MISSION_ID,
        status: 'cancelled',
        actionable: false,
        revision: 3,
        terminalAt: '2026-07-27T12:00:00.000Z',
      },
    },
  );
  assert.throws(
    () => decodeM1BCancellationRecoveryEvidence(cancellationRecoveryProof({
      recoveryMatches: false,
    })),
    /cancellation response-loss recovery proof/u,
  );
});

test('preuve finale exige mission annulée, journal complet, brouillon et lease absents', () => {
  assert.deepEqual(decodeM1BFinalEvidence(finalProof()), {
    stage: 'final',
    passed: true,
  });
  assert.throws(
    () => decodeM1BFinalEvidence(finalProof({ draftCount: 1 })),
    /cleanup proof did not pass/u,
  );
});

test('preuve OFF finale exige la disparition de la lease exacte après hangup', () => {
  assert.deepEqual(decodeM1BNegativeFinalEvidence(negativeFinalProof()), {
    stage: 'negative-final',
    passed: true,
  });
  assert.throws(
    () => decodeM1BNegativeFinalEvidence(negativeFinalProof({
      sessionLeaseCount: 1,
    })),
    /negative runtime cleanup proof/u,
  );
});

test('certification passe les identités en variables psql et ne les imprime pas dans le SQL', () => {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: `${JSON.stringify(activeProof())}\n`,
      stderr: '',
    };
  };
  assert.deepEqual(
    certifyM1BActiveEvidence(activeInput(), environment(), { spawnSync }),
    { stage: 'active', passed: true },
  );
  assert.equal(calls[0].command, 'psql');
  assert.equal(calls[0].options.input, M1B_ACTIVE_EVIDENCE_SQL);
  assert.equal(calls[0].options.input.includes(MISSION_ID), false);
  assert.equal(calls[0].options.input.includes('secret'), false);
  assert.equal(calls[0].args.includes(`mission_id=${MISSION_ID}`), true);
});

test('certification de propreté utilise le rôle runtime et un SQL sans identifiant brut', () => {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: `${JSON.stringify(cleanProof())}\n`,
      stderr: '',
    };
  };
  assert.deepEqual(certifyM1BCleanEvidence(environment(), { spawnSync }), {
    stage: 'clean',
    passed: true,
  });
  assert.equal(calls[0].options.input, M1B_CLEAN_EVIDENCE_SQL);
  assert.equal(calls[0].options.input.includes(environment().BOB_M1B_STAGING_COMPANY_ID), false);
  assert.equal(calls[0].args.includes('company_id=company-staging'), true);
});

test('les récupérations response-loss restent sous rôle runtime et paramètres liés', () => {
  const calls = [];
  const outputs = [
    startRecoveryProof(),
    cancellationRecoveryProof(),
  ];
  const spawnSync = (_command, args, options) => {
    calls.push({ args, options });
    return {
      status: 0,
      stdout: `${JSON.stringify(outputs.shift())}\n`,
      stderr: '',
    };
  };
  assert.equal(
    certifyM1BStartRecoveryEvidence(
      { startCommandId: START_COMMAND_ID },
      environment(),
      { spawnSync },
    ).mission.id,
    MISSION_ID,
  );
  assert.equal(
    certifyM1BCancellationRecoveryEvidence({
      missionId: MISSION_ID,
      startCommandId: START_COMMAND_ID,
      cancelCommandId: CANCEL_COMMAND_ID,
      expectedMissionRevision: 2,
      draftSessionId: 'draft-m1b-staging',
      draftContentRevision: 0,
    }, environment(), { spawnSync }).mission.revision,
    3,
  );
  assert.equal(calls[0].options.input, M1B_START_RECOVERY_EVIDENCE_SQL);
  assert.equal(calls[1].options.input, M1B_CANCELLATION_RECOVERY_EVIDENCE_SQL);
  assert.equal(calls[0].options.input.includes(START_COMMAND_ID), false);
  assert.equal(calls[0].args.includes(`start_command_id=${START_COMMAND_ID}`), true);
  assert.equal(calls[1].args.includes(`cancel_command_id=${CANCEL_COMMAND_ID}`), true);
  assert.equal(calls[1].args.includes('expected_mission_revision=2'), true);
});

test('preuve finale lie les trois commandes et la révision terminale', () => {
  const calls = [];
  const spawnSync = (_command, args, options) => {
    calls.push({ args, options });
    return {
      status: 0,
      stdout: `${JSON.stringify(finalProof())}\n`,
      stderr: '',
    };
  };
  assert.deepEqual(certifyM1BFinalEvidence({
    missionId: MISSION_ID,
    sessionId: SESSION_ID,
    startCommandId: START_COMMAND_ID,
    ackCommandId: ACK_COMMAND_ID,
    cancelCommandId: CANCEL_COMMAND_ID,
    missionRevision: 3,
  }, environment(), { spawnSync }), { stage: 'final', passed: true });
  assert.equal(calls[0].options.input, M1B_FINAL_EVIDENCE_SQL);
  assert.equal(calls[0].args.includes(`cancel_command_id=${CANCEL_COMMAND_ID}`), true);
  assert.equal(calls[0].args.includes('mission_revision=3'), true);
});

test('preuve OFF finale cible uniquement la session créée par le smoke', () => {
  const calls = [];
  const spawnSync = (_command, args, options) => {
    calls.push({ args, options });
    return {
      status: 0,
      stdout: `${JSON.stringify(negativeFinalProof())}\n`,
      stderr: '',
    };
  };
  assert.deepEqual(
    certifyM1BNegativeFinalEvidence(
      { sessionId: SESSION_ID },
      environment(),
      { spawnSync },
    ),
    { stage: 'negative-final', passed: true },
  );
  assert.equal(calls[0].options.input, M1B_NEGATIVE_FINAL_EVIDENCE_SQL);
  assert.equal(calls[0].options.input.includes(SESSION_ID), false);
  assert.equal(calls[0].args.includes(`session_id=${SESSION_ID}`), true);
});

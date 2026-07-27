import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import test from 'node:test';
import { withPsqlChildEnvironment } from './psql-child-environment.mjs';

const CONNECTION_URL =
  'postgresql://postgres.project:secret@pooler.example.test:5432/postgres?sslmode=require';

test('décompose la connexion libpq et isole le mot de passe dans un fichier éphémère', () => {
  const source = {
    PATH: '/usr/bin',
    KEEP_ME: 'yes',
    DATABASE_URL: 'postgresql://runtime:secret@example.test/runtime',
    DIRECT_URL: CONNECTION_URL,
    PGDATABASE: 'foreign',
    PGHOST: 'foreign.example.test',
    PGHOSTADDR: '127.0.0.1',
    PGPORT: '6543',
    PGUSER: 'foreign',
    PGPASSWORD: 'foreign-secret',
    PGPASSFILE: '/tmp/foreign-passfile',
    PGSERVICE: 'foreign',
    PGSERVICEFILE: '/tmp/foreign-service',
  };
  let passwordFile;

  const result = withPsqlChildEnvironment(CONNECTION_URL, source, (child) => {
    passwordFile = child.PGPASSFILE;
    assert.equal(child.PGHOST, 'pooler.example.test');
    assert.equal(child.PGPORT, '5432');
    assert.equal(child.PGDATABASE, 'postgres');
    assert.equal(child.PGUSER, 'postgres.project');
    assert.equal(child.PGSSLMODE, 'require');
    assert.equal(child.PATH, '/usr/bin');
    assert.equal(child.KEEP_ME, 'yes');
    assert.equal(existsSync(passwordFile), true);
    assert.equal(statSync(passwordFile).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(passwordFile, 'utf8'),
      'pooler.example.test:5432:postgres:postgres.project:secret\n',
    );
    assert.equal(Object.hasOwn(child, 'PGPASSWORD'), false);
    for (const name of [
      'DATABASE_URL',
      'DIRECT_URL',
      'PGHOSTADDR',
      'PGSERVICE',
      'PGSERVICEFILE',
    ]) {
      assert.equal(Object.hasOwn(child, name), false, name);
    }
    return 'spawn-result';
  });

  assert.equal(result, 'spawn-result');
  assert.equal(existsSync(passwordFile), false);
  assert.equal(source.DIRECT_URL, CONNECTION_URL);
  assert.equal(source.PGDATABASE, 'foreign');
});

test('refuse une valeur non PostgreSQL ou contenant des contrôles', () => {
  const operation = () => undefined;
  assert.throws(
    () => withPsqlChildEnvironment('https://example.test', {}, operation),
    /missing or invalid/u,
  );
  assert.throws(
    () =>
      withPsqlChildEnvironment(
        'postgresql://postgres:secret@example.test/postgres\n',
        {},
        operation,
      ),
    /missing or invalid/u,
  );
  assert.throws(
    () =>
      withPsqlChildEnvironment(
        'postgresql://postgres:secret@example.test/postgres?connection_limit=5',
        {},
        operation,
    ),
    /missing or invalid/u,
  );
  assert.throws(
    () =>
      withPsqlChildEnvironment(
        'postgresql://postgres:secret%0Ainjected@example.test/postgres',
        {},
        operation,
      ),
    /missing or invalid/u,
  );
});

test('supprime le fichier secret même si le processus enfant échoue', () => {
  let passwordFile;
  assert.throws(
    () =>
      withPsqlChildEnvironment(CONNECTION_URL, {}, (child) => {
        passwordFile = child.PGPASSFILE;
        assert.equal(existsSync(passwordFile), true);
        throw new Error('spawn failed');
      }),
    /spawn failed/u,
  );
  assert.equal(existsSync(passwordFile), false);
});

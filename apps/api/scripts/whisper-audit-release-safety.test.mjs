import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryRoot = new URL('../../../', import.meta.url);
const [
  manifestSource,
  dockerfile,
  railwaySource,
  gateway,
  gatewayTests,
  contract,
  packageSource,
  notices,
  whisperCppLicense,
  openAiWhisperLicense,
  ci,
] = await Promise.all([
  readFile(new URL('infra/whisper-audit/manifest.json', repositoryRoot), 'utf8'),
  readFile(new URL('Dockerfile.whisper-audit', repositoryRoot), 'utf8'),
  readFile(new URL('railway.whisper-audit.json', repositoryRoot), 'utf8'),
  readFile(new URL('infra/whisper-audit/server.mjs', repositoryRoot), 'utf8'),
  readFile(new URL('infra/whisper-audit/server.test.mjs', repositoryRoot), 'utf8'),
  readFile(
    new URL('apps/api/src/ai/local-whisper-audit-contract.ts', repositoryRoot),
    'utf8',
  ),
  readFile(new URL('apps/api/package.json', repositoryRoot), 'utf8'),
  readFile(new URL('infra/whisper-audit/THIRD_PARTY_NOTICES.md', repositoryRoot), 'utf8'),
  readFile(new URL('infra/whisper-audit/LICENSE.whisper.cpp', repositoryRoot), 'utf8'),
  readFile(new URL('infra/whisper-audit/LICENSE.openai-whisper', repositoryRoot), 'utf8'),
  readFile(new URL('.github/workflows/ci.yml', repositoryRoot), 'utf8'),
]);

const manifest = JSON.parse(manifestSource);
const railway = JSON.parse(railwaySource);
const packageJson = JSON.parse(packageSource);

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

test('le moteur et le modèle sont immuables et liés au contrat compilé', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.service, {
    id: 'bob-live-whisper-audit',
    privateHostname: 'bob-live-whisper-audit.railway.internal',
    healthPath: '/v1/health',
    transcriptionPath: '/v1/audio/transcriptions',
  });
  assert.equal(manifest.engine.version, 'v1.9.1');
  assert.equal(
    manifest.engine.sourceUrl,
    `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${manifest.engine.version}.tar.gz`,
  );
  assert.match(manifest.engine.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.model.repositoryRevision.length, 40);
  assert.equal(
    manifest.model.sourceUrl,
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/` +
      `${manifest.model.repositoryRevision}/${manifest.model.artifact}`,
  );
  assert.match(manifest.model.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.model.bytes, 574_041_195);
  assert.doesNotMatch(manifest.engine.sourceUrl, /(?:latest|main|master|releases\/latest)/u);
  assert.doesNotMatch(manifest.model.sourceUrl, /(?:latest|main|master)/u);

  for (const literal of [
    manifest.service.privateHostname,
    manifest.engine.id,
    manifest.engine.version,
    manifest.engine.sourceSha256,
    manifest.model.id,
    manifest.model.sha256,
  ]) {
    assert.equal(
      occurrences(contract, literal),
      1,
      `le contrat TypeScript doit porter une fois la valeur figée ${literal}`,
    );
  }
  assert.match(contract, /bytes:\s*574_041_195/u);
  assert.match(contract, /maxRequestBytes:\s*4_259_840/u);
  assert.match(contract, /\/\^\[\\x21-\\x7e\]\{32,256\}\$\/u/u);
  assert.match(gateway, /\/\^\[\\x21-\\x7e\]\{32,256\}\$\/u/u);
});

test('le build vérifie chaque artefact avant compilation ou copie dans le runtime', () => {
  assert.match(
    dockerfile,
    /^# syntax=docker\/dockerfile:1\.7@sha256:[a-f0-9]{64}$/mu,
  );
  assert.match(
    dockerfile,
    /^FROM node:22\.18\.0-bookworm-slim@sha256:[a-f0-9]{64} AS build$/mu,
  );
  assert.match(
    dockerfile,
    /^FROM gcr\.io\/distroless\/nodejs22-debian12:nonroot@sha256:[a-f0-9]{64} AS runtime$/mu,
  );
  assert.match(
    dockerfile,
    /deb \[check-valid-until=no\] http:\/\/snapshot\.debian\.org\/archive\/debian\/20250915T000000Z bookworm main/u,
  );
  assert.doesNotMatch(dockerfile, /deb\.debian\.org|security\.debian\.org/u);
  assert.doesNotMatch(
    dockerfile,
    /trusted\s*=\s*yes|allow-unauthenticated|AllowInsecureRepositories/u,
  );
  for (const pinnedPackage of [
    'build-essential=12.9',
    'ca-certificates=20230311+deb12u1',
    'cmake=3.25.1-1',
    'curl=7.88.1-10+deb12u14',
  ]) {
    assert.match(dockerfile, new RegExp(pinnedPackage.replaceAll('+', '\\+'), 'u'));
  }
  const sourceDownload = dockerfile.indexOf('--output /build/whisper-source.tar.gz');
  const sourceVerification = dockerfile.indexOf(
    "sha256sum -c -",
    sourceDownload,
  );
  const sourceExtraction = dockerfile.indexOf('tar --extract', sourceVerification);
  const compilation = dockerfile.indexOf('cmake --build', sourceExtraction);
  assert.ok(
    sourceDownload >= 0
      && sourceVerification > sourceDownload
      && sourceExtraction > sourceVerification
      && compilation > sourceExtraction,
    'le source doit être téléchargé, vérifié, extrait puis compilé',
  );
  const modelDownload = dockerfile.indexOf('--output "/build/$model_name"');
  const modelLength = dockerfile.indexOf('wc -c', modelDownload);
  const modelDigest = dockerfile.indexOf('sha256sum -c -', modelLength);
  const modelInstall = dockerfile.indexOf('"/out/$model_name"', modelDigest);
  assert.ok(
    modelDownload >= 0
      && modelLength > modelDownload
      && modelDigest > modelLength
      && modelInstall > modelDigest,
    'le modèle doit être téléchargé, borné, vérifié puis installé',
  );
  assert.match(dockerfile, /! ldd \/out\/whisper-server \| grep -F 'not found'/u);

  const runtime = dockerfile.slice(dockerfile.indexOf(' AS runtime\n'));
  assert.doesNotMatch(runtime, /\b(?:RUN|ADD)\b|apt-get|curl|wget|ffmpeg/u);
  assert.equal(occurrences(runtime, 'COPY --from=build'), 2);
  for (const requiredAsset of [
    'server.mjs',
    'manifest.json',
    'THIRD_PARTY_NOTICES.md',
    'LICENSE.whisper.cpp',
    'LICENSE.openai-whisper',
  ]) {
    assert.match(runtime, new RegExp(`COPY[^\\n]*${requiredAsset}`, 'u'));
  }
  assert.match(runtime, /^CMD \["\/opt\/bob-whisper-gateway\/server\.mjs"\]$/mu);
});

test('le gateway est fermé, borné, annulable et sans persistance de contenu', () => {
  assert.match(gateway, /requestTarget === manifest\.service\.healthPath/u);
  assert.match(gateway, /requestTarget !== manifest\.service\.transcriptionPath/u);
  assert.equal(occurrences(gateway, "method: 'POST'"), 2);
  assert.match(gateway, /redirect: 'error'/u);
  assert.match(gateway, /signal\.throwIfAborted\(\);[\s\S]*active \+= 1/u);
  assert.match(gateway, /request\.aborted \|\| request\.destroyed \|\| response\.destroyed/u);
  assert.match(gateway, /file\.type !== 'audio\/wav'/u);
  assert.match(gateway, /'audit\.wav'/u);
  assert.match(gateway, /maxConcurrentInferences/u);
  assert.match(gateway, /maxQueuedRequests/u);
  assert.match(gateway, /inferenceTimeoutMs/u);
  assert.doesNotMatch(
    gateway,
    /\b(?:writeFile|appendFile|createWriteStream|mkdtemp|rename|copyFile)\b|console\./u,
  );
  assert.equal(occurrences(gateway, 'process.stderr.write'), 1);
  assert.match(gateway, /stdio: \['ignore', 'ignore', 'inherit'\]/u);
  assert.match(gatewayTests, /une déconnexion déjà observée annule avant toute admission/u);
  assert.match(gatewayTests, /alreadyAborted/u);
});

test('Railway déploie uniquement le Dockerfile audité avec une santé réelle', () => {
  assert.equal(railway.build.builder, 'DOCKERFILE');
  assert.equal(railway.build.dockerfilePath, 'Dockerfile.whisper-audit');
  assert.equal(railway.deploy.healthcheckPath, manifest.service.healthPath);
  assert.equal(railway.deploy.numReplicas, 1);
  assert.equal(railway.deploy.sleepApplication, false);
  assert.equal(railway.deploy.restartPolicyType, 'ON_FAILURE');
  assert.equal(railway.deploy.overlapSeconds, 30);
  assert.deepEqual(railway.deploy.multiRegionConfig, {
    'europe-west4-drams3a': { numReplicas: 1 },
  });
  assert.equal(railway.deploy.startCommand, null);
  assert.equal(railway.deploy.preDeployCommand, null);
});

test('les licences redistribuées et les gardes locales font partie de la suite API', () => {
  assert.match(whisperCppLicense, /MIT License[\s\S]*Copyright \(c\) 2023-2026 The ggml authors/u);
  assert.match(openAiWhisperLicense, /MIT License[\s\S]*Copyright \(c\) 2022 OpenAI/u);
  assert.match(notices, /LICENSE\.whisper\.cpp/u);
  assert.match(notices, /LICENSE\.openai-whisper/u);
  const whisperScript = packageJson.scripts['test:whisper-audit'];
  assert.equal(
    whisperScript,
    'node --test ../../infra/whisper-audit/server.test.mjs ' +
      'scripts/whisper-audit-release-safety.test.mjs',
  );
  for (const aggregate of ['test', 'test:release-flags']) {
    assert.equal(
      occurrences(packageJson.scripts[aggregate], 'scripts/whisper-audit-release-safety.test.mjs'),
      1,
    );
    assert.equal(
      occurrences(packageJson.scripts[aggregate], '../../infra/whisper-audit/server.test.mjs'),
      1,
    );
  }
});

test('la CI construit et démarre réellement l’image linux/amd64 exacte', () => {
  const start = ci.indexOf('\n  whisper-audit-image:\n');
  assert.ok(start >= 0, 'le job CI whisper-audit-image doit exister');
  const job = ci.slice(start);
  assert.match(job, /runs-on: ubuntu-24\.04/u);
  assert.match(job, /timeout-minutes: 25/u);
  assert.match(job, /docker\/setup-buildx-action@[a-f0-9]{40}/u);
  assert.match(job, /version: v0\.35\.0/u);
  assert.match(job, /image=moby\/buildkit@sha256:[a-f0-9]{64}/u);
  assert.match(job, /docker\/build-push-action@[a-f0-9]{40}/u);
  assert.match(job, /file: \.\/Dockerfile\.whisper-audit/u);
  assert.match(job, /platforms: linux\/amd64/u);
  assert.match(job, /push: false/u);
  assert.match(job, /load: true/u);
  assert.match(job, /docker run --detach/u);
  assert.match(job, /--publish 127\.0\.0\.1:18080:8080/u);
  assert.match(job, /http:\/\/127\.0\.0\.1:18080\/v1\/health/u);
  assert.match(job, /whisper_audit_health_contract_drift/u);
  assert.match(job, /image_user[\s\S]*\[ "\$image_user" != 65532 \]/u);
  assert.match(job, /--write-out '%\{http_code\}'[\s\S]*"\$http_status" = 200/u);
  assert.match(job, /\.split\(\/\\r\?\\n\/u\)[\s\S]*headers\.includes/u);
  assert.match(job, /docker rm --force/u);
  assert.doesNotMatch(job, /continue-on-error:\s*true|allow_failure|ignore-errors/u);
});

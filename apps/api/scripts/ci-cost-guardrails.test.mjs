import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Verrous du plan d'optimisation CI (audit 2026-07-28). Deux objectifs indissociables :
//   1. les économies restent en place (dédoublonnage push/PR, caches, annulation des runs
//      PR périmés) — toute branche qui régresse sur ces YAML échoue ici, dans sa propre PR ;
//   2. AUCUNE économie ne peut rogner la couverture : leçon 2 du postmortem
//      (design_handoff_bob_pro/POSTMORTEM_DEPLOY_20260717.md) sur chaque push de chaque
//      branche, liste des jobs figée, caches d'entrées revalidés par leurs outils, DerivedData
//      restauré uniquement sur clé exacte et semé uniquement par des builds verts.

const repositoryRoot = new URL('../../../', import.meta.url);
const [ci, bobLiveNative, packageSource] = await Promise.all([
  readFile(new URL('.github/workflows/ci.yml', repositoryRoot), 'utf8'),
  readFile(new URL('.github/workflows/bob-live-native.yml', repositoryRoot), 'utf8'),
  readFile(new URL('apps/api/package.json', repositoryRoot), 'utf8'),
]);
const packageJson = JSON.parse(packageSource);

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function jobIds(workflow) {
  const jobsStart = workflow.indexOf('\njobs:\n');
  assert.ok(jobsStart >= 0, 'le workflow doit déclarer un bloc jobs:');
  return [...workflow.slice(jobsStart).matchAll(/^  ([a-z][a-z0-9-]*):$/gmu)].map(
    (match) => match[1],
  );
}

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `marqueur introuvable : ${startMarker}`);
  if (endMarker === undefined) {
    return source.slice(start);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `marqueur de fin introuvable : ${endMarker}`);
  return source.slice(start, end);
}

test('leçon 2 du postmortem : ci.yml écoute chaque push de chaque branche, sans filtre', () => {
  const onBlock = slice(ci, '\non:\n', '\nconcurrency:\n');
  assert.match(
    onBlock,
    /\n  push:\n  pull_request:\n/u,
    'push: doit rester nu (aucun branches:/paths:) pour couvrir chaque push de chaque branche',
  );
});

test('les runs push de la CI ne s’annulent jamais ; seuls les runs PR d’une même ref se remplacent', () => {
  const concurrencyBlock = slice(ci, '\nconcurrency:\n', '\njobs:\n');
  assert.ok(concurrencyBlock.includes("format('ci-pr-{0}', github.ref)"));
  assert.ok(
    concurrencyBlock.includes("format('ci-push-{0}', github.run_id)"),
    'chaque run push doit recevoir un groupe unique : jamais annulé, jamais évincé d’une file',
  );
  assert.ok(
    concurrencyBlock.includes(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    ),
  );
  assert.equal(
    occurrences(ci, 'cancel-in-progress'),
    1,
    'une seule politique d’annulation dans ci.yml : PR uniquement',
  );
});

test('api-artifact tourne exactement une fois par SHA : sur chaque push, et côté PR seulement pour un fork', () => {
  const job = slice(ci, '\n  api-artifact:\n', '\n  whisper-audit-image:\n');
  assert.match(
    job,
    /if: >-\n {6}github\.event_name == 'push'\n {6}\|\| github\.event\.pull_request\.head\.repo\.full_name != github\.repository\n/u,
    'le dédoublonnage ne doit retirer que la répétition PR d’une branche interne, jamais un push',
  );
  // La substance de la leçon 2 reste entière : build complet, garde d'artefact, boot smoke.
  assert.match(job, /pnpm --filter "@bob\/api\.\.\." run build/u);
  assert.match(job, /test -f apps\/api\/dist\/main\.js/u);
  assert.match(job, /NODE_ENV: production/u);
  assert.match(job, /http:\/\/127\.0\.0\.1:3000\/health/u);
});

test('veille des mentions légales : préavis NON bloquant sur chaque PR, avant le reste du job', () => {
  // Ce verrou protège les deux moitiés du régime d'alarme, et elles sont indissociables.
  // 1. Le canal existe et vit dans `verify` (chaque PR + chaque push de main) : sans ce step, le
  //    préavis n'aurait plus AUCUN canal et l'échéance reviendrait à un commentaire que personne
  //    ne relit le jour venu.
  const job = slice(ci, '\n  verify:\n', '\n  agent-missions-postgres-certification:\n');
  const step = slice(
    job,
    '- name: Veille des mentions légales (préavis non bloquant, échéance bloquante)',
    '- run: pnpm typecheck',
  );
  assert.match(step, /pnpm exec turbo run build --filter @bob\/core/u);
  assert.match(step, /node apps\/api\/scripts\/veille-mentions-legales-ci\.mjs/u);
  // 2. Le step est placé AVANT typecheck/test : l'avertissement doit sortir même quand la PR est
  //    rouge par ailleurs, et un blocage doit échouer vite.
  assert.ok(
    job.indexOf('veille-mentions-legales-ci.mjs') < job.indexOf('- run: pnpm typecheck'),
    'la veille doit précéder typecheck : une alarme qui n’apparaît que sur une PR verte est ratable',
  );
  // 3. Aucun `continue-on-error` dans tout le workflow : c'est le seul moyen de défaire l'étage 2
  //    (échéance atteinte = CI rouge) sans toucher au code de sortie du rapporteur.
  assert.equal(
    occurrences(ci, 'continue-on-error'),
    0,
    'un continue-on-error rendrait l’étage bloquant décoratif — y compris pour la veille légale',
  );
});

test('bob-live-native ne double plus les branches : push borné à main, la PR porte la preuve', () => {
  const onBlock = slice(bobLiveNative, '\non:\n', '\nconcurrency:\n');
  assert.match(
    onBlock,
    /\n  push:\n    branches:\n      - main\n/u,
    'sans ce filtre, chaque SHA de branche paie deux fois le build iOS macOS (~20 min)',
  );
  assert.match(onBlock, /\n  pull_request:\n    paths:\n/u);
  const concurrencyBlock = slice(bobLiveNative, '\nconcurrency:\n', '\njobs:\n');
  assert.ok(concurrencyBlock.includes("format('bob-live-native-pr-{0}', github.ref)"));
  assert.ok(
    concurrencyBlock.includes("format('bob-live-native-{0}', github.run_id)"),
    'les runs de main ne doivent jamais s’annuler entre eux : chaque merge garde sa preuve',
  );
  assert.ok(
    concurrencyBlock.includes(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    ),
  );
  assert.equal(occurrences(bobLiveNative, 'cancel-in-progress'), 1);
});

test('DerivedData : restauration PR-only sur clé exacte, semis par main, jamais un build rouge', () => {
  const swiftJob = slice(bobLiveNative, '\n  swift-contract:\n');
  const restoreStep = slice(
    swiftJob,
    '- name: Restaurer DerivedData (PR uniquement, clé exacte)',
    '- name: Compile the real Expo iOS application and BobLiveAudio pod',
  );
  assert.match(restoreStep, /if: github\.event_name == 'pull_request'/u);
  assert.match(restoreStep, /uses: actions\/cache\/restore@[a-f0-9]{40} # v4/u);
  assert.ok(
    !restoreStep.includes('restore-keys'),
    'aucune restore-key partielle : un DerivedData d’autres dépendances ne doit jamais servir de base incrémentale',
  );
  const derivedDataKey =
    'key: bob-live-deriveddata-${{ env.XCODE_CACHE_PIN }}-' +
    "${{ hashFiles('apps/mobile/ios/Podfile.lock', 'pnpm-lock.yaml', 'apps/mobile/app.json') }}";
  assert.equal(
    occurrences(swiftJob, derivedDataKey),
    2,
    'restore et save doivent partager exactement la même clé stricte (Xcode épinglé + locks générés)',
  );
  const saveStep = slice(swiftJob, '- name: Sauvegarder DerivedData après un build vert');
  assert.ok(
    swiftJob.indexOf('- name: Sauvegarder DerivedData') >
      swiftJob.indexOf('- name: Compile the real Expo iOS application'),
    'la sauvegarde doit suivre xcodebuild : seul un build vert peut semer le cache',
  );
  assert.match(saveStep, /if: steps\.deriveddata_restore\.outputs\.cache-hit != 'true'/u);
  assert.ok(
    !saveStep.includes('always()'),
    'jamais de sauvegarde d’un état partiel après un step rouge',
  );
  assert.match(saveStep, /uses: actions\/cache\/save@[a-f0-9]{40} # v4/u);
  // Le pin Xcode du toolchain et celui de la clé de cache doivent désigner la même version.
  const developerDir = swiftJob.match(/DEVELOPER_DIR: \/Applications\/Xcode_(\d+\.\d+)\.app/u);
  const cachePin = swiftJob.match(/XCODE_CACHE_PIN: xcode-(\d+\.\d+)/u);
  assert.ok(developerDir && cachePin, 'les deux pins Xcode doivent exister');
  assert.equal(
    developerDir[1],
    cachePin[1],
    'monter de Xcode exige de changer DEVELOPER_DIR ET XCODE_CACHE_PIN ensemble',
  );
  assert.ok(
    swiftJob.includes(`test "$(xcodebuild -version | head -n 1)" = "Xcode ${developerDir[1]}"`),
    'le step de vérification du toolchain doit contrôler la même version que le pin',
  );
  // Le build réel compile toujours dans le chemin caché, avec le même workspace.
  assert.match(swiftJob, /-derivedDataPath "\$\{RUNNER_TEMP\}\/bob-live-derived-data"/u);
  assert.match(swiftJob, /-workspace BobPro\.xcworkspace/u);
});

test('Gradle et CocoaPods restent des caches d’ENTRÉES, revalidés par leurs outils', () => {
  const androidJob = slice(bobLiveNative, '\n  android-contract:\n', '\n  swift-contract:\n');
  const gradleCache = slice(
    androidJob,
    '- name: Mettre en cache les dépendances Gradle (wrapper + dépôts)',
    '- name: Compile the real Android app, patched Expo modules, and deterministic VAD tests',
  );
  assert.match(gradleCache, /uses: actions\/cache@[a-f0-9]{40} # v4/u);
  assert.match(gradleCache, /\$\{\{ runner\.temp \}\}\/bob-live-gradle\/caches/u);
  assert.match(gradleCache, /\$\{\{ runner\.temp \}\}\/bob-live-gradle\/wrapper/u);
  assert.ok(
    !gradleCache.includes('bob-live-gradle\n'),
    'ne jamais cacher GRADLE_USER_HOME entier (démons, verrous) : caches/ et wrapper/ seulement',
  );
  // L'app et les modules Expo patchés compilent avant les tests VAD, daemon désactivé.
  assert.match(
    androidJob,
    /\.\/gradlew :app:compileDebugKotlin :bob-live-audio:testDebugUnitTest/u,
  );
  assert.match(androidJob, /--no-daemon --stacktrace/u);
  assert.match(androidJob, /GRADLE_USER_HOME: \$\{\{ runner\.temp \}\}\/bob-live-gradle/u);

  const swiftJob = slice(bobLiveNative, '\n  swift-contract:\n');
  const podsCache = slice(
    swiftJob,
    '- name: Mettre en cache CocoaPods (téléchargements + Pods résolus)',
    '- name: Resolve the generated CocoaPods workspace',
  );
  assert.match(podsCache, /~\/Library\/Caches\/CocoaPods/u);
  assert.match(podsCache, /apps\/mobile\/ios\/Pods/u);
  assert.ok(
    swiftJob.indexOf('- name: Resolve the generated CocoaPods workspace') >
      swiftJob.indexOf('- name: Mettre en cache CocoaPods'),
    'pod install doit suivre la restauration : c’est lui qui revalide le lockfile',
  );
  // Exactement trois usages de cache : deux composites (entrées) + le couple restore/save
  // DerivedData. Un quatrième cache devrait repasser par une revue de fiabilité.
  assert.equal(occurrences(bobLiveNative, 'uses: actions/cache@'), 2);
  assert.equal(occurrences(bobLiveNative, 'uses: actions/cache/restore@'), 1);
  assert.equal(occurrences(bobLiveNative, 'uses: actions/cache/save@'), 1);
});

test('aucun job n’a disparu d’aucun des deux workflows', () => {
  assert.deepEqual(jobIds(ci), [
    'verify',
    'agent-missions-postgres-certification',
    'rls-certification',
    'document-archive-quarantine-certification',
    'realtime-global-capacity-certification',
    'mistral-key-rotation-certification',
    'facturx-conformance',
    'api-artifact',
    'whisper-audit-image',
  ]);
  assert.deepEqual(jobIds(bobLiveNative), ['android-contract', 'swift-contract']);
});

test('ce garde fait partie des suites API agrégées', () => {
  for (const aggregate of ['test', 'test:release-flags']) {
    for (const garde of [
      'scripts/ci-cost-guardrails.test.mjs',
      // Le rapporteur de la veille légale : ses règles de rendu (préavis → sortie 0, échéance
      // atteinte → sortie 1) doivent être vérifiées partout où ce garde-ci l'est.
      'scripts/veille-mentions-legales-ci.test.mjs',
    ]) {
      assert.equal(
        occurrences(packageJson.scripts[aggregate], garde),
        1,
        `${aggregate} doit exécuter ${garde} à chaque run CI`,
      );
    }
  }
});

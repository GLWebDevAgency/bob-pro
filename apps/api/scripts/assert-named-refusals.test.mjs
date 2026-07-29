// GARDE ANTI-FAUX-VERT — un refus attendu doit NOMMER la règle qui l'a produit.
//
// LE 29/07, LA CERTIFICATION DES FICHES DE PASSAGE ÉTAIT VERTE POUR UNE RAISON ENTIÈREMENT
// FAUSSE. Hors NODE_ENV=production, Prisma préfixe son message d'un EXTRAIT DU CODE SOURCE
// citant les lignes voisines de l'appel. Pour l'assertion de la ligne 528, cet extrait citait
// la ligne 526 — qui contient littéralement `.rejects.toThrow(/RÈGLE/)`. L'assertion se
// satisfaisait donc de son PROPRE TEXTE SOURCE, jamais de la réponse de la base. Le gate, lui,
// tourne en NODE_ENV=production (errorFormat 'minimal', aucun extrait) : d'où « vert en local,
// rouge au déploiement », et un refus qui ne prouvait plus rien depuis son écriture.
//
// TROIS DÉFENSES, ET IL FAUT LES TROIS :
//  1. une unité de travail par refus attendu — sinon la première erreur avorte la transaction
//     et la suivante n'atteint jamais la base (helper `expectRefused` des certifications) ;
//  2. un motif OBLIGATOIRE et SPÉCIFIQUE sur chaque refus — ce que ce fichier verrouille.
//  3. `errorFormat: 'minimal'` sur le client Prisma — sinon une panne de pool peut recopier
//     l'extrait source contenant le motif attendu et satisfaire l'assertion sans atteindre SQL.
// Un `rejects.toThrow()` nu accepte n'importe quelle erreur, « transaction avortée » comprise :
// il ne prouve rien. Un motif trop large (`/Invalid/`, `/./`, `/Error/`) non plus.
//
// POURQUOI UN CLIQUET PLUTÔT QU'UNE INTERDICTION SÈCHE : le dépôt porte 60 refus nus hérités,
// répartis sur 13 fichiers. Isolés dans leur propre transaction, ils ne produisent pas de faux
// vert — ils prouvent seulement moins qu'ils ne devraient. Les corriger d'un bloc mêlerait une
// refonte de 60 assertions à un correctif de production. La dette est donc GELÉE ici, fichier
// par fichier : aucune nouvelle occurrence ne peut apparaître, et chaque baisse de compteur est
// définitive (le test échoue si un chiffre est laissé au-dessus du réel). La dette ne peut que
// décroître.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

// fileURLToPath, jamais .pathname : un chemin contenant une espace arriverait percent-encodé.
const RACINE_API = fileURLToPath(new URL('..', import.meta.url));
const RACINE_SRC = join(RACINE_API, 'src');

/** Dette HÉRITÉE, gelée au 29/07/2026. Un compteur ne doit JAMAIS croître, et toute baisse se grave ici. */
const DETTE_GELEE = Object.freeze({
  'persistence/prisma/credit-note-traceability.postgres.test.ts': 7,
  'persistence/prisma/devices.postgres.test.ts': 3,
  'persistence/prisma/document-archive-integrity.postgres.test.ts': 15,
  'persistence/prisma/document-archive-rollout.postgres.test.ts': 19,
  'persistence/prisma/expense-creation-requests.postgres.test.ts': 2,
  'persistence/prisma/notification-jobs.postgres.test.ts': 2,
  'persistence/prisma/quote-creation-requests.postgres.test.ts': 2,
  'voice/realtime/mistral-conversation-authority.postgres.test.ts': 1,
  'voice/realtime/mistral-conversation-bootstrap-reaper.postgres.test.ts': 3,
  'voice/realtime/mistral-conversation-bootstrap-ticket.postgres.test.ts': 1,
  'voice/realtime/mistral-conversation-resume-ticket.postgres.test.ts': 1,
  'voice/realtime/realtime-capacity.postgres.test.ts': 3,
  'voice/realtime/realtime-speech.prisma.postgres.test.ts': 1,
});

/**
 * Certifications PostgreSQL qui ne construisent pas encore tous leurs clients Prisma avec le
 * format minimal.
 *
 * C'est un cliquet, pas une approbation : aucune nouvelle certification ne peut rejoindre cette
 * dette et toute correction doit retirer immédiatement son chemin. L'analyse passe par l'AST
 * TypeScript : un commentaire, une chaîne ou un seul client protégé ne peut pas contourner la
 * règle. Une future factory sûre devra être reconnue explicitement ici après son propre test de
 * contrat ; elle n'est jamais déduite d'un nom ou d'un marqueur textuel.
 */
const DETTE_CLIENTS_PRISMA_NON_MINIMAUX = Object.freeze([
  'persistence/prisma/agent-mission.persistence.postgres.test.ts',
  'persistence/prisma/cabinet-dossiers.postgres.test.ts',
  'persistence/prisma/catalogue-chantiers.postgres.test.ts',
  'persistence/prisma/company-billing-settings.postgres.test.ts',
  'persistence/prisma/company-mutation-lifecycle.postgres.test.ts',
  'persistence/prisma/credit-note-traceability.postgres.test.ts',
  'persistence/prisma/devices.postgres.test.ts',
  'persistence/prisma/diagnostic-assessment.postgres.test.ts',
  'persistence/prisma/document-archive-integrity.postgres.test.ts',
  'persistence/prisma/document-archive-rollout.postgres.test.ts',
  'persistence/prisma/equipments.postgres.test.ts',
  'persistence/prisma/expense-creation-requests.postgres.test.ts',
  'persistence/prisma/expense-payment-evidence.postgres.test.ts',
  'persistence/prisma/invoice-issue-lifecycle.postgres.test.ts',
  'persistence/prisma/invoice-settlement-rollout.postgres.test.ts',
  'persistence/prisma/invoice-settlement-semantics.postgres.test.ts',
  'persistence/prisma/notification-jobs.postgres.test.ts',
  'persistence/prisma/public-capability-lifecycle.postgres.test.ts',
  'persistence/prisma/quote-creation-requests.postgres.test.ts',
  'persistence/prisma/quote-draft-slots.postgres.test.ts',
  'persistence/prisma/quote-signature-token-concurrency.postgres.test.ts',
  'persistence/prisma/sales-document-search.repository.postgres.test.ts',
  'persistence/prisma/sales-tenant-integrity.postgres.test.ts',
  'persistence/prisma/stripe-subscription-invoices.postgres.test.ts',
  'voice/realtime/mistral-conversation-admission-delete-fence.postgres.test.ts',
  'voice/realtime/mistral-conversation-authority.postgres.test.ts',
  'voice/realtime/mistral-conversation-bootstrap-reaper.postgres.test.ts',
  'voice/realtime/mistral-conversation-bootstrap-reconciliation.postgres.test.ts',
  'voice/realtime/mistral-conversation-bootstrap-ticket.postgres.test.ts',
  'voice/realtime/mistral-conversation-identity-key-version-lifecycle.postgres.test.ts',
  'voice/realtime/mistral-conversation-key-version-lifecycle.postgres.test.ts',
  'voice/realtime/mistral-conversation-key-version.postgres.test.ts',
  'voice/realtime/mistral-conversation-reaper-termination.postgres.test.ts',
  'voice/realtime/mistral-conversation-resume-ticket.postgres.test.ts',
  'voice/realtime/mistral-conversation-subject-key-version.postgres.test.ts',
  'voice/realtime/openai-native-key-version-lifecycle.postgres.test.ts',
  'voice/realtime/openai-native-speech-delivery.postgres.test.ts',
  'voice/realtime/realtime-admission.postgres.test.ts',
  'voice/realtime/realtime-capacity.postgres.test.ts',
  'voice/realtime/realtime-mistral-ingress-ticket.postgres.test.ts',
  'voice/realtime/realtime-speech-delivery.prisma.postgres.test.ts',
  'voice/realtime/realtime-speech.prisma.postgres.test.ts',
  'voice/realtime/realtime-voice-usage.prisma.postgres.test.ts',
]);

/** Motifs trop larges : ils resatisfont une transaction avortée, donc ne prouvent rien. */
const MOTIFS_NON_SPECIFIQUES = [/^\/\.[?*]?\/[a-z]*$/i, /^\/Invalid\/[a-z]*$/i, /^\/Error\/[a-z]*$/i];

function certifications(dossier, acc = []) {
  for (const entree of readdirSync(dossier)) {
    if (entree === 'node_modules' || entree === 'dist' || entree === '.turbo') continue;
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) certifications(chemin, acc);
    else if (entree.endsWith('.postgres.test.ts')) acc.push(chemin);
  }
  return acc;
}

function tousLesClientsPrismaSontMinimaux(source, nomFichier) {
  const fichier = ts.createSourceFile(
    nomFichier,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // Les noms canoniques restent reconnus même dans les sources synthétiques et dans un test
  // qui déclare localement son adapter ; les imports ci-dessous ajoutent leurs alias réels.
  const constructeursDirects = new Set(['PrismaClient', 'PrismaService']);
  const constructeursParEspaceDeNoms = new Map();
  const constructions = [];

  function ajouterConstructeurEspaceDeNoms(espaceDeNoms, constructeur) {
    const constructeurs = constructeursParEspaceDeNoms.get(espaceDeNoms) ?? new Set();
    constructeurs.add(constructeur);
    constructeursParEspaceDeNoms.set(espaceDeNoms, constructeurs);
  }

  for (const instruction of fichier.statements) {
    if (
      ts.isClassDeclaration(instruction)
      && instruction.name !== undefined
      && (
        instruction.name.text === 'PrismaClient'
        || instruction.name.text === 'PrismaService'
      )
    ) {
      constructeursDirects.add(instruction.name.text);
      continue;
    }
    if (!ts.isImportDeclaration(instruction) || !ts.isStringLiteral(instruction.moduleSpecifier)) {
      continue;
    }
    const clause = instruction.importClause;
    if (clause === undefined) continue;
    const module = instruction.moduleSpecifier.text;
    const exposePrismaClient = module === '@prisma/client';
    const exposePrismaService = /(?:^|[/.-])prisma(?:\.service)?(?:$|[/.-])/.test(module);

    if (clause.name !== undefined && exposePrismaService) {
      constructeursDirects.add(clause.name.text);
    }
    if (clause.namedBindings === undefined) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      if (exposePrismaClient) {
        ajouterConstructeurEspaceDeNoms(clause.namedBindings.name.text, 'PrismaClient');
      }
      if (exposePrismaService) {
        ajouterConstructeurEspaceDeNoms(clause.namedBindings.name.text, 'PrismaService');
      }
      continue;
    }
    for (const importSpecifie of clause.namedBindings.elements) {
      const nomExporte = importSpecifie.propertyName?.text ?? importSpecifie.name.text;
      if (
        (exposePrismaClient && nomExporte === 'PrismaClient')
        || nomExporte === 'PrismaService'
      ) {
        constructeursDirects.add(importSpecifie.name.text);
      }
    }
  }

  function expressionSansEnveloppe(expression) {
    let courante = expression;
    while (
      ts.isParenthesizedExpression(courante)
      || ts.isAsExpression(courante)
      || ts.isTypeAssertionExpression(courante)
      || ts.isNonNullExpression(courante)
    ) {
      courante = courante.expression;
    }
    return courante;
  }

  function nomMembreStatique(expression) {
    if (ts.isStringLiteral(expression)) return expression.text;
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    return null;
  }

  function estExpressionConstructeurPrisma(expression) {
    const cible = expressionSansEnveloppe(expression);
    if (ts.isIdentifier(cible)) return constructeursDirects.has(cible.text);
    if (ts.isPropertyAccessExpression(cible) && ts.isIdentifier(cible.expression)) {
      return constructeursParEspaceDeNoms
        .get(cible.expression.text)
        ?.has(cible.name.text) === true;
    }
    if (
      ts.isElementAccessExpression(cible)
      && ts.isIdentifier(cible.expression)
      && cible.argumentExpression !== undefined
    ) {
      const constructeurs = constructeursParEspaceDeNoms.get(cible.expression.text);
      if (constructeurs === undefined) return false;
      const nom = nomMembreStatique(cible.argumentExpression);
      // `P[key]` peut résoudre PrismaClient à l'exécution : on le traite comme un client
      // potentiel et on exige donc aussi ses options minimales, au lieu de l'ignorer.
      return nom === null || constructeurs.has(nom);
    }
    return false;
  }

  // Les alias locaux ne doivent pas permettre de soustraire un constructeur au contrôle.
  // La boucle atteint un point fixe pour couvrir `const B = A; const C = B`.
  let aliasAjoute = true;
  while (aliasAjoute) {
    aliasAjoute = false;
    function collecterAlias(noeud) {
      if (
        ts.isVariableDeclaration(noeud)
        && ts.isIdentifier(noeud.name)
        && noeud.initializer !== undefined
        && estExpressionConstructeurPrisma(noeud.initializer)
        && !constructeursDirects.has(noeud.name.text)
      ) {
        constructeursDirects.add(noeud.name.text);
        aliasAjoute = true;
      }
      ts.forEachChild(noeud, collecterAlias);
    }
    collecterAlias(fichier);
  }

  function nomProprieteStatique(nom) {
    if (
      ts.isIdentifier(nom)
      || ts.isStringLiteral(nom)
      || ts.isNumericLiteral(nom)
      || ts.isNoSubstitutionTemplateLiteral(nom)
    ) {
      return nom.text;
    }
    if (ts.isComputedPropertyName(nom)) return nomMembreStatique(nom.expression);
    return null;
  }

  function optionsProuveesMinimales(options) {
    if (!ts.isObjectLiteralExpression(options)) return false;
    let formatMinimalProuve = false;
    for (const propriete of options.properties) {
      if (ts.isSpreadAssignment(propriete)) {
        // Un spread peut écraser errorFormat. Une propriété minimale placée APRÈS pourra
        // de nouveau établir la preuve ; placée avant, elle ne suffit jamais.
        formatMinimalProuve = false;
        continue;
      }
      const nom = nomProprieteStatique(propriete.name);
      if (nom === null) {
        // Une clé calculée inconnue peut être `errorFormat` : échec fermé.
        formatMinimalProuve = false;
        continue;
      }
      if (nom !== 'errorFormat') continue;
      formatMinimalProuve = ts.isPropertyAssignment(propriete)
        && ts.isStringLiteral(propriete.initializer)
        && propriete.initializer.text === 'minimal';
    }
    return formatMinimalProuve;
  }

  function visiter(noeud) {
    if (ts.isNewExpression(noeud) && estExpressionConstructeurPrisma(noeud.expression)) {
      const options = noeud.arguments?.[0];
      constructions.push(options !== undefined && optionsProuveesMinimales(options));
    }
    ts.forEachChild(noeud, visiter);
  }

  visiter(fichier);
  return constructions.length > 0 && constructions.every(Boolean);
}

test('la dette de refus NON NOMMÉS ne croît jamais (cliquet)', () => {
  const reels = {};
  for (const fichier of certifications(RACINE_SRC)) {
    const cle = relative(RACINE_SRC, fichier);
    const n = (readFileSync(fichier, 'utf8').match(/\.rejects\s*\.\s*toThrow\s*\(\s*\)/g) ?? []).length;
    if (n > 0) reels[cle] = n;
  }
  const regressions = [];
  for (const [cle, n] of Object.entries(reels)) {
    const gele = DETTE_GELEE[cle] ?? 0;
    if (n > gele) {
      regressions.push(
        `${cle} : ${n} refus nus contre ${gele} gelés — un refus attendu doit nommer SA règle ` +
          `(trigger, CHECK ou contrainte), sinon il accepte aussi « transaction avortée ».`,
      );
    }
  }
  for (const [cle, gele] of Object.entries(DETTE_GELEE)) {
    const n = reels[cle] ?? 0;
    if (n < gele) {
      regressions.push(
        `${cle} : dette réduite à ${n} (gelé à ${gele}) — merci, grave-le en abaissant DETTE_GELEE.`,
      );
    }
  }
  assert.deepEqual(regressions, [], `\n${regressions.join('\n')}`);
});

test('aucun refus attendu ne se contente d’un motif trop large', () => {
  const fautifs = [];
  for (const fichier of certifications(RACINE_SRC)) {
    readFileSync(fichier, 'utf8')
      .split('\n')
      .forEach((ligne, i) => {
        const motif = /\.rejects\s*\.\s*toThrow\s*\(\s*(\/[^)]*\/[a-z]*)\s*\)/.exec(ligne);
        if (motif && MOTIFS_NON_SPECIFIQUES.some((large) => large.test(motif[1] ?? ''))) {
          fautifs.push(`${relative(RACINE_SRC, fichier)}:${i + 1} — motif ${motif[1]} : ne prouve rien`);
        }
      });
  }
  assert.deepEqual(fautifs, [], `\n${fautifs.join('\n')}`);
});

test("l’analyse AST résiste aux contournements de l’écho source Prisma", () => {
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      "// new PrismaClient({ errorFormat: 'minimal' });\nconst texte = \"errorFormat: 'minimal'\";",
      'commentaire-et-chaine.postgres.test.ts',
    ),
    false,
  );
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      [
        "const protege = new PrismaClient({ errorFormat: 'minimal' });",
        'const vulnerable = new PrismaService({ datasourceUrl });',
        'await expect(operation()).rejects.toMatchObject({ code: "P2024" });',
      ].join('\n'),
      'client-mixte.postgres.test.ts',
    ),
    false,
  );
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      [
        "const admin = new PrismaClient({ errorFormat: 'minimal' });",
        "const worker = new PrismaService({ datasourceUrl, errorFormat: 'minimal' });",
      ].join('\n'),
      'clients-proteges.postgres.test.ts',
    ),
    true,
  );
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      [
        "import { PrismaClient } from '@prisma/client';",
        "const admin = new PrismaClient({ errorFormat: 'minimal', ...overrides });",
      ].join('\n'),
      'spread-apres-format.postgres.test.ts',
    ),
    false,
  );
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      [
        "import { PrismaClient } from '@prisma/client';",
        "const key = 'errorFormat';",
        "const admin = new PrismaClient({ errorFormat: 'minimal', [key]: 'pretty' });",
      ].join('\n'),
      'cle-calculee-apres-format.postgres.test.ts',
    ),
    false,
  );
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      [
        "import { PrismaClient as Admin } from '@prisma/client';",
        "import { PrismaService } from './prisma.service';",
        "const protege = new PrismaService({ errorFormat: 'minimal' });",
        'const vulnerable = new Admin({});',
      ].join('\n'),
      'client-alias-vulnerable.postgres.test.ts',
    ),
    false,
  );
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      [
        "import * as P from '@prisma/client';",
        "import { PrismaService } from './prisma.service';",
        "const protege = new PrismaService({ errorFormat: 'minimal' });",
        'const vulnerable = new P.PrismaClient({});',
      ].join('\n'),
      'client-namespace-vulnerable.postgres.test.ts',
    ),
    false,
  );
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      [
        "import * as P from '@prisma/client';",
        "import { PrismaService } from './prisma.service';",
        "const protege = new PrismaService({ errorFormat: 'minimal' });",
        "const constructorName = 'PrismaClient';",
        'const vulnerable = new P[constructorName]({});',
      ].join('\n'),
      'client-namespace-calcule-vulnerable.postgres.test.ts',
    ),
    false,
  );
  assert.equal(
    tousLesClientsPrismaSontMinimaux(
      [
        "import { PrismaClient } from '@prisma/client';",
        'const Admin = PrismaClient;',
        "const protege = new Admin({ ...overrides, ['errorFormat']: 'minimal' });",
      ].join('\n'),
      'alias-local-protege.postgres.test.ts',
    ),
    true,
  );
});

test("aucune nouvelle certification ne peut réactiver l’écho source Prisma", () => {
  const detteReelle = certifications(RACINE_SRC)
    .filter((fichier) => {
      const source = readFileSync(fichier, 'utf8');
      return !tousLesClientsPrismaSontMinimaux(source, fichier);
    })
    .map((fichier) => relative(RACINE_SRC, fichier))
    .sort();

  assert.deepEqual(
    detteReelle,
    [...DETTE_CLIENTS_PRISMA_NON_MINIMAUX].sort(),
    [
      'La dette errorFormat Prisma a changé.',
      "Toute nouvelle certification PostgreSQL doit construire tous ses clients avec errorFormat: 'minimal'.",
      'Une dette corrigée doit être retirée de DETTE_CLIENTS_PRISMA_NON_MINIMAUX.',
    ].join('\n'),
  );
});

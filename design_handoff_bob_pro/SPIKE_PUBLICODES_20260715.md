# Rapport de due diligence — Moteur fiscal Bob Pro sur Publicodes serveur épinglé

**Verdict : GO avec réserves.** L'architecture "Publicodes + règles `modele-social` épinglées, évaluation serveur uniquement" est solide, très légère, activement maintenue par un organisme officiel (URSSAF/DINUM), et le test scratch confirme une faisabilité technique excellente. Les réserves portent sur la fréquence des breaking changes de nommage des règles, un décalage réel (jusqu'à ~4 mois observé) entre l'entrée en vigueur d'une loi et sa publication en version npm, et des trous de couverture documentés (activités mixtes, professions libérales réglementées, non-résidents).

## 1. Paquets exacts

| Paquet | Version testée | Licence | Dépendances runtime | Poids installé | Repo |
|---|---|---|---|---|---|
| `publicodes` (moteur) | **1.10.1** (latest au 2026-07-15) | MIT | **0** | ~1,1 MB | github.com/publicodes/publicodes (dir `packages/core`) |
| `modele-social` (règles) | **11.0.0** (publié 2026-07-10, 5 jours avant la date du jour) | MIT | 0 (peerDep `publicodes: ^1.0.4`) | ~0,74 MB | github.com/betagouv/mon-entreprise (dir `modele-social`) |

- `npm install publicodes@1.10.1 modele-social@11.0.0` dans un dossier scratch produit un `node_modules` total de **1,8 MB**, zéro vulnérabilité `npm audit`. Empreinte supply-chain minimale.
- API TS de qualité "best dev" : `Engine<RuleNames>` générique, `.d.ts` complet avec JSDoc sur chaque méthode publique (`setSituation`, `evaluate`, `getRule`, `shallowCopy`, `getPossibilitiesFor`…). `modele-social` fournit un fichier `names.ts` (union type de tous les noms de règles) qui, branché sur `Engine<RuleNames>`, transforme un renommage de règle en **erreur de compilation TypeScript** plutôt qu'en bug silencieux à l'exécution — un vrai filet de sécurité pour un monorepo TS strict.
- Deux paquets npm distincts avec un `peerDependencies` large (`^1.0.4`) → **version des règles épinglable indépendamment du moteur** (confirmé : `publicodes@1.10.1` + `modele-social@11.0.0` fonctionnent ensemble sans erreur).
- Discussion officielle sur le choix paquet npm vs API REST hébergée : le mainteneur recommande le paquet npm pour la maîtrise des mises à jour (pas de breaking change silencieux) et la performance (pas d'appel réseau) — exactement l'architecture visée par Bob Pro. [Discussion #2865](https://github.com/betagouv/mon-entreprise/discussions/2865)

## 2. Couverture — validée par lecture directe des règles sources

Vérifié en clonant/lisant les fichiers `.publicodes` du repo (pas seulement la doc) :

- **Micro-entrepreneur** : `dirigeant . auto-entrepreneur . chiffre d'affaires`, distinction vente/service BIC/BNC/BNC Cipav (`entreprise . activités . service ou vente`), versement libératoire, ACRE avec `taux Acre` daté. ✅
- **EI au réel, EURL/gérant TNS** (`dirigeant . indépendant`, `entreprise . catégorie juridique . EURL`), **SASU/assimilé salarié** (`dirigeant . régime social = 'assimilé salarié'`, `salarié . coût total employeur`), **dividendes PFU** (`impôt . dividendes . PFU`, cotisations TNS >10% capital), **IS** (`entreprise . imposition . IS`, taux réduit 15%/taux normal 25% à jour 2026) sont tous présents avec références légales (Légifrance, BOFiP, service-public.fr) intégrées dans les règles.
- **Comparateur de statuts** : simulateur officiel dédié [mon-entreprise.urssaf.fr/simulateurs/comparaison-régimes-sociaux](https://mon-entreprise.urssaf.fr/simulateurs/comparaison-r%C3%A9gimes-sociaux) construit sur ces mêmes règles (micro / EI / EURL / SASU).

**Exemples concrets exécutés (voir §4)** : CA 30 000 €/an service micro → 585 €/mois de cotisations, revenu net avant impôt 22 980 €/an. SASU net cible 2 500 €/mois → brut 3 191,75 €/mois, coût total employeur 4 492,60 €/mois (ratio ~1,80, cohérent avec les ordres de grandeur usuels).

## 3. Fraîcheur 2026 — vérification empirique, pas déclarative

J'ai vérifié dans le **code source réel** des règles (pas juste le changelog) :

- **PFU 31,4 %** (LFSS 2026, effectif 01/01/2026) : confirmé exact dans `bénéficiaire.publicodes` — la CSG non déductible sur dividendes PFU passe de 9,2 % à **10,6 %** `si: date >= 01/2026`, ce qui donne bien 12,8 % (IR, `impôt.publicodes`) + 10,6 % + 0,5 % (CRDS) + 7,5 % (prélèvement de solidarité) = **31,4 %**. Commit source : [`c95c6155`, 2026-01-23](https://github.com/betagouv/mon-entreprise/commits) (~3 semaines après l'entrée en vigueur), premier package npm à l'embarquer : `modele-social@10.0.1` (publié **2026-04-26**, soit ~4 mois après le 1er janvier).
- **ACRE micro-entrepreneur** (réforme 01/07/2026) : confirmé exact dans `dirigeant/auto-entrepreneur/exonérations.publicodes` — `taux Acre` passe de 50 % à **75 %** (= exonération réduite de 50 % à 25 %) `si: date < 07/2026 alors 50% sinon 75%`. Commit source anticipé dès [`58913e71`, 2026-03-06](https://github.com/betagouv/mon-entreprise/commits) (4 mois **avant** l'échéance), publié dans `modele-social@11.0.0` le **2026-07-10** (9 jours après l'échéance).
- **Plafonds micro 2026** : ligne "Mise à jour des plafonds de chiffre d'affaires au régime micro-fiscal" dans le changelog v11.0.0.

**Enseignement clé sur le délai loi → release** : le moteur permet d'encoder des règles datées par anticipation (le code source contient déjà le futur), mais la **publication npm effective** peut accuser un décalage significatif et irrégulier — observé de 9 jours à ~4 mois selon les cas, avec un creux notable de 4 mois entre `10.0.1` (26 avril) et `11.0.0` (10 juillet) qui a englobé une bonne partie du premier semestre 2026. Épingler une version sans processus de veille est risqué en début d'année (saison loi de finances/PLFSS).

## 4. Faisabilité serveur — test scratch exécuté avec succès

Environnement : Node v24.10.0, dossier scratch isolé (`/private/tmp/.../publicodes-test`), aucune modification du repo.

- **Init moteur (une fois par process)** : `new Engine(rules)` ≈ **130-190 ms**, +17 MB de heap (mesuré avec `--expose-gc`, delta `heapUsed` avant/après). Coût à amortir au démarrage du process NestJS, pas par requête.
- **Pattern par-requête documenté par l'API elle-même** : `Engine.shallowCopy()` — "Useful to evaluate the same rules with different situations", explicitement conçu pour ce cas d'usage serveur multi-requêtes. Benchmarké : **200× `shallowCopy() + setSituation() + evaluate()`** en 1,08 s → **~5,4 ms par évaluation complète**. C'est la réponse à la question thread-safety : ne jamais appeler `setSituation()` sur l'instance partagée (mutation en place, `setSituation()` retourne `this`), toujours passer par `shallowCopy()` par requête.
- **Cas micro exécuté** : CA 30 000 €/an service → 585 €/mois cotisations (23,4 % du CA), revenu net 22 980 €/an.
- **Cas SASU exécuté** : net cible 2 500 €/mois (via `inversion numérique` sur `salarié . contrat . salaire brut`) → brut 3 191,75 €/mois → coût total employeur 4 492,60 €/mois. Le mécanisme d'inversion numérique permet nativement le calcul "net → brut → coût total" ou même "net → CA nécessaire", ce qui correspond exactement au besoin produit décrit (rémunération nette↔chargée).
- Double export CJS/ESM (`dist/index.cjs` + `dist/index.js`) → compatible NestJS (CommonJS par défaut).

## 5. Traçabilité — "Comment Bob a calculé ça ?"

Confirmé par exécution : `engine.evaluate(...)` retourne un nœud avec `nodeKind` (`reference`, `condition`, `operation`, `est non défini`, etc.), `explanation` (enfants de l'arbre de calcul), `dottedName`, `nodeValue`, et surtout `rawNode` qui porte les métadonnées saisies par les auteurs de la règle : `titre`, `description`, et surtout **`références`** — un dictionnaire libellé → URL pointant vers Légifrance, BOFiP, service-public.fr, urssaf.fr (vérifié concrètement sur la règle du taux ACRE). C'est directement exploitable pour justifier chaque calcul avec sa base légale. L'écosystème fournit aussi `@publicodes/react-ui` et `publicodes-language-server`/`tree-sitter-publicodes` pour visualiser/parcourir cet arbre si besoin côté outillage interne.

Point d'attention : `traversedVariables` a été supprimé de `evaluate()` dans une breaking change antérieure (#422) — c'est `missingVariables` (avec un score de pertinence heuristique) et l'arbre `explanation` qu'il faut utiliser aujourd'hui.

## 6. Risques et gouvernance

- **Gouvernance officielle et saine** : `mon-entreprise.urssaf.fr` est hébergé sur le domaine `urssaf.fr` même, "sponsorisé par l'Urssaf Caisse Nationale" et piloté par la direction DINUM (beta.gouv.fr) — pas un projet tiers non officiel. Repo actif : dernier commit **2026-07-13** (2 jours avant aujourd'hui), commits quasi quotidiens, non archivé, licence MIT au niveau repo et paquets.
- **Stabilité API du moteur** : `publicodes` v1.0.0 date de 2020-05-18, toujours en v1.x en 2026 (v1.10.1) — l'API publique (`Engine`, `setSituation`, `evaluate`, `shallowCopy`) est stable depuis 6 ans. Une note du changelog signale toutefois que l'AST interne peut changer hors semver ("AST BREAKING CHANGE (AST change are not in semantic versioning)") — ne pas dépendre de structures internes non documentées.
- **Instabilité des noms de règles côté `modele-social`** : quasiment chaque release contient une section "Breaking changes" (renommages, suppressions de règles dépréciées) — observé sur 9+ versions majeures en ~2 ans (2.x→11.x). C'est le principal risque opérationnel : la mitigation naturelle est le typage `RuleNames` (compile-time), pas un test à l'exécution.
- **Trous de couverture connus** (issues GitHub ouvertes, vérifiées) : activités mixtes — UX/logique incomplète ([#3195](https://github.com/betagouv/mon-entreprise/issues/3195)), bug ouvert sur le calculateur de charges pour indépendants suite à la réforme de l'assiette sociale ([#4497](https://github.com/betagouv/mon-entreprise/issues/4497)), erreurs sur les droits retraite CNAVPL pour professions libérales réglementées ([#3545](https://github.com/betagouv/mon-entreprise/issues/3545)), parcours PLR (avocat, notaire, vétérinaire) incomplet côté choix de statut ([#2491](https://github.com/betagouv/mon-entreprise/issues/2491)), caisses de retraite spécifiques à certaines PLR explicitement "non implémentées" dans le code source, imposition des non-résidents "pas encore implémentée" (notification native dans la règle elle-même).
- **Alternative en cas d'abandon du projet** : OpenFisca-France existe et semble maintenu (mises à jour jusqu'à janvier 2026), mais son périmètre historique est différent (prestations sociales/allocations familiales, RSA, APL) — **ce n'est pas un remplaçant direct** pour le domaine cotisations indépendants/dirigeants couvert par `modele-social`. Le vrai filet de sécurité est la licence MIT : le ruleset est lisible (DSL proche du YAML) et forkable en interne si nécessaire.

## Ce que Bob Pro devra construire par-dessus (manques à combler)

1. **Couche d'adaptation/façade** entre les DTO internes de Bob et les `dottedName` bruts de `modele-social`, avec le typage `RuleNames` actif en CI pour transformer tout renommage amont en échec de build plutôt qu'en silence.
2. **Processus de veille des releases** (pas un simple "pin and forget") — vérifier le CHANGELOG `modele-social` au minimum en janvier (lois de finances/PLFSS) et juillet (réformes mi-année comme l'ACRE 2026), vu le décalage observé de plusieurs mois entre effet de loi et publication npm.
3. **Moteur de rendu de l'explication** au-dessus de `evaluate().explanation` + `rawNode.références` pour la fonctionnalité "Comment Bob a calculé ça ?".
4. **Garde-fous produit explicites** sur les zones de trous connus (activités mixtes, PLR réglementées avocat/notaire/vétérinaire, non-résidents) — soit combler avec un moteur maison, soit afficher un avertissement honnête plutôt que de laisser le moteur retourner une valeur incomplète via `missingVariables`.
5. **Un singleton `Engine` par process Node** (initialisé au boot, ~150 ms/17 MB) + `shallowCopy()` systématique par requête — pattern validé en scratch à ~5 ms/évaluation.

Fichiers de test produits (scratch, hors repo) : `/private/tmp/claude-501/.../scratchpad/publicodes-test/{test-micro.mjs, test-sasu.mjs, bench.mjs, mem.mjs, test-explain.mjs}` — reproductibles si besoin de re-vérifier.

Sources principales citées : [npmjs.com/package/publicodes](https://www.npmjs.com/package/publicodes), [npmjs.com/package/modele-social](https://www.npmjs.com/package/modele-social), [github.com/publicodes/publicodes](https://github.com/publicodes/publicodes), [github.com/betagouv/mon-entreprise](https://github.com/betagouv/mon-entreprise), [CHANGELOG modele-social](https://github.com/betagouv/mon-entreprise/blob/master/modele-social/CHANGELOG.md), [Discussion npm vs API #2865](https://github.com/betagouv/mon-entreprise/discussions/2865), [Comparateur de statut juridique](https://mon-entreprise.urssaf.fr/simulateurs/comparaison-r%C3%A9gimes-sociaux), articles presse PFU 31,4% (dougs.fr, meilleurtaux.com) et ACRE juillet 2026 (service-public.gouv.fr, CCI Portes de Normandie).

## ERRATUM POST-IMPLÉMENTATION (15/07, service livré) — les goldens §4 étaient FAUX
Le scratch omettait `entreprise . catégorie juridique = 'EI'` : le CA micro était routé
dans le bucket Cipav par accident. Valeurs corrigées (service, CA 30 000 €/an) :
cotisations 533,50 €/mois (12,3 % vente < 21,2 % service < 23,2 % Cipav < 25,6 % VL
différenciés), net 23 598 €/an. Réconciliation au centime avec computeMicroSocialProvision
du core (530 € ; +3,50 € = TFC+CFP documentés). SASU confirmé exact. Autre bug appris :
evaluate(string) top-level peut ignorer setSituation — toujours evaluate(getRule(name)).
Leçon : un golden sans réconciliation croisée n'est pas un golden.

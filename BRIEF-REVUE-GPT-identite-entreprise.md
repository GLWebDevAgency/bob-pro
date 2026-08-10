# Brief de revue pour Codex/GPT — lot « identité entreprise »

> À transmettre tel quel. Les chiffres du rituel et la liste des corrections seront complétés
> quand le lot sera poussé ; le reste du brief est définitif.

---

## Ta mission

Tu reprends en **revue adversariale** le lot « identité entreprise » livré par Claude sur la
branche `<BRANCHE>`. Ta consigne est de **challenger à fond**, pas de valider : ce lot a déjà
subi une première revue adversariale qui a produit **25 findings**, tous censés être soldés.
Ton travail est de trouver ce que cette première revue **a manqué**, et de vérifier que les
corrections tiennent réellement.

Ne conclus « approuvé » que si tu as sincèrement essayé de casser et échoué.

## Ce que le lot livre

Trois choses, demandées par le fondateur :

1. **Recherche d'un client par raison sociale** (`GET /company/search`) avec propositions —
   parce qu'on n'a pas toujours le SIRET, mais souvent le nom.
2. **Pré-remplissage d'une fiche client par photo de l'en-tête** d'une facture, via LLM, avec
   validation humaine — pour accélérer l'arrivée d'un nouvel utilisateur qui vient d'un autre
   logiciel.
3. **Parité vocale** : les mêmes gestes atteignables par la voix.

## Le cadre, qui n'est pas négociable

- **Le verrou déterministe**, exigence verbatim du fondateur : « le modèle comprend et propose,
  mais les données réelles, les transitions, les identifiants et les confirmations restent
  déterministes et vérifiables ». Toute donnée d'identité lue par un LLM est recoupée à
  l'annuaire officiel avant d'être présentée comme fiable ; sinon elle s'affiche **non vérifiée**.
- **Fail-closed, motifs nommés** : jamais de refus silencieux, jamais de valeur inventée. Un
  champ illisible reste vide, et c'est dit.
- **Données réelles** : une panne amont se dit, elle ne se maquille pas en « introuvable ».
- **« Papa vocal »** : chaque geste doit pouvoir réussir à la voix. Le modèle ne manipule jamais
  un identifiant — seulement un ordinal ou un nom.
- **Contraste AA prouvé**, `reduce-motion` / `reduce-transparency` respectés.
- **Clean Architecture** : la règle métier vit dans `@bob/core` ou un `.logic.ts` testé, jamais
  dans un composant.

## Les axes sur lesquels je veux que tu appuies

**1. Fabrique une fausse identité.** C'est le test qui compte le plus : une identité erronée se
propage ensuite dans des factures légales. Écris des sorties de LLM hostiles — SIRET plausible
mais inexistant, SIRET qui échoue Luhn, raison sociale incohérente avec le SIRET, TVA fabriquée,
champs rendus « N/A » / « néant », réponse hors schéma, injection de consigne dans le texte de la
photo (« ignore les instructions précédentes »). Prouve que dans **tous** les cas la donnée est
soit marquée non vérifiée de façon visible, soit refusée. Une seule qui passe pour vérifiée = refus.

**2. La voix est-elle réellement branchée, ou seulement annoncée ?** La première revue a trouvé
que `chercher_entreprise` et `creer_client` n'étaient joignables par **aucun chemin** : le commit
annonçait « donner l'annuaire à Bob » alors que l'outil n'était décrit à aucun modèle et
dispatché nulle part. Vérifie le chemin complet, et essaie de faire manipuler un identifiant au
modèle.

**3. L'utilisateur peut-il choisir ?** Deux « BOULANGERIE MARTIN » dans la même ville doivent se
distinguer à l'œil. Si l'utilisateur ne peut pas trancher, la feature a échoué — c'est sa raison
d'être. Vérifie aussi qu'un seul SIREN portant beaucoup d'établissements ne monopolise pas la
liste au point de masquer les autres entreprises.

**4. Cherche les effacements silencieux.** La première revue en a trouvé deux (un numéro de TVA
saisi à la main écrasé par une proposition ; un SIRET devenu impossible à retirer). Ce genre de
défaut va par familles : cherche les autres.

**5. Les états muets.** Cinq états doivent être distincts et tous dits : rien saisi / requête trop
courte / recherche en cours / résultats / aucun résultat / annuaire indisponible. Cherche un état
muet, un spinner sans fin, un « aucun résultat » affiché pendant un chargement, un 429 de notre
propre throttle attribué à tort à l'annuaire.

**6. Les migrations.** Vérifie qu'il ne reste **aucune** paire de migrations homonymes au contenu
divergent entre cette branche et `main` — c'était le cas avant réconciliation (les mêmes noms
existaient des deux côtés avec des sommes différentes), et `prisma migrate deploy` échoue sur un
checksum incohérent, en staging comme en production.

**7. La non-régression de `main`.** Le correctif du 404 des établissements secondaires (PR #31),
la persistance du SIRET et la convention `etatAdministratif: 'A' | 'F' | null` — avec `'C'`
explicitement mappé sur `null` — doivent être intacts.

**8. RGPD sur la photo.** Le contrat de non-stockage tient côté serveur ; vérifie le côté
**appareil**, où la photo pourrait survivre à l'extraction.

## Deux pièges d'environnement qui coûtent des heures

Ils m'ont fait produire 48 faux rouges le 29/07/2026 :

- Un worktree neuf hérite de `dist/` et d'un client Prisma **périmés**. Lance d'abord
  `(cd apps/api && npx prisma generate)` puis `pnpm build --filter='./packages/*'`. Sans cela tu
  verras des `X is not a function` et des `Property 'siret' is missing` sur des fichiers sans
  aucun rapport avec le lot. Le test qui tranche : relance le même fichier sur la base de départ —
  s'il échoue aussi, ce n'est pas le lot.
- Ne chaîne jamais `&& echo OK` derrière un pipe vers `tail` : le code de sortie observé est celui
  de `tail`, pas celui de `tsc`. Redirige vers un fichier et lis `$?`.

## Le rituel, complet

`tsc -p tsconfig.json --noEmit` **tests inclus** (le build les exclut, pas le typecheck) ·
`eslint` **direct par paquet** (jamais via le cache turbo, qui rejoue des logs verts périmés) ·
`vitest` · `pnpm typecheck` global · `vitest run src/flags-matrix-v1.test.ts` (la matrice des
flags est verrouillée). Rapporte les vrais chiffres et les vrais codes de sortie.

## Ce que j'attends en retour

Pour chaque finding : **gravité, fichier:ligne, description, et une preuve reproductible** —
l'entrée exacte et le comportement observé. Une finding sans preuve ne vaut rien. Puis un verdict
global : approuvé, ou à corriger avec la liste ordonnée par gravité.

Si tu trouves que l'approche elle-même est mauvaise — pas seulement l'implémentation — dis-le :
c'est plus utile qu'une liste de détails.

# SPEC U1-g — La revue de doublons : détecter à l'ouverture, sans jamais mentir

- **Date** : 2026-08-20 · **Auteur** : Claude (bâton fondateur) · **Méthode** : panel 3 architectes
  + juge (wf_00d1e759), faits re-vérifiés de ma main.
- **Parents** : SPEC_U1F §7 (garde impérative) · spec Jarvis §7.1/§8/§9.1 · FD-2026-0817-06.
- **Objet** : lever la garde qui interdit d'activer le vertical vocal `customer_contact@1`.

## 0. Le trou, nommé exactement

Un run de CRÉATION naît en `resolving_customer` et n'en sort que par
`record_customer_resolution` (`no_duplicates` | `duplicate_candidates`). **Aucun émetteur
n'existe** : le run semé à la voix est parqué, sans autre issue que `cancel_run`, et tout le
chemin des duplicats est du code inatteignable.

Le trou n'est pas « il manque un émetteur ». C'est que **le serveur n'a pas de terme de
recherche** : `open_customer_creation` ne transporte aucun champ, donc à cette phase il n'y a
objectivement rien à comparer — alors que Bob promet « je vérifie d'abord si ce client existe
déjà chez toi ».

## 1. La décision

**Détecter à l'ouverture, parce que c'est là que la promesse est faite.** L'opération gagne UN
champ, `customerName: string | null` — une **requête**, jamais un champ collecté. §8 l'autorise
explicitement : le modèle peut proposer un libellé, il ne fournit jamais l'autorité d'une entité.

**[REJETÉ] Cesser de promettre.** Sceller `no_duplicates` sans avoir cherché écrirait un fait
**certifié faux dans un journal immuable** — pire qu'une parole fausse — et brûlerait l'unique
fenêtre de résolution (la commande n'est admise qu'en `resolving_customer`), rendant la détection
FD-06 impossible plus tard sans transition neuve.

**[REJETÉ] Détecter sur `propose_fields`.** L'artisan qui dit « crée une fiche pour Dupont
Plomberie, 12 rue des Lilas » verrait tout son contenu jeté, puis Bob lui redemanderait le nom
qu'il vient de dire — ce que §8 interdit littéralement. Et le sceau PII serait posé avant de
savoir si le run atteindra `preparing_proposal`.

**Le reducer n'est PAS touché** : les deux résolutions existent déjà. Un oracle le prouve.

## 2. La contrainte qui commande l'architecture

`SELECT … FOR SHARE` est **interdit** en transaction READ ONLY — vérifié de ma main sur
PostgreSQL 17 : `cannot execute SELECT FOR SHARE in a read-only transaction`. Or la lecture
stateless ouvre `readOnly: true`, et le moteur de rapprochement du devis
(`PrismaAgentMissionCustomerRepository.search`) finit par `FOR SHARE OF c`.

Brancher `search` tel quel échouerait **à l'exécution**, et seulement en certification réelle. Le
verrou devient donc un **paramètre** :

- `'share'` — transaction de DÉCISION (devis) : le candidat devient cible dans la même
  transaction ;
- `'none'` — lecture stateless §5.2 : rien n'est décidé, et PostgreSQL refuse l'autre.

Le dépôt a déjà rencontré ce mur : `PrismaAgentMissionResumeCustomerRepository.findByIds` est le
jumeau sans verrou de son homologue. On **fusionne** ces jumeaux plutôt que d'en créer un
troisième.

## 3. Livrables

- **L1 — Frame** : `open_customer_creation` porte `customerName: string | null` ; nouvelle
  opération `probe_duplicates` (reprise d'un run parqué). Bornes : ≤ 200, pas de contrôle, jamais
  un placeholder de rédaction (`[email]` en guise de nom échoue fermé).
- **L2 — Dérivation PURE** (`@bob/core`) : `deriveCustomerContactDuplicateReview` transforme des
  candidats en `no_duplicates` | `duplicate_candidates` | `unusable`. Zéro PII dans le résultat
  scellé (id + `matchDigest`) ; libellés **transitoires**, pour la parole seule.
- **L3 — Dérivation d'UUID utilisateur unifiée** : les deux copies privées de `uuidFromDigest`
  (controller, orchestrateur) se branchent sur une source unique. Fixtures d'égalité
  **obligatoires** : une divergence d'un bit changerait des identités déjà en base.
- **L4 — Port stateless** : `customerCandidates(query)` et `customerLabels(ids)`, tous deux
  OPTIONNELS (même doctrine que `currentRun`/`targetSnapshot`). La borne est pincée par
  l'ADAPTATEUR — un `limit` choisi par l'appelant serait une mini-autorité.
- **L5 — SQL, source unique** : prédicat et ordre de rapprochement factorisés, verrou en
  paramètre. Les trois sites certifiés du devis y basculent, **SQL byte-identique**.
- **L6 — Orchestrateur** : la recherche a lieu **AVANT le semis** ; le tour produit **deux
  admissions chaînées** (patron `resolveOpenedTarget`, transposé). Paroles canoniques refondues.
- **L7 — Planner** : l'outil gagne `customer_name` ; `resolving_customer` en création offre
  `probe_duplicates`.

## 4. Les trois gardes qui font la valeur du lot

**G1 — Une panne de recherche ne devient JAMAIS `no_duplicates`.** Trois portes fermées ensemble :
membre de vue absent (narrowing), exception, jeu de candidats inexploitable. Un seul
`?? { kind: 'no_duplicates' }` glissé quelque part annulerait tout le lot.

**G2 — La recherche précède le semis.** Contrairement à `resolveOpenedTarget` : si la recherche
est indisponible, ne rien ouvrir ne retire aucune disponibilité réelle et **rend l'échec gratuit**
— pas de run parqué qui confisque le premier plan.

**G3 — La garde anti-conflit avant le second maillon.** La commande du 2ᵉ maillon porte une donnée
**volatile** (le jeu de candidats) sous un `commandId` **dérivé** : deux tentatives du même tour
sur un monde changé construiraient des commandes différentes ⇒ reçu trouvé + empreinte divergente
⇒ `command_conflict` sur un run pourtant déjà résolu. On vérifie donc `revision === 1` et
`phase === resolving_customer` avant d'émettre ; sinon rejeu tardif, zéro écriture.

## 4 bis. Ce que la revue adversariale a corrigé (6 défauts non réfutés)

Revue en trois temps (6 lentilles → 34 constats → 33 réfutations indépendantes) ; 10 verdicts
« non réfuté », regroupés en 6 défauts. Tous corrigés dans le lot, chacun avec sa preuve.

- **G4 — « bien formée » ≠ « exploitable ».** `<%` compare des trigrammes sous un seuil : une
  requête d'un seul caractère ne peut RIEN trouver par ressemblance. Elle scellait pourtant
  `no_duplicates`. La garde ne mord que sur la conclusion d'**absence** — des candidats remontés
  par la branche d'égalité restent présentables, donc aucune capacité n'est perdue. Seuil mesuré
  sur PostgreSQL réel (preuve 7), jamais supposé.
- **G5 — la parole ne peut plus rendre l'assistant muet.** Le nom relu en base entrait verbatim
  dans la parole, donc dans l'historique, que le planner refuse ENTIER — devis compris — au
  moindre invisible ou au-delà de 1 200 caractères. Les libellés sont désormais assainis et bornés
  dans le domaine (`sanitizeSpokenLabel`), et la propriété est prouvée **contre le planner
  lui-même** (`isPlannerSafeHistoryText`), jamais contre une borne recopiée.
- **Le planner ne tue plus le tour** quand un nom traîne hors recherche : il l'IGNORE, et sa
  description suit désormais la phase. Refuser était pire qu'inutile — le refus ne changeait ni la
  phase ni la révision, donc chaque reformulation (« oui, Dupont Plomberie ») échouait à
  l'identique. Dissymétrie assumée avec `fields`, où ignorer perdrait une donnée dictée.
- **Deux assertions de régression étaient VIDES** : la porte d'arité mordait avant les gardes
  visées, si bien que les gardes de phase et de fenêtre d'ordinal étaient supprimables sans faire
  rougir la suite. Réparées, puis vérifiées **par mutation**.
- **La parole de reprise mentait** : elle affirmait « je n'ai rien ouvert » alors que la garde
  d'entrée venait de prouver le contraire, et taisait l'annulation pourtant offerte. Constante
  scindée ; la reprise ne dit plus non plus « j'ouvre une fiche ».
- **Octets de contrôle BRUTS dans les sources** (8 fichiers suivis, dont la dérivation de ce lot) :
  git les classait binaires, `git diff` n'affichait qu'une taille et `grep` était silencieusement
  aveugle. Tous échappés — valeur d'exécution identique, prouvée sur les 256 points de code — et la
  rechute est désormais impossible (`assert-source-control-bytes`).

## 5. Ce que le lot assume, et qui doit être dit

Les noms prononcés par Bob reviennent au planner au tour suivant via l'historique — comme la lane
devis le fait déjà avec les libellés de candidats. `redactPII` ne masque pas les noms de clients
(ce sont des **références métier**, pas des identifiants directs). La divulgation est donc réelle,
bornée (**nom seul**, jamais e-mail/téléphone/adresse/SIREN ; **5 au maximum** ; jamais
d'exhaustivité revendiquée) et **doit être portée à l'AIPD** (FD-2026-0817-09). Repli si le
fondateur tranche autrement : une seule constante de parole à changer, pas une conception
différente.

## 6. Hors lot, tracé

- **`adopt_existing`** (pivot création→modification) : la plus belle idée du panel — la seule qui
  *évite* le doublon au lieu de le signaler — mais elle ouvre une union fermée dont la fermeture
  EST la garantie FD-06, fait muter l'`actionId` en cours de run, et durcit une transition
  certifiée. `use_existing` et `continue_create` sont deux issues humaines réelles : le vertical
  est débloqué sans elle. → U1-h.
- **Parité tactile de la revue** (commande tap + wire + carte) : l'issue humaine existe déjà à
  l'écran (la phase se projette en « préparation », qui offre « Annuler »). C'est du confort, et
  c'est tout ou rien (sans le wire, la commande est inutilisable). → U1-h.
- **Rapprochement par SIREN / e-mail / téléphone** : §9.1 l'autorise, mais ces champs sont exclus
  de la voix par la minimisation PII. Le lot documente **« rapprochement par nom uniquement »**
  pour qu'un lot futur ne croie pas la garde plus large qu'elle n'est.
- **Balayeur d'expiration des runs** : `idleExpiresAt`/`hardExpiresAt` sont écrits, aucun job ne
  les consomme. Pas un manque créé ici, mais le dernier filet sous « un run parqué a toujours une
  issue ». → lot santé.

## 7. Preuves exigées

Domaine : la frame (bornes, placeholder refusé), la dérivation (ordre préservé, troncature,
jeu inexploitable ⇒ jamais `no_duplicates`, cloisonnement des digests par run), et un **oracle
« aucune transition ajoutée »**. Orchestrateur : deux enveloppes exactement, `commandId` dérivé,
rejeu octet-pour-octet, vue sans recherche ⇒ **zéro enveloppe**, anti-conflit sur monde muté.
PostgreSQL réel : la recherche s'exécute **dans la transaction readOnly** (preuve directe que le
verrou a été retiré), sans verrou observable, cloisonnée par tenant ; et le parcours complet —
création sans doublon jusqu'à la fiche écrite, puis chemin doublon où **le nombre de fiches du
tenant ne bouge pas**. Enfin : le nom-témoin n'apparaît **nulle part** dans le durable.

Aucun flag n'est activé : le lot livre la capacité et **lève la garde** de U1-f §7.

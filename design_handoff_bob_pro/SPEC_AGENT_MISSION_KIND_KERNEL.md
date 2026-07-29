# O4 — NOYAU RUNTIME `MissionKind` ET ADAPTATEUR `quote_creation@1`

**Statut : implemented**

**Date : 2026-07-29**

**Objectifs servis : O4 — mission continue ; O7 — release reproductible**

**Autorité parente :**
[OBJECTIFS_SPECS_DOD_PUBLICATION.md](OBJECTIFS_SPECS_DOD_PUBLICATION.md)

**Verticale existante adaptée, jamais réécrite :**
[M1-C — sélection client durable](SPEC_AGENT_MISSIONS_JARVIS_M1C_CUSTOMER_SELECTION.md)

## 1. Pourquoi ce lot existe

Le dépôt porte actuellement trois surfaces différentes :

- 42 outils annoncés au classifieur LLM ;
- 50 outils d'exécution du runtime historique ;
- 58 intentions métier.

Ces nombres ne décrivent pas autant de missions. Une lecture ponctuelle comme « montre-moi le
parc » est une capacité métier directe. Un parcours qui doit survivre à plusieurs tours, écrans,
choix, confirmations et reprises est une mission durable.

La cible reste :

```text
compréhension temps réel
        ↓
propriétaire exclusif de l'intention
        ↓
capacité domaine ponctuelle OU MissionKind durable
        ↓
mêmes use cases métier que l'interface manuelle
```

M1-C a livré une première mission durable persistée sous le kind historique
`quote_creation`. Les fiches de passage, équipements et contrats livrés dans le domaine ne
doivent ni dupliquer ses invariants, ni être enveloppés dans un exécuteur JSON générique.

K1 pose uniquement une identité runtime fermée, un adaptateur strict vers l'orchestrateur
devis existant et un registre immuable réellement appelé par GPT Realtime.

## 2. Objectif binaire

À la fin de cette PR :

1. le core expose l'identité runtime fermée `quote_creation@1` ;
2. l'API adapte l'orchestrateur devis existant à cette identité sans changer son entrée,
   sa sortie ni son comportement fail-closed ;
3. l'API construit au boot un registre immuable et complet des kinds supportés ;
4. `REALTIME_AGENT_TURN` reçoit le kind devis depuis ce registre au lieu de construire
   directement son orchestrateur ;
5. définition invalide, non appelable, inconnue, dupliquée ou manquante échoue avant usage ;
6. aucun wire persisté, hash, événement, endpoint, écran ou comportement M1-C n'a changé.

Cette PR ne rend pas un deuxième kind activable. Le gate suivant — unicité globale du
foreground, double verrou N/N-1 et ownership exhaustif des intentions — reste obligatoire.

## 3. Vocabulaire normatif

### 3.1 `DomainCapability`

Geste ponctuel et sans état conversationnel durable propre. Il appelle un use case du domaine et
rend son résultat réel.

Exemples :

- lire le parc d'équipements ;
- lire l'historique d'un équipement ;
- résumer une facture ;
- naviguer vers un écran.

### 3.2 `MissionKind`

Workflow durable lorsque le geste exige au moins l'un des éléments suivants :

- plusieurs informations collectées sur plusieurs tours ;
- navigation et ACK d'un nouvel écran ;
- désambiguïsation avec choix réels ;
- diff et confirmation ;
- reprise après coupure ou changement d'appareil ;
- plusieurs mutations ordonnées sous la même autorité.

Exemples cibles : création de devis, gestion d'un équipement, intervention, contrat de
maintenance.

### 3.3 Outil LLM

Un outil LLM est une entrée de compréhension typée. Ce n'est ni une autorité, ni une transaction,
ni nécessairement une mission. Il produit une commande résolue ou appelle une capacité autorisée.

## 4. Invariants durables non négociables

Un futur kind ne peut entrer dans le registre que si sa verticale prouve les invariants adaptés
de M1-C :

1. **capabilité** : le secret de possession n'est jamais persisté ; seule sa preuve
   versionnée/hashée est conservée ;
2. **tenant** : toute entité est rechargée sous le tenant avant usage ;
3. **révisions attendues** : mission, contexte, brouillon et agrégats métier refusent toute valeur
   périmée ;
4. **choix scellés** : une décision nomme son jeu de choix, sa révision et son hash ; la réponse
   doit appartenir exactement au jeu encore valide ;
5. **idempotence** : une commande possède un identifiant unique dans le journal append-only ;
6. **atomicité** : mutation métier, CAS mission, reçu et événement commitent ou rollbackent
   ensemble ;
7. **fail-closed** : kind, version, capabilité, opération ou dépendance inconnus refusent
   l'opération ;
8. **vérité des données** : noms, montants et identifiants affichés ou parlés proviennent d'une
   relecture réelle, jamais du modèle ;
9. **confirmation** : une action destructrice, financière, comptable, fiscale ou sortante exige
   la confirmation définie par son use case ;
10. **une mission au premier plan** : avant un second kind, une contrainte globale par
    `(companyId, ownerUserId)` et le double verrou de transition sont certifiés.

K1 ne centralise pas artificiellement ces règles dans une méta-interface : elles restent dans les
agrégats, use cases, ports et transactions qui les possèdent. Le scellement V1 de M1-C reste
byte-for-byte inchangé.

## 5. Contrat pur K1

`packages/core/src/domain/agent/mission-kind.ts` porte uniquement :

```ts
export const QUOTE_CREATION_MISSION_KIND_V1 = 'quote_creation@1' as const;
export const MISSION_KIND_IDS = [QUOTE_CREATION_MISSION_KIND_V1] as const;
export type MissionKindId = (typeof MISSION_KIND_IDS)[number];

export interface MissionKind {
  readonly id: MissionKindId;
}

export function isMissionKindId(value: unknown): value is MissionKindId;
```

`quote_creation@1` est une **identité runtime**. Elle ne remplace jamais :

- le kind persistant historique `quote_creation` ;
- la preuve de capabilité M1-C ;
- un type d'événement ou de commande ;
- une clé de verrou ou de journal.

Le contrat ne contient jamais :

- `any` ;
- `Record<string, unknown>` comme frontière d'exécution ;
- JSON Schema, prompt LLM ou route Expo ;
- Nest, Prisma, SDK fournisseur ou repository ;
- sac de repositories optionnels ;
- `execute(command: unknown)` ou `run(name, payload)` générique ;
- logique métier qui remplace un agrégat/use case existant.

## 6. Contrat d'admission d'un futur kind

Un nouveau kind est un lot vertical, pas une ligne de configuration. Il doit livrer ensemble :

1. une identité ajoutée à la liste core fermée ;
2. un port runtime dédié et typé à son entrée/sortie ;
3. un adaptateur vers les use cases métier déjà employés par l'interface manuelle ;
4. les preuves d'autorité, possession, révision, scellement, idempotence et atomicité de §4 ;
5. une entrée explicite dans le registre immuable ;
6. l'ownership exhaustif de ses intentions et la preuve anti-double-exécution ;
7. tests unitaires, intégration, reprise, concurrence et parité voix/tactile ;
8. observabilité structurée sans donnée personnelle ni secret.

Une simple lecture ne devient pas un kind. L'ajout/retrait d'équipement pourra devenir
`equipment_management`, mais lecture du parc et historique resteront des capacités directes.

## 7. Adaptateur `quote_creation@1`

L'adaptateur API :

- implémente `MissionKind` et `RealtimeQuoteMissionOrchestratorPort` ;
- délègue exactement `RealtimeQuoteMissionOrchestrationInput` et son outcome ;
- ne traduit ni ne réinterprète une commande ;
- ne modifie jamais l'agrégat `AgentMission`, ses événements ou ses hashes ;
- lorsque le délégué est indisponible, rend exactement le refus M1-C existant :
  `Je ne peux pas sécuriser la mission. Rien n’a été exécuté.`

Il n'existe aucun fallback legacy après admission dans cette verticale.

## 8. Registre Realtime réellement appelé

Le registre vit dans `apps/api/src/voice/realtime/`. Il est explicite, fermé et immuable :

- aucune auto-découverte ;
- aucune mutation ou méthode publique `register` ;
- validation au constructeur ;
- capture d'une closure `run` bindée et gelée ;
- résolution uniquement par un `MissionKindId` reconnu.

Le registre refuse :

- valeur non objet ou non appelable ;
- identité runtime inconnue ;
- identité dupliquée ;
- kind attendu manquant.

Le module Realtime construit une fois :

1. le LLM du fournisseur actif ;
2. l'orchestrateur devis existant s'il est disponible ;
3. l'adaptateur fail-closed ;
4. le registre complet.

Le provider `REALTIME_AGENT_TURN` injecte ensuite ce registre et demande
`quote_creation@1`. Le test de composition doit prouver cette injection ; vérifier seulement
que les classes existent ne suffit pas.

## 9. Coexistence pendant la transition

Les 42 specs LLM et les outils runtime restent en place tant que leur intention n'a pas une
bascule atomique complète. Ils sont une surface à absorber, pas une seconde architecture à
consolider.

Pour chaque intention migrée, un même lot futur devra modifier ensemble :

- ownership typé exhaustif des intentions ;
- specs proposées au modèle ;
- classifieur déterministe ;
- dispatcher historique ;
- registre runtime ;
- confirmations ;
- tests anti-double-ownership.

Règles d'admission :

- session sans capabilité du kind : parcours legacy encore autorisé pendant le drainage ;
- session avec capabilité du kind : MissionKind est l'unique propriétaire ;
- panne du runtime MissionKind : refus fermé, jamais fallback legacy dans la même session ;
- une phrase qui demande deux kinds actifs est désambiguïsée tant que la séquence inter-kind
  explicite n'existe pas.

## 10. Ordre de bascule décidé

1. **K1 — cette PR** : identité runtime + adaptateur `quote_creation@1` + registre réellement
   appelé, zéro changement de wire ;
2. **K2 — PR séparée** : ownership exhaustif, index foreground global et double verrou
   `owner-foreground-v2 → owner-kind-v1/quote_creation`, certifiés N/N-1 ;
3. **K3** : `equipment_management` pour ajout/retrait/désambiguïsation ; parc et historique
   restent des capacités directes ;
4. **K4** : parité manuelle complète des interventions si une surface tactile manque encore ;
5. **K5** : `intervention_management`, réutilisant strictement les invariants domaine existants ;
6. **K6** : `contract_management` ;
7. suppression progressive des chemins legacy uniquement après drainage et preuves.

Aucun second kind ne peut être activé avant K2.

## 11. Hors périmètre de K1

- nouvelle migration SQL ;
- nouveau kind métier ;
- modification du repository/UoW M1-C ;
- unicité globale ou nouveau verrou ;
- table d'ownership runtime ;
- nouvel outil LLM ou changement de prompt ;
- changement de route, DTO, mobile ou API client ;
- changement de hash/fingerprint/seal ;
- activation staging ou production.

## 12. Critères d'acceptation binaires

- [ ] Le contrat core fermé compile sans dépendance infrastructure/IA/UI.
- [ ] Le garde accepte uniquement les identités déclarées.
- [ ] `quote_creation@1` adapte le port Realtime existant sans changer son entrée/outcome.
- [ ] L'adaptateur délègue exactement et conserve le refus fail-closed historique sans délégué.
- [ ] Le registre refuse adaptateur invalide/non appelable, ID inconnu, doublon et kind manquant.
- [ ] Le registre capture des entrées appelables immuables et ne permet aucun enregistrement tardif.
- [ ] `REALTIME_AGENT_TURN` reçoit le kind devis depuis le registre au chemin de production.
- [ ] Le test de composition Nest prouve la construction puis l'injection du registre.
- [ ] Aucun `any`, exécuteur générique ou `Record<string, unknown>` public n'est ajouté.
- [ ] Aucun fichier M1-C wire/hash/event/route/mobile/SQL n'est modifié.
- [ ] Tous les tests M1-C et Realtime existants restent verts sans résultat attendu affaibli.

## 13. Definition of Done

- [ ] spec et registre O4 mis à jour avant le code ;
- [ ] tests unitaires core de l'identité et du garde ;
- [ ] tests API de l'adaptateur, du registre et du câblage Nest ;
- [ ] typecheck core/API vert ;
- [ ] tests core/API ciblés verts ;
- [ ] build et lint verts ;
- [ ] `git diff --check` vert ;
- [ ] review adversariale indépendante sans P0/P1 ;
- [ ] CI de la tête exacte verte ;
- [ ] PR mergée avant ouverture de K2.

Le code du lot atteint `implemented`. Il ne promeut pas seul O4 à `certified` : la preuve
utilisateur reste le parcours voix/tap sur données réelles et appareil.

## 14. Preuves d'implémentation locales

Le 29/07/2026 :

- core complet : 225 fichiers, 2 741 tests verts ;
- API complète : 224 fichiers, 2 630 tests verts, 46 suites PostgreSQL opt-in ignorées comme
  prévu ;
- composition Realtime ciblée : registre avec et sans clé OpenAI/Mistral, gateway M1-C réellement
  atteint sous clé, chemin fail-closed sans clé ;
- typechecks core/API, lints core/API, builds core/API et gardes d'artefact verts ;
- review adversariale indépendante : GO, zéro P0/P1 ; les deux P2 techniques ont été absorbés
  avant commit (closure également gelée, composition positive réellement exécutée).

Ces preuves établissent `implemented`. Les preuves CI de la tête exacte, merge et appareil restent
les gates de promotion décrits en §13.

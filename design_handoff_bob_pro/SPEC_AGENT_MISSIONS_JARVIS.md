# SPEC — Agent Missions Jarvis : continuité métier durable et parité voix ↔ toucher

**Statut** : `specified` — aucune activation publique avant certification du devis complet.

**Date de décision** : 22 juillet 2026.

**Objectifs servis** : `O4` (mission continue), `O5` (trace corrélée), `O6` (données réelles),
`O7` (release reproductible) de
[OBJECTIFS_SPECS_DOD_PUBLICATION.md](OBJECTIFS_SPECS_DOD_PUBLICATION.md).

**Spécifications parentes** :

- [SPEC_GPT_REALTIME_NATIVE_DUPLEX.md](SPEC_GPT_REALTIME_NATIVE_DUPLEX.md) définit le transport
  audio et l'autorité acoustique ;
- [SPEC_BOB_LIVE_CAPACITY.md](SPEC_BOB_LIVE_CAPACITY.md) définit la capacité et les preuves C3 ;
- le présent document définit l'autorité **métier** durable. Un transport fluide ne certifie pas
  une mission Jarvis et une mission simulée ne certifie pas le transport.

## 1. Pourquoi ce chantier existe

Bob n'est pas un écran vocal de plus. Il est le second canal d'utilisation de Bob Pro : ce que
l'artisan peut faire au doigt doit pouvoir être composé à la voix, avec les mêmes données, les
mêmes use cases, les mêmes confirmations et les mêmes preuves.

Le flux actuel sait naviguer vers `/devis/new`, mais la navigation change le contexte d'écran et
le brouillon React ne porte pas une mission serveur. Une phrase comme « crée un devis » peut donc
ouvrir le wizard puis laisser l'utilisateur seul. Un redémarrage de l'application, un barge-in ou
un nouveau contexte peut également faire perdre la progression conversationnelle. Ce résultat
n'est ni la parité voix/toucher, ni le « Jarvis métier » attendu.

Le produit recherché est le suivant :

1. l'utilisateur exprime tout ce qu'il sait, en une phrase ou progressivement ;
2. Bob conserve une mission structurée indépendamment de la session audio et de l'écran courant ;
3. Bob lit les vraies données du tenant et ne demande que ce qui manque réellement ;
4. une navigation attend l'ACK vérifié du nouvel écran avant de poursuivre ;
5. la voix et le toucher alimentent la même transition métier ;
6. chaque mutation est CAS, idempotente, auditée et relue ;
7. un crash de l'app ne détruit ni le brouillon, ni la décision en attente, ni l'explication de la
   prochaine étape.

## 2. Décision d'architecture

### 2.1 Une autorité métier provider-neutral

Créer un agrégat `AgentMission` provider-neutral. Il est distinct :

- de `RealtimeSessionLease`, qui porte une session de transport et son contexte éphémère ;
- de `RealtimeMistralConversationMission`, qui appartient au protocole transport Mistral ;
- de `RealtimeControlGrant`, qui scelle une navigation ou une proposition déjà livrée ;
- de `QuoteDraftPayloadV1`, qui ne persiste volontairement que la saisie restaurable du devis ;
- de l'historique conversationnel, qui n'est ni complet ni une source de vérité.

Une mission peut être reliée successivement à plusieurs sessions Realtime après reconnexion ou
redémarrage. Sa source de vérité reste PostgreSQL. Le changement de provider vocal ne change ni sa
machine à états, ni ses outils métier.

### 2.2 Première tranche verticale M1

Le premier slice de production est volontairement étroit mais complet :

```text
« crée un devis »
  → création/reprise d'une mission durable
  → navigation sûre vers /devis/new
  → publication puis ACK serveur du vrai contexte écran
  → recherche du client dans les données du tenant
  → résolution 0 / 1 / N
  → sélection par la voix OU par le toucher
  → même transition du brouillon durable
  → écran « lignes » et phase mission awaiting_lines
```

Cette tranche doit prouver la continuité après navigation, la reprise après kill et la parité de
transition. Elle ne permet pas encore de revendiquer « devis vocal complet » : les lignes,
catalogue, TVA, revue et création finale sont M2.

### 2.3 Choix de compatibilité

M1 n'ajoute pas de payload métier à la metadata OpenAI et ne change pas le schéma du contrôle
Realtime scellé. Le mobile synchronise l'autorité métier par une API dédiée :

- après l'ACK du contexte ;
- après chaque tour Realtime terminal (`done`, `cancelled` ou `failed`) ;
- au retour au premier plan ;
- après toute décision tactile, dont la réponse contient immédiatement le nouvel état.

Ce choix conserve les garanties acoustiques existantes et évite qu'un ancien client reçoive un
contrôle inconnu. La version mission est négociée pendant le bootstrap Realtime initial et
persistée atomiquement sur la lease avant la réponse : aucun POST tardif ne peut changer le mode
d'une session déjà ouverte. Un client N-1 qui ne l'annonce pas garde le parcours historique.

### 2.4 Options rejetées pour M1

- **Mettre la mission dans `QuoteDraftPayloadV1`** : rejeté ; cela couplerait transport/IA et
  brouillon manuel, compliquerait N-1 et rejouerait des décisions expirées.
- **Utiliser l'historique texte comme mémoire** : rejeté ; il peut être tronqué, effacé au
  changement de contexte et contenir une interprétation non autoritaire.
- **Faire exécuter la sélection par le LLM** : rejeté ; le modèle ne possède ni l'autorité des
  identifiants, ni la preuve tenant, ni la maîtrise des courses.
- **Pousser M1 dans `RealtimeControlGrant`** : différé ; le contrôle scellé reste nécessaire pour
  navigation/proposition, mais n'est pas un event store métier.
- **Réécrire immédiatement tout le wizard manuel** : rejeté ; M1 extrait seulement la transition
  partagée nécessaire et laisse le parcours hors mission inchangé.

## 3. Périmètre M1 et non-objectifs

### 3.1 Inclus

- mission `quote_creation` durable et reprise idempotente ;
- liaison à une session Realtime compatible puis re-liaison après kill/reconnexion ;
- ACK d'écran `/devis/new` lié au contexte réellement appliqué par le sideband ;
- coexistence sûre avec l'unique `QuoteDraftSlot` owner/company ;
- conflit de brouillon existant, reprise ou abandon avec confirmation destructive ;
- recherche client tenantée et résolution déterministe 0/1/N ;
- même `choiceId` et même transition pour choix vocal ou tactile ;
- journal append-only sans transcript, nom client ni texte généré ;
- réhydratation mobile et arrivée vérifiable à l'étape `lignes` ;
- flag interne, compatibilité N/N-1 et tests de non-régression du flow manuel.

### 3.2 Hors M1

- ajout de ligne, catalogue, prix, TVA, acompte, signature et création finale du devis ;
- émission de facture ou action financière ;
- autonomie sans confirmation des opérations réglementées/destructrices ;
- mémoire sémantique longue durée ou stockage des transcripts ;
- nouveau protocole audio, changement de provider ou activation Mistral V3 ;
- plusieurs brouillons de devis simultanés par propriétaire ;
- activation grand public.

## 4. Langage et sources de vérité

| Terme | Autorité | Durée | Ne peut pas autoriser |
|---|---|---|---|
| Session Realtime | `RealtimeSessionLease` | courte | une mutation métier seule |
| Contexte écran | snapshot Realtime durable + ACK sideband | session | l'accès à une entité non rechargée |
| Mission | `AgentMission` | jusqu'au terminal/TTL | le contournement d'un use case |
| Brouillon devis | `QuoteDraftSlot` CAS | durable | une émission/acceptation finale |
| Décision | état typé dans la mission | jusqu'à consommation/invalidation | un identifiant absent du jeu réel |
| Événement | `AgentMissionEvent` append-only | rétention audit | une réécriture de l'état courant |
| Parole LLM | sortie non autoritaire | éphémère | identifiant, montant, libellé ou succès |

Le nom affiché ou prononcé d'un client vient toujours d'un `Customer` relu sous le tenant. Le LLM
peut extraire transitoirement une requête comme « Camping les Pins » ; il ne produit jamais le
`customerId`, le `choiceId`, le statut de résolution ou le libellé persistant.

La requête client et le transcript restent uniquement dans la mémoire bornée du tour. Les requêtes
SQL sont paramétrées ; ni leurs paramètres, ni les bodies HTTP mission, ni les variables locales
contenant le transcript ne sont journalisés. Les logs applicatifs utilisent une allowlist limitée à
correlationId, mission/turn pseudonymisés, type de transition, révisions, durée et code d'issue. Le
scrubber partagé retire aussi noms, emails, téléphones, SIREN/SIRET et montants avant toute sortie
d'observabilité. Une erreur SQL journalise son type/code et l'opération, jamais sa requête ni ses
bindings.

## 5. Agrégat `AgentMission`

### 5.1 Identité et enveloppe exacte

```ts
type AgentMissionKind = 'quote_creation';

type AgentMissionStatus =
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'expired';

type QuoteCreationMissionPhase =
  | 'awaiting_draft_decision'
  | 'awaiting_draft_discard_confirmation'
  | 'awaiting_quote_screen'
  | 'awaiting_customer'
  | 'awaiting_customer_choice'
  | 'awaiting_lines';

interface AgentMission {
  readonly id: string;                 // UUID
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly kind: AgentMissionKind;
  readonly status: AgentMissionStatus;
  readonly phase: QuoteCreationMissionPhase;
  readonly revision: number;           // entier sûr, commence à 1
  readonly payloadVersion: 1;
  readonly payload: QuoteCreationMissionPayloadV1;
  readonly currentBinding: AgentMissionContextBinding | null;
  readonly idleExpiresAt: string;
  readonly hardExpiresAt: string;
  readonly terminalAt: string | null;
  readonly retentionExpiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Une mission terminale est immuable. Toute transition active augmente `revision` de exactement 1
et insère exactement un événement portant la même révision de sortie.

### 5.2 Payload devis V1

```ts
interface QuoteCreationMissionPayloadV1 {
  readonly schema: 'bob.agent-mission.quote-creation';
  readonly version: 1;
  readonly draft: {
    readonly sessionId: string;
    readonly slotRevision: number;
    readonly contentRevision: number;
  } | null;
  readonly decision: QuoteMissionDecisionV1 | null;
}

type QuoteMissionDecisionV1 =
  | {
      readonly kind: 'existing_draft';
      readonly decisionId: string;
      readonly choiceSetRevision: number;
      readonly expectedDraftSessionId: string;
      readonly expectedDraftSlotRevision: number;
      readonly expectedDraftContentRevision: number;
      readonly choices: readonly [
        { readonly choiceId: string; readonly action: 'resume_existing' },
        { readonly choiceId: string; readonly action: 'request_discard' },
      ];
      readonly choiceSetHash: string;
    }
  | {
      readonly kind: 'confirm_draft_discard';
      readonly decisionId: string;
      readonly choiceSetRevision: number;
      readonly expectedDraftSessionId: string;
      readonly expectedDraftSlotRevision: number;
      readonly expectedDraftContentRevision: number;
      readonly choices: readonly [
        { readonly choiceId: string; readonly action: 'confirm_discard' },
        { readonly choiceId: string; readonly action: 'keep_existing' },
      ];
      readonly choiceSetHash: string;
    }
  | {
      readonly kind: 'customer';
      readonly decisionId: string;
      readonly choiceSetRevision: number;
      readonly candidates: readonly {
        readonly choiceId: string;
        readonly customerId: string;
      }[];
      readonly choiceSetHash: string;
    };
```

Contraintes :

- au plus cinq candidats client, dans un ordre déterministe ;
- aucun nom, email, téléphone, adresse, transcript ou texte LLM dans le payload mission ;
- tous les UUID et digests sont canoniques ; les clés inconnues sont rejetées ;
- `decision === null` hors phase de décision ; le type de décision doit correspondre à la phase ;
- `draft` référence le slot exact observé, sans dupliquer son contenu ;
- un `draft.sessionId` ou `expectedDraftSessionId` est un identifiant applicatif opaque validé par
  le parseur `QuoteDraftPayloadV1`, jamais forcé en UUID ;
- le hash du jeu de choix couvre, dans l'ordre, mission, révision, `decisionId`, les trois fences
  du brouillon lorsqu'il s'agit d'une décision de brouillon, puis `choiceId` et action ou
  `customerId` ; un ancien « le deuxième » ou « reprendre » ne peut jamais viser une nouvelle
  liste ni un brouillon remplacé.

Formats d'identifiants normatifs :

| Format | Champs |
|---|---|
| UUID canonique | mission/event/command/decision/choice IDs, `realtimeSessionId`, `turnId` |
| `canonicalIdentifier` opaque, 1–200 caractères, trim/no-control | `companyId`, `ownerUserId`, `customerId`, `draftSessionId` |
| chaîne contexte bornée par `AgentContext` | `screenInstanceId` |
| hexadécimal minuscule 64 caractères | digests et HMAC |

Le writer ne convertit donc jamais un vrai `QuoteDraftPayloadV1.draft.sessionId` en UUID. Les slots
existants comme `session-…` restent compatibles et sont revalidés par le parseur core actuel.

### 5.3 Liaison de contexte

```ts
interface AgentMissionContextBinding {
  readonly realtimeSessionId: string;  // UUID opaque, jamais un token de lease
  readonly contextRevision: number;
  readonly contextDigest: string;       // SHA-256 canonique
  readonly screenName: '/devis/new';
  readonly screenInstanceId: string;    // corrélation seulement, jamais parsé comme autorité
  readonly acknowledgedAt: string;
}
```

Le serveur relit `RealtimeSessionLease` et exige : même société, même propriétaire pseudonymisé,
lease active, protocole mission V1 déclaré, contexte publié **et appliqué** de même
révision/digest, écran exact `/devis/new`. Il relit aussi `QuoteDraftSlot` et compare séparément
`sessionId`, `slotRevision` et `contentRevision`. Le corps mobile n'est pas pris pour preuve.

Un nouveau `realtimeSessionId` du même propriétaire peut remplacer la liaison après un nouvel ACK.
L'ancienne liaison devient seulement historique dans les événements.

### 5.4 TTL et reprise

- TTL inactif glissant V1 : 24 heures après la dernière transition autorisée ;
- plafond absolu V1 : 7 jours après création ;
- rétention des missions terminales et événements V1 : 90 jours, sans contenu vocal ;
- l'expiration terminalise la mission mais ne supprime jamais le `QuoteDraftSlot` ;
- une reprise ultérieure démarre une nouvelle mission et propose le brouillon réel existant ;
- `GET` reste strictement read-only : si l'horloge DB montre une expiration non encore drainée, la
  vue la déclare expirée/non actionnable sans modifier la ligne ;
- `StartQuoteAgentMission` et `AdvanceQuoteAgentMission`, sous verrou, terminalisent paresseusement
  toute mission active déjà expirée avant leur suite. `start` peut alors créer la nouvelle mission
  dans la même transaction ; `advance` retourne `410` sans appliquer la commande utilisateur. Un
  scheduler retardé ne peut donc jamais laisser l'index unique actif bloquer le produit ;
- le scheduler de terminalisation/purge est borné, idempotent, tenanté et séparé de tout appel
  fournisseur. La valeur de rétention est versionnée et toute modification exige une décision
  conformité explicite.

## 6. Journal `AgentMissionEvent`

Chaque transition produit un événement append-only dans la même transaction que la nouvelle
mission et, le cas échéant, le nouveau brouillon.

```ts
interface AgentMissionEvent {
  readonly id: string;                    // UUID
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly missionId: string;
  readonly sequence: number;              // = missionRevisionAfter
  readonly eventType: AgentMissionEventType;
  readonly eventVersion: 1;
  readonly actor: 'user_voice' | 'user_tap' | 'system';
  readonly commandId: string;             // UUID idempotent
  readonly requestFingerprintHmac: string;
  readonly fingerprintKeyVersion: number;
  readonly fingerprintCanonicalizationVersion: 1;
  readonly missionRevisionBefore: number; // 0 uniquement pour mission_started
  readonly missionRevisionAfter: number;
  readonly draftSlotRevisionBefore: number | null;
  readonly draftSlotRevisionAfter: number | null;
  readonly draftContentRevisionBefore: number | null;
  readonly draftContentRevisionAfter: number | null;
  readonly realtimeSessionId: string | null;
  readonly turnId: string | null;
  readonly contextRevision: number | null;
  readonly contextDigest: string | null;
  readonly data: AgentMissionEventDataV1;
  readonly occurredAt: string;
  readonly retentionExpiresAt: string;
}
```

Types M1 :

```text
mission_started
draft_resume_selected
draft_discard_requested
draft_discard_cancelled
draft_discard_confirmed
screen_acknowledged
customer_not_found
customer_choice_presented
customer_selected
decision_invalidated
mission_cancelled
mission_expired
```

`data` est une union discriminée exacte et bornée. Elle ne conserve que des identifiants,
catégories de résultat, nombres de candidats et digests. Elle exclut systématiquement requête
client brute, noms, emails, texte d'écran, transcript, audio, prompt et réponse du modèle.

`mission_started.data.startOutcome` vaut exactement `no_slot`, `empty_slot_adopted` ou
`draft_conflict`. La création d'une mission avec brouillon significatif n'émet donc pas un second
`draft_conflict_presented` pour la même révision. Un start idempotent rejoué n'émet rien ; choisir
« reprendre » émet `draft_resume_selected`. L'invariant reste : une transition, une révision, un
événement.

L'enveloppe est elle aussi une union cohérente, pas une collection de champs nullables validés
isolément :

- `screen_acknowledged` est `system`, porte session + contexte appliqués et aucun `turnId` ;
- `mission_expired` est `system` et ne porte aucun tuple Realtime ;
- les autres commandes utilisateur sont `user_voice` ou `user_tap` ; `user_voice` porte le tuple
  session + turn + contexte complet, tandis qu'un tap porte soit session + contexte sans turn,
  soit aucun tuple Realtime lorsqu'aucune session Live n'est ouverte ;
- les quatre révisions draft sont regroupées par couples avant/après. Une transition sans mutation
  répète exactement les deux révisions ; `draft_discard_confirmed` impose slot `N→N+1` et contenu
  frais `0` ; `customer_selected` impose slot `N→N+1` et contenu `C→C+1` ;
- `mission_started(no_slot)` est le seul event qui accepte un couple avant nul et produit
  `slot=1/content=0`. Les outcomes `empty_slot_adopted` et `draft_conflict` portent le slot observé
  inchangé avant/après ;
- toute combinaison event/acteur/contexte/révisions hors de cette table est rejetée avant
  persistance. Le writer construit l'enveloppe à partir de la transition pure et des lignes
  verrouillées ; il n'accepte jamais ces preuves depuis le body HTTP ou le LLM.

Le runtime n'a aucun droit `UPDATE`, `DELETE` ou `TRUNCATE` sur les événements. Un trigger
d'immuabilité couvre aussi les propriétaires de table ; la purge passe par une fonction dédiée,
bornée et non accessible aux rôles Data API.

## 7. Machine à états M1

| État courant | Entrée | Garde | État suivant | Effet atomique |
|---|---|---|---|---|
| absent | start | aucun slot | `awaiting_quote_screen` | `mission_started(no_slot)` + brouillon vide durable |
| absent | start | slot non significatif | `awaiting_quote_screen` | `mission_started(empty_slot_adopted)` + lie le slot existant |
| absent | start | slot significatif | `awaiting_draft_decision` | `mission_started(draft_conflict)`, ne touche pas au slot |
| active | start rejoué | même owner/kind | inchangé | retourne la mission existante, aucun event doublé |
| `awaiting_draft_decision` | reprendre | choix courant | `awaiting_quote_screen` | lie le slot, event `draft_resume_selected` |
| `awaiting_draft_decision` | abandonner | choix courant | `awaiting_draft_discard_confirmation` | aucune suppression |
| `awaiting_draft_discard_confirmation` | garder | choix courant | `awaiting_draft_decision` | renouvelle un jeu de choix |
| `awaiting_draft_discard_confirmation` | confirmer | identité + révisions slot exactes | `awaiting_quote_screen` | remplace le payload **in place** par CAS `N → N+1`, jamais DELETE/CREATE |
| `awaiting_quote_screen` | ACK écran | contexte appliqué + draft exact | `awaiting_customer` ou `awaiting_lines` | lie le contexte réel |
| `awaiting_customer` | requête, 0 match | résolution réelle | inchangé | journalise `customer_not_found`, demande de préciser |
| `awaiting_customer` | 1 exact unique | client encore réel | `awaiting_lines` | sélectionne + avance le draft |
| `awaiting_customer` | 1 fuzzy ou N | candidats réels | `awaiting_customer_choice` | persiste IDs/choiceIds ordonnés |
| `awaiting_customer_choice` | choice voix/tap | jeu courant + client réel | `awaiting_lines` | sélectionne + avance le draft |
| toute phase active | annuler | commandId courant | `cancelled` | terminalise, conserve le draft |
| toute phase active | TTL, scheduler ou commande | horloge DB | `expired` | terminalise une fois, conserve le draft |

Les phases terminales ne sont jamais rouvertes. Une nouvelle demande crée une nouvelle mission ou
reprend le brouillon via la décision explicite prévue.

## 8. Brouillon existant : aucune perte silencieuse

La V1 possède un seul `QuoteDraftSlot` par `(companyId, ownerUserId)`. Cette contrainte est
conservée dans M1.

1. Aucun slot : créer un brouillon vide avec `expectedRevision = 0`.
2. Slot de la même mission/draft : reprendre à sa révision exacte.
3. Slot différent mais non significatif : il ne peut être adopté/remplacé que par une règle pure
   testée et un CAS exact ; aucune heuristique UI.
4. Slot significatif différent : présenter `Reprendre` et `Abandonner et créer`. Le jeu de choix
   scelle dès sa création les trois fences du slot observé ; une décision ne peut jamais adopter le
   slot qui se trouve simplement « courant » au moment du clic ou de la réponse vocale.
5. Choisir l'abandon ne supprime rien ; une seconde confirmation explicite est exigée.
6. La confirmation remplace le payload **dans la même ligne** par `upsert(expectedRevision=N)` et
   obtient `revision=N+1`. La mission n'appelle jamais `delete` puis `create` : remettre la révision
   à 1 créerait un ABA où un ancien writer pourrait écraser le nouveau brouillon.
7. Toute décision liée au draft fence simultanément `expectedDraftSessionId`,
   `expectedDraftSlotRevision` et `expectedDraftContentRevision`.
8. Tant qu'une mission active possède ce slot, les mutations legacy `PUT` et `DELETE`
   `/quote-drafts/current` sont vérifiées dans la même transaction et répondent `409
   mission_owns_draft`; la lecture reste disponible. Il n'existe ainsi aucun second writer hors de
   l'autorité mission.
9. Un conflit retourne `revision_conflict` et recharge l'état ; il n'essaie jamais une seconde fois
   avec une révision nouvelle sans nouvelle décision utilisateur.

Le payload `QuoteDraftPayloadV1` reste inchangé : aucune mission, proposition ou callback n'y est
ajouté. Le client sélectionné y est écrit avec l'identifiant et le nom **réel relu en base**.

## 9. Résolution client 0 / 1 / N

### 9.1 Pipeline déterministe

1. Le NLU extrait transitoirement une requête utilisateur bornée ; elle n'est ni loggée ni
   persistée dans la mission.
2. Le use case appelle `CustomerCandidateSearchPort` sous tenant/owner ; il ne réutilise ni
   `ListCustomers`, ni `listBillableCustomers`, qui chargent aussi factures/paiements et ne sont pas
   un chemin de recherche scalable.
3. L'adapter Prisma exécute une requête paramétrée indexée sur le nom normalisé, avec `LIMIT 6` :
   cinq choix maximum et la sixième ligne comme preuve « plus de cinq ». Il applique un classement
   stable : correspondance
   exacte normalisée avant fuzzy, puis score, puis nom canonique, puis identifiant.
4. Le core applique la politique 0/1/N ; le LLM ne choisit aucun candidat.
5. Avant sélection, le client est relu par ID sous le même tenant.
6. Le view builder recharge les libellés réels et marque sans libellé un choix devenu indisponible.
   Le prochain `AdvanceQuoteMission` invalide alors le jeu sous CAS et remet la mission à
   `awaiting_customer` ; un `GET` ne mute jamais l'agrégat et aucun ancien nom n'est affiché.

### 9.2 Politique

- **0 candidat** : Bob dit qu'aucun client correspondant n'a été trouvé et demande un autre nom ou
  propose le parcours de création client futur. Rien n'est sélectionné.
- **1 correspondance exacte normalisée** : le brouillon peut être sélectionné automatiquement car
  il s'agit d'un staging réversible ; Bob annonce le vrai nom choisi. Ce comportement est une règle
  core, jamais une appréciation LLM.
- **1 correspondance fuzzy** : Bob propose explicitement ce client ; aucune sélection silencieuse.
- **N correspondances** : au plus cinq choix réels, ordonnés et numérotés, sont présentés.
- **Plus de cinq** : Bob demande de préciser ; il ne tronque pas une liste puis ne traite pas cette
  troncature comme exhaustive.

### 9.3 Parité voix/toucher

La vue expose des `choiceId` opaques. Le tap envoie ce `choiceId`. « Le premier », « le deuxième »
ou le nom prononcé sont résolus côté serveur vers **le même `choiceId`** du jeu courant. Les deux
canaux appellent `AdvanceQuoteMission` avec :

```text
missionId + commandId + expectedMissionRevision
+ expectedDraftSlotRevision + decisionId + choiceId
```

Ils appellent ensuite la même transition pure de brouillon : `select_customer`, puis `next_step`.
Un test contractuel exige le même hash canonique de payload, les mêmes révisions et le même event
`customer_selected`, seul `actor` différant.

Lorsque l'utilisateur touche directement un client dans la liste normale de l'écran et qu'aucun
jeu de désambiguïsation n'est ouvert, le mobile transmet `customerId` comme référence non fiable.
Le serveur le recharge sous tenant, crée une sélection canonique puis appelle **le même**
`AdvanceQuoteMission`. Cette variante n'invente pas un `choiceId` rétroactivement. Dès qu'un jeu de
choix est affiché, voix et toucher doivent en revanche consommer son `choiceId` exact.

## 10. CAS, idempotence et transaction

### 10.1 Identifiants de commande

- chaque tour vocal reçoit un `commandId` UUID une seule fois à l'ingress et le conserve au retry ;
- chaque geste tactile crée un `commandId` UUID avant l'appel et le conserve jusqu'au résultat ;
- chaque ACK écran porte un `commandId`/`acknowledgementId` stable ;
- `(companyId, ownerUserId, commandId)` est unique dans le journal ;
- le HMAC versionné d'une requête canonique détecte la réutilisation d'un `commandId` avec un autre
  contenu sans exposer la requête client.

Un replay exact n'écrit rien et renvoie `already_applied` avec la vue autoritaire actuelle. Un même
`commandId` avec un autre fingerprint échoue `idempotency_conflict`. La terminalisation lazy utilise
un identifiant système déterministe dérivé de mission + révision + échéance ; scheduler, `start` et
`advance` convergent donc sur le même event sans doublon.

La canonicalisation du fingerprint est versionnée dans chaque événement. Le keyring conserve la
clé active et toute clé retired tant qu'un événement non purgé la référence, donc au minimum
90 jours après sa dernière écriture en V1. Une rotation ajoute une version puis change l'active ;
elle ne retire jamais une ancienne version dans le même train. Readiness et release refusent une
clé référencée mais absente. Les retries antérieurs à la rotation restent classables en replay exact
ou conflit sans recalculer avec la nouvelle clé.

### 10.2 Fences obligatoires

Toute mutation reçoit :

- `expectedMissionRevision` ;
- `expectedDraftSessionId`, `expectedDraftSlotRevision` et `expectedDraftContentRevision` lorsque
  le draft est concerné ;
- `decisionId`, `choiceSetRevision` et `choiceId` pour un choix ;
- `realtimeSessionId`, `contextRevision` et `contextDigest` pour un ACK/turn vocal.

Une fence périmée retourne un conflit structuré, sans event, sans write partiel et sans tentative de
fusion implicite.

### 10.3 Transaction unique

Dans une transaction PostgreSQL tenantée et owner-scopée :

1. poser le contexte RLS société + utilisateur ;
2. relire/verrouiller la mission ;
3. si elle est active mais expirée selon l'horloge DB, la terminaliser idempotemment avant toute
   autre transition ;
4. détecter un `commandId` déjà consommé ;
5. vérifier statut, phase, révision, TTL, décision et liaison de contexte ;
6. relire le client et le `QuoteDraftSlot` concernés ;
7. appliquer la transition pure du core ;
8. écrire le draft sous CAS si nécessaire ;
9. mettre à jour la mission sous CAS `revision = expectedRevision` ;
10. insérer l'événement `sequence = missionRevisionAfter` ;
11. commit ; seulement ensuite produire la parole, les métriques ou toute I/O externe.

Une erreur à n'importe quelle étape annule mission, draft et event. Aucun appel LLM/provider ne
reste sous transaction.

## 11. Ports et use cases du core

Fichiers cibles :

```text
packages/core/src/domain/agent/agent-mission.ts
packages/core/src/domain/agent/agent-mission-event.ts
packages/core/src/application/ports/agent-mission-repository.ts
packages/core/src/application/ports/agent-mission-unit-of-work.ts
packages/core/src/application/ports/customer-candidate-search.ts
packages/core/src/application/agent-missions/start-quote-agent-mission.ts
packages/core/src/application/agent-missions/get-active-agent-mission.ts
packages/core/src/application/agent-missions/acknowledge-agent-mission-screen.ts
packages/core/src/application/agent-missions/advance-quote-agent-mission.ts
packages/core/src/application/agent-missions/cancel-agent-mission.ts
packages/core/src/application/quote-drafts/apply-quote-draft-transition.ts
apps/api/src/persistence/prisma/customer-candidate-search.prisma.ts
```

Le core reste sans Prisma, Nest, HTTP, Expo, OpenAI ou Mistral. Le port d'unité de travail garantit
que les repositories mission, événement et brouillon utilisés par un use case partagent la même
transaction et les mêmes GUC RLS.

`CustomerCandidateSearchPort.search({ companyId, query, limit: 6 })` retourne au plus six
références `{ customerId, canonicalName, matchKind, score }` relues depuis `customers`. L'adapter
utilise l'index d'expression trigram/unaccent existant, ne joint aucune facture ni paiement et reste
tenant-scopé dans SQL. `canonicalName` sert uniquement à construire la vue/parole du tour ; la
mission persiste seulement `customerId` et `choiceId`.

Use cases publics M1 :

- `StartQuoteAgentMission` : crée ou reprend l'unique mission active ;
- `GetActiveAgentMission` : lit puis construit une vue à partir des entités réelles ;
- `AcknowledgeAgentMissionScreen` : attache le contexte appliqué et le draft rechargé ;
- `AdvanceQuoteAgentMission` : résout une requête ou consomme un choix voix/tap ;
- `CancelAgentMission` : terminalise sans supprimer le brouillon ;
- `ExpireAgentMissions` : maintenance bornée et idempotente.

La transition de brouillon client est extraite du composant mobile : l'adapter du flow manuel et
le use case mission consomment la même fonction pure. Aucun controller, écran ou handler agent ne
recode la règle `select_customer + next_step`.

## 12. Schéma PostgreSQL et migration expand-only

### 12.1 Tables nouvelles

Migration dédiée `<timestamp>_agent_missions_expand` :

```text
agent_missions
  id UUID PK
  companyId TEXT NOT NULL FK companies(id) ON DELETE RESTRICT
  ownerUserId TEXT NOT NULL
  kind TEXT NOT NULL
  status TEXT NOT NULL
  phase TEXT NOT NULL
  revision INTEGER NOT NULL
  payloadVersion INTEGER NOT NULL
  payload JSONB NOT NULL
  realtimeSessionId UUID NULL
  contextRevision INTEGER NULL
  contextDigest CHAR(64) NULL
  screenName TEXT NULL
  screenInstanceId TEXT NULL
  contextAcknowledgedAt TIMESTAMPTZ NULL
  idleExpiresAt TIMESTAMPTZ NOT NULL
  hardExpiresAt TIMESTAMPTZ NOT NULL
  terminalAt TIMESTAMPTZ NULL
  retentionExpiresAt TIMESTAMPTZ NOT NULL
  createdAt TIMESTAMPTZ NOT NULL
  updatedAt TIMESTAMPTZ NOT NULL

agent_mission_events
  id UUID PK
  companyId TEXT NOT NULL
  ownerUserId TEXT NOT NULL
  missionId UUID NOT NULL
  sequence INTEGER NOT NULL
  eventType TEXT NOT NULL
  eventVersion INTEGER NOT NULL
  actor TEXT NOT NULL
  commandId UUID NOT NULL
  requestFingerprintHmac CHAR(64) NOT NULL
  fingerprintKeyVersion INTEGER NOT NULL
  fingerprintCanonicalizationVersion INTEGER NOT NULL
  missionRevisionBefore INTEGER NOT NULL
  missionRevisionAfter INTEGER NOT NULL
  draftSlotRevisionBefore INTEGER NULL
  draftSlotRevisionAfter INTEGER NULL
  draftContentRevisionBefore INTEGER NULL
  draftContentRevisionAfter INTEGER NULL
  realtimeSessionId UUID NULL
  turnId UUID NULL
  contextRevision INTEGER NULL
  contextDigest CHAR(64) NULL
  data JSONB NOT NULL
  occurredAt TIMESTAMPTZ NOT NULL
  retentionExpiresAt TIMESTAMPTZ NOT NULL
```

Une FK composite `(missionId, companyId, ownerUserId)` pointe vers une contrainte unique identique
de `agent_missions`. Elle rend impossible un événement rattaché à une autre société ou un autre
propriétaire. Aucun FK vers la lease Realtime n'est créé : la mission et ses preuves doivent
survivre à la rétention transport.

### 12.2 Expansion compatible

- aucune suppression, renommage ou réécriture de table existante ;
- aucun backfill et aucune mission créée automatiquement pour les brouillons existants ;
- `QuoteDraftSlot` et son payload V1 restent byte-for-byte compatibles ;
- ajout nullable à `realtime_session_leases` :
  `agentMissionProtocolVersion INTEGER NULL` et `agentMissionProtocolBoundAt TIMESTAMPTZ NULL` ;
- un binaire N-1 ignore ces colonnes et continue son comportement ;
- les indexes online sont séparés si la taille de la table l'exige.

### 12.3 Contraintes et indexes

- CHECK exact sur kind/status/phase et leur combinaison ;
- CHECK `revision >= 1`, versions égales à 1, timestamps ordonnés ;
- CHECK liaison contexte tout-ou-rien et digests hexadécimaux 64 caractères ;
- CHECK `terminalAt IS NULL` seulement pour `active` ;
- payload mission ≤ 64 KiB, payload event ≤ 32 KiB ;
- index unique partiel : un seul `quote_creation` actif par
  `(companyId, ownerUserId, kind)` ;
- unique `(id, companyId, ownerUserId)` sur mission ;
- unique `(companyId, missionId, sequence)` sur events ;
- unique `(companyId, ownerUserId, commandId)` sur events ;
- index lecture active `(companyId, ownerUserId, status, updatedAt DESC, id DESC)` ;
- index maintenance bornée `(status, idleExpiresAt, id)` et
  `(status, hardExpiresAt, id)` ;
- index purge `(retentionExpiresAt, companyId, id)`.

### 12.4 RLS et ACL

Les deux tables activent et forcent RLS.

- missions : `SELECT/INSERT/UPDATE` seulement si `companyId` et `ownerUserId` égalent les deux GUC
  de requête ; aucun `DELETE` runtime ;
- événements : `SELECT/INSERT` seulement sous le même tenant/owner ; aucun
  `UPDATE/DELETE/TRUNCATE` runtime ;
- trigger d'immuabilité événement ;
- rôle applicatif non-superuser, non-`BYPASSRLS`, sans ownership des tables/fonctions ;
- maintenance globale limitée à une projection minimale ou fonction `SECURITY DEFINER`, puis
  mutation tenantée ; aucune lecture globale de payload ;
- les certificats PostgreSQL utilisent le rôle exact de production et prouvent aussi les refus.

## 13. API HTTP et orchestration Realtime

### 13.1 Endpoints exacts M1

```text
POST /voice/realtime/calls
  body additif N+1 { agentMissionProtocolVersion: 1 | null, ...contrat existant }
  response N+1 { agentMissionProtocolVersion: 1 | null, ...bootstrap existant }

GET /agent-missions/current/quote-creation
  response { mission: AgentMissionViewV1 | null }

POST /agent-missions/quote-creation/start
  body { commandId, realtimeSessionId?, contextRevision?, contextDigest? }

POST /agent-missions/:missionId/screen-acks
  body {
    commandId,
    expectedMissionRevision,
    realtimeSessionId,
    contextRevision,
    contextDigest,
    draftSessionId,
    expectedDraftSlotRevision,
    expectedDraftContentRevision
  }

POST /agent-missions/:missionId/decisions
  body
    | {
        action: 'choose_presented_option',
        commandId,
        expectedMissionRevision,
        expectedDraftSessionId,
        expectedDraftSlotRevision,
        expectedDraftContentRevision,
        decisionId,
        choiceSetRevision,
        choiceId
      }
    | {
        action: 'select_screen_customer',
        commandId,
        expectedMissionRevision,
        expectedDraftSessionId,
        expectedDraftSlotRevision,
        expectedDraftContentRevision,
        customerId
      }

POST /agent-missions/:missionId/cancel
  body { commandId, expectedMissionRevision }
```

Les champs inconnus, les champs **déclarés UUID** non canoniques, les identifiants applicatifs qui
échouent `canonicalIdentifier`, les nombres hors borne et les digests invalides sont rejetés.
`companyId`, `ownerUserId` et `actor` ne viennent jamais du corps : JWT/route et canal serveur les
dérivent.

Le champ de la requête **initiale** annonce seulement la capacité du client. Le serveur réévalue
master flag, release flag utilisateur, readiness et identité, puis calcule
`negotiated = requested === 1 && eligible ? 1 : null`. Cette valeur est persistée avec la lease
dans la transaction d'admission avant que le bootstrap ne soit retourné. Requête et réponse doivent
concorder ; aucune mise à niveau tardive n'est autorisée dans cette session.

Pour préserver le mobile N, une requête qui omet le champ reçoit le bootstrap historique sans champ
additif. Une requête N+1 qui fournit `1|null` exige ce champ dans la réponse. Ainsi, l'ancien codec
exact ne voit jamais une clé inconnue et le nouveau codec sait distinguer la négociation.

Un bootstrap absent, ambigu ou dont la version ne concorde pas ferme la session avant ouverture du
micro. Le repli historique n'est admis que lorsqu'un bootstrap valide a explicitement négocié
`null`, ou pour un mobile N qui avait omis le champ et reçoit le bootstrap historique sans champ.
Un appel N+1 rejeté par un serveur N ne possède encore ni lease ni micro : seul un nouvel appel
historique explicitement choisi peut alors repartir. Aucun timeout ou 5xx ne provoque un downgrade
silencieux au milieu d'un appel.

Réponses :

- `200` pour vue/reprise/replay exact ; `201` pour première création ;
- `404` sans révéler une mission d'un autre tenant/owner ;
- `409` pour CAS, décision périmée ou idempotency conflict, avec révisions courantes non sensibles ;
- `410` pour mission terminale/expirée ;
- `422` pour transition impossible ;
- `503` si l'autorité DB/contexte ne peut pas être vérifiée. Aucun `503` n'est traduit en succès.

### 13.2 Vue mobile

`AgentMissionViewV1` expose : identité, kind, statut, phase, révision, expirations, liaison écran,
le `QuoteDraftSlotView` atomiquement observé et une décision éventuellement présentable.

Pour un choix client, la vue utilise l'union exacte :

```ts
type CustomerMissionChoiceView =
  | { readonly status: 'available'; readonly choiceId: string; readonly label: string }
  | { readonly status: 'unavailable'; readonly choiceId: string };
```

`label` vient exclusivement de la relecture `Customer`. Une option indisponible reste à sa position
mais est disabled et sans ancien libellé ; sa consommation invalide le jeu sous CAS. Le mapping
`choiceId → customerId` ne devient jamais une valeur fournie par le LLM. Pour une décision de
brouillon, la vue contient des clés i18n canoniques, pas de prose générée.

### 13.3 Orchestrateur Realtime

`RealtimeAgentTurnInput` reçoit l'identité durable de session/turn. Avant le `BobAgent` générique :

1. vérifier que la lease annonce `agentMissionProtocolVersion = 1` et que le flag est actif ;
2. relire la mission active ;
3. si le tour correspond à la phase courante, appeler le use case mission ;
4. construire la parole canonique à partir du résultat réel ;
5. sinon déléguer au comportement existant.

L'orchestrateur n'interprète jamais le contexte comme une autorisation et ne contient aucune
logique de devis. Le commit métier précède la parole. Si la parole est interrompue, le résultat
reste durable ; le tour suivant le relit au lieu de rejouer l'action.

Le contrat cible `RealtimeTransportEvent` ajoute un événement provider-neutral exact :

```ts
{
  readonly type: 'turn_settled';
  readonly turnId: string;
  readonly status: 'done' | 'cancelled' | 'failed';
}
```

La composition transport l'émet exactement une fois après terminalité locale du tour, pour WebRTC
natif comme pour la livraison auditée. Un état `ready`, un transcript Bob `final` ou
`conversation_completed` ne le remplace pas : ils ne couvrent pas tous les barge-ins et erreurs.
`AgentMissionProvider` déclenche sa relecture sur `turn_settled`, y compris si l'audio a été annulé
après un commit métier.

## 14. Mobile

### 14.1 Composition

Fichiers cibles :

```text
packages/api-client/src/client.ts
packages/api-client/src/http-client.ts
packages/api-client/src/local-client.ts
packages/api-client/src/agent-mission-codec.ts
apps/mobile/src/agent-mission/agent-mission-provider.tsx
apps/mobile/src/agent-mission/agent-mission-runtime.ts
apps/mobile/src/agent/realtime-session.ts
apps/mobile/src/quote-draft/quote-draft-provider.tsx
apps/mobile/app/devis/new.tsx
apps/mobile/app/_layout.tsx
packages/i18n/src/catalogs/**
```

Le codec API est exact. `HttpBobClient` est l'implémentation production. Les doubles/in-memory ne
sont importables que par les tests et l'artefact guard les refuse ; un mode local non autoritaire
retourne `unavailable`, jamais de faux client ou de fausse mission.

### 14.2 `AgentMissionProvider`

- se monte une seule fois dans l'arbre authentifié ;
- annonce V1 dans l'appel initial N+1, puis vérifie la version négociée dans le bootstrap ;
- traite cette négociation comme une barrière avant le micro : liaison de réponse puis premier ACK
  contexte exact, ensuite seulement `setMicrophoneEnabled(true)` ;
- recharge la mission au démarrage authentifié, retour foreground et changement d'identité ;
- invalide toute réponse tardive par génération owner/session ;
- ACK l'écran seulement après hydratation du draft et confirmation du contexte appliqué ;
- réessaie un `context_not_applied` avec backoff borné tant que l'app est foreground ;
- recharge mission + draft à chaque `turn_settled`, y compris barge-in/échec audio ;
- applique la réponse d'une décision tactile immédiatement ;
- n'ouvre jamais deux sheets : une file de décisions séquentielle en montre une seule.

### 14.3 Compatibilité du wizard manuel

- avant la décision de fraîcheur actuelle, le mount attend **les deux** hydratations autoritaires :
  mission courante et `QuoteDraftSlot`. Tant que ce gate n'est pas résolu, il affiche loading ou
  erreur/retry et n'appelle aucune transition locale ;
- si une mission V1 active est liée au slot exact (`draftSessionId`, slot/content revisions), le
  provider installe ce slot et **n'appelle jamais** `startFresh()` ni `resumePending()` ;
- si la réponse confirme qu'il n'existe aucune mission compatible, le code reprend alors seulement
  la décision historique `resume=1` / `startFresh()` ; une réponse tardive d'une ancienne
  génération ne peut pas remplacer un draft déjà ouvert ;
- sans mission active compatible, `devis/new.tsx` garde exactement le reducer et la navigation
  actuels ;
- avec mission active liée au même draft, le tap client appelle `AdvanceQuoteMission` ;
- à l'arrivée `awaiting_lines`, tant que M2 n'est pas activé, l'UI propose explicitement
  « Continuer à la main ». Ce choix terminalise la mission avec reason `manual_handoff`, conserve
  le slot puis rend le writer manuel ; aucun PUT ne rencontre un `409` surprise ;
- les deux chemins consomment la transition pure core extraite ;
- le provider sait remplacer son état depuis un slot serveur seulement si génération, session et
  révisions attendues correspondent ;
- aucun optimistic success n'est annoncé avant la réponse autoritaire ;
- chargement, erreur/retry, vide et données sont distingués ;
- zones tactiles, lecteur d'écran, focus de sheet et `reduce-motion` respectent les tokens Bob.

### 14.4 Reprise après kill

Au redémarrage :

1. attendre l'identité authentifiée ;
2. lire la mission active et le brouillon sur le serveur ;
3. ne prononcer, naviguer ou muter rien automatiquement ;
4. si le bon écran est déjà restauré, republier son contexte puis ACK ;
5. sinon afficher « Reprendre le devis avec Bob » ; tap ou voix déclenchent la même navigation sûre ;
6. à la nouvelle session Live, négocier V1 au bootstrap puis remplacer la liaison par un nouvel ACK ;
7. reprendre la phase exacte et les choix réels rechargés.

`AsyncStorage`, le fil de chat et l'état React ne sont jamais l'autorité de reprise.

## 15. Feature flag, rollout et N/N-1

Deux gates cumulatifs et fail-closed sont obligatoires :

1. master environnement `BOB_AGENT_MISSIONS_QUOTE_V1_ENABLED`, absent ou `false` = désactivé ;
2. release flag existant `bob.agent_missions.quote.v1`, évalué par `EvaluateReleaseFlag` pour le
   vrai `userId` (global OFF, overrides des comptes internes seulement pendant le rollout).

Une absence ou panne du store de release flags négocie `null`. Le client ne choisit jamais
son éligibilité. Le bloc secret
`BOB_AGENT_MISSION_HMAC_KEY_VERSION` + `BOB_AGENT_MISSION_HMAC_KEYRING` est tout-ou-rien : requis et
distinct des clés usage/contrôle quand le master est ON, physiquement absent quand il est OFF.
L'activation exige aussi migration, ACL/readiness et maintenance complètes ; toute configuration
partielle fait échouer le boot Live.

Compatibilité :

| Couple | Comportement attendu |
|---|---|
| serveur N + mobile N | parcours historique, aucune mission créée |
| serveur N+1 + mobile N | champ absent traité comme `null` ; parcours historique inchangé |
| serveur N + mobile N+1 | appel N+1 rejeté avant lease/micro ; repli manuel ou nouvel appel historique explicitement choisi |
| serveur N+1 + mobile N+1, flag OFF | bootstrap négocie `null` ; parcours historique |
| serveur N+1 + mobile N+1, master ON + release flag user ON | M1 durable activé pour ce compte |

Le flag est d'abord limité aux comptes internes. M1 ne peut pas activer une promesse publique
« crée tes devis entièrement à la voix » ; cette promesse attend M2 et sa certification device.

Déploiement : migration expand → certification RLS/ACL → binaire serveur compatible N-1 → mobile
N+1 → activation cohorte interne. La contraction des anciens chemins n'appartient pas à M1.

## 16. Tests obligatoires

### 16.1 Core

- table de transitions exhaustive ; phase/statut impossibles refusés ; terminaux immuables ;
- start sans draft, avec draft significatif, reprise, demande d'abandon et double confirmation ;
- aucun écrasement quand la révision draft change entre décision et confirmation ;
- un writer ayant vu la révision 1 avant un abandon ne peut pas écraser le payload remplacé in
  place en révision N+1 ; aucun DELETE/CREATE n'est observé ;
- résolution 0, 1 exact, 1 fuzzy, N ≤ 5 et N > 5 ;
- classement stable accents/casse/homonymes ; aucun ID inventé ;
- candidat supprimé/inaccessible invalide la décision ;
- ordinal hors borne, ancien `choiceId`, ancien hash et mauvaise phase refusés ;
- voix et tap produisent le même payload/hash/révisions ;
- canonicalisation/fingerprint restent stables avant et après rotation ; une clé retired encore
  référencée est obligatoire et un keyring amputé échoue readiness ;
- expiration conserve le draft ; terminalisation idempotente ;
- parseurs exacts, limites taille/unicode/caractères de contrôle.

### 16.2 API et contrats

- identité dérivée du JWT ; tentative de fournir tenant/owner rejetée ;
- bodies et réponses exacts, inconnus rejetés ; client HTTP/local de test en parité ;
- protocole absent, demandé `null`, flag OFF ou store indisponible négocie `null` et ne crée jamais
  de mission ;
- une phrase injectée au tick de connexion ne franchit pas la barrière bootstrap + contexte : le
  micro reste fermé et aucun tour historique ne part avant la version négociée ;
- ACK relit la lease et exige contexte publié/appliqué exact ;
- session, contexte, écran ou draft forgé/périmé refusé sans event ;
- parole construite après commit depuis le vrai résultat ;
- `done`, `cancelled` et `failed` provoquent la resynchronisation mobile ;
- WebRTC natif et transport audité émettent exactement un `turn_settled` par tour ; `ready` et
  transcript final seuls ne satisfont pas ce test ;
- aucun label LLM ou requête brute dans DB/log/métrique ;
- instrumentation de test capturant logger/SQL prouve qu'aucun transcript, nom client ou binding de
  recherche ne sort, y compris sur succès, 0 match, conflit CAS et exception DB.
- la recherche candidate exécute une requête tenantée indexable `LIMIT 6`, sans appel aux
  repositories factures/paiements, et le sixième résultat produit honnêtement « préciser » ;

### 16.3 PostgreSQL réel

- FORCE RLS avec deux sociétés et deux propriétaires dans une même société ;
- cross-tenant/cross-owner SELECT/INSERT/UPDATE/IDOR refusés ;
- rôle runtime sans `BYPASSRLS`, ownership, DELETE/TRUNCATE événement ou exécution purge libre ;
- deux starts concurrents donnent une seule mission active ;
- deux décisions concurrentes donnent un gagnant, un conflit, un seul event ;
- replay exact ne crée pas d'event ; commandId réutilisé autrement échoue ;
- replay créé sous une clé HMAC retired reste reconnu après rotation ; retrait prématuré de cette
  version est refusé par readiness/release ;
- une mission expirée non encore drainée est terminalisée sous verrou par `start`, puis la nouvelle
  mission franchit l'index unique ; un `GET` simultané reste sans écriture ;
- faute injectée après draft ou mission provoque rollback total ;
- event UPDATE/DELETE impossible, contraintes phase/payload/timestamps actives ;
- scheduler expiration/purge borné, restart-safe, sans famine ;
- migration expand fonctionne avec writer N-1 puis N+1.

### 16.4 Mobile

- flow manuel historique inchangé quand mission absente/flag OFF ;
- hydratation lente, retry, logout/login, réponse tardive et changement de compte fenced ;
- un seul overlay/sheet ; choix accessible au tap et au lecteur d'écran ;
- choix tap met le draft à `lignes` depuis la réponse autoritaire ;
- tap direct sur un client réel, hors sheet de choix, recharge cet ID et traverse le même use case ;
- choix voix met le même draft à `lignes` au turn settled ;
- le handoff explicite à la main terminalise la mission sans toucher au slot, puis le save manuel
  courant réussit ; sans handoff, legacy PUT/DELETE reçoit le conflit prévu ;
- barge-in après commit recharge le résultat sans double application ;
- kill après navigation, après choix présenté et après sélection : reprise exacte ;
- app relancée sur un autre écran n'auto-navigue ni ne parle sans intention ;
- navigation froide/chaude vers `/devis/new` prouve que l'hydratation mission précède la freshness
  decision ; une réponse mission tardive ou d'une génération précédente ne déclenche jamais
  `startFresh()` ni remplacement surprise ;
- aucune fixture ou valeur client de démonstration dans le bundle production.

### 16.5 E2E de preuve M1

Le scénario utilise une base isolée avec des clients créés par l'API de test, jamais une constante
du runtime :

1. ouvrir Bob Live avec une lease V1 ;
2. dire « crée un devis » ;
3. vérifier mission/event/draft réels puis navigation `/devis/new` ;
4. vérifier l'ACK du contexte appliqué exact ;
5. dire un nom ambigu, vérifier les choix issus de la DB ;
6. choisir le second à la voix, relire le draft `lignes` et son client ;
7. rejouer depuis le même état en choisissant au tap ;
8. comparer hash payload, transitions et révisions ;
9. tuer l'app entre navigation et choix, relancer, rattacher une nouvelle session et terminer ;
10. injecter stale context, stale draft, double commande et autre tenant ; tout doit échouer fermé.

La preuve C3 lit les tables mission/event/draft et l'entité client autoritaire. Un booléen envoyé par
le runner, une phrase LLM ou un simple screenshot n'est pas une preuve.

## 17. Definition of Done binaire M1

- [ ] La spec est challengée par correctness/sécurité, architecture/parité et UX/accessibilité.
- [ ] `AgentMission` et ses transitions sont framework-free, exacts et exhaustivement testés.
- [ ] Mission, draft CAS et event commitent ou rollbackent ensemble sous RLS owner/tenant.
- [ ] Un seul `quote_creation` actif résiste aux starts et décisions concurrentes.
- [ ] L'ACK d'écran prouve le contexte réellement appliqué et le draft réellement hydraté.
- [ ] Les résolutions 0/1/N utilisent uniquement les clients DB du tenant.
- [ ] Aucun label/ID LLM, mock, fixture ou repository in-memory n'est atteignable en production.
- [ ] Le choix voix et le choix tap utilisent le même `choiceId`, le même use case et le même hash.
- [ ] Un brouillon existant n'est jamais détruit sans décision puis confirmation CAS.
- [ ] Le remplacement d'un brouillon est un upsert in-place `N→N+1`; legacy PUT/DELETE est fenced
      tant que la mission le possède et un writer pré-abandon échoue.
- [ ] Un kill/relaunch reprend la même mission, le même draft et la même décision réelle.
- [ ] Un scheduler d'expiration retardé ne bloque ni `start` ni l'index unique ; GET reste read-only.
- [ ] Barge-in, échec audio, retry HTTP et réponse tardive ne doublent aucune transition.
- [ ] Le parcours manuel sans mission reste identique par tests de non-régression.
- [ ] N/N-1 et flag OFF sont certifiés ; aucun flag public n'est activé par le lot.
- [ ] La capability est négociée/persistée dans l'admission initiale avant bootstrap et micro ;
      aucun endpoint ni upgrade tardif n'existe.
- [ ] RLS/ACL/immutabilité/concurrence/migration sont certifiées sur PostgreSQL réel avec le rôle
      runtime.
- [ ] États loading/empty/error/data, i18n, a11y, focus et reduce-motion sont certifiés sur mobile.
- [ ] Tests ciblés, typecheck, lint, tests globaux et builds API/mobile passent depuis un checkout
      propre du commit candidat.
- [ ] L'E2E M1 traverse voix → navigation → ACK → choix client → lignes et relit chaque preuve DB.
- [ ] Le registre de preuve reste `implemented` tant que device réel et C3 ne sont pas verts ; M1
      seul n'autorise aucune promesse de devis vocal complet.

## 18. Roadmap des missions Jarvis

### M2 — devis complet, scénario canonique

- extraire tous les faits d'une phrase longue ou les compléter progressivement ;
- recherche catalogue 0/1/N, choix existant ou nouvelle ligne, catégories main-d'œuvre/fourniture/
  déplacement, quantité, unité, prix et texte professionnel ;
- suggestions TVA déterministes fondées sur les données métier, jamais décision fiscale LLM ;
- échéance, acompte, signature, revue et diff réel ;
- confirmation voix/tap par le même `proposalId` ;
- création idempotente par le use case existant, puis relecture du devis ;
- reprise exacte à chaque écran et correction d'une ligne sans rejouer les précédentes.

### M3 — facture

- facture depuis un devis réel avec lien source immuable ou brouillon direct ;
- lignes, TVA, échéance, audience et mentions légales issues des autorités existantes ;
- séparation stricte brouillon/émission ; toute émission reste confirmée ;
- Factur-X/PA/archivage selon les capacités réellement certifiées, jamais une promesse anticipée ;
- idempotence, numérotation atomique, relecture PDF/XML/statut et gestion d'erreur récupérable.

### M4 — client

- création et modification avec champs obligatoires demandés seulement s'ils manquent ;
- détection de doublons réels avant écriture ;
- SIREN/TVA/adresse/contact validés par les use cases existants ;
- choix voix/tap identique, diff et confirmation avant création ;
- fiche finale relue, aucune identité complétée par invention.

### M5 — catalogue

- recherche approximative stable, résultats réels et même politique 0/1/N ;
- « le deuxième » lié au jeu de choix courant ;
- suggestion d'une entrée forte sans sélection silencieuse lorsqu'elle reste fuzzy ;
- création d'une prestation uniquement après revue catégorie/unité/prix/TVA et confirmation ;
- réutilisation par devis/facture via le même use case catalogue.

### M6 — notifications et briefing

- « explique tout ce qui est en attente » agrège une page bornée d'entités réelles ;
- lecture/ouverture/navigation sans confirmation car non destructive ;
- notification liée à facture/client rechargée avant toute proposition ;
- marquer lu, relancer ou communiquer passent par leur politique de confirmation exacte ;
- reprise après navigation vers le détail sans perdre la notification source ni la mission.

### Généralisation après M6

Une nouvelle mission n'ajoute jamais un interpréteur JSON générique. Elle ajoute un `kind`, un
payload versionné, une machine à états, des use cases et des preuves explicites. Documents,
dépenses, argent, clôture, chantiers et pilotage suivent alors le même contrat : données réelles,
choix réels, staging/diff, confirmation appropriée, écriture idempotente et relecture.

## 19. Risques restant ouverts

- Le slot unique de brouillon limite encore les usages multi-device/multi-devis ; une évolution
  multi-slots exigera sa propre migration et son ADR, pas une extension opportuniste de M1.
- La synchronisation au `turn settled` est volontairement distincte du contrôle audio ; si les
  mesures device montrent une UX trop tardive, un événement de synchronisation versionné pourra
  être ajouté après négociation N/N-1, sans déplacer l'autorité DB.
- Le score fuzzy et ses seuils doivent être fixés par tests métier sur un corpus français réel
  avant activation ; en leur absence, le système demande de choisir au lieu de sélectionner.
- La rétention initiale doit être validée avec la politique de confidentialité avant publication.
- M1 prouve l'architecture mais laisse la mission active à `awaiting_lines`. Seule M2 fermée
  autorise le parcours devis public de bout en bout.

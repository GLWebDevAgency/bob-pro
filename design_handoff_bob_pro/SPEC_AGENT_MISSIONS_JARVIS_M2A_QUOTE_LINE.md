# SPEC — Agent Missions Jarvis M2-A : ligne de devis durable, catalogue réel et parité voix ↔ toucher

**Statut : specified**

**Date : 29 juillet 2026**

**Objectifs servis : O4, O5, O6 et O7**

**Spécifications parentes :**

- [OBJECTIFS_SPECS_DOD_PUBLICATION.md](OBJECTIFS_SPECS_DOD_PUBLICATION.md) ;
- [SPEC_AGENT_MISSIONS_JARVIS.md](SPEC_AGENT_MISSIONS_JARVIS.md) ;
- [SPEC_AGENT_MISSIONS_JARVIS_M1C_CUSTOMER_SELECTION.md](SPEC_AGENT_MISSIONS_JARVIS_M1C_CUSTOMER_SELECTION.md) ;
- [SPEC_BOB_LIVE_SEMANTIC_PLANNER.md](SPEC_BOB_LIVE_SEMANTIC_PLANNER.md).

## 1. Objectif et preuve utilisateur

M2-A absorbe dans l'unique mission `quote_creation@1` la première boucle métier qui suit le
client : préparer, désambiguïser, corriger puis confirmer une ou plusieurs lignes de devis.

La preuve verticale normative est :

> Depuis n'importe quel écran, « fais un devis pour Camping Les Pins, ajoute deux heures de
> main-d'œuvre plomberie à 55 euros » ouvre ou reprend la mission, résout le vrai client et le
> vrai catalogue du tenant, conserve tous les faits déjà donnés pendant la navigation, présente
> les correspondances réelles, accepte le même choix par « le premier » ou par tap, ne demande que
> les champs réellement absents, montre le diff de la ligne, puis l'ajoute au brouillon durable
> après confirmation explicite.

Après confirmation, Bob revient à l'attente de la ligne suivante sans couper la session. Un kill,
une reconnexion, un changement d'écran ou une réponse HTTP perdue ne fait ni perdre ni doubler la
ligne.

Cette tranche est **complète pour la boucle ligne**, mais ne permet pas encore d'annoncer « devis
vocal complet ». La revue globale, la création du devis réel, l'envoi et la signature appartiennent
aux trains M2-B et M2-C.

## 2. Constats qui motivent la tranche

Sur `main@5fedf5f5`, M1-C est correctement câblé jusqu'à `awaiting_lines`, puis :

- l'orchestrateur serveur demande explicitement de continuer à la main ;
- les faits de ligne présents dans la phrase initiale sont perdus ;
- le wizard mobile reprend avec un parseur regex local et une recherche catalogue locale ;
- il n'existe aucun choix catalogue scellé, aucun `proposalId`, aucun diff durable et aucune
  confirmation voix/toucher commune ;
- `VoiceTrace` ne mesure pas encore le chemin sideband GPT Realtime et ne doit pas recevoir de
  transcript ou d'arguments métier bruts dans cette tranche.

M2-A ne crée donc ni un nouveau cerveau, ni un nouveau registre d'outils, ni un deuxième brouillon.
Il étend l'autorité AgentMission déjà fusionnée.

## 3. Périmètre

### 3.1 Inclus

- compréhension sémantique typée des lignes présentes dans le tour initial ou un tour ultérieur ;
- conservation ordonnée de plusieurs lignes dictées dans une même phrase, dans une file bornée ;
- recherche du catalogue **réel du tenant** selon la politique 0/1/N ;
- proposition explicite d'utiliser une entrée catalogue ou une ligne libre ;
- collecte progressive de libellé, catégorie, quantité, unité, prix unitaire et intention TVA ;
- résolution déterministe des décimaux, montants, unités et taux après le modèle ;
- même `choiceId` pour sélection catalogue vocale ou tactile ;
- même `proposalId` et même diff pour confirmation vocale ou tactile ;
- ajout atomique et CAS d'une ligne au `QuoteDraftSlot`, puis relecture ;
- corrections sur la ligne en attente sans rejouer les lignes déjà confirmées ;
- reprise à froid et idempotence à chaque phase ;
- événements et métriques sans transcript, libellé, prix ni arguments d'outil bruts ;
- activation interne séparée et writer N-1 prouvé à chaque migration.

### 3.2 Hors M2-A

- création finale d'un `Quote`, numérotation, envoi ou signature ;
- ajout automatique d'une nouvelle entrée dans le catalogue ;
- choix d'un chantier, remise globale, retenue de garantie ou acompte ;
- dates de contrat, récurrence et missions autres que `quote_creation@1` ;
- activation du protocole `openai-native-webrtc-v1` pour AgentMission ;
- stockage de transcript, audio, prompt, réponse LLM ou nom de catalogue dans le journal ;
- Mistral V3 ;
- activation grand public.

Le wizard tactile hors mission reste disponible. Lorsqu'une mission M2-A possède le devis, les
affordances vocales regex du wizard sont désactivées : une intention n'a jamais deux writers.

## 4. Architecture retenue

```text
transcript final GPT Realtime
  → ContextEnvelope réel et versionné
  → frame sémantique V2 typée, non autoritaire
  → parseur exact
  → résolveurs purs nombre / argent / unité
  → recherche catalogue tenantée 0/1/N
  → file de lignes candidates dans le brouillon durable
  → choix ou question ciblée
  → proposition scellée + diff
  → confirmation voix OU toucher
  → transition core partagée
  → transaction mission + brouillon + événement
  → relecture autoritaire
  → réponse canonique et ligne suivante
```

Le LLM comprend le français ; il n'accède à aucun identifiant et ne calcule aucune règle fiscale.
Le serveur résout les entités réelles et le core autorise les transitions. Le mobile rend l'état
et transmet les décisions ; il ne devient jamais l'autorité de la mission.

## 5. ContextEnvelope M2-A

Le tour sémantique reçoit une enveloppe reconstituée côté serveur :

```ts
interface QuoteLineSemanticContextV1 {
  readonly schema: 'bob.semantic-context.quote-line';
  readonly version: 1;
  readonly locale: 'fr-FR';
  readonly timeZone: string;
  readonly now: string;
  readonly screen: {
    readonly route: string;
    readonly revision: number;
    readonly digest: string;
  } | null;
  readonly mission: {
    readonly idAlias: string;
    readonly revision: number;
    readonly phase: QuoteCreationMissionPhase;
    readonly confirmedLineCount: number;
    readonly pendingLineCount: number;
    readonly pendingDecisionKind:
      | 'customer'
      | 'catalogue'
      | 'line_confirmation'
      | null;
    readonly presentedChoiceCount: number;
    readonly requiredFact: QuoteLineRequiredFact | null;
  };
  readonly quote: {
    readonly customerStatus: 'missing' | 'choices' | 'resolved';
    readonly vatStatus: 'missing' | 'confirmed';
  };
  readonly availableCapabilities: readonly [
    'quote.line.stage',
    'quote.catalogue.search',
    'quote.line.confirm',
  ];
}
```

Contraintes :

- `now` vient de l'horloge serveur et `timeZone` du profil confirmé ; une valeur manquante rend
  une résolution temporelle indisponible au lieu d'inventer `Europe/Paris` ;
- aucun ID, nom client, libellé catalogue, email, téléphone, secret ou capability n'entre dans
  l'enveloppe ;
- les choix déjà présentés sont décrits seulement par leur nombre et leur ordre ; « le deuxième »
  est résolu ensuite contre le jeu scellé ;
- une réponse courte est autorisée uniquement quand `requiredFact` la rend non ambiguë ;
- le contexte et la fence mission/brouillon sont relus après le modèle.

## 6. Frame sémantique V2

La V2 remplace la V1 uniquement quand la capability M2-A est admise. Elle accepte plusieurs faits
dans un tour afin que l'utilisateur ne répète pas sa phrase après navigation.

```ts
interface QuoteCreationSemanticFrameV2 {
  readonly schema: 'bob.semantic.quote-creation';
  readonly version: 2;
  readonly operations: readonly QuoteCreationSemanticOperationV2[];
  readonly model: string;
}

type QuoteCreationSemanticOperationV2 =
  | {
      readonly kind: 'start_quote_creation';
      readonly customerReference: string | null;
      readonly lines: readonly QuoteLineCandidateV1[];
    }
  | {
      readonly kind: 'set_customer_reference';
      readonly customerReference: string;
      readonly lines: readonly QuoteLineCandidateV1[];
    }
  | {
      readonly kind: 'append_line_candidates';
      readonly lines: readonly QuoteLineCandidateV1[];
    }
  | {
      readonly kind: 'patch_pending_line';
      readonly patch: QuoteLineCandidatePatchV1;
    }
  | {
      readonly kind: 'select_presented_choice';
      readonly ordinal: 1 | 2 | 3 | 4 | 5 | 6;
      readonly lines: readonly QuoteLineCandidateV1[];
    }
  | { readonly kind: 'confirm_current_proposal' }
  | { readonly kind: 'reject_current_proposal' }
  | { readonly kind: 'unrelated' };

interface QuoteLineCandidateV1 {
  readonly serviceReference: string | null;
  readonly categoryHint:
    | 'labor'
    | 'supply'
    | 'travel'
    | 'subscription'
    | null;
  readonly quantityDecimal: string | null;
  readonly unitReference: string | null;
  readonly unitPriceDecimal: string | null;
  readonly currency: 'EUR' | null;
  readonly priceBasis: 'per_unit' | 'total' | null;
  readonly vatRateHint: '0' | '2.1' | '5.5' | '10' | '20' | null;
}

type QuoteLineCandidatePatchV1 =
  | { readonly field: 'service_reference'; readonly value: string }
  | {
      readonly field: 'category';
      readonly value: 'labor' | 'supply' | 'travel' | 'subscription';
    }
  | { readonly field: 'quantity'; readonly decimal: string }
  | { readonly field: 'unit'; readonly value: string }
  | {
      readonly field: 'unit_price';
      readonly decimal: string;
      readonly currency: 'EUR';
      readonly basis: 'per_unit' | 'total';
    }
  | { readonly field: 'vat_rate'; readonly value: '0' | '2.1' | '5.5' | '10' | '20' }
  | { readonly field: 'housing_older_than_2y'; readonly value: boolean }
  | { readonly field: 'energy_renovation'; readonly value: boolean };
```

Règles :

- un tool call exact et unique, `additionalProperties: false`, au plus 20 opérations et 20 lignes ;
- chaînes bornées, trimées, sans caractères de contrôle ; frame totale ≤ 32 KiB ;
- les nombres et montants restent des chaînes décimales canoniques dans la frame, puis deviennent
  quantité millième et centimes par résolveurs purs ;
- `400 balles par machine` doit produire `unitPriceDecimal="400"`, `currency="EUR"`,
  `priceBasis="per_unit"` ; le modèle ne multiplie pas le total ;
- un prix annoncé comme total est converti en prix unitaire seulement si la division en centimes
  par la quantité est exacte ; sinon Bob demande le prix unitaire ou la répartition et ne fait
  aucun arrondi caché ;
- `deux heures` doit produire quantité `2` et unité `heure` ;
- `Contrat 4 saisons` reste un `serviceReference` complet et ne fabrique ni quantité ni date ;
- `non, 450 et pas 400` est un patch du prix courant, jamais une nouvelle ligne ;
- une sortie invalide, multiple, hors phase ou dépassant une borne est rejetée sans écriture et
  donne une clarification naturelle ;
- aucune regex de synonymes métier ne décide de l'intention. Une regex syntaxique est permise
  uniquement pour valider un UUID, un décimal canonique ou une borne.

Matrice d'autorisation :

| Phase | Opérations sémantiques admises |
|---|---|
| inactive | `start_quote_creation` ; les lignes sont staged mais non exécutées |
| étapes client | `set_customer_reference`, `select_presented_choice` ; leurs lignes sont staged dans la même commande |
| `awaiting_lines` | `append_line_candidates` |
| `awaiting_catalogue_choice` | `select_presented_choice`, nouveau `service_reference` |
| `awaiting_line_details` | `patch_pending_line` pour le `requiredFact` courant ou une correction explicite |
| `awaiting_line_confirmation` | confirmer, rejeter ou patch explicite |

Toute autre combinaison échoue sans écriture. Une phrase comportant plusieurs opérations reste
ordonnée ; le serveur applique au plus une transition autoritaire par commande puis poursuit par
des continuations système idempotentes.

La commande et son fingerprint couvrent conjointement la décision client et ses lignes. Les work
items sont insérés dans la même transaction que `customer_selected` ou la nouvelle résolution ;
un succès client ne peut donc jamais être acquitté en perdant « et ajoute… ». Cette règle vaut
pour une référence nommée comme pour un choix ordinal.

## 7. Faits en attente : table AgentMission dédiée

M2-A ne modifie **aucune clé** de `QuoteDraftPayloadV1`. Son parseur fermé est utilisé par tous les
clients, y compris un appareil N-1 qui pourrait relire le slot après un kill ou un downgrade. Une
clé « optionnelle » nouvelle dans cette V1 casserait donc la compatibilité de lecture.

Les faits non confirmés vivent dans une table enfant de la mission :

```ts
type QuoteLineRequiredFact =
  | 'service_reference'
  | 'category'
  | 'quantity'
  | 'unit'
  | 'unit_price'
  | 'vat_rate'
  | 'housing_older_than_2y'
  | 'energy_renovation';

interface AgentMissionQuoteLineWork {
  readonly id: string; // UUID serveur, devient l'id metadata de la ligne confirmée
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly missionId: string;
  readonly ordinal: number; // 1..20, unique dans la mission
  readonly revision: number;
  readonly state:
    | 'queued'
    | 'awaiting_catalogue_choice'
    | 'awaiting_details'
    | 'awaiting_confirmation';
  readonly origin: 'user_voice' | 'user_tap';
  readonly serviceReference: string | null;
  readonly category: Exclude<LineCategory, 'disbursement'> | null;
  readonly quantityMilli: number | null;
  readonly unit: string | null;
  readonly unitPriceCents: number | null;
  readonly requestedVatRate: VatRate | null;
  readonly priceBasis: 'per_unit' | 'total' | null;
  readonly housingOlderThan2y: boolean | null;
  readonly energyRenovation: boolean | null;
  readonly requiredFact: QuoteLineRequiredFact | null;
  readonly catalogueItemId: string | null;
  readonly expectedCatalogueRevision: number | null;
  readonly proposalId: string | null;
  readonly proposalRevision: number | null;
  readonly proposalDiffHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Contraintes SQL :

- FK composite `(missionId, companyId, ownerUserId)` vers la mission ;
- unicité `(missionId, ordinal)` et au plus 20 lignes imposé sous verrou mission par le use case ;
- `revision` et `ordinal` entiers positifs bornés ;
- checks de cohérence par état : choix catalogue, question ou proposition ne peuvent pas
  coexister de façon contradictoire ;
- prix en centimes, quantité en millièmes, taux dans l'union fermée existante ;
- RLS activée et forcée, policies owner/tenant, rôle runtime non-propriétaire ;
- toute écriture exige aussi
  `missionId = nullif(current_setting('app.current_agent_mission_id', true), '')::uuid` ; ce
  setting n'est posé qu'après validation de la capability et verrou de la mission ;
- aucun grant implicite `anon`, `authenticated`, `service_role` ni `PUBLIC` ;
- identité `(id, companyId, ownerUserId, missionId, ordinal, createdAt)` immuable par trigger ;
- grants runtime minimaux CRUD, certifiés ; aucun rôle de lecture général ne contourne la policy ;
- suppression en cascade seulement avec la mission, jamais avec un item catalogue ;
- index `(companyId, ownerUserId, missionId, ordinal)` pour la reprise.

Les lignes dictées dans le tour initial sont insérées dans cette table dans la même transaction
que `mission_started`. Elles survivent ainsi à une décision de brouillon existant sans muter ce
brouillon. Reprendre ou abandonner le brouillon ne les consomme pas ; elles deviennent
actionnables seulement après le claim du slot et l'ACK écran.

`requiredFact` est l'autorité de la question courte en attente. Après kill, le ContextEnvelope
expose cet enum uniquement : « oui » ne peut être compris comme
`housing_older_than_2y=true` que si cette question exacte est persistée. Une réponse courte hors
question active est rejetée.

`serviceReference=null` est la seule représentation d'un libellé manquant. La chaîne vide est
interdite ; la recherche catalogue et la proposition sont impossibles tant que ce fait n'est pas
collecté.

Seuls les faits normalisés nécessaires à la reprise sont persistés. Le transcript, les spans,
prompts, scores LLM et alternatives rejetées ne le sont jamais.

Le `QuoteDraftPayloadV1` ne change qu'à la confirmation d'une ligne financière réelle. La ligne
et sa metadata prennent l'identifiant du work item ; le work item est supprimé dans la même
transaction après l'événement acquis. Un replay relit l'événement et le brouillon, sans exiger que
le work item supprimé existe encore.

Annuler, expirer ou compléter la mission supprime tous ses work items dans la même transaction.
Ils n'entrent pas dans la rétention audit de 90 jours : le journal conserve seulement leurs
identifiants/digests non sensibles. Un trigger refuse l'insertion ou la mise à jour d'un work item
si la mission parente n'est plus `active`.

## 8. Recherche catalogue réelle 0/1/N

M2-A introduit un port core dédié :

```ts
interface CatalogueCandidateSearchPort {
  search(input: {
    readonly companyId: string;
    readonly query: string;
    readonly limit: 6;
  }): Promise<{
    readonly candidates: readonly CatalogueCandidateRecord[]; // 0..5
    readonly truncated: boolean;
  }>;

  getById(input: {
    readonly companyId: string;
    readonly id: string;
  }): Promise<CatalogueCandidateRecord | null>;
}
```

L'adapter Prisma :

- inclut toujours `companyId` dans le prédicat ;
- ne charge pas le catalogue global de tous les tenants ;
- classe de façon stable : exact normalisé, préfixe, tokens, puis identifiant ;
- normalise casse, accents, ligatures et ponctuation de la même manière que le core ;
- lit au plus six lignes mais retourne au core cinq candidats maximum et `truncated=true` si une
  sixième existe ; aucune fausse ligne « sentinelle » n'entre dans le type candidat ;
- retourne la `revision` réelle, le libellé, catégorie, unité, prix et taux uniquement au service
  résolveur, jamais au LLM ;
- s'exécute dans la même transaction tenantée que la transition qui présente les choix.

`AgentMissionTransaction` expose ce port sous `catalogueCandidates`. L'adapter est construit avec
le `Prisma.TransactionClient` courant et verrouille `FOR SHARE` les lignes réellement présentées.
La confirmation relit `(companyId, id, revision)` dans cette même frontière transactionnelle.

La recherche possède un index tenant-first compatible avec sa normalisation. Le choix exact
(`searchKey` versionnée, casse/accents/ligatures/ponctuation) et l'index PostgreSQL sont décrits
dans la migration ; un scan de toutes les lignes du tenant n'est pas une certification acceptable
pour le SLO vocal.

Les CHECK SQL actuels du catalogue omettent encore `subscription` dans les catégories et `2,1`
dans les taux alors que `CATALOGUE_CATEGORIES` et `VAT_RATES` les autorisent. M2-A-0 corrige ces
deux dérives en expand/validate/cutover, avec les listes générées depuis TypeScript et un writer
N-1 à chaque étape. Aucune ligne `subscription` ou à `2,1 %` n'est présumée exister avant cette
migration.

Politique :

- `0` résultat : préparer une ligne libre et demander uniquement les faits manquants ;
- `1` résultat exact : présenter l'entrée réelle **et** « créer une ligne libre » ;
- `1` fuzzy ou `2..5` résultats : présenter les entrées réelles dans l'ordre stable **et**
  « créer une ligne libre » ;
- `truncated=true` : demander de préciser, sans faire croire que la liste est complète ;
- au choix ou à la confirmation, relire l'item sous tenant et exiger la même `revision` ;
- item supprimé/modifié : invalider la décision ou proposition, relancer la résolution et
  expliquer honnêtement ; jamais copier une ancienne valeur silencieusement.

Une entrée catalogue complète seulement les faits absents. Le libellé, la catégorie et l'unité
catalogue sont les valeurs proposées de référence. Un prix ou une quantité explicitement dits par
l'utilisateur ne sont jamais écrasés par le catalogue : le diff affiche l'écart. Une contradiction
de catégorie ou d'unité est demandée explicitement au lieu de choisir silencieusement. Pour une
ligne libre, le `serviceReference` normalisé par le modèle est une proposition de libellé avec
provenance `user_voice`; il ne devient contenu financier qu'à la confirmation.

## 9. Machine à états M2-A

Phases additives :

```ts
type QuoteCreationMissionPhaseM2A =
  | 'awaiting_lines'
  | 'awaiting_catalogue_choice'
  | 'awaiting_line_details'
  | 'awaiting_line_confirmation';
```

Transitions :

```text
awaiting_lines
  ├─ lignes dictées/tap ───────────────→ queue persistée
  └─ queue non vide ──────────────────→ résolution de la tête

résolution tête
  ├─ catalogue 1..5 ──────────────────→ awaiting_catalogue_choice
  ├─ catalogue >5 ────────────────────→ awaiting_line_details (précision demandée)
  └─ catalogue 0 ─────────────────────→ ligne libre

ligne choisie/libre
  ├─ faits obligatoires absents ──────→ awaiting_line_details
  └─ faits complets + TVA validable ──→ awaiting_line_confirmation

awaiting_line_confirmation
  ├─ confirmer ───────────────────────→ ajout atomique puis awaiting_lines
  ├─ modifier ────────────────────────→ awaiting_line_details
  └─ annuler cette ligne ─────────────→ retire la tête puis awaiting_lines
```

Un tour peut avancer automatiquement à travers toutes les lectures/résolutions sans décision. Il
s'arrête au premier choix réel, champ obligatoire manquant ou confirmation. Une seule décision est
active à la fois.

## 10. Décisions et proposition scellées

Deux nouveaux kinds fermés complètent `QuoteMissionDecisionV1`.

```ts
interface CatalogueDecisionV1 {
  readonly kind: 'catalogue';
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly pendingLineId: string;
  readonly expectedDraft: QuoteMissionDraftReferenceV1;
  readonly expectedWorkRevision: number;
  readonly candidates: readonly {
    readonly choiceId: string;
    readonly catalogueItemId: string;
    readonly expectedCatalogueRevision: number;
  }[];
  readonly freeLineChoiceId: string;
  readonly choiceSetHash: string;
}

interface LineConfirmationDecisionV1 {
  readonly kind: 'line_confirmation';
  readonly decisionId: string;
  readonly choiceSetRevision: number;
  readonly pendingLineId: string;
  readonly proposalId: string;
  readonly proposalRevision: 1;
  readonly expectedDraft: QuoteMissionDraftReferenceV1;
  readonly expectedWorkRevision: number;
  readonly expectedCatalogue:
    | { readonly itemId: string; readonly revision: number }
    | null;
  readonly diffHash: string;
  readonly choices: readonly [
    { readonly choiceId: string; readonly action: 'confirm_line' },
    { readonly choiceId: string; readonly action: 'edit_line' },
    { readonly choiceId: string; readonly action: 'cancel_line' },
  ];
  readonly choiceSetHash: string;
}
```

Le hash canonique couvre mission, révision, décision, ligne pending et sa révision, fences du
brouillon, catalogue éventuel, proposition, diff et choix ordonnés. Le diff contient seulement l'ajout
proposé par rapport au brouillon relu ; son rendu vocal et visuel provient des données réelles
relues, pas du modèle.

« le premier » résout le `choiceId` courant ; le tap transmet ce même `choiceId`.
« oui/valide » résout le `confirm_line` du jeu courant ; le bouton **Ajouter la ligne** transmet
le même choix. Un ordinal hors jeu, un ancien `proposalId`, une revision périmée ou un autre
payload avec le même `commandId` échoue fermé.

## 11. TVA

Le LLM ne choisit pas la TVA.

`AgentMissionTransaction` expose un port purpose-specific `quoteVatContext` qui relit, sous tenant,
les faits fiscaux nécessaires de la société et du client confirmé. Il ne retourne ni un taux
calculé par l'infrastructure, ni un agrégat partiel trompeur.

Un moteur pur `deriveQuoteVatDecisionOptions` partage les mêmes faits que `suggestVatRate` :

1. franchise ou autoliquidation impose `0` ;
2. un taux catalogue ou explicitement dicté reste une **intention** ;
3. `10` et `5,5` exposent les `requiredFact` d'éligibilité manquants ;
4. s'il n'existe aucun taux imposé et aucun choix explicite, Bob demande le taux ; il n'invente
   pas `20` ;
5. le choix et son contexte sont finalement validés par `suggestVatRate` avant la proposition puis
   revalidés à la confirmation.

M2-A conserve l'invariant historique d'un taux unique dans `QuoteDraftPayloadV1` afin qu'un client
N-1 puisse toujours relire le slot. En conséquence :

- `disbursement` est refusé actionnablement dans cette tranche ;
- si le brouillon possède déjà des lignes, une ligne dont le taux valide diffère est refusée sans
  mutation et Bob explique que la TVA mixte exige le futur payload négocié ;
- aucune décision M2-A ne remplace le taux de lignes déjà confirmées.

La TVA par ligne et les débours rejoindront une vraie `QuoteDraftPayloadV2` négociée, jamais une
extension silencieuse de V1.

## 12. Transition core partagée

La primitive commune reste pure, sans framework et neutre vis-à-vis d'AgentMission :

```ts
appendResolvedQuoteDraftLine(input: {
  readonly payload: QuoteDraftPayloadV1;
  readonly expectedContentRevision: number;
  readonly resolvedLine: QuoteDraftPayloadLine;
  readonly metadata: QuoteDraftPayloadLineMetadata;
  readonly vatDecision: QuoteDraftPayloadV1['draft']['vatDecision'];
}): QuoteDraftPayloadResult;
```

Elle :

- reparcourt le parseur strict du payload ;
- exige la bonne révision ;
- vérifie bornes quantité/prix, catégorie, unité, TVA et nombre maximal de lignes ;
- ajoute exactement une ligne et sa metadata ;
- réinitialise le form staging ;
- augmente `contentRevision` de exactement 1 ;
- ne connaît ni LLM, ni ORM, ni React.

Le wrapper mission vérifie work item, décision, `proposalId`, diff, catalogue et CAS avant
d'appeler cette primitive, puis supprime le work item. Le wizard tactile hors mission appelle la
même primitive avec une ligne déjà résolue ; il n'a pas à fabriquer un faux `proposalId`. Tous les
taps rendus pendant une mission passent, eux, par les commandes mission et les vrais IDs scellés.

## 13. Transaction, idempotence et journal

La confirmation réussie réalise dans une transaction PostgreSQL :

1. validation capability/tenant/owner ;
2. horloge DB et reçu `commandId` ;
3. verrou mission puis vérification phase/révision/décision/proposition ;
4. verrou brouillon et comparaison session/slot/content ;
5. verrou du work item et comparaison de sa révision ;
6. relecture client, faits TVA et catalogue éventuel sous tenant ;
7. validation TVA et construction de la ligne autoritaire ;
8. transition core partagée ;
9. CAS brouillon `slot N→N+1`, `content C→C+1` ;
10. suppression de la tête de file ;
11. CAS mission `revision R→R+1`, décision consommée, phase `awaiting_lines` ;
12. événement append-only de séquence `R+1` ;
13. relecture de la mission et du brouillon avant réponse.

Événements additifs :

```text
line_candidates_staged
catalogue_not_found
catalogue_choices_presented
catalogue_choice_selected
line_details_requested
line_proposal_presented
line_proposal_rejected
line_confirmed
line_cancelled
```

Les données d'événement contiennent seulement identifiants, compteurs, catégories de résultat,
révisions, acteur, `commandId`, HMAC d'empreinte et digests. Elles excluent transcript, libellé,
quantité, unité, prix, TVA, nom client, nom catalogue et arguments d'outil.

Un replay exact relit son reçu et n'écrit rien. Un même `commandId` avec un autre fingerprint est
refusé. Deux confirmations concurrentes ne peuvent produire qu'une ligne.

Si la file contient encore une ligne, l'API dérive ensuite un `commandId` système stable depuis
l'événement `line_confirmed`, puis exécute `continue_quote_line_queue`. Cette commande acquiert sa
propre révision et son propre événement, résout la nouvelle tête et converge jusqu'au prochain
état stable (choix, question, proposition ou file vide). L'API n'annonce pas la fin du tour avant
ce terminal. Un replay relit les deux reçus ; une panne de la continuation ne révoque pas la ligne
déjà confirmée et reste retryable.

## 14. API, mobile et réponse canonique

Les endpoints mission existants restent la seule surface. Les commandes additives sont
versionnées et soumises à la même capability M2-A :

- stage/patch d'une ligne ;
- choix catalogue ;
- confirmation, modification ou annulation de proposition.

Les IDs persistés ne suffisent pas à rendre l'interface. Chaque lecture/commande retourne aussi
une projection stricte et éphémère :

```ts
interface QuoteAgentMissionPresentationV1 {
  readonly schema: 'bob.agent-mission.quote-presentation';
  readonly version: 1;
  readonly requiredFact: QuoteLineRequiredFact | null;
  readonly catalogueChoices: readonly {
    readonly choiceId: string;
    readonly available: boolean;
    readonly label: string | null;
    readonly category: Exclude<LineCategory, 'disbursement'> | null;
    readonly unit: string | null;
    readonly unitPriceCents: number | null;
    readonly vatRate: VatRate | null;
  }[];
  readonly freeLineChoiceId: string | null;
  readonly proposal: {
    readonly proposalId: string;
    readonly diffHash: string;
    readonly line: QuoteDraftPayloadLine;
    readonly catalogue:
      | { readonly itemId: string; readonly revision: number; readonly label: string }
      | null;
  } | null;
}
```

Cette projection est recalculée depuis le work item, le brouillon, le catalogue, la société et le
client relus sous tenant. Une entrée disparue vaut `available=false` et ses champs métier valent
`null` ; elle ne réutilise jamais le snapshot d'une réponse précédente. Les codecs API-client
ferment toutes les unions et bornes. La projection n'est ni persistée dans la mission, ni envoyée
au LLM.

Le mobile :

- réhydrate la file, la décision et la proposition depuis l'API ;
- affiche les candidats réels dans l'ordre scellé ;
- ouvre une seule sheet à la fois ;
- rend le diff label/quantité/unité/prix/TVA et l'origine catalogue ;
- utilise les tokens Bob, i18n, zones tactiles ≥ 44 pt et `reduce-motion` ;
- affiche chargement, vide, erreur avec retry et données ;
- ne fabrique jamais un libellé ou prix de secours ;
- ne ferme pas Bob Live après `awaiting_lines`.

La réponse vocale est reconstruite depuis la relecture :

- plusieurs choix : « J'ai trouvé trois prestations dans ton catalogue… » ;
- champ absent : question unique sur le premier champ nécessaire ;
- proposition : résumé concis du diff puis demande de confirmation ;
- succès : « La ligne est ajoutée » uniquement après relecture ;
- conflit : état réel et prochaine action, jamais un faux succès.

## 15. Compatibilité et migrations

Le flag M2-A reste OFF pendant tout le train.

Les unions JSON et CHECK PostgreSQL étant fermés, le rollout est append-only :

1. **M2-A-0 / expand** : table de work items, RLS/FK/indexes, correction du CHECK catalogue
   `subscription`, ports et parseurs purs, sans writer de feature ;
2. **M2-A-1 / expand mission** : nouvelles phases, décisions et événements dans des contraintes
   `NOT VALID`, sans retirer les contraintes actives ;
3. **validate** : validation séparée ;
4. **cutover** : flag OFF, writers N-1 drainés, remplacement atomique des anciennes contraintes ;
5. déploiement writer N ;
6. activation bornée sur compte interne seulement ;
7. preuve puis retrait de l'override en cas d'échec.

Chaque migration commence par `SET LOCAL lock_timeout` et `statement_timeout`. Les listes de
phases/kinds/events sont générées depuis les constantes TypeScript. Un test writer N-1 insère la
forme exacte historique :

- après expand ;
- après validate ;
- après cutover ;
- sous rôle non-superuser avec FORCE RLS.

Le test couvre aussi un **reader N-1** : GET puis décodage du `QuoteDraftPayloadV1` exact avant,
pendant et après M2-A. Le slot ne contient aucun work item, donc un ancien client continue à le
lire. Il ne reçoit jamais une capability M2-A et ne peut pas ouvrir la mission en écriture.

### 15.1 Trains de livraison — une seule PR active à la fois

| Train | Résultat atomique | Statut maximal avant la fin |
|---|---|---|
| M2-A-0 | schéma work items + RLS + contrat core + parité catalogue SQL | `implemented` |
| M2-A-1 | frame V2, staging initial, recherche 0/1/N, continuation et choix API | `implemented` |
| M2-A-2 | questions persistées, TVA, proposition, primitive partagée et confirmation | `implemented` |
| M2-A-3 | projection mobile, parité voix/tap, reprise et certification device/staging | `certified` |

Chaque PR est fusionnée et sa CI verte avant d'ouvrir la suivante. Aucun sous-train n'est présenté
comme une fonctionnalité finie ; le flag reste OFF jusqu'à M2-A-3.

## 16. Observabilité M2-A

M2-A émet des mesures allowlistées corrélées par IDs pseudonymisés :

- durée compréhension ;
- durée recherche catalogue ;
- durée transaction ;
- nombre de candidats borné `0..6` ;
- résultat de transition ;
- conflits CAS, replay et invalidations ;
- temps jusqu'à la première question ou proposition.

Ce train n'écrit aucun transcript ni argument d'outil dans `VoiceTrace`. Le raccord complet du
sideband GPT Realtime à `VoiceTrace V2` reste un train distinct et doit supprimer les payloads
vocaux bruts avant activation. L'absence de cette certification interdit de promouvoir O5 à
`certified`, sans bloquer les tests locaux M2-A.

## 17. Critères d'acceptation binaires

### Compréhension et contexte

- [ ] la phrase canonique Camping conserve client + ligne après navigation ;
- [ ] en phase client, « Camping Les Pins » puis « le deuxième » conservent exactement le
      comportement M1-C tout en préservant les lignes staged ;
- [ ] « Camping Les Pins, et ajoute deux heures à 55 € » et « le deuxième, puis ajoute deux
      heures à 55 € » sélectionnent le client et stagent la ligne dans une seule transaction ;
- [ ] `400 balles par machine`, quantité `3` et unité `machine` deviennent 40 000 centimes,
      quantité millième `3000`, sans total calculé par le LLM ;
- [ ] « Contrat 4 saisons » ne fabrique ni quantité ni date ;
- [ ] « non, 450 et pas 400 » corrige seulement la proposition courante ;
- [ ] frame invalide, multiple ou hors phase : zéro écriture et clarification.
- [ ] après kill, une réponse courte n'est acceptée que pour le `requiredFact` persisté.

### Données réelles et catalogue

- [ ] toutes les recherches portent le `companyId` autoritaire ;
- [ ] politiques 0, 1 exact, 1 fuzzy, 2..5 et ≥6 certifiées ;
- [ ] même liste et même ordre sur la voix et l'UI ;
- [ ] item supprimé ou révisé avant le choix/confirm : invalidation sans copie obsolète ;
- [ ] aucun mock, fixture ou tarif inventé dans un chemin de production.
- [ ] `subscription` traverse le core, le CHECK SQL et l'adapter réel.
- [ ] le taux `2,1 %` traverse frame, patch, catalogue, validation core et CHECK SQL.

### Parité et sécurité

- [ ] même `choiceId` sélectionné par ordinal ou tap ;
- [ ] même `proposalId` confirmé par voix ou bouton ;
- [ ] confirmation concurrente : une seule ligne ;
- [ ] réponse HTTP perdue : replay sans seconde ligne ;
- [ ] ancien choix/proposal/révision : refus sans mutation ;
- [ ] RLS et anti-IDOR sur client, catalogue, mission et brouillon.
- [ ] aucun work item n'est mutable sans le setting de mission courante validé.

### Reprise et UX

- [ ] kill/relaunch à chaque nouvelle phase restitue l'état exact sans parole automatique ;
- [ ] la session reste ouverte après ajout et accepte une ligne suivante ;
- [ ] le mobile rend chargement/vide/erreur/données, i18n, accessibilité et `reduce-motion` ;
- [ ] aucune sheet concurrente et aucun tap sec ne confirme une action financière.

### Non-régression

- [ ] M1-C client, reprise et ACK restent verts ;
- [ ] writer N-1 reste valide après chaque étape SQL ;
- [ ] reader N-1 relit le même `QuoteDraftPayloadV1` pendant toute la mission ;
- [ ] wizard manuel hors mission reste fonctionnel ;
- [ ] aucune intention devis ne traverse simultanément AgentMission et le parseur regex local.

## 18. Definition of Done

M2-A passe de `implemented` à `certified` seulement si :

1. core, API, client et mobile sont réellement câblés ;
2. tests unitaires purs, contrats, intégration API et PostgreSQL réel sont verts ;
3. typecheck, lint, garde artefact et build de la chaîne sont verts depuis un checkout propre ;
4. review adversariale correctness/sécurité, architecture/parité et UX sans P0/P1 ouvert ;
5. certification staging Supabase avec déployeur non-superuser et writer N-1 ;
6. test appareil sur compte interne avec données réelles, barge-in et reprise ;
7. artefact de preuve non-PII : SHA, versions de flags, phases, latences, replays et état final ;
8. flag public toujours OFF tant que M2-B création/revue n'est pas certifié.

La publication du devis vocal complet reste interdite tant que M2-B et M2-C ne sont pas eux-mêmes
`certified`.

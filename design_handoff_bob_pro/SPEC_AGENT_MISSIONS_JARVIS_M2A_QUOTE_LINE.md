# SPEC — Agent Missions Jarvis M2-A : ligne de devis durable, catalogue réel et parité voix ↔ toucher

**Statut global : implemented ; non certified**

**Train M2-A-0 : implemented dans `4c844111`, flag public OFF ; non certified**

**Train M2-A-1 : implemented, flag public OFF ; non certified**

**Train M2-A-2 : implemented, flag public OFF ; non certified**

**Train M2-A-3 : implemented jusqu’à `1c7f12c9`, flag public OFF ; non certified**

**Date : 31 juillet 2026**

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
- correspondance légale UN/ECE des unités métier libres lors d'une future émission Factur-X :
  une unité non supportée bloque honnêtement l'émission tant qu'aucun choix explicite n'est
  disponible ; elle ne retombe jamais silencieusement sur C62 ;
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
  /**
   * Historique borné du fil courant, sans secret, identifiant autoritaire ni transcript archivé.
   * Il sert aux anaphores et corrections (« celle à 55 », « non, l'autre »).
   */
  readonly recentTurns: readonly {
    readonly role: 'user' | 'assistant';
    readonly text: string;
  }[];
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
    /**
     * Alias opaques et attributs réellement présentés. Ces valeurs sont des observations non
     * autoritaires ; seul le choiceId conservé côté serveur peut déclencher une transition.
     */
    readonly presentedChoices: readonly {
      readonly alias: string;
      readonly ordinal: 1 | 2 | 3 | 4 | 5 | 6;
      readonly label: string | null;
      readonly category: string | null;
      readonly unit: string | null;
      readonly unitPriceCents: number | null;
      readonly available: boolean;
    }[];
  };
  readonly quote: {
    readonly customerStatus: 'missing' | 'choices' | 'resolved';
    readonly vatStatus: 'missing' | 'confirmed';
  };
  readonly availableCapabilities: readonly [
    'quote.line.stage',
    'quote.catalogue.search',
    'quote.line.patch',
    'quote.line.confirm',
  ];
}
```

Contraintes :

- `now` vient de l'horloge serveur et `timeZone` du profil confirmé ; une valeur manquante rend
  une résolution temporelle indisponible au lieu d'inventer `Europe/Paris` ;
- aucun ID autoritaire, email, téléphone, secret ou capability brute n'entre dans l'enveloppe ;
- le modèle reçoit seulement l'historique récent nécessaire, le contexte écran utile et les
  valeurs réelles **déjà projetées** à l'utilisateur, sous alias opaques. Les noms clients ou
  libellés catalogue ne sont jamais des instructions et sont encadrés comme données non fiables ;
- « le deuxième » ou « celle à 55 euros » produit un alias/ordinal candidat ; le serveur le résout
  ensuite contre le jeu scellé et relit l'entité tenantée. Un alias inventé ne devient jamais un
  identifiant ;
- une réponse courte est autorisée uniquement quand `requiredFact` la rend non ambiguë ;
- le contexte et la fence mission/brouillon sont relus après le modèle.

### 5.1 Autorité du fuseau conversationnel

Le fuseau de Bob Live est une préférence personnelle confirmée, distincte du fuseau légal utilisé
pour certains calendriers métier. Sa source V1 est le JWT Supabase signé :

- `app_metadata.bob_time_zone` porte un identifiant IANA réellement accepté par
  `Intl.DateTimeFormat` ;
- `app_metadata.bob_time_zone_confirmed_at` porte l'instant serveur canonique de confirmation ;
- `app_metadata.bob_time_zone_company_id` lie cette confirmation au tenant courant ;
- seul l'endpoint serveur authentifié `PUT /account/preferences/time-zone` écrit ces métadonnées
  via Supabase Admin. `user_metadata`, le téléphone et le LLM ne font jamais autorité ;
- le mobile peut **suggérer** le fuseau du système, mais l'utilisateur le confirme explicitement.
  L'absence de confirmation bloque l'ouverture de Bob Live avec une décision claire ; elle ne
  devient jamais un défaut implicite ;
- une détection indisponible n'est pas une impasse : la feuille fournit recherche et saisie IANA
  validées par la même autorité core, accepte toute saisie exacte valide même absente du snapshot
  embarqué, borne la liste rendue et permet une redétection explicite ;
- la confirmation est single-flight par gate monotone : deux gestes same-frame réutilisent la même
  promesse et produisent un seul PUT puis un seul refresh. Annulation, logout, démontage ou nouveau
  gate invalident toute réponse réseau tardive ; une erreur conserve la sélection pour le retry ;
- le guard vérifie signature, format IANA, instant et égalité du tenant. Une clé absente, invalide
  ou liée à une autre société produit `null`, sans repli ;
- le principal confirmé est capturé au bootstrap Bob Live et figé pour toute la session. Aucun
  appel GoTrue par tour et aucune modification de fuseau au milieu d'une mission ;
- après confirmation, le mobile rafraîchit la session Supabase avant d'ouvrir Bob Live afin que le
  JWT présenté au bootstrap porte la nouvelle autorité.

Cette V1 évite une table et une migration uniquement pour une petite préférence d'identité signée.
Si le produit exige plus tard des préférences multi-appareil historisées, une table tenantée pourra
remplacer cette source par une migration additive ; le contrat `confirmed | unavailable` restera
identique.

## 6. Frame sémantique V2

La V2 remplace la V1 uniquement quand la capability M2-A est admise. Elle accepte plusieurs faits
dans un tour afin que l'utilisateur ne répète pas sa phrase après navigation.

### 6.1 Négociation et isolement N/N-1

La version de frame sémantique ne doit jamais fuiter par la capability V1 actuelle. M2-A-1 pose
donc le support serveur d'un protocole AgentMission `2`, additif au protocole `1` :

- un client V1 continue de demander `agentMissionProtocolVersion=1`, reçoit une capability
  `bam1_*` et ne peut lire ou muter que les phases M1-C ;
- un client M2-A demande explicitement `agentMissionProtocolVersion=2` et ne peut recevoir une
  capability `bam2_*` que si le master
  `BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED=true` **et** le release flag
  `bob.agent_missions.quote.m2a` est activé pour cet utilisateur ;
- le protocole demandé, le préfixe de capability, le binding durable de lease et la preuve portée
  jusqu'à l'UoW doivent être identiques ; toute divergence échoue fermée ;
- `agent_missions.protocolVersion SMALLINT NOT NULL DEFAULT 1` persiste le protocole propriétaire
  de chaque mission et devient immuable. Une mission V2 garde cette identité lorsqu'elle traverse
  une phase commune telle que `awaiting_lines` ;
- avant toute projection ou mutation, l'UoW exige
  `proof.protocolVersion === mission.protocolVersion`. Une preuve V1 ne peut donc pas reprendre
  une mission V2 après fermeture de sa session, et une preuve V2 ne peut pas s'approprier une
  mission historique V1 ;
- les endpoints M2-A et les nouvelles phases refusent une preuve V1 avant toute lecture métier ;
- les endpoints et codecs V1 restent de forme exacte. Une mission déjà en phase M2-A n'est jamais
  projetée dans un codec V1 : l'ancien client reçoit une erreur explicite de mise à niveau et
  aucune autorité d'écriture ;
- l'application mobile publiée continue à demander V1 pendant M2-A-1/M2-A-2. Le basculement de sa
  négociation vers V2, sa projection et les preuves device appartiennent à M2-A-3.

Le master M2-A vaut `false` dans tous les environnements à l'atterrissage. Il est invalide au boot
si le master V1 et le keyring AgentMission ne sont pas eux-mêmes complets. Aucune « tolérance » ne
rabaisse silencieusement une demande V2 vers V1.

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
      /**
       * Réponse à la question persistée ou correction nommée indépendamment de cette question.
       */
      readonly scope: 'answer_required_fact' | 'explicit_correction';
      readonly patch: QuoteLineCandidatePatchV1;
    }
  | {
      readonly kind: 'select_presented_choice';
      readonly ordinal: 1 | 2 | 3 | 4 | 5 | 6;
      /** Une autre demande du même tour reste à redemander après ce choix scellé. */
      readonly hasUnprocessedRequest: boolean;
    }
  | { readonly kind: 'confirm_current_proposal' }
  | { readonly kind: 'reject_current_proposal' }
  | { readonly kind: 'cancel_current_line' }
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

- un tool call exact et unique, `additionalProperties: false`, contenant exactement une opération
  autoritaire enrichie d'au plus 20 lignes lorsque cette opération porte elle-même une parole
  courante (`start_quote_creation`, `set_customer_reference`, `append_line_candidates`) ;
- le JSON Schema présenté au modèle est calculé depuis la phase autoritaire et n'expose jamais une
  opération interdite dans cette phase ; le parseur conserve la même matrice comme défense
  indépendante ;
- sur OpenAI, les outils mission compatibles utilisent le mode strict du fournisseur. Leur schéma
  reste dans le sous-ensemble Structured Outputs documenté (`anyOf`, objets fermés, propriétés
  requises et null explicite). Cette option n'est jamais envoyée aveuglément aux adapters qui ne
  la supportent pas ;
- chaînes bornées, trimées, sans caractères de contrôle ; frame totale ≤ 32 KiB ;
- les nombres et montants restent des chaînes décimales canoniques dans la frame, puis deviennent
  quantité millième et centimes par résolveurs purs ;
- `400 balles par machine` doit produire `unitPriceDecimal="400"`, `currency="EUR"`,
  `priceBasis="per_unit"` ; le modèle ne multiplie pas le total ;
- un prix annoncé comme total est converti en prix unitaire seulement si la division en centimes
  par la quantité est exacte ; sinon Bob demande le prix unitaire ou la répartition et ne fait
  aucun arrondi caché ;
- `deux heures` doit produire quantité `2` et unité `heure` ;
- les alias standards fermés sont canonisés par le même résolveur après le modèle, avant toute
  persistance et toute comparaison catalogue (`heures`, `h`, `1 h` → `heure`). Il ne singularise
  jamais une unité libre ; `machine` et `machines`, `unité` et `pièce`, `forfait` et `lot`
  demeurent des références métier distinctes ;
- une TVA absente de la parole courante reste `vatRateHint=null` ; `0` signifie exclusivement que
  l'utilisateur a réellement donné un taux nul dans ce tour ;
- `Contrat 4 saisons` reste un `serviceReference` complet et ne fabrique ni quantité ni date ;
- `non, 450 et pas 400` est un patch du prix courant, jamais une nouvelle ligne ;
- une sortie invalide, multiple, hors phase ou dépassant une borne est rejetée sans écriture et
  donne une clarification naturelle ;
- aucune regex de synonymes métier ne décide de l'intention. Une regex syntaxique est permise
  uniquement pour valider un UUID, un décimal canonique ou une borne.

Matrice d'autorisation :

| Phase | Opérations sémantiques admises |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| inactive | `start_quote_creation` ; les lignes sont staged mais non exécutées |
| étapes client                                      | `set_customer_reference`, `select_presented_choice` ; seul `set_customer_reference` peut porter les lignes dictées dans le même tour   |
| `awaiting_lines` | `append_line_candidates` |
| `awaiting_catalogue_choice` | `select_presented_choice` en M2-A-1 ; correction explicite de `service_reference` en M2-A-2 |
| `awaiting_line_details` _(M2-A-2 uniquement)_      | `patch_pending_line` pour le `requiredFact` courant ou une correction explicite ; `cancel_current_line` pour retirer seulement la tête |
| `awaiting_line_confirmation` _(M2-A-2 uniquement)_ | confirmer, rejeter pour modifier, annuler la ligne ou patch explicite                                                                  |

Toute autre combinaison échoue sans écriture. Une phrase composite est représentée par une seule
opération enrichie de ses lignes pour `start_quote_creation` ou `set_customer_reference` ; le
serveur applique au plus une transition autoritaire par commande puis poursuit par des
continuations système idempotentes.

`select_presented_choice` ne transporte que l'ordinal. Le choix catalogue/client est scellé depuis
les choix autoritaires présentés ; il ne peut pas transporter une ligne tirée du contexte, de
l'historique ou d'un choix. Le LLM doit rendre `hasUnprocessedRequest=true` lorsque le même tour
contient une autre demande : après l'effet autoritaire, Bob annonce explicitement que cette seconde
action n'a pas été exécutée et demande de la redire après l'étape courante. Cette fermeture est
volontaire et temporaire : « le deuxième, puis ajoute deux heures » sélectionne le deuxième choix
sans perdre silencieusement la seconde intention. La composition en un seul tour ne sera rouverte
qu'avec un reliquat textuel exact validé comme sous-chaîne de la parole courante, puis une extraction
séparée par le même planner sur ce seul reliquat, sans historique, ligne courante ni choix
présentés. Fermer cette capacité est un impact produit explicite, pas un correctif transparent.

Les séquences de plusieurs transitions sémantiques dans un même tool call restent fermées jusqu'au
train qui saura toutes les consommer dans l'ordre avec cette provenance bornée.

La correction du libellé pendant un choix catalogue ne doit pas être simulée par
`append_line_candidates` : cela créerait une seconde ligne au lieu de corriger la tête. M2-A-1
refuse donc cette tournure sans mutation ; M2-A-2 l'introduit avec le patch persistant de la tête,
la remise explicite de `catalogueResolution='pending'` et une nouvelle recherche idempotente.

`reject_current_proposal` signifie « revenir modifier cette ligne » et consomme donc le choix
`edit_line`. `cancel_current_line` signifie « abandonner cette ligne » et consomme le choix
`cancel_line`. Les deux opérations restent distinctes dans la frame, le fingerprint, le journal et
la réponse canonique : un refus de proposition ne peut jamais supprimer silencieusement la tête de
file. Le retour générique « modifier » place le work item en `awaiting_details` avec
`requiredFact=null` et demande quel champ changer ; aucune réponse courte (« oui », « 55 ») n'est
alors interprétable. Dès qu'un champ explicite est patché, la continuation recalcule soit le
premier vrai `requiredFact`, soit une nouvelle proposition.

Le `scope` de `patch_pending_line` appartient à la forme fermée et au fingerprint. Le scope
`answer_required_fact` exige que le champ du patch soit exactement le `requiredFact` non nul relu
sous verrou ; il est le seul scope autorisé pour une réponse courte. Le scope
`explicit_correction` peut nommer un autre champ et doit être envoyé par tout contrôle tactile.
Une réponse issue du modèle ne peut jamais être promue silencieusement d'un scope à l'autre.

La commande et son fingerprint couvrent conjointement la décision client, le scope éventuel et
ses lignes. Les work items sont insérés dans la même transaction que `customer_selected` ou la
nouvelle résolution ;
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
  /**
   * Séquence INT4 strictement positive et monotone dans la mission. La borne de 20 porte sur le
   * NOMBRE d'items encore en file, pas sur cet ordinal : supprimer la tête 1 ne doit jamais
   * autoriser une nouvelle ligne à repasser avant les restes 2..20.
   */
  readonly ordinal: number;
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
  /**
   * Axe orthogonal à `state` : distingue une recherche encore due d'une décision explicite de
   * ligne libre. Sans ce marqueur, une continuation rejouerait indéfiniment la recherche après
   * le choix « créer une ligne libre ».
   */
  readonly catalogueResolution: 'pending' | 'free' | 'selected';
  readonly catalogueItemId: string | null;
  readonly expectedCatalogueRevision: number | null;
  /**
   * Preuves durables que l'utilisateur a explicitement conservé une valeur différente de
   * l'entrée catalogue relue. Sans elles, la même contradiction serait redemandée après kill.
   */
  readonly catalogueCategoryOverrideConfirmed: boolean;
  readonly catalogueUnitOverrideConfirmed: boolean;
  readonly proposalId: string | null;
  readonly proposalRevision: number | null;
  readonly proposalDiffHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Contraintes SQL :

- FK composite `(missionId, companyId, ownerUserId)` vers la mission ;
- unicité `(missionId, ordinal)` ; `ordinal` est un INT4 positif monotone, jamais réutilisé ;
- au plus 20 work items **présents** imposé sous verrou mission par le use case, avec calcul du
  prochain ordinal depuis le maximum existant et refus avant débordement INT4 ;
- `revision` et `ordinal` entiers positifs bornés à INT4 ;
- checks de cohérence par état : choix catalogue, question ou proposition ne peuvent pas
  coexister de façon contradictoire ;
- `catalogueResolution='selected'` si et seulement si la fence
  `(catalogueItemId, expectedCatalogueRevision)` est complète ; `pending|free` exigent les deux
  valeurs nulles ;
- les deux preuves d'override valent `false` par défaut et hors
  `catalogueResolution='selected'` ; une sélection catalogue ou une nouvelle
  `serviceReference` les remet à `false` ;
- une preuve passe à `true` seulement après un patch `explicit_correction` de catégorie ou
  d'unité qui conserve explicitement une valeur différente de l'item catalogue relu sous sa
  révision ; elle revient à `false` si la valeur rejoint celle du catalogue ;
- `awaiting_catalogue_choice` exige `catalogueResolution='pending'` ;
- `awaiting_details + pending` n'est admis que pour
  `requiredFact='service_reference'` : toute autre question exige que la recherche ait déjà
  convergé vers `free` ou `selected` ;
- une correction explicite de `serviceReference` remet la résolution à `pending`, efface la
  fence catalogue et toute proposition ; un item supprimé ou révisé produit le même retour
  explicite avant une nouvelle recherche ;
- prix en centimes, quantité en millièmes, taux dans l'union fermée existante ;
- RLS activée et forcée, policies owner/tenant, rôle runtime non-propriétaire ;
- toute écriture exige aussi
  `missionId = nullif(current_setting('app.current_agent_mission_id', true), '')::uuid` ; ce
  setting n'est posé qu'après validation de la capability et verrou de la mission ;
- aucun grant implicite `anon`, `authenticated`, `service_role` ni `PUBLIC` ;
- identité `(id, companyId, ownerUserId, missionId, ordinal, origin, createdAt)` immuable par
  trigger ; une provenance voix/toucher ne peut jamais être réécrite après coup ;
- insertion et mutation refusées si la mission parente n'est pas en protocole `2`, même si un
  appelant V1 atteint accidentellement le port ;
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
si la mission parente n'est plus `active`. La suppression explicite des work items précède donc
le CAS terminal de la mission ; l'ordre inverse serait refusé par ce trigger.

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
- retourne la `revision` réelle uniquement au service résolveur. Après création d'un jeu scellé,
  le libellé, la catégorie, l'unité, le prix et la disponibilité réellement affichés peuvent être
  projetés au LLM sous alias opaque afin qu'il comprenne « celle à 55 euros » ; la révision,
  l'identifiant catalogue et le `choiceId` restent hors de sa portée ;
- retourne `0` avant SQL pour une requête vide après normalisation ; toute entrée tenant/requête
  invalide échoue fermée avant le port et l'adapter, elle ne devient jamais un faux résultat vide ;
- s'exécute dans la même transaction tenantée que la transition qui présente les choix.

`AgentMissionTransaction` expose ce port sous `catalogueCandidates`. L'adapter est construit avec
le `Prisma.TransactionClient` courant et verrouille `FOR SHARE` les lignes réellement présentées.
La confirmation relit `(companyId, id, revision)` dans cette même frontière transactionnelle.

La recherche possède des index tenant-first compatibles avec sa normalisation. Le choix exact
(`searchKey` versionnée, casse/accents/ligatures/ponctuation) et les index PostgreSQL sont décrits
dans la migration ; un scan de toutes les lignes du tenant n'est pas une certification acceptable
pour le SLO vocal.

Le `GIN(to_tsvector(...))` historique de M2-A-0 ne constitue **pas** cette preuve : sous
`FORCE RLS`, PostgreSQL ne pousse pas l'opérateur `@@`, non `LEAKPROOF`, à travers la barrière de
sécurité et le plan retombe sur un scan. M2-A-1 introduit donc
`catalogue_prestation_search_tokens`, une projection transactionnelle qui ne contient que
`(companyId, token normalisé, catalogueItemId)`. Sa clé primaire commence par
`(companyId, token)` ; sa FK composite vers le catalogue cascade les suppressions ; un trigger
`SECURITY DEFINER`, sans droit d'exécution runtime ni Data API, remplace les tokens dans la même
transaction qu'un insert ou changement de libellé. Le trigger reste soumis à RLS et exige donc le
contexte tenant réel de l'écriture. La borne token de 1 000 caractères est sourcée depuis le core :
elle couvre les 500 caractères bruts acceptés, y compris une expansion intégrale `œ → oe`; seuls
les tokens plus longs, qu'aucune requête acceptée ne peut adresser, sont omis.

La fonction de trigger appartient après provisioning à un rôle global dédié
`bob_catalogue_search_token_sync`, `NOLOGIN`, `NOBYPASSRLS` et sans héritage. Ce rôle ne reçoit
que les privilèges colonne/table nécessaires pour remplacer les tokens du tenant courant ; il ne
possède ni la table, ni le schéma, ni une adhésion à un rôle privilégié. Le certificat vérifie son
owner exact, son profil, son corps canonique et son comportement sous deux tenants **après** le
split des propriétaires Supabase-like. Une fonction déplacée vers le schema owner `BYPASSRLS`
échoue donc la release au lieu de transformer `row_security=on` en simple décoration.

La recherche tokenisée exige **tous** les tokens distincts de la requête par égalité B-tree
leakproof. La table de projection est elle-même sous `ENABLE` + `FORCE RLS`; le runtime n'obtient
que `SELECT`, et `PUBLIC`, `anon`, `authenticated`, `service_role` n'obtiennent aucun privilège
table, colonne ou fonction. La certification charge une volumétrie multi-tenant puis prouve la clé
tenant-token sous plan par défaut et sous `force_generic_plan`.

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

Le résultat courant est persisté sur le work item :

- avant recherche et pendant un choix présenté : `catalogueResolution='pending'` ;
- zéro résultat ou choix explicite « créer une ligne libre » :
  `catalogueResolution='free'` ;
- choix d'une entrée réelle relue à la bonne révision :
  `catalogueResolution='selected'` avec sa fence.

Le journal conserve la provenance (« zéro résultat » ou « choix libre »), mais il n'est jamais
utilisé comme substitut de l'état courant. Un événement passé ne constitue pas une fence
transactionnelle et ne doit pas être reparcouru pour deviner si une recherche reste due.

Une entrée catalogue complète seulement les faits absents. Le libellé, la catégorie et l'unité
catalogue sont les valeurs proposées de référence. Un prix ou une quantité explicitement dits par
l'utilisateur ne sont jamais écrasés par le catalogue : le diff affiche l'écart. Une contradiction
de catégorie ou d'unité est demandée explicitement au lieu de choisir silencieusement. Les graphies
standards sûres sont comparées après résolution partagée afin qu'un historique `heures` et un
catalogue `heure` ne créent pas une fausse contradiction ; les unités métier distinctes ne sont
jamais fusionnées selon leur seul code légal. Cette résolution appartient à la consommation par
la mission : elle ne réécrit ni les lignes historiques ni la source catalogue lossless. Pour une
ligne libre, le `serviceReference` normalisé par le modèle est une proposition de libellé avec
provenance `user_voice`; il ne devient contenu financier qu'à la confirmation.

## 9. Machine à états M2-A

Phases additives de la cible complète :

```ts
type QuoteCreationMissionPhaseM2A =
  | 'awaiting_lines'
  | 'awaiting_catalogue_choice'
  | 'awaiting_line_details'
  | 'awaiting_line_confirmation';
```

Le train M2-A-1 n'ouvre **que** `awaiting_catalogue_choice`. Les phases
`awaiting_line_details` et `awaiting_line_confirmation`, leurs décisions et leurs handlers sont
introduits atomiquement par M2-A-2. Une phase sans handler de reprise est interdite dans les unions
core, les CHECK SQL et le protocole exposé au client.

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

awaiting_line_details
  ├─ compléter/corriger ──────────────→ nouvelle résolution de la tête
  └─ annuler cette ligne ─────────────→ retire la tête puis awaiting_lines

awaiting_line_confirmation
  ├─ confirmer ───────────────────────→ ajout atomique puis awaiting_lines
  ├─ modifier ────────────────────────→ awaiting_line_details
  └─ annuler cette ligne ─────────────→ retire la tête puis awaiting_lines
```

Un tour peut avancer automatiquement à travers toutes les lectures/résolutions sans décision. Il
s'arrête au premier choix réel, champ obligatoire manquant ou confirmation. Une seule décision est
active à la fois.

### 9.1 Frontière atomique M2-A-1 → M2-A-2

M2-A-1 sait consommer le choix catalogue sans fabriquer une question, une TVA ou une proposition
qui appartiennent à M2-A-2 :

1. il revalide décision, brouillon, tête de file et item catalogue sous les verrous prévus ;
2. il écrit seulement `catalogueResolution` et, pour `selected`, la fence
   `(catalogueItemId, expectedCatalogueRevision)` ; il ne copie encore aucun libellé, prix, unité,
   catégorie ou taux catalogue ;
3. il remet le work item en `queued`, `requiredFact=null`, `proposal*=null` ;
4. il place la mission en `awaiting_lines`, consomme la décision et émet
   `catalogue_choice_selected` ;
5. la continuation M2-A-2 relit ensuite ce work item et reste l'unique propriétaire du merge des
   faits utilisateur/catalogue, des contradictions, de la TVA, des questions et de la
   proposition.

Ce `queued` est une frontière système transitoire, jamais un état présenté comme terminal à
l'utilisateur. Tant que M2-A-2 n'est pas livré, le flag M2-A reste OFF. À l'activation finale, la
commande de choix n'acquitte sa réponse canonique qu'après la continuation jusqu'au prochain état
stable. Cette frontière évite les deux mensonges possibles : inventer un `requiredFact` déjà connu
ou produire une proposition financière incomplète.

## 10. Décisions et proposition scellées

Deux kinds fermés complètent à terme `QuoteMissionDecisionV1`, mais pas dans le même train :

- M2-A-1 introduit uniquement `CatalogueDecisionV1` avec ses transitions complètes ;
- M2-A-2 introduit `LineConfirmationDecisionV1` avec questions, TVA, diff et confirmation.

Il est interdit d'ajouter un kind au payload persistant avant que son parseur, tous ses handlers,
sa reprise et ses preuves de corrélation soient livrés dans le même commit.

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
  /**
   * SHA-256 canonique des faits fiscaux relus à la présentation. La confirmation relit puis
   * compare cette fence même si deux contextes distincts produiraient encore le même taux.
   */
  readonly expectedVatContextDigest: string;
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
brouillon, catalogue éventuel, contexte TVA, proposition, diff et choix ordonnés. Le diff contient
seulement l'ajout proposé par rapport au brouillon relu ; son rendu vocal et visuel provient des
données réelles relues, pas du modèle.

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

La présentation scelle aussi `computeQuoteVatContextDigest` dans
`LineConfirmationDecisionV1`. La confirmation et la reprise froide relisent les faits fiscaux et
comparent cette fence **avant** de déclarer la proposition disponible. Un changement de régime,
métier, type client ou statut de sous-traitance invalide donc la proposition même lorsque son effet
visible resterait provisoirement identique.

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
line_fact_patched
line_details_requested
line_proposal_presented
line_proposal_rejected
line_confirmed
line_cancelled
```

Le contrat de données est fermé et ne porte aucune valeur métier :

| Event | Corrélation | Effet brouillon | Clés après `kind`, dans l'ordre canonique |
|---|---|---|---|
| `line_fact_patched` | user | no-op | `pendingLineId`, `field`, `workRevisionAfter` |
| `line_details_requested` | system + continuation | no-op | `pendingLineId`, `requiredFact`, `workRevisionAfter` |
| `line_proposal_presented` | system + continuation | no-op | `pendingLineId`, `proposalId`, `proposalRevision`, `expectedWorkRevision`, `diffHash`, `choiceSetHash` |
| `line_proposal_rejected` | user | no-op | `pendingLineId`, `proposalId`, `workRevisionAfter`, `choiceId`, `choiceSetHash` |
| `line_confirmed` | user | slot +1, content +1 | `pendingLineId`, `proposalId`, `proposalRevision`, `expectedWorkRevision`, `choiceId`, `choiceSetHash`, `diffHash` |
| `line_cancelled` | user | no-op | `pendingLineId`, `expectedWorkRevision`, `choiceId`, `choiceSetHash` |

`requiredFact` appartient à l'union fermée et peut être JSON `null` uniquement pour l'édition
générique qui demande à l'utilisateur quel champ changer.

`line_cancelled` possède deux formes exactes sans modifier ses clés : depuis une confirmation,
`choiceId` et `choiceSetHash` portent tous deux les valeurs de la décision scellée ; depuis
`awaiting_line_details`, ils valent tous deux JSON `null`, car aucune décision de confirmation
n'existe. Une paire mixte est invalide. Cette seconde forme est introduite par migrations
expand/validate/cutover avec writer N-1 : l'ancienne forme string/string reste acceptée à toutes
les étapes, null/null n'est admise qu'après le cutover, et aucun identifiant n'est fabriqué.

L'annulation en phase détails appelle le use case typé
`CancelQuoteAgentMissionPendingLine`. Dans une unique transaction, il verrouille mission, slot et
tête de file ; compare capability, tenant, owner, `commandId`, `expectedMissionRevision`,
session/slot/content du brouillon, `pendingLineId`, `expectedWorkRevision` et binding de contexte ;
supprime exactement la tête, conserve le brouillon byte-identique, passe la mission à
`awaiting_lines`, ajoute le reçu `line_cancelled` null/null, puis hydrate la tête suivante. Le
rejeu du même `commandId` converge ; une empreinte différente, une tête stale ou un appel
concurrent échoue sans supprimer une autre ligne. La voix et le bouton tactile appellent
strictement ce même use case.

Les données d'événement contiennent seulement identifiants, compteurs, catégories de résultat,
révisions, acteur, `commandId`, HMAC d'empreinte et digests. Elles excluent transcript, libellé,
quantité, unité, prix, TVA, nom client, nom catalogue et arguments d'outil.

`line_fact_patched` porte exactement `pendingLineId`, `field` dans l'union fermée
`QuoteLineRequiredFact` et `workRevisionAfter`. Il constitue le reçu idempotent d'une correction
utilisateur sans recopier sa valeur. Une réponse courte ne peut produire ce reçu que si `field`
égale le `requiredFact` persistant courant ; une correction explicite peut cibler un autre champ,
mais le scope n'est pas recopié dans l'événement. Il reste scellé dans le fingerprint de commande :
un replay avec le même `commandId` et un autre scope est refusé.

Un replay exact relit son reçu et n'écrit rien. Un même `commandId` avec un autre fingerprint est
refusé. Deux confirmations concurrentes ne peuvent produire qu'une ligne.

Si la file contient encore une ligne, l'API dérive ensuite un `commandId` système stable depuis
l'événement `line_confirmed`, puis exécute `continue_quote_line_queue`. Cette commande acquiert sa
propre révision et son propre événement, résout la nouvelle tête et converge jusqu'au prochain
état stable (choix, question, proposition ou file vide). L'API n'annonce pas la fin du tour avant
ce terminal. Un replay relit les deux reçus ; une panne de la continuation ne révoque pas la ligne
déjà confirmée et reste retryable.

Une continuation dérivée hérite exactement de la forme d'autorité de sa commande parente :

- parent vocal : `realtimeSessionId` et contexte appliqué présents, `turnId` absent car le
  `commandId` système est dérivé ;
- parent tactile autonome : les champs session/contexte sont tous null ;
- toute forme partielle ou toute fabrication d'un ancien binding est interdite.

Cette union fermée préserve la parité tactile : une continuation n'exige jamais une session
Realtime inexistante et ne réutilise jamais une session terminée pour donner artificiellement de
l'autorité à un tap.

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
  /**
   * Fence minimale permettant de construire un patch CAS après un GET froid. Nulle sans tête de
   * file ; elle ne contient aucune valeur métier.
   */
  readonly pendingLine:
    | {
        readonly pendingLineId: string;
        readonly expectedWorkRevision: number;
      }
    | null;
  /**
   * Décision scellée exécutable après kill/reconnexion. Le mobile ne reconstruit aucun choix à
   * partir d'un ordinal local et ne reçoit jamais une action libre à transmettre au serveur.
   */
  readonly decision:
    | null
    | {
        readonly kind: 'catalogue';
        readonly decisionId: string;
        readonly choiceSetRevision: number;
        readonly choiceSetHash: string;
        readonly pendingLineId: string;
        readonly expectedDraft: {
          readonly sessionId: string;
          readonly slotRevision: number;
          readonly contentRevision: number;
        };
        readonly expectedWorkRevision: number;
        readonly choices: readonly {
          readonly choiceId: string;
          readonly catalogueItemId: string;
          readonly expectedCatalogueRevision: number;
        }[];
        readonly freeLineChoiceId: string;
      }
    | {
        readonly kind: 'line_confirmation';
        readonly decisionId: string;
        readonly choiceSetRevision: number;
        readonly choiceSetHash: string;
        readonly pendingLineId: string;
        readonly proposalId: string;
        readonly proposalRevision: 1;
        readonly expectedDraft: {
          readonly sessionId: string;
          readonly slotRevision: number;
          readonly contentRevision: number;
        };
        readonly expectedWorkRevision: number;
        readonly expectedCatalogue:
          | { readonly itemId: string; readonly revision: number }
          | null;
        readonly expectedVatContextDigest: string;
        readonly diffHash: string;
        readonly choices: readonly [
          { readonly choiceId: string; readonly action: 'confirm_line' },
          { readonly choiceId: string; readonly action: 'edit_line' },
          { readonly choiceId: string; readonly action: 'cancel_line' },
        ];
      };
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
  readonly proposalStatus:
    | { readonly kind: 'absent' }
    | { readonly kind: 'available' }
    | {
        readonly kind: 'stale';
        readonly reason: 'catalogue_changed' | 'vat_context_changed';
      };
  readonly proposal: {
    readonly proposalId: string;
    readonly diffHash: string;
    /**
     * Projection autoritaire calculée dans le même snapshot que la proposition. Le mobile ne
     * recalcule jamais cet avant/après depuis son state local.
     */
    readonly diff: {
      readonly kind: 'append_line';
      readonly before: {
        readonly contentRevision: number;
        readonly lineCount: number;
        readonly totalHtCents: number;
      };
      readonly after: {
        readonly contentRevision: number;
        readonly lineCount: number;
        readonly totalHtCents: number;
      };
    };
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

`proposalStatus.kind='available'` implique une proposition non nulle redérivée avec un `diffHash`
identique aux fences mission + work. `absent` implique `proposal=null`. Une évolution externe du
catalogue ou du contexte TVA produit `stale` avec `proposal=null` ; une incohérence interne entre
mission, work item et brouillon est une indisponibilité, jamais un état vide.

La reprise V1 historique reste byte-pour-byte `{ mission }`. La reprise M2-A utilise le même GET
avec `X-Bob-Agent-Mission-Protocol-Version: 2` et retourne une enveloppe V2 distincte contenant la
mission **réduite `ResumableQuoteAgentMissionView` déjà publiée par V1** et cette présentation.
Elle n'expose donc ni payload persistant complet, ni binding Realtime, ni staged IDs, ni
timestamps internes supplémentaires. L'absence du header signifie V1. La réponse porte
`Vary: Authorization, X-Bob-Agent-Mission-Protocol-Version`. Aucun codec V1 n'accepte les champs ou
phases M2-A.

La présentation V2 est construite dans une transaction `REPEATABLE READ READ ONLY` dédiée. Ses
ports de lecture work/catalogue/TVA n'utilisent ni `FOR UPDATE` ni `FOR SHARE`; ils appliquent les
GUC tenant + owner et la RLS forcée dans le même snapshot. Le protocole attendu est fourni
explicitement à l'UoW : aucun fallback silencieux V2 vers V1 n'est autorisé.

Les réponses de commande V2 qui peuvent déclencher la continuation — ACK écran et décision client
compris — portent elles aussi une `presentation` fraîche, relue après le commit et liée exactement
à la mission finale renvoyée. Les codecs V2 refusent une nouvelle phase sans cette projection. Les
réponses V1 conservent strictement leur forme historique, sans champ additif : un même endpoint a
donc deux contrats exacts négociés par la capability, jamais une enveloppe ambiguë.

Le mobile :

- réhydrate la file, la décision et la proposition depuis l'API ;
- affiche les candidats réels dans l'ordre scellé ;
- ouvre une seule sheet à la fois ;
- rend le diff label/quantité/unité/prix/TVA, l'origine catalogue et l'impact autoritaire
  `avant/après` sur le nombre de lignes et le total HT ;
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
   `NOT VALID` — uniquement `awaiting_catalogue_choice`, `CatalogueDecisionV1` et les événements
   catalogue de ce train — ajout expand-safe de
   `catalogueResolution TEXT NOT NULL DEFAULT 'pending'` et élargissement de la cohérence
   `queued`, ajout de `agent_missions.protocolVersion SMALLINT NOT NULL DEFAULT 1` avec CHECK
   fermé `1|2` et trigger d'immuabilité, sans retirer les contraintes actives ; correction
   append-only de l'ordinal en INT4 monotone, provenance immuable, parent protocole `2`, révision
   catalogue `old+1`, ACL Data API catalogue fermées et projection de tokens tenantée, synchronisée
   atomiquement et indexée par égalité sous FORCE RLS ;
3. **validate** : validation séparée ;
4. **cutover** : flag OFF, writers N-1 drainés, remplacement atomique des anciennes contraintes ;
5. déploiement writer N ;
6. activation bornée sur compte interne seulement ;
7. preuve puis retrait de l'override en cas d'échec.

M2-A-2 ouvre un nouveau train expand/validate/cutover, sans réécrire M2-A-1 :

- expand additif des deux preuves d'override `BOOLEAN NOT NULL DEFAULT false`, des phases
  `awaiting_line_details|awaiting_line_confirmation`, de la décision `line_confirmation` et des
  événements ligne ;
- nouvelle cohérence d'état `NOT VALID` qui autorise explicitement
  `awaiting_details + requiredFact=null` pour l'édition générique ;
- validation dans une migration séparée, puis cutover seulement après les preuves writer N-1 et
  runtime N.

Chaque migration commence par `SET LOCAL lock_timeout` et `statement_timeout`. Les générateurs
lisent les constantes TypeScript du train qu'ils créent, mais le SQL et les octets de vérification
d'un train déjà publié sont ensuite immuables. Avant d'étendre les unions vivantes pour M2-A-2, le
générateur M2-A-1 fige et vérifie ses snapshots phases/kinds/events ; M2-A-2 possède son propre
générateur et ne régénère jamais une migration M2-A-1. Un test writer N-1 insère la forme exacte
historique :

- après expand ;
- après validate ;
- après cutover ;
- sous rôle non-superuser avec FORCE RLS.

**Fermeture explicite du writer dormant M2-A-0.** Le trigger final des work items exige un parent
en protocole `2`; il est donc impossible de préserver en parallèle un writer work-item M2-A-0
attaché à une mission V1. Ce n'est pas présenté comme une simple correction : M2-A-1 ferme ce
writer non activé, exige la table `agent_mission_quote_line_work` vide avant l'expand et refuse la
migration avec une erreur nommée si une ligne existe. Impact produit : aucun, puisque le flag M2-A
est resté OFF et aucun client publié ne possède cette capacité. Repli : réconcilier explicitement
les lignes de test ou abandonner leur mission avant de rejouer la migration; aucun backfill
sémantique ni suppression automatique n'est autorisé. La compatibilité writer N-1 prouvée
ci-dessus porte donc sur les surfaces réellement actives — mission, événement, lease, reçu et
catalogue — et non sur ce writer dormant fermé.

Le test couvre aussi un **reader N-1** : GET puis décodage du `QuoteDraftPayloadV1` exact avant,
pendant et après M2-A. Le slot ne contient aucun work item, donc un ancien client continue à le
lire. Il ne reçoit jamais une capability M2-A et ne peut pas ouvrir la mission en écriture.
Le writer N-1 omet `protocolVersion` et obtient donc exactement `1` par défaut ; une tentative de
modifier cette colonne après insertion est refusée. Les phases M2-A et leurs événements exigent
`protocolVersion=2` dans les contraintes SQL finales.

**Budget de connexions des certificats staging.** Une preuve de concurrence vérifie un invariant
de possession ; ce n'est pas un test de charge et elle exige au minimum deux connexions
indépendantes. Le certificat d'archive conserve huit workers par défaut sur PostgreSQL isolé, mais
le rituel Supabase staging en impose exactement quatre : le pool session-mode observé est partagé
avec l'unique réplique API et limité à quinze clients. La valeur de test est une décimale canonique
bornée `2..8`; toute autre forme échoue fermée avant connexion. Les deux appels predeploy et
postdeploy doivent porter le même budget explicite. Un dépassement `EMAXCONNSESSION` n'est jamais
converti en succès ni masqué par un retry global.

### 15.1 Trains de livraison — une seule PR active à la fois

| Train | Résultat atomique | Statut actuel | Promotion maximale du train |
|---|---|---|---|
| M2-A-0 | schéma work items + RLS + contrat core + parité catalogue SQL | `implemented` | `implemented` |
| M2-A-1 | frame V2, staging initial, recherche 0/1/N, continuation et choix API | `implemented` | `implemented` |
| M2-A-2 | questions persistées, TVA, proposition, primitive partagée et confirmation | `implemented` | `implemented` |
| M2-A-3 | projection mobile, parité voix/tap, reprise et certification device/staging | `implemented` dans `1a2e5eaa` | `certified` |

Chaque PR est fusionnée et sa CI verte avant d'ouvrir la suivante. Aucun sous-train n'est présenté
comme une fonctionnalité finie ; le flag reste OFF jusqu'à M2-A-3.

**Bloquant explicite M2-A-3 — convergence après coupure.** Le GET V2 de M2-A-2 est strictement
`READ ONLY` : il restitue honnêtement une tête `queued`, mais ne prétend pas la faire avancer.
M2-A-3 doit livrer un seul mécanisme de reprise autoritaire — rejeu durable de la commande initiale
ou commande serveur idempotente dédiée — puis prouver par un test de coupure entre le commit
utilisateur et la continuation que la file converge sans doublon. Aucun consumer mobile ne peut
présenter `queued` comme « repris » avant cette preuve.

**Frontière explicite M2-A-2 → M2-A-3 — voix Realtime.** M2-A-2 livre les primitives, endpoints,
wrappers voix et projections autoritaires, mais le moteur sémantique sideband reste volontairement
sur la matrice M2-A-1 tant que le mobile publié négocie V1. M2-A-3 doit étendre atomiquement le
schéma d'outil, son parseur, `requiredFact`, les phases de l'orchestrateur et son gateway pour
`patch_pending_line`, confirmer, modifier et annuler. Chaque opération doit appeler les wrappers
M2-A-2 existants avec les fences de la présentation fraîche et être prouvée jusqu'à la persistence.
Avant ce train, aucune documentation ne peut annoncer que ces opérations A2 sont atteignables à la
voix ; après ce train, aucun wrapper voix sans appel réel n'est admissible.

### 15.1.1 Contrat d'exécution figé pour M2-A-3

M2-A-3 ne crée ni endpoint métier parallèle, ni store de proposition, ni registre d'outils GPT.
Il raccorde les surfaces déjà publiées selon les règles binaires suivantes.

**Négociation et autorité uniques.**

- le transport GPT/OpenAI WebRTC demande explicitement le protocole AgentMission `2` ; une réponse
  `null/null`, une capability V1 ou une capability mal formée n'est jamais rétrogradée en V1 ;
- le transport Mistral reste sur son contrat historique V1 et hors M2-A conformément au §3.2 :
  aucune requête, clé ou reprise Mistral n'est autorisée dans une session OpenAI ;
- le runtime mobile sait conserver les handles V1 N-1 sans modifier leur wire, mais seule une
  capability V2 peut rendre ou muter une phase M2-A ;
- le GET capability V1 conserve exactement `{ mission }`. Le GET capability V2 rend exactement
  `{ mission, presentation }`, avec une présentation fraîche liée aux mêmes mission, phase,
  révision et brouillon ; une divergence ferme la lecture.

**Reprise autoritaire, sans second consumer.**

- le GET JWT V2 reste strictement `READ ONLY` et restitue honnêtement une tête `queued` ;
- après un kill, l'utilisateur déclenche explicitement « Reprendre ». Le mobile négocie une
  nouvelle capability V2, publie le contexte courant puis émet le même ACK d'écran scellé que le
  chemin chaud ;
- cet ACK augmente la révision, remplace le binding de contexte et devient l'unique parent durable
  de continuation. `acknowledgeScreen` appelle la continuation existante pour toute phase M2-A
  active dont la tête doit converger, pas seulement `awaiting_lines` ;
- la continuation relit mission, brouillon et work item sous leurs verrous puis dérive ses
  commandIds système depuis l'ACK. Un ACK rejoué, deux reprises concurrentes ou une réponse HTTP
  perdue convergent sans deuxième événement métier ni deuxième ligne ;
- aucun nouveau scan d'événements, scheduler, worker mobile ou mutation cachée dans un GET n'est
  introduit.

**Compréhension et mutation Realtime.**

- la frame sémantique reste un unique outil fermé, une opération maximum, 20 lignes et 32 KiB ;
- elle ajoute `patch_pending_line`, `confirm_current_proposal`,
  `reject_current_proposal` et `cancel_current_line`, ainsi que les phases
  `awaiting_line_details` et `awaiting_line_confirmation` ;
- `answer_required_fact` n'est valide que si la présentation persistée porte un `requiredFact`
  non nul et si le champ du patch lui est exactement égal. Une correction spontanée utilise
  `explicit_correction` ; après « modifier », une réponse courte sans champ est refusée ;
- le sideband relit une seconde fois la projection V2 après le modèle. Toute variation de mission,
  brouillon, work revision, décision, choix, proposition, catalogue ou diff empêche la mutation ;
- la lecture interne du planner, absente de tout controller et de tout wire mobile, projette depuis
  le même snapshot transactionnel les faits déjà acceptés de la tête durable
  (`serviceReference`, catégorie, quantité, unité, prix, TVA et faits fiscaux). Cette projection
  est liée à `pendingLineId + expectedWorkRevision`, comparée à la présentation publique puis
  convertie en valeurs bornées sans identifiant d'autorité avant le LLM. Une phase M2-A avec un
  brouillon dont `step !== lignes` échoue fermée dans le core et dans le décodeur client ;
- les quatre opérations appellent exclusivement `patchLineFromVoiceTurn`,
  `decideLineProposalFromVoiceTurn` ou `cancelPendingLineFromVoiceTurn` avec les fences de cette
  seconde lecture. Le `turnId` reste l'unique `commandId` voix ;
- une intention M2-A reconnue ne traverse jamais `askBob`, le parseur regex du wizard ni un outil
  GPT fournisseur.

**Projection mobile et parité.**

- la reprise V2 hydrate mission, brouillon, choix réels et `presentation` sans parler ni naviguer
  automatiquement ;
- une seule surface mission rend successivement catalogue, fait manquant et proposition. Les taps
  et la voix envoient les mêmes `choiceId`, `proposalId`, révisions et hashes ;
- `awaiting_lines` maintient Bob et la mission ouverts ; il ne déclenche plus le handoff manuel ;
- tant que la mission possède le slot, tous les writers legacy du wizard et ses affordances regex
  restent inertes. « Arrêter Bob », « annuler cette ligne » et « abandonner la mission » demeurent
  trois gestes distincts ;
- un seul chrome Bob et une seule sheet peuvent être montés ; les états chargement, erreur,
  données et indisponibilité sont i18n, accessibles et compatibles `reduce-motion`.

**Frontière acoustique honnête.** M2-A reste, conformément au §3.2, sur
`audited-signed-url-v1`. Son raccord métier peut atteindre `implemented` avec les preuves
logicielles et staging ci-dessus, mais la promotion globale `certified` du §18 reste interdite tant
que le train acoustique OpenAI hybride n'a pas prouvé sur appareils réels micro simultané, AEC,
silence local au barge-in et reprise du nouveau tour. Un événement `user_speaking` synthétique, un
tap qui ferme la session ou un micro coupé pendant le playback ne constitue jamais cette preuve.

### 15.2 Preuves du train M2-A-0

Le commit `4c844111` porte la spec et l'implémentation atomique. Les preuves locales
reproductibles du 29 juillet 2026 sont :

- certificat PostgreSQL 17 complet sous déployeur/runtime non-superuser : exit `0`, tests Prisma
  `53/53` ;
- writer et reader `QuoteDraftPayloadV1` N-1 avant expand, après expand, après validate et après
  cutover ;
- RLS owner et cross-tenant, capability mission, parent terminal/cross-kind, cascade, savepoint,
  CAS et ACL/Data API réels ;
- suite `@bob/core` complète : `2 809/2 809` ;
- contrats migrations/release : `40/40` ;
- tests API ciblés : `26/26` ;
- typechecks et lint core/API, générateur `--check`, builds core/AI/API et gardes d'artefact verts ;
- trois reviews adversariales en lecture seule : aucun P0/P1 ouvert.

Ces preuves donnent à M2-A-0 le statut `implemented`, pas `certified`. La certification Supabase
staging exact-SHA et les preuves produit voix/toucher/appareil restent dues dans les trains
suivants ; aucune capacité M2-A n'est activée en public par ce commit.

### 15.3 Preuves du train M2-A-1

Les preuves locales reproductibles du 30 juillet 2026 sont :

- suites complètes : core `2 887/2 887`, AI `871/871`, client API `474/474`, API
  `2 726/2 726` avec `371` certificats opt-in ignorés hors contexte ;
- contrats de release : `527/527`, un scénario explicitement ignoré ; générateurs M2-A-1,
  fondation M2-A et historique tous en mode `--check` ;
- certificat AgentMission PostgreSQL 17 sous déployeur/runtime non-superuser : `56/56`, avec
  writer et reader N-1, RLS/anti-IDOR, replay, concurrence voix/tap et plan catalogue tenanté ;
- reproduction Supabase locale isolée : `154` migrations, release predeploy puis postdeploy,
  transfert d'ownership, second rejeu de `rls.sql`, autorité trigger
  `NOLOGIN`/`NOBYPASSRLS`, et preuve réelle deux tenants terminée par
  `RLS owner-split replay certified with a non-superuser deployer` ;
- typecheck et lint des quatre couches modifiées ainsi que du monorepo, builds topologiques et
  gardes d'artefact core/AI/client/API verts ;
- trois reviews adversariales correctness/DoD, architecture/parité et sécurité/release :
  aucun P0/P1 ouvert après correction du rejeu owner-aware ;
- master `BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED=false`, release flag et tous ses sujets
  exactement OFF.

Ces preuves donnent à M2-A-1 le statut `implemented`, pas `certified`. Le mobile publié continue
à négocier V1 et aucune capacité M2-A n'est exposée. La certification staging exact-SHA, la
projection voix/toucher et la preuve appareil restent dues à M2-A-3.

### 15.4 Preuves du train M2-A-2

Les preuves locales reproductibles du 30 juillet 2026 sont :

- suites complètes : core `3 008/3 008`, client API `490/490`, API `2 749/2 749`, avec
  `371` certificats opt-in ignorés hors contexte ;
- contrats de release API : `534/534`, un scénario explicitement ignoré ;
- certificat AgentMission PostgreSQL 17 sous déployeur/runtime non-superuser : `56/56`, avec
  writer et reader N-1 après expand, validate et cutover, FORCE RLS, anti-IDOR, CAS et reprise V2 ;
- générateurs M2-A-1 figé et M2-A-2 en mode `--check`, migrations
  expand/validate/cutover et `git diff --check` verts ;
- typechecks et lint core/client/API, typecheck monorepo `17/17`, builds topologiques et gardes
  d'artefact core/client/API verts ;
- deux reviews adversariales indépendantes correctness et architecture/parité : aucun P0/P1
  ouvert après correction de la reprise d'une tête `queued` dans les phases préparatoires et de
  la projection V2 fraîche après ACK ou décision ;
- master `BOB_AGENT_MISSIONS_QUOTE_M2A_ENABLED=false`, release flag et tous ses sujets
  exactement OFF.

Ces preuves donnent à M2-A-2 le statut `implemented`, pas `certified`. Le mobile publié continue
à négocier V1 et les commandes sémantiques Realtime de patch, confirmation, édition et annulation
ne sont pas encore raccordées. Leur raccord voix/toucher, la convergence après coupure, la
certification Supabase staging exact-SHA et la preuve appareil restent dues à M2-A-3.

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

### 17.0 Gate du train M2-A-1

M2-A-1 est `implemented` uniquement si, flag M2-A toujours OFF :

- [x] le serveur négocie V1 et V2 sans fallback, une capability V1 ne peut ni lire ni muter une
      phase M2-A et le mobile courant continue à demander V1 ;
- [x] le protocole de la mission est persisté, immuable et doit correspondre à celui de la lease ;
      V1→mission V2 et V2→mission V1 échouent avant lecture du payload ou des work items ;
- [x] la frame V2 est fermée à chaque profondeur, bornée à une opération, 20 lignes et 32 KiB, sans
      historique textuel Bob ni donnée catalogue/client projetée vers le LLM ;
- [x] les décimaux sont convertis par arithmétique exacte de chaînes/entiers ; aucune conversion
      flottante, troncature d'unité ou multiplication/arrondi caché ;
- [x] `start`, résolution client et choix ordinal stagent toutes les lignes normalisées ordonnées
      dans la même UoW que leur événement utilisateur, avec un fingerprint unique et un replay
      sans second insert ;
- [x] la recherche catalogue 0/1/2..5/≥6 est tenantée, stable, limitée à six lectures, verrouille
      les lignes présentées et prouve son plan à volumétrie multi-tenant ;
- [x] une décision catalogue scelle draft, tête de file, work revision, candidats et révisions ;
      voix et API choisissent le même `choiceId` ;
- [x] zéro résultat/ligne libre écrit `catalogueResolution='free'`, un item réel relu écrit
      `selected`, puis la frontière retourne `queued` sans copier de valeur catalogue et sans
      créer de `requiredFact`, TVA, diff ou proposition ;
- [x] annulation et expiration suppriment tous les work items dans leur transaction ; les writers
      actifs et readers N-1 restent valides après expand, validate et cutover, tandis que le
      writer work-item dormant est refusé explicitement comme documenté en §15 ;
- [x] la file accepte au plus 20 items présents mais conserve un ordinal monotone après suppression
      de tête ; `origin` est immuable et aucun work item ne peut appartenir à une mission V1 ;
- [x] toute mutation réelle d'un item catalogue force `revision = old + 1`, ses ACL table **et
      colonnes** sont fermées à `PUBLIC`, `anon`, `authenticated`, `service_role`; sa projection
      de tokens est transactionnelle, sous FORCE RLS et sans droit de mutation runtime ; son
      trigger appartient à un rôle `NOLOGIN`/`NOBYPASSRLS` aux ACL minimales, certifié après
      owner-split sur deux tenants, et la recherche token utilise sa clé tenantée certifiée sous
      plan générique comme sous plan par défaut ;
- [x] une continuation système issue d'une voix conserve session+contexte sans `turnId`; une
      continuation issue d'un tap autonome conserve une corrélation entièrement nulle ;
- [x] les contraintes M1-C historiques restent byte-for-byte inchangées et sont figées avant que
      le générateur M2-A-1 soit introduit ;
- [x] core, AI, API, client, migrations, PostgreSQL réel, RLS/anti-IDOR, typecheck, lint, build et
      reviews adversariales sont verts depuis un checkout propre.

### Compréhension et contexte

- [ ] la phrase canonique Camping conserve client + ligne après navigation ;
- [ ] en phase client, « Camping Les Pins » puis « le deuxième » conservent exactement le
      comportement M1-C tout en préservant les lignes staged ;
- [ ] « Camping Les Pins, et ajoute deux heures à 55 € » sélectionne le client et stage la ligne
      dans une seule transaction ; « le deuxième, puis ajoute deux heures à 55 € » sélectionne
      seulement le choix, ne recopie aucune ligne du contexte et poursuit la demande dans la même
      session sans mutation silencieuse ;
- [ ] `400 balles par machine`, quantité `3` et unité `machine` deviennent 40 000 centimes,
      quantité millième `3000`, sans total calculé par le LLM ;
- [ ] `heure`, `heures`, `h` et `1 h` persistent `heure` et ne déclenchent pas d'arbitrage face à
      un catalogue `heure`; une unité absente, `jour`, `unité` ou `pièce` distincte reste refusée
      ou explicitement arbitrée selon la phase ;
- [ ] « Contrat 4 saisons » ne fabrique ni quantité ni date ;
- [ ] « non, 450 et pas 400 » corrige seulement la proposition courante ;
- [ ] « modifie la ligne » revient aux détails alors que « annule cette ligne » retire seulement
      la tête ; aucune des deux formulations ne peut être confondue par le protocole ;
- [ ] frame invalide, multiple ou hors phase : zéro écriture et clarification.
- [ ] après kill, une réponse courte n'est acceptée que pour le `requiredFact` persisté.
- [ ] après kill, un arbitrage explicite de catégorie ou d'unité différent du catalogue reste
      acquis et ne déclenche pas une seconde demande identique.

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
- [ ] un GET froid restitue `pendingLineId + expectedWorkRevision` et permet le même patch CAS
      qu'une session restée ouverte ;
- [ ] confirmation concurrente : une seule ligne ;
- [ ] réponse HTTP perdue : replay sans seconde ligne ;
- [ ] ancien choix/proposal/révision : refus sans mutation ;
- [ ] patch exact rejoué : aucun second événement ni seconde révision ; même `commandId` avec une
      autre valeur échoue par fingerprint ;
- [ ] même patch et même `commandId` avec un scope réponse/correction différent échoue fermé ;
- [ ] RLS et anti-IDOR sur client, catalogue, mission et brouillon.
- [ ] aucun work item n'est mutable sans le setting de mission courante validé.

### Reprise et UX

- [ ] kill/relaunch à chaque nouvelle phase restitue l'état exact sans parole automatique ;
- [ ] la session reste ouverte après ajout et accepte une ligne suivante ;
- [ ] le mobile rend chargement/vide/erreur/données, i18n, accessibilité et `reduce-motion` ;
- [ ] aucune sheet concurrente et aucun tap sec ne confirme une action financière.

### Non-régression

- [ ] M1-C client, reprise et ACK restent verts ;
- [ ] writer N-1 des surfaces actives reste valide après chaque étape SQL et la tentative de
      migrer avec un work item M2-A0 existant refuse tout le train sans mutation ;
- [ ] reader N-1 relit le même `QuoteDraftPayloadV1` pendant toute la mission ;
- [ ] wizard manuel hors mission reste fonctionnel ;
- [ ] aucune intention devis ne traverse simultanément AgentMission et le parseur regex local.

### 17.1 Gate spécifique du train M2-A-3

**Protocole Supabase staging exact-SHA.** `M2A3-12` est certifié par un workflow manuel
`AgentMission M2-A-3 Supabase Staging Schema`, routé avant merge par le purpose
`m2a3-staging-schema` de `Railway API Release`. Il est distinct de toute release et de tout
déploiement Railway. Son input
`expected_sha` doit être identique à `github.sha` et au checkout avant la première opération.
Le gate réépingle le projet, le cluster, l'OID, la base, le déployeur Supabase non-superuser
`BYPASSRLS` et le rôle runtime non-superuser `NOBYPASSRLS`, puis exige que le suffixe pending soit
strictement les trois migrations M2-A-3.

Les migrations sont appliquées par `prisma migrate deploy`, une seule à la fois, depuis une vue
Prisma temporaire sans symlink contenant tous les historiques et uniquement le suffixe jusqu'à
l'étape courante. La machine à états est fermée :

| État | Historique Prisma M2-A-3 | Schéma attendu |
|---|---|---|
| `S0` | aucun | ancien CHECK canonique validé |
| `S1` | expand | ancien CHECK validé + nouveau CHECK `NOT VALID` |
| `S2` | expand + validate | les deux CHECK validés |
| `S3` | expand + validate + cutover | nouveau CHECK canonique, ancien absent |

La lignée Prisma est elle aussi une machine fermée : aucune tentative d'une phase future n'est
admise, les phases restent monotones dans `started_at`, chaque tentative d'une phase dépendante
est strictement postérieure au record actif de sa phase prérequise, et une phase possède au plus
une tête active ou non résolue, strictement postérieure à ses retries `rolled_back`. Dans chaque
phase ayant des retries, le maximum `started_at` des lignes `rolled_back` est unique : deux maxima
ex æquo rendent le rattachement causal d'un ACK impossible et invalident toute phase dépendante,
même si une tête active plus récente existe.

Chaque job applique ou recertifie exactement son état, écrit immédiatement un reçu non-PII et
chaîne son digest au suivant. Le reçu sépare le hash de la définition PostgreSQL du CHECK — qui
change légitimement entre `NOT VALID` et validé — du hash sémantique stable de son expression
`pg_get_expr`. Une recertification `S2` doit donc dériver du CHECK étendu prouvé en `S1`, et une
recertification `S3` doit prouver que ce même CHECK étendu a été promu en canonique. Un état hors
ordre, une régression de tentative/chronologie, une migration Prisma incomplète, un checksum ou
CHECK sémantique divergent, une autre migration pending, un `migrate resolve` hors du planner de
reprise exact ci-dessous, `db push`, une mutation de variable, un `railway up` ou un appel au
rituel global de release échoue fermé.

**Recertification d'un train déjà finalisé.** Un nouveau SHA qui ne modifie pas ces migrations
doit pouvoir relier son code exact au schéma staging déjà en `S3`, sans prétendre rejouer les états
historiques `S1` et `S2`. Ce chemin n'est autorisé que si les trois migrations locales exactes ont
chacune une tête active terminale, dans l'ordre, avec leurs checksums committés, sans tentative non
résolue ni migration étrangère pending. Les trois jobs relisent alors le même état final `S3`,
chacun sous l'identité de sa migration, et opèrent tous en `recertify` : aucune commande Prisma de
mutation n'est appelée. Le manifest v2 porte explicitement
`certificationMode=finalized-recertification`; les nombres appliqué/pending, le digest de
l'historique, les empreintes CHECK, l'autorité, les ACL et les flags OFF doivent rester identiques
sur les six reçus. Un préfixe seulement partiel, une tentative future sans train entièrement
terminal, une chronologie descendante, un retry postérieur à sa tête, un checksum divergent ou la
moindre mutation entre deux lectures échoue fermé. Le mode historique normal reste
`transition-train` et conserve les preuves contiguës `S0→S1→S2→S3`.

Les empreintes `S0..S3` ne sont jamais des constantes recopiées ni une simple reconnaissance de
forme. Avant toute mutation, l'opérateur extrait les clauses CHECK exactes des migrations M2-A-2
et M2-A-3 commitées, les compile dans une table `pg_temp` sur **le même PostgreSQL cible**, puis
relit leur représentation canonique via `pg_get_expr`. Il compare alors type de contrainte,
`NO INHERIT`, validation, hash de définition et hash d'expression de chaque CHECK live à cet
oracle dérivé. Un CHECK de même nom mais de sémantique différente échoue donc avant tout
`migrate resolve` ou `migrate deploy`.

Après chaque état, la preuve relit les définitions CHECK réelles, FORCE RLS, propriétaires, ACL et
fermeture Data API, puis vérifie que les flags M2-A sont exactement OFF sans subject activé. Le
staging peut aussi fermer le writer par le keyring fingerprint. Dans ce cas, le reçu porte
explicitement `runtimeWriterOutcome=disabled-fence` : il est interdit d'annoncer un insert réel
accepté. La matrice `sealed/null_pair/mixed_id_null/mixed_null_hash` est alors rejouée sous le vrai
rôle runtime dans une table temporaire construite depuis les CHECK live et détruite par rollback.
Ce gate ne crée aucune clé, n'ouvre aucun flag, ne déploie aucun binaire et ne touche jamais la
production ; le rollback d'un schéma additif déjà commité est exclusivement roll-forward.

**Reprise opérateur.** Utiliser uniquement **Re-run failed jobs** sur le même run. Si la migration
est déjà terminale, la phase recertifie sans la réappliquer. Si Prisma porte exactement une
tentative non résolue sur la migration cible, le gate compare le checksum et l'identité de la
tentative. Cette tentative doit être la dernière tentative cible selon `started_at` : toute sœur
postérieure ou ex æquo rend la causalité ambiguë et échoue fermé. Le gate prouve ensuite le schéma
réel : `S(n)` autorise uniquement
`migrate resolve --rolled-back` avant réapplication ; `S(n+1)` autorise uniquement
`migrate resolve --applied` avant recertification. Toute autre forme, migration ou état échoue
fermé.

**Perte du control plane Railway avant exécution.** Le CLI Railway reste épinglé à une version et
un digest immuables. Pour cette version, `railway run` relit d'abord projet, environnement, service
et variables, puis seulement démarre le processus enfant. Le wrapper M2-A-3 peut donc rejouer au
plus trois fois **uniquement** les erreurs Railway exactes et documentées de décodage/réponse du
control plane, à condition que la tentative n'ait émis aucun octet sur stdout **et** qu'un lanceur
isolé n'ait pas encore créé atomiquement son marqueur `child-started` juste avant de démarrer le
vrai processus. La classification porte sur la totalité d'un stderr borné, jamais sur une
sous-chaîne.
L'allowlist est sourcée par les runs `30626014174` (`Problem processing request`) et
`30626237262`, tentative 2 (enveloppe de décodage à cinq lignes), exécutés avec le binaire Railway
`5.26.0` épinglé et vérifié par digest ; toute variation de version ou de forme est inconnue et
échoue fermée.
Les attentes sont bornées et croissantes. Une sortie stdout, une autre classe d'erreur, un marqueur,
un signal, un reçu présent ou l'épuisement du budget échoue immédiatement et conserve un diagnostic
borné ; aucune erreur Prisma, Supabase, modèle ou processus enfant n'est rejouée. Cette reprise
pré-exécution ne constitue ni un second appel modèle ni un retry métier. Les workflows schéma et
évaluation sémantique utilisent le même wrapper et ses tests exécutables ; le workflow conserve le
même SHA, le même run, le même `run_attempt` et le même digest de phase. À épuisement, une preuve
JSON à forme fermée atteste la classe Railway, le nombre de tentatives et
`childStarted=false` ; elle est validée avant archivage.

Le superviseur unique possède toute terminaison du groupe de processus Railway, qui contient le
lanceur et l'opérateur. Sur interruption, il envoie le signal une seule fois au groupe. Sur toute
sortie directe de Railway — succès, erreur ou signal — il vérifie que le groupe est vide et termine
les descendants résiduels. Il attend une grâce bornée de deux secondes, escalade le groupe entier
en `SIGKILL` si un descendant résiste, puis attend encore deux secondes la disparition du groupe
avant de rendre le statut initial. Tout signal spontané est rendu comme `128 + signal` ou comme
l'erreur technique 70 si son identité n'est pas reconnue : jamais comme le statut 1 rejouable. Une
quiescence non prouvée devient également une erreur technique 70, jamais une sortie faussement
acquittée.

L'inventaire relu immédiatement après `resolve` devient la base append-only de l'opération. Une
réapplication doit préserver byte-for-byte toutes ses lignes et ajouter exactement une tentative
cible terminale `applied_steps_count=1`, strictement postérieure à tout le préfixe. Une
recertification doit laisser l'inventaire strictement identique. Toute substitution, suppression,
seconde ligne ou transformation `rolled_back ↔ applied` échoue avant le reçu certifié.

Avant tout `migrate resolve`, l'opérateur écrit en mode `0600`, puis `fsync` fichier + répertoire,
un intent v3 non-PII. Son digest logique lie SHA, pin base, phase, migration/checksum, action,
tentative, préfixe immuable de l'historique et oracle sémantique ; son bloc de provenance porte
run, attempt, instant et hashes live sans modifier cette identité logique. Si le processus tombe
après `migrate resolve` mais avant le reçu, la lignée terminale Prisma doit permettre de
reconstruire **le même** intent logique : les retries historiques `rolled_back` restent dans le
préfixe immuable, la dernière tentative antérieure au record actif éventuel est la tentative
récupérée, toute chronologie ou cardinalité ambiguë échoue fermé, et aucun second `resolve` n'est
exécuté. Les reçus
preflight puis certified v3 chaînent cet intent logique et leurs digests d'historique ; le manifest
final relit l'intent, recalcule son digest et vérifie toute la chaîne.

Un diagnostic Prisma reste borné à sa classe (`P3009`, `P3018`, lock/statement timeout, SQL), sans
SQL, URL ni donnée tenant. Ce comportement est certifié avec Prisma 6.19.3 sur PostgreSQL réel,
sous un propriétaire de base `NOSUPERUSER/NOCREATEROLE/NOBYPASSRLS`, par deux interruptions
réelles : échec transactionnel avant `COMMIT`, puis coupure du processus Prisma après `COMMIT`
visible et avant son ACK. Le premier cas impose `--rolled-back` puis un retry au même checksum ;
le second impose `--applied`, puis prouve qu'un nouveau deploy est un no-op et que l'effet n'a pas
été rejoué. Aucun `DROP`, `UPDATE _prisma_migrations` ni superuser ne peut fabriquer l'incident ou
la résolution ; le superuser de harnais ne sert qu'au bootstrap, à l'injection de la coupure et au
teardown.

Tout `migrate resolve` manuel ou générique reste interdit ; une incohérence hors de ces deux états
se corrige par un nouveau train roll-forward revu. Ne pas lancer **Re-run all jobs** ni un nouveau
dispatch lorsque le train est seulement en `S1` ou `S2` : `expand` refuse volontairement ce préfixe
futur incomplet et seule la reprise des jobs du run courant est admise. Un nouveau dispatch devient
licite uniquement lorsque le train est exactement terminal en `S3` et prend alors le chemin
`finalized-recertification` intégralement non mutant décrit plus haut. Les noms d'artefacts incluent
phase et `run_attempt`, et le manifest final télécharge les trois noms exacts avant de chaîner
intents et reçus preflight/certified.

- [x] `M2A3-01` : OpenAI WebRTC demande exactement le protocole 2 ; absence/refus de capability
      échoue fermé sans tentative V1 et sans requête Mistral ;
- [x] `M2A3-02` : le GET V1 conserve son wire exact et le GET V2 exige mission + présentation
      cohérentes ; aucun ID autoritaire n'entre dans le LLM, tandis que les choix réellement
      présentés lui sont accessibles sous alias opaques avec libellé/catégorie/unité/prix
      nécessaires à une désambiguïsation naturelle ;
- [x] `M2A3-03` : `requiredFact`, scope et champ du patch forment une matrice fermée ; « oui »,
      « modifie » et « annule » utilisent la décision/proposition fraîche, ou la tête
      `awaiting_line_details` fraîche lorsqu'aucune décision n'existe, et ne tombent jamais dans le
      cerveau legacy ;
- [x] `M2A3-04` : coupure après commit utilisateur et avant continuation, puis nouvel ACK : tête
      convergée, une ligne au plus, aucun événement métier dupliqué et GET resté read-only ;
- [x] `M2A3-05` : kill/relaunch dans `awaiting_lines`, `awaiting_catalogue_choice`,
      `awaiting_line_details` et `awaiting_line_confirmation` restitue les mêmes IDs/révisions sans
      parole automatique ;
- [x] `M2A3-06` : politiques catalogue 0, 1 exact, 1 fuzzy, 2..5 et ≥6 ; voix et toucher exposent
      le même ordre, les mêmes choix scellés et la même indisponibilité. Pour 1..5 choix, la voix
      prononce depuis la projection autoritaire chaque ordinal, libellé, prix et unité avant
      l'option ligne libre ; aucun texte LLM ne peut nommer ou réordonner ces choix ;
- [x] `M2A3-07` : patch tactile/vocal rejoué conserve son `commandId`; autre valeur ou autre scope
      échoue par fingerprint sans nouvelle révision ;
- [x] `M2A3-08` : confirmer, modifier et annuler consomment les mêmes choice/proposal/diff/work
      fences ; le mobile affiche le même diff autoritaire avant/après que la voix, sans le
      recalculer ; deux confirmations concurrentes produisent exactement une ligne et une seule
      interaction tactile peut partir à la fois ; annuler depuis les détails consomme la même tête
      par voix ou toucher, conserve le brouillon byte-identique et ne peut jamais devenir un
      abandon de mission ;
- [x] `M2A3-09` : après confirmation ou annulation, le brouillon frais et la tête suivante sont
      hydratés, Bob reste ouvert et accepte une autre ligne ;
- [x] `M2A3-10` : mission propriétaire du slot = zéro writer legacy, zéro affordance regex, une
      sheet et un chrome Bob ; le wizard sans mission reste fonctionnel ;
- [x] `M2A3-11` : suites core/AI/client/API/mobile, PostgreSQL réel, typecheck, lint, builds et
      reviews adversariales sont verts depuis un checkout propre ;
- [ ] `M2A3-12` : Supabase staging exact-SHA sous déployeur/runtime non-superuser restitue la preuve
      non-PII complète, flags publics OFF ; après un premier train `S0→S3`, un SHA successeur aux
      migrations byte-identiques obtient un manifest `finalized-recertification` sans commande
      Prisma mutante ni changement d'inventaire ; une panne du control plane Railway antérieure au
      processus enfant ne peut être rejouée que par le wrapper borné ci-dessus, sans masquer ni
      réexécuter une panne de l'opérateur ;
- [ ] `M2A3-13` : sur iPhone et Android physiques, parler pendant Bob coupe localement le son avant
      le réseau et capture le nouveau tour ; tant que cette preuve manque, M2-A reste non certified.
- [ ] `M2A3-14` : le planner reçoit le contexte écran, la mission, le fuseau confirmé, l'historique
      récent borné et le manifeste de capacités ; paraphrases, anaphores et corrections multi-tours
      passent des evals sur un vrai appel modèle, pas seulement des tool-calls fabriqués. Le
      contexte porte la fence écran `{route, revision, digest}`, la révision et la décision de
      mission ainsi que les seules capacités réellement admises par l'hôte. Le fuseau non nul vient
      exclusivement du JWT signé, confirmé et lié au tenant. La confirmation n'est demandée
      qu'après qu'une négociation autoritaire a choisi Mission V2 ; V1 et les transports sans
      Mission V2 ne sont jamais bloqués par ce gate. Sans confirmation, le bootstrap V2 reste fermé.
      L'eval opt-in appelle exactement l'adapter et le modèle du runtime, compte une seule
      complétion sans retry ni second cerveau et produit une preuve exact-SHA non-PII. Le
      workflow exige le même `expected_sha` que le gate schéma et prouve
      `checkout=github.sha=expected_sha` avant toute installation. Le
      one-shot surcharge `BOB_LIVE_PROVIDER=openai` dans son seul processus, sans modifier la
      configuration Railway canonique de staging qui reste `mistral`. Le
      modèle chat demandé par ce one-shot est résolu par la même source de vérité que
      `buildLlmForProvider('openai')` : l'absence gouvernée de `OPENAI_MODEL` certifie donc le
      défaut runtime versionné, sans poser d'override Railway ni recopier un nom de modèle dans le
      workflow. Une valeur vide ou mal formée échoue fermée ; la preuve porte le modèle
      effectivement demandé et refuse tout modèle retourné incompatible. Le
      fournisseur ne reçoit qu'une enveloppe JSON de rôle `user` : seul
      `currentUserUtterance` porte la demande actuelle ; `recentTurns`, `uiContext` et les labels
      sont redigés et restent des données non fiables, y compris lorsqu'une parole Bob mémorisée
      reprend un label catalogue hostile. Le schéma mission est borné à la phase autoritaire, une
      TVA absente reste nulle et une sélection ordinale ne peut transporter aucune ligne. Chaque
      cas du reçu prouve exactement un appel `complete` résolu, zéro `generate`, le modèle
      fournisseur observé même si le planner rejette la sortie, ainsi que des codes d'issue fermés
      sans transcript, prompt, argument, label ni identifiant métier. Le reçu n'est téléversé
      qu'après une garde confidentialité indépendante, y compris lorsque l'eval live échoue. Il
      exige la source `versioned_default` ; tout `OPENAI_MODEL` Railway, même valide, ferme la
      certification V1 et reste seulement diagnosticable comme `environment_override` dans le
      reçu rouge local ;
- [x] `M2A3-15` : un tour n'est jamais envoyé séquentiellement à deux cerveaux. Le planner unique
      choisit le `mission kind` ou le geste global ; aucun `unrelated → askBob` ne double la latence
      et aucun fallback regex ne conserve une autorité d'écriture.
- [x] `M2A3-16` : la capacité du brouillon est calculée depuis l'unique
      `MAX_BILLING_LINES` avec `lignes confirmées + file verrouillée + nouvelles lignes`. La
      centième ligne est admise, la cent-unième est refusée avant tout insert, et voix comme toucher
      annoncent honnêtement la limite sans retry infini, ligne pendante ni donnée fabriquée.
- [x] `M2A3-17` : chaque CTA décrit exactement son effet réel — fermer ne prétend jamais relancer
      Bob. Les choix exclusifs publient `radiogroup`/`radio` et leur état coché, les conteneurs de
      reprise ne masquent pas les rôles `header`/`alert`, et les libellés voix/toucher restent
      utilisables sans dépendre de la couleur ni du regard.

### 17.2 Preuve d'implémentation locale M2-A-3 — `1c7f12c9`

Le statut `implemented` repose sur les preuves reproductibles suivantes, rejouées le 31 juillet
2026 depuis le checkout propre du commit :

- `pnpm lint` : 9 tâches sur 9 ;
- `pnpm typecheck` : 17 tâches sur 17 ;
- `pnpm test` : 15 tâches sur 15, dont core 3 051 tests, AI 919, API 2 820 et mobile 1 599 ;
- `pnpm exec turbo run build --force` : 10 tâches sur 10, artefacts core/AI/client/API sans
  fixture ni double de production ;
- `sh apps/api/scripts/certify-agent-missions-local.sh` : migrations
  expand/validate/cutover, writers N-1 à chaque étape, ACL/RLS non-superuser et 56 tests
  transactionnels PostgreSQL réels ;
- `RUN_AGENT_MISSION_M2A3_PRISMA_RECOVERY_CERT=true ... test:m2a3-staging-schema` : 29 tests sur
  29 avec Prisma 6.19.3 et PostgreSQL 17 réels ; coupures avant et après `COMMIT`, résolution
  reconstruisible et déployeur/propriétaire non-superuser ;
- revues adversariales indépendantes recovery/correctness et staging/frontières de confiance :
  deux verdicts `GO`, zéro P0/P1 ouvert.

`M2A3-12`, `M2A3-13` et `M2A3-14` restent volontairement non cochés : la certification Supabase
staging exact-SHA, les essais iPhone/Android physiques et l'eval du modèle réellement déployé
restent dus. Le flag public demeure OFF et le train ne peut donc pas être qualifié `certified`.

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

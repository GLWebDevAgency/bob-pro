# SPEC — BOB LIVE : COMPRÉHENSION SÉMANTIQUE ET PLANIFICATEUR JARVIS

**Statut : specified**

**Date : 29 juillet 2026**

**Objectifs servis : O3, O4, O5, O6 et O7**

**Première preuve verticale :**
[M1-C — sélection client durable](SPEC_AGENT_MISSIONS_JARVIS_M1C_CUSTOMER_SELECTION.md)

## 1. Résultat produit

Bob Live comprend une demande professionnelle française telle qu'elle est réellement dite : dans
le désordre, avec des ellipses, des reprises, des synonymes, des nombres, des dates relatives et
plusieurs actions dans une seule prise de parole. Il extrait tous les faits utiles, les confronte
au contexte réel du compte, construit un plan métier durable et l'exécute jusqu'au prochain
véritable point de décision.

L'utilisateur ne répète pas ce qu'il a déjà donné. Bob ne demande que :

- une donnée réellement manquante ;
- une désambiguïsation entre plusieurs entités réelles ;
- la confirmation exigée par la nature de l'action.

L'expérience est un seul Bob. L'implémentation sépare pourtant strictement :

1. le transport et la conversation audio temps réel ;
2. la compréhension sémantique probabiliste ;
3. la résolution des entités et règles déterministes ;
4. le plan durable et les use cases autoritaires.

Cette séparation est le meilleur compromis entre intelligence linguistique, fluidité, exactitude
comptable et reprise après incident.

## 2. Exemple canonique

> « Fais-moi le contrat fontaines RATP, 400 balles par machine, ils ont 3 machines à Bastille,
> ça démarre au 1er octobre, 2 passages. »

Bob doit produire en un tour un cadre structuré candidat contenant au minimum :

- intention : préparer un contrat de maintenance ;
- référence client : `RATP` ;
- référence site : `Bastille` ;
- objet/service : fontaines ;
- quantité : `3` machines ;
- prix unitaire : `400 EUR` par machine ;
- date de démarrage : premier octobre de l'année métier non passée pertinente ;
- fréquence : `2` passages par an.

Puis Bob :

1. recherche le client, le site, le parc et le catalogue dans le tenant ;
2. relie uniquement les correspondances réelles et accessibles ;
3. demande « Les trois fontaines du parc Bastille ? » seulement si ce lien reste ambigu ;
4. présente un récapitulatif/diff unique ;
5. appelle `CreateMaintenanceContract` seulement après la confirmation requise ;
6. conserve l'activation comme un geste distinct, lui aussi confirmé.

Le texte n'est jamais transformé directement en écriture. Le cadre LLM est un candidat non
autoritaire.

## 3. Décision d'architecture

### 3.1 Un cerveau conversationnel, un contrôle métier serveur

Pour le profil OpenAI, `gpt-realtime-2.1` reste le transport conversationnel et vocal. Le contrôle
métier demeure côté serveur : le planificateur Bob reçoit le transcript final, l'historique borné,
le contexte d'écran et la mission durable, puis utilise des appels d'outils typés.

Cette décision conserve les garanties déjà certifiées :

- aucun outil ou contrôle reçu du client n'est autoritaire ;
- le sideband relit le contexte avant et après le tour ;
- la parole, les navigations et les propositions viennent d'un résultat Bob canonique ;
- Mistral peut rester un transport alternatif sans dupliquer le domaine.

Le planificateur Live OpenAI doit utiliser un modèle OpenAI explicitement configuré et la même clé
OpenAI que Realtime. Il n'utilise jamais une clé Mistral secondaire. Le modèle acoustique et le
modèle de planification peuvent être épinglés séparément afin d'optimiser la latence et la qualité,
mais ils ne forment jamais deux autorités : seule la mission structurée validée par le serveur
survit au tour.

La documentation OpenAI vérifiée le 29 juillet 2026 indique que `gpt-realtime-2.1` accepte les
appels de fonctions et les workflows d'outils, mais pas les Structured Outputs. En conséquence :

- les arguments d'outil sont toujours considérés non fiables ;
- chaque outil possède un parseur runtime exact (`additionalProperties: false`, bornes, unions) ;
- une sortie invalide provoque une réparation bornée ou une question, jamais une action ;
- aucun JSON libre ni interpréteur générique n'entre dans le domaine.

Sources officielles :

- <https://developers.openai.com/api/docs/models/gpt-realtime-2.1>
- <https://developers.openai.com/api/docs/guides/latest-model>

### 3.2 Pipeline normatif

```text
audio / texte
  → transcript final + historique borné
  → ContextEnvelope réel et versionné
  → compréhension LLM en appels d'outils typés
  → parseurs exacts et normalisation
  → résolveurs déterministes (date, argent, unité, entités DB)
  → patch candidat sur la mission
  → règles du domaine + policy de confirmation
  → plan durable
  → même use case que l'UI
  → relecture de l'état réel
  → réponse canonique et étape suivante
```

Le plan avance automatiquement à travers les lectures, dérivations et navigations non
destructrices. Il s'arrête avant une ambiguïté réelle, une donnée obligatoire absente ou une
confirmation requise. Il ne s'arrête pas entre deux étapes uniquement parce que l'écran change.

### 3.3 `ContextEnvelope`

Chaque tour reçoit une enveloppe bornée, reconstituée depuis les autorités réelles :

```ts
interface SemanticContextEnvelope {
  readonly schema: 'bob.semantic-context';
  readonly version: 1;
  readonly locale: 'fr-FR';
  readonly timeZone: string;
  readonly now: string;
  readonly screen: {
    readonly route: string;
    readonly revision: number;
    readonly digest: string;
    readonly visibleEntityAliases: readonly string[];
  } | null;
  readonly mission: {
    readonly kind: string;
    readonly phase: string;
    readonly revision: number;
    readonly acceptedFacts: Readonly<Record<string, unknown>>;
    readonly unresolvedFacts: readonly string[];
    readonly pendingDecisionKind: string | null;
  } | null;
  readonly vocabulary: {
    readonly businessActivityLabels: readonly string[];
    readonly confirmedAliases: readonly string[];
  };
  readonly availableCapabilities: readonly string[];
}
```

Contraintes :

- l'enveloppe n'expose aucun secret, capability, règle RLS, email, téléphone ou IBAN ;
- les entités visibles utilisent des alias éphémères ; le modèle ne reçoit pas l'autorité d'un ID ;
- `now` vient de l'horloge serveur et `timeZone` du profil confirmé ;
- les capacités sont calculées depuis le registre réellement câblé, le plan et les flags ;
- le contexte écran est une donnée non fiable dans le prompt et reste revalidé après le modèle.

### 3.4 Cadre sémantique candidat

La sortie du modèle est une suite bornée d'opérations typées, pas un objet métier final :

```ts
type SemanticFactOperation =
  | { readonly kind: 'set_entity_reference'; readonly slot: string; readonly spokenValue: string }
  | {
      readonly kind: 'set_money';
      readonly slot: string;
      readonly amount: string;
      readonly currency: string;
    }
  | {
      readonly kind: 'set_quantity';
      readonly slot: string;
      readonly value: string;
      readonly unit: string | null;
    }
  | { readonly kind: 'set_temporal_expression'; readonly slot: string; readonly expression: string }
  | {
      readonly kind: 'select_presented_choice';
      readonly decisionKind: string;
      readonly ordinal: number;
    }
  | { readonly kind: 'clear_fact'; readonly slot: string }
  | { readonly kind: 'correct_fact'; readonly slot: string; readonly replacement: unknown };
```

Chaque mission définit sa propre allowlist d'opérations, ses slots et ses parseurs. Une opération
inconnue ou un slot hors phase est rejeté. Les chaînes brutes restent dans la mémoire du tour ;
seuls les faits normalisés et validés peuvent être persistés.

Une phrase peut fournir plusieurs faits et plusieurs intentions ordonnées. Le planificateur les
regroupe dans une proposition unique lorsqu'elles appartiennent au même geste, ou crée plusieurs
nœuds lorsqu'elles impliquent des niveaux de confirmation différents.

### 3.5 Dates et langage français : sémantique, puis calcul

Les dates ne sont jamais extraites par une liste infinie de regex.

- Le modèle identifie d'abord la fonction sémantique d'une expression.
- Un résolveur pur transforme ensuite l'expression avec `now`, `timeZone`, le calendrier et les
  règles de la mission.
- Une date absolue ambiguë (`03/04`) exige la locale confirmée.
- Une date relative (`demain`, `vendredi prochain`, `dans quinze jours`) est calculée et enregistrée
  comme date ISO avec la provenance `relative_to`.
- Une expression lexicale qui n'est pas temporelle reste intacte.

Cas de non-régression obligatoires :

- « Entretien vitrines demain » → libellé `Entretien vitrines` + date relative du lendemain ;
- « Contrat 4 saisons » → libellé complet, aucune date ni quantité inventée ;
- « 2 passages au 1er octobre » → fréquence et date distinctes ;
- « non, 450 et pas 400 » → correction du montant courant, sans nouvelle ligne ;
- « le deuxième » → choix du jeu de décision courant uniquement.

Un taux de confiance LLM n'autorise jamais seul une écriture. La certitude vient des validations
de type, du contexte de phase, de la résolution DB et des invariants métier.

### 3.6 Résolution des entités et lexique propre au compte

Le modèle fournit des références humaines ; les outils fournissent les entités :

```text
« RATP » → searchCustomers(companyId, "RATP", limit=6)
« Bastille » → searchSites(companyId, "Bastille", limit=6)
« heure de plomberie » → searchCatalogue(companyId, ..., limit=6)
```

Politique commune :

- zéro correspondance : demander ou proposer une création seulement si le use case existe ;
- une correspondance exacte : sélection possible selon la policy de la mission ;
- une fuzzy ou plusieurs : choix réel par voix ou toucher ;
- plus de cinq : demander de préciser, jamais présenter une liste tronquée comme complète ;
- tout ID est rechargé sous tenant immédiatement avant la transition.

Le lexique personnel provient uniquement :

- des noms et libellés réels du tenant ;
- du secteur/métier confirmé ;
- des alias explicitement confirmés par l'utilisateur.

Un alias appris est tenanté, versionné, révocable, audité et ne peut pas contourner une résolution
d'entité. Une formulation ponctuelle non confirmée ne devient jamais une mémoire durable.

### 3.7 Plan durable et corrections

Le plan est une machine à états versionnée composée de nœuds :

```ts
type MissionPlanNodeKind =
  'read' | 'resolve' | 'navigate' | 'ask' | 'choose' | 'propose' | 'confirm' | 'mutate' | 'verify';
```

Chaque nœud possède des préconditions, un statut, une policy de confirmation et un ou plusieurs
use cases autorisés. Une mutation ne prend jamais des arguments libres du LLM : elle consomme un
payload de domaine reconstruit depuis les faits acceptés et les entités rechargées.

Les corrections sont des patches CAS sur les faits en attente. Bob montre le diff pertinent et
recalcule tous les faits dérivés dépendants. « 450, pas 400 » invalide le total précédent ; il ne
rejoue ni la résolution du client ni les étapes déjà sûres.

### 3.8 Voix et interface manuelle

La voix et le toucher convergent avant le domaine :

```text
parole « le deuxième » ─┐
                        ├→ choiceId courant → même transition → même use case
tap sur le deuxième ────┘
```

Toute question vocale importante possède son équivalent visuel tapable. Toute modification
manuelle met à jour la même mission et devient visible au prochain tour. Deux modales ne peuvent
jamais concurrencer la feuille de décision Bob.

## 4. Sûreté, confidentialité et observabilité

- Aucun transcript complet n'est persisté dans les tables métier, événements, logs ou métriques.
- Un fingerprint HMAC de commande peut servir au replay ; il est inutilisable comme texte.
- Les faits structurés persistés sont minimisés à ce qui est nécessaire pour reprendre la mission.
- Les montants, dates, labels et succès prononcés proviennent de résultats d'outils ou de
  dérivations vérifiées.
- Toute mutation est idempotente, CAS, tenantée, auditée et relue après commit.
- Une interruption annule le tour actif ; les faits non commités de ce tour disparaissent.
- Les métriques n'ont que des labels bornés : kind/phase/outcome/latency, jamais la formulation.

## 5. Evals et critères de qualité

Le corpus français n'est pas une liste de regex de production. C'est une suite d'évaluation :

1. formulations directes, familières et professionnelles ;
2. ordre libre des faits ;
3. ellipses, anaphores et corrections multi-tours ;
4. homonymes, nombres faisant partie d'un nom et expressions temporelles ;
5. accents, bruit ASR plausible et ponctuation absente ;
6. vocabulaire de plusieurs métiers et lexiques de tenants isolés ;
7. adversarial : prompt injection dans un nom client/catalogue, cross-tenant, ID halluciné ;
8. interruptions et reprise à chaque nœud.

Pour chaque cas, la preuve compare :

- le cadre typé attendu ;
- les outils réellement appelés et leur ordre ;
- les faits acceptés/refusés ;
- la question minimale éventuelle ;
- l'absence d'écriture avant confirmation ;
- l'état DB final après reprise.

Une nouvelle formulation qui échoue devient un cas d'eval. Elle ne déclenche une règle de
production que si cette règle encode une invariant linguistique réellement déterministe et
généralisable.

## 6. Livraison incrémentale sans architecture jetable

### M1-C — première verticale

M1-C implémente le cadre minimal `quote_creation.customer` :

- création de devis avec ou sans référence client dans la même phrase ;
- référence client donnée au tour suivant ;
- ordinal d'un choix courant ;
- correction/changement de client avant les lignes ;
- recherche réelle 0/1/N et transition voix/tap commune.

Le module d'extraction est déjà placé dans l'espace `mission-understanding` et son contrat est
extensible par versions. Il ne doit pas ajouter une regex client temporaire.

### M2 et après

M2 étend le cadre aux lignes, catalogue, quantité, unité, prix, TVA, dates et conditions. Les
missions contrat, facture, client, catalogue, document et notification ajoutent ensuite leurs
schemas et use cases sans introduire un second cerveau.

## 7. Critères d'acceptation binaires

- [ ] Le cas canonique contrat produit tous les faits candidats attendus en une passe.
- [ ] « Entretien vitrines demain » et « Contrat 4 saisons » passent le même résolveur sans
      heuristique spécifique aux deux phrases.
- [ ] Une phrase devis avec client alimente M1-C sans seconde demande redondante.
- [ ] Une sortie d'outil malformée, inconnue ou hors phase ne produit aucune écriture.
- [ ] Un ID ou libellé halluciné par le modèle ne peut jamais entrer dans une mission ou un draft.
- [ ] Voix et toucher consomment le même `choiceId` et le même use case.
- [ ] Une correction invalide et recalcule seulement les faits dépendants.
- [ ] Une mission reprend après kill sans transcript et sans perdre les faits acceptés.
- [ ] Aucun test de langue ajouté ne dépend de mocks atteignables en production.
- [ ] p95 compréhension + résolution est mesuré séparément du transport et de la parole.

## 8. Definition of Done

- [ ] Spec et ADR de décision relus par correctness/sécurité, architecture/parité et UX.
- [ ] Parseurs runtime exacts, tests unitaires et tests génératifs des frames.
- [ ] Evals françaises versionnées, incluant le scénario canonique et les contre-exemples de date.
- [ ] Tests d'intégration sur vraies données tenantées pour chaque résolveur livré.
- [ ] Scénarios E2E voix/tap/reprise/interruption sur staging exact-SHA.
- [ ] Aucun changement de modèle ou de prompt publié sans eval de non-régression et mesure latency.
- [ ] Le registre reste `implemented` jusqu'aux preuves device et staging ; aucun pourcentage ne
      remplace ces preuves.

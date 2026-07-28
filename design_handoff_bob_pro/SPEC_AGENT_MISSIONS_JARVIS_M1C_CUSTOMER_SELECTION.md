# M1-C — SÉLECTION CLIENT DURABLE, VOIX ↔ TACTILE

**Statut : specified**

**Objectifs servis : O4, O6, O7**

**Spec parente :** [SPEC_AGENT_MISSIONS_JARVIS.md](SPEC_AGENT_MISSIONS_JARVIS.md)

**Contrat de compréhension :**
[SPEC_BOB_LIVE_SEMANTIC_PLANNER.md](SPEC_BOB_LIVE_SEMANTIC_PLANNER.md)

## 1. Résultat produit

Depuis une session Bob Live V1 admise, « crée un devis » démarre ou reprend une mission durable,
navigue vers `/devis/new`, attend l'ACK du vrai écran et du vrai brouillon, puis permet de choisir
un client réel :

- à la voix par son nom ou par l'ordinal d'un choix présenté ;
- au toucher depuis le même jeu de choix ou depuis la liste réelle de l'écran ;
- avec le même use case, les mêmes fences, le même brouillon serveur et le même journal.

Après sélection, le brouillon autoritaire est à l'étape `lignes` et la mission à
`awaiting_lines`. Un arrêt audio, un kill ou une nouvelle session ne rejouent pas la sélection :
la reprise relit l'état serveur. Tant que M2 n'est pas livré, l'utilisateur continue les lignes à
la main après un handoff explicite ; M1-C ne promet pas encore un devis complet à la voix.

## 2. Portée exacte

### Inclus

1. `CustomerCandidateSearchPort` tenanté, paramétré et indexable, avec `LIMIT 6`.
2. Politique core déterministe :
   - zéro résultat : rien n'est sélectionné ;
   - plus de cinq : demander de préciser ;
   - un exact normalisé : sélectionner ;
   - un fuzzy : proposer ;
   - deux à cinq : présenter des choix stables.
3. Relecture du client par ID sous le même tenant avant toute sélection.
4. Cadre sémantique M1-C typé, sans regex de production, capable d'extraire une référence client
   de « crée un devis pour Camping les Pins », d'un tour complémentaire ou un ordinal du choix
   courant. Les arguments LLM passent un parseur exact avant toute recherche.
5. Transition pure partagée qui applique `select_customer + next_step` au payload durable.
6. `AdvanceQuoteAgentMission` avec idempotence, CAS et transaction unique
   brouillon + mission + événement.
7. Endpoint tactile exact `POST /agent-missions/:missionId/decisions`.
8. Orchestrateur Realtime mission-aware :
   - démarre/reprend la mission après une navigation canonique « nouveau devis » ;
   - consomme une requête client seulement en phase `awaiting_customer` ;
   - consomme un ordinal ou un nom seulement dans le jeu courant en
     `awaiting_customer_choice` ;
   - délègue au BobAgent historique lorsqu'aucune transition M1-C n'est applicable.
9. Autorité Realtime formée uniquement depuis la lease admise côté serveur :
   `subjectHashCandidates + principalBindingHash + capabilityHash`; aucun secret client ni
   release flag request-time ne décide après admission.
10. Vue mobile enrichie des choix dont les libellés sont relus en base. Un client supprimé devient
   indisponible, sans ancien nom affiché.
11. Handle capability transféré à un unique `AgentMissionProvider`, sans double ownership.
12. Synchronisation mission + brouillon après `turn_settled`, foreground et action tactile.
13. Lecture de reprise froide owner-scopée par JWT + RLS, strictement read-only et indépendante
    d'une capability Live disparue au kill.
14. Wizard manuel inchangé lorsqu'aucune mission compatible n'est active.

### Non inclus

- ajout de lignes, catalogue, TVA, acompte, signature ou création finale du devis ;
- activation publique du flag AgentMission ;
- activation ou reprise du chantier Mistral V3 ;
- stockage du transcript, de la requête client ou d'un libellé produit par le LLM ;
- navigation/parole automatique au redémarrage ;
- changement du contrat durable `QuoteDraftPayloadV1`.

## 3. Invariants non négociables

### 3.1 Données et confidentialité

- Le LLM et le transcript ne fournissent jamais `customerId`, `choiceId` ni label persistant.
- Tout ID consommé existe sous `companyId` et tout nom affiché/parlé vient de la ligne `customers`
  relue dans la requête courante.
- La requête client est bornée, transitoire, absente de la mission, des événements, logs,
  métriques et traces.
- Aucun repository in-memory, fixture ou client fictif n'est importable depuis le chemin
  production.

### 3.2 Transaction et concurrence

L'ordre de verrouillage reste :

```text
Company SHARE → owner/kind → mission → quote_draft_slot → customer
```

La sélection réussie réalise dans une seule transaction PostgreSQL :

1. validation de la lease/capability admise ;
2. horloge DB et replay `commandId` ;
3. verrou mission et vérification phase/révision/contexte ;
4. verrou brouillon et fences session/slot/contenu ;
5. relecture client tenantée ;
6. transition pure du payload ;
7. CAS brouillon `slot N→N+1`, `content C→C+1` ;
8. CAS mission `revision R→R+1`, phase `awaiting_lines` ;
9. événement `customer_selected` de séquence `R+1`.

Toute erreur annule les trois writes. Un replay exact n'écrit rien ; un même `commandId` avec un
autre payload échoue. Une décision ou un écran périmé échoue sans « meilleure estimation ».

### 3.3 Parité voix/toucher

- Un jeu présenté persiste uniquement `decisionId`, `choiceSetRevision`, `choiceId → customerId`
  et son hash canonique.
- « le deuxième » est résolu vers le deuxième `choiceId` du jeu courant ; un tap transmet ce même
  `choiceId`.
- Un tap direct hors jeu transmet un `customerId` non fiable, relu sous tenant, puis traverse la
  même transition de brouillon et le même use case.
- La différence d'événement entre les canaux se limite à l'acteur et à la corrélation de tour.

### 3.4 Runtime et reprise

- Le secret capability reste privé dans le handle mobile ; il n'est ni sérialisé ni reconstruit.
- La reprise froide ne recrée jamais une capability : elle utilise un endpoint de lecture séparé,
  dérive tenant/owner du JWT et traverse une transaction RLS sans accès aux mutations.
- Le serveur réutilise seulement l'attestation de capability persistée lors de l'admission
  Realtime ; aucune capability fournie par le modèle ou le datachannel n'est acceptée.
- Chaque tour expose un `turnId` UUID stable et produit exactement un `turn_settled` terminal
  `done | cancelled | failed` sur WebRTC natif et livraison auditée.
- `ready`, transcript final et `conversation_completed` ne valent pas `turn_settled`.
- Une fermeture de transport dispose le handle seulement si aucun provider ne l'a adopté.
- Après kill : aucune voix, navigation ou mutation automatique. La UI propose une reprise, puis
  rattache une nouvelle session V1 par ACK.

## 4. Contrats exacts

### 4.1 Recherche

```ts
interface CustomerCandidateSearchPort {
  search(input: {
    companyId: string;
    query: string;
    limit: 6;
  }): Promise<readonly {
    customerId: string;
    canonicalName: string;
    matchKind: 'exact' | 'fuzzy';
    score: number;
  }[]>;
}
```

Classement SQL :

```text
exact normalisé DESC, score DESC, nom normalisé ASC, customerId ASC
```

L'opérateur fuzzy utilise l'index existant
`immutable_unaccent(lower(customers.name)) gin_trgm_ops`. Le sixième résultat signale
`too_many` ; il n'est jamais présenté comme un choix.

### 4.2 Décision tactile

```text
POST /agent-missions/:missionId/decisions
```

Le body est exactement l'une des deux formes de la spec parente §13.1 :
`choose_presented_option` ou `select_screen_customer`. Champs inconnus rejetés.

### 4.3 Reprise froide read-only

```text
GET /agent-missions/current/quote-creation/resume
Authorization: Bearer <JWT>
```

Ce endpoint :

- dérive `companyId` et `ownerUserId` exclusivement du principal authentifié ;
- n'accepte aucun body, capability, tenant ou owner fourni par le mobile ;
- n'expose que la vue owner-scopée nécessaire à la reprise ;
- utilise FORCE RLS avec les GUC tenant + owner ;
- n'expire, ne rejoint, n'ACK et ne modifie jamais une mission ;
- retourne `mission: null` seulement après une lecture DB réussie ; une DB indisponible donne
  `503`, jamais un faux vide.

Le `GET /agent-missions/current/quote-creation` historique reste lié à la capability Live pour les
relectures pendant une session. Toutes les mutations restent exclusivement sous cette capability.

### 4.4 Vue

La vue ajoute le brouillon observé et, pour une décision client :

```ts
type CustomerMissionChoiceView =
  | { status: 'available'; choiceId: string; label: string }
  | { status: 'unavailable'; choiceId: string };
```

Une indisponibilité de la base rend la vue indisponible ; elle ne transforme pas les clients en
choix vides.

## 5. Critères d'acceptation binaires

- [ ] Dire « crée un devis » sous une lease V1 crée/reprend exactement une mission et retourne une
      navigation sûre `/devis/new`.
- [ ] Dire « crée un devis pour Camping les Pins » conserve la référence client dans le même tour,
      puis applique la politique DB 0/1/N sans redemander quel client.
- [ ] Un appel d'outil sémantique avec clé inconnue, ordinal hors bornes ou référence vide est
      refusé sans recherche, mission, brouillon ni événement.
- [ ] Aucun tour client n'est consommé avant l'ACK contexte + brouillon exact.
- [ ] Les cas 0, 1 exact, 1 fuzzy, 2–5 et >5 sont prouvés avec clients créés en base.
- [ ] Accents, casse et homonymes ont un ordre stable ; la requête SQL contient `LIMIT 6` et le
      filtre tenant.
- [ ] Le choix vocal ordinal et le tap du même choix produisent le même client, la même phase,
      les mêmes révisions et le même hash de payload.
- [ ] Le tap direct d'un client cross-tenant ou supprimé échoue sans write/event.
- [ ] Une faute injectée après le write brouillon rollbacke brouillon, mission et événement.
- [ ] Deux décisions concurrentes donnent un gagnant, un conflit et un seul événement.
- [ ] Un replay exact ne crée pas de second événement ; un replay altéré échoue.
- [ ] `turn_settled` est émis exactement une fois pour `done`, `cancelled` et `failed` sur les deux
      chemins OpenAI, et provoque une relecture mobile.
- [ ] La capability n'apparaît dans aucun JSON, log, métrique, trace ou stockage mobile.
- [ ] Kill/relaunch relit par JWT+RLS le même draft/choix sans recréer de capability, sans
      navigation, parole ni mutation automatique.
- [ ] Une panne de la lecture de reprise affiche erreur/retry et ne devient jamais
      `mission: null`.
- [ ] Mission absente, protocole `null` ou flag OFF conserve le flow manuel actuel.
- [ ] Aucune donnée mockée n'est atteignable dans les artefacts API/mobile.

## 6. Definition of Done de la tranche

- [ ] Revue adversariale correctness/sécurité, architecture/parité et UX/accessibilité soldée.
- [ ] Tests core, API, codec/client et mobile ciblés verts.
- [ ] Certification PostgreSQL réelle avec rôle runtime non-superuser :
      RLS owner/tenant, 0/1/N, concurrence, replay, rollback et writer N-1.
- [ ] Typecheck, lint, suites globales et builds API/mobile verts depuis un checkout propre.
- [ ] PR unique à jour sur `main`, checks requis verts, puis merge et suppression de branche.
- [ ] Staging exact-SHA avec flag compte interne seulement, scénario voix + tap et retour OFF.
- [ ] Le registre reste `implemented` tant que device réel et preuve staging C3 ne sont pas verts.
- [ ] **[BLOQUÉ FONDATEUR : clé OpenAI production + budget]** pour la certification de publication
      sur appareils réels ; ce blocage n'empêche ni l'implémentation ni la certification staging.

# SPEC — GPT Realtime : isolation stricte du fournisseur

**Statut** : lot de publication GPT Realtime, avant activation des flags et certification device.
**Socle** : `50a998cf` — PR d'intégration V1 gelée, aucun changement de ses flags.

## But

Une session Bob Live choisit son fournisseur une seule fois au bootstrap. Ce choix traverse le
transport, l'adaptateur agent et le routeur LLM. La présence d'autres clés dans le serveur ne peut
jamais provoquer un appel concurrent, un fallback silencieux ou un mélange OpenAI/Mistral.

## Invariants

1. Le fournisseur est injecté depuis `RealtimeVoiceSettings.provider`, jamais relu depuis une clé
   disponible au milieu d'un tour.
2. `RealtimeBobAgentTurnAdapter` transmet cette contrainte dans les options d'exécution serveur ;
   elle n'est pas sérialisable dans le payload utilisateur.
3. `ModelRouter` réduit sa chaîne au fournisseur imposé pour toutes les tâches du tour ; seul le
   repli déterministe local de Bob reste possible après une panne, jamais un autre fournisseur.
4. Si la clé du fournisseur imposé manque, le tour répond `unavailable` ; aucune autre clé ne sert
   de repli.
5. Le mode UE et une contrainte vers un fournisseur non UE constituent une configuration
   incompatible et échouent fermés.
6. Les outils métier, les politiques `confirm_all`, le tenant et le contexte restent inchangés.
7. Ce lot n'active ni Bob Live, ni Voice Trace, ni Mistral V3.

## Critères d'acceptation binaires

- [x] Le routeur retourne OpenAI pour `intent.detect`, `agent.plan` et les tâches équilibrées quand
      OpenAI est imposé, même si toutes les autres clés existent.
- [x] OpenAI imposé sans clé OpenAI retourne `unavailable` malgré une clé Mistral valide.
- [x] Un tour `BackendService.askBob` avec clés OpenAI et Mistral présentes émet uniquement des
      requêtes vers l'endpoint configuré OpenAI et utilise uniquement la clé OpenAI.
- [x] Le même tour fonctionne avec la seule clé OpenAI.
- [x] Le test symétrique Mistral n'émet aucun appel concurrent quand tous les fournisseurs existent.
- [x] Les tests de l'adaptateur prouvent la propagation exacte de `openai` et `mistral`.
- [x] Typecheck, lint et tests ciblés `@bob/ai` + `@bob/api` sont verts depuis le checkout propre.
- [x] Une review adversariale indépendante ne conserve aucun P0/P1.

## Hors périmètre

- duplex audio natif et barge-in acoustique ;
- Voice Trace et SLO device ;
- mission conversationnelle durable après navigation ;
- activation des variables de publication.

Ces sujets restent les lots suivants de `OBJECTIFS_SPECS_DOD_PUBLICATION.md`.

## Preuves locales du lot

- `@bob/ai` : 543 tests verts, typecheck, lint et artefact de production certifié ;
- `@bob/api` : 1 862 tests verts, 247 certifications PostgreSQL opt-in ignorées hors base dédiée,
  177 tests de scripts de release verts, typecheck et artefact API certifié ;
- preuves ciblées isolation/composition : 27 tests verts ;
- deux reviews adversariales indépendantes : zéro P0/P1 restant ;
- aucun flag de publication modifié et aucune migration requise.

# Verdict GPT — architecture de compréhension et d'exécution vocale

## Verdict

**Accord sur le tool calling, avec un amendement structurant : la cible est un runtime de mission
bout-en-bout, pas seulement un meilleur routeur d'intents ni une suite d'outils atomiques.**

La décision complète est proposée dans `docs/adr/0002-boucle-agentique-vocale-outils-types.md`.
Claude est invité à la challenger avant passage à `Accepted` et avant suppression d'un chemin
historique.

## Réponses aux questions de la réunion

1. Mistral Small 4 (`mistral-small-2603`) supporte officiellement le function calling. Cela le
   rend éligible, pas certifié : Small démarre en shadow/canary sur corpus ; Mistral Medium 3.5
   prend les échecs observables ; aucun routage par confiance déclarée du modèle. Small 3.2 est
   déprécié depuis le 30 avril 2026 et n'est pas retenu.
2. Les commandes/invariants/diffs restent dans `packages/core`. Les outils et schémas
   provider-neutral vivent dans `packages/ai`. Mobile/API ne sont que des bindings vers les mêmes
   use cases.
3. L'état multi-tour est une `AgentMission` qui survit aux navigations. La mission est fencée par
   identité/génération ; chaque appel mobile l'est séparément par écran, contexte et révision de
   brouillon. Les slots structurés et interactions en attente sont checkpointés ; le LLM ne
   constitue jamais la source de vérité.
4. Migration verticale : devis complet d'abord, puis facture, client, documents. Aucun big-bang.
5. Manquaient : UI conversationnelle riche, évals par trajectoire, registre parité, révisions de
   brouillon, idempotence, interruptions, dynamic STT bias et outils macro.
6. Le hot path combine fast path local + Mistral Small. Les parcours complets utilisent un outil
   macro (`quote.prepare_from_brief`) pour éviter un appel LLM par champ. Medium/Large ne sont
   escaladés que si les mesures l'exigent.

Le macro `prepare` ne produit aucun effet externe : il prépare un brouillon et une revue. Envoi,
signature client authentifiée, émission de facture et paiement restent des étapes séparées,
idempotentes et auditées. Une confirmation orale de l'artisan ne vaut jamais signature du client.

En mode connecté, l'API est l'unique autorité CAS de l'`AgentMission`. Le mobile ne possède que
les brouillons, outils locaux et reçus tenant-scopés ; hors ligne, il fait du staging sans effet
externe. La reprise réconcilie reçus et révisions avant toute nouvelle étape.

## Précondition protocolaire

ADR-0001 ne transporte pas encore les appels d'outils mobiles ni les interactions riches. Avant
le runner, il faut ajouter les événements corrélés `tool.request/result/cancelled` et
`interaction.present/resolve`, avec ACK/replay idempotents, génération, révisions, deadline et
payloads bornés. Une navigation conserve la mission mais invalide tout appel adressé à l'ancien
écran. Aucun résultat mobile ne peut autoriser seul une mutation serveur.

Deux gates précèdent la tranche catalogue/devis : migrer la clé globale
`bob.catalogue.perso` vers une identité entreprise/utilisateur/révision avec purge au logout, et
neutraliser le legacy `/voix` qui appelle aujourd'hui `SignQuote` sans preuve client. Le test
bloquant garantit qu'une confirmation artisan ne déclenche jamais cette signature.

## Deux tests d'acceptation obligatoires

1. « Ajoute deux heures de main-d'œuvre » → catalogue top 3 → choix voix/tap → diff → validation.
2. Dictée complète d'un devis en une fois → Bob enchaîne client, lignes, catalogue, acompte,
   validité et TVA, puis ne demande que les ambiguïtés/champs indispensables et une revue groupée.

Le second test s'arrête honnêtement au devis prêt et revu. L'envoi est une action confirmée
séparée, la signature place la mission en attente d'une preuve client externe, puis seulement la
facture depuis devis peut être générée.

L'acompte, la validité et tous les autres termes sont figés avant l'envoi/signature. Modifier un
terme invalide la demande ou la preuve antérieure : Bob ne peut jamais rattacher une signature à
un contenu modifié après le consentement.

## Challenge demandé à Claude

- granularité exacte des outils macro/atomiques ;
- politique confirmation voix/tap par niveau de risque ;
- persistance minimale d'une mission locale et reprise après kill ;
- top 3 catalogue : score, seuil de match fort, fingerprint ;
- matrice de capacités devis/facture/client avant implémentation ;
- corpus et SLO bloquants pour accepter l'ADR.

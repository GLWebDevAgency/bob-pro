# ADR-0004 : GPT Realtime pour la publication, Mistral V3 après la V1

## Statut

Accepted — 2026-07-21, décision fondateur.

## Contexte

Bob Pro possède plusieurs travaux vocaux parallèles : un chemin OpenAI Realtime, un chemin Mistral
tour-par-tour déjà exploité et un protocole Mistral full-duplex V2/V3 en cours de construction.
Cette pluralité protège l'indépendance fournisseur, mais elle impose avant publication plusieurs
matrices de transport, VAD, synthèse, reprise, secrets, tests device et observabilité. Elle a aussi
favorisé des branches longues et des lots partiellement intégrés.

Le besoin immédiat n'est pas de maintenir deux implémentations premium simultanées. Il est de
publier rapidement une expérience vocale stable, mesurable et continue. OpenAI Realtime fournit le
chemin le plus direct vers ce résultat ; Voice Trace doit en établir la qualité réelle.

## Décision

1. **GPT Realtime est l'unique chemin vocal temps réel du train de publication.** Une session en
   mode OpenAI utilise OpenAI de l'entrée audio à la sortie audio et ne dépend pas d'une clé Mistral.
2. **Voice Trace appartient au même chemin critique.** Une capacité vocale sans traces corrélées,
   SLO mesurés et diagnostic de ses dégradations n'est pas publiable.
3. **Mistral Realtime V3 est différé après publication.** Ses branches, décisions et preuves sont
   préservées, mais aucun développement V3 supplémentaire ni activation de production n'entre dans
   ce train.
4. Le code Mistral déjà intégré reste derrière des flags désactivés. Une garde anti-drift doit
   empêcher son activation accidentelle dans les profils de publication.
5. Les use cases, outils agentiques, politiques de consentement, événements d'audit et contrats de
   contexte restent provider-neutral. Le fournisseur vocal est un adapter, jamais une autorité
   métier.
6. Une défaillance OpenAI n'autorise pas une bascule silencieuse vers Mistral. Le produit annonce
   la dégradation et propose reconnexion, mode manuel ou repli explicitement spécifié.

L'[ADR-0001](0001-bob-live-mistral-conversation-v2.md) et l'[ADR-0003](0003-mistral-v2-ordered-retention.md)
restent les contrats techniques de la solution Mistral préservée. Le présent ADR les remplace
uniquement comme **priorité de publication**, sans invalider leurs invariants de sécurité.

## Critères de réactivation de Mistral V3

Le chantier peut être rouvert après publication par un nouvel ADR si au moins un besoin mesuré le
justifie :

- GPT Realtime manque durablement les SLO de qualité ou disponibilité ;
- son coût réel dépasse le budget produit validé ;
- les exigences de résidence, RGPD ou souveraineté ne peuvent pas être satisfaites ;
- Bob Pro décide de commercialiser une infrastructure vocale européenne propriétaire.

La réactivation exige alors une lane financée, une matrice de tests équivalente à OpenAI, une
certification device et une stratégie de maintenance. L'existence de code ou de branches anciennes
ne suffit pas.

## Conséquences

Positives : réduction du chemin critique, une seule matrice de QA, moins de secrets et de chemins
de panne, intégration Git plus rapide, effort concentré sur la fluidité et les missions complètes.

Négatives : dépendance temporaire à OpenAI pour la voix premium, exposition à ses coûts et à sa
disponibilité, risque de dérive du code Mistral tant qu'il est gelé. Ces limites doivent être
mesurées et présentées honnêtement.

## Preuves attendues

- test de configuration démontrant qu'une session OpenAI ne réclame ni n'appelle Mistral ;
- test anti-drift des flags de publication ;
- traces device réelles p50/p95 et barge-in ;
- scénario mission complète avec outils réels et confirmation ;
- inventaire Git attestant que les travaux Mistral V3 sont sauvegardés sans être activés.

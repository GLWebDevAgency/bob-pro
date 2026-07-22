# UX-ADR-003 — Projection visuelle Bob Live

## Statut

Proposed — 2026-07-23

## Décideurs attendus

Bob Live owner, Mobile tech lead, Design owner, Security/Privacy et QA voix. Décision attendue en
Vague 0 ; activation interdite avant disponibilité et certification des événements runtime.

## Contexte

Les surfaces actuelles projettent plusieurs phases runtime vers quelques états visuels et utilisent
des pulses minutés. Des composants d'orb/thinking existent mais ne constituent pas l'autorité de
session. Le train de publication priorise GPT Realtime ; les outils et contrats doivent rester
provider-neutral.

## Drivers

- zéro phase fictive ;
- aucune autorité UI sur le transport ou les mutations ;
- signature Bob unique ;
- amplitude réelle et éphémère ;
- SLO voix inchangés ;
- accessibilité et confidentialité.

## Options

### A — Timers locaux et états UI autonomes

Simple mais trompeur, non réconciliable et impossible à certifier.

### B — Brancher directement l'UI sur chaque provider

Plus riche à court terme mais duplique les sémantiques et lie la marque au transport.

### C — Projection pure provider-neutral

Le runtime publie des événements sémantiques ; la présentation les projette vers un view model avec
générations et rejette le tardif.

## Preuves minimales pour accepter la décision

- inventaire signé des événements canoniques réellement disponibles, incluant générations,
  playback, reconnexion et erreurs typées ;
- prototype pur runtime-event→view-model sur fixtures, sans timer décoratif ni autorité de commande ;
- faisabilité amplitude input/output ou fallback honnête documenté ;
- baseline Voice Trace et plan démontrant que le renderer ne se place pas sur le chemin audio ;
- revue Security/Privacy sur l'éphémérité et l'absence de contenu télémétré.

## Décision proposée

Retenir C :

- contrat `BobVisualState` dans la couche mobile experience ;
- projection pure et testée ;
- phase visuelle toujours reliée à une source ;
- amplitude input/output via port éphémère, aucune persistance ;
- renderer/flag figé au démarrage d'une session ;
- kill switch visuel indépendant du provider ;
- Reduced Motion et captions obligatoires.

## Conséquences

Positives : vérité, portabilité provider, tests déterministes, meilleure récupération.
Négatives : peut exiger d'exposer des événements sémantiques manquants ; synchronisation générations
et playback plus stricte.

## Contraintes sécurité/confidentialité

- Aucun audio, transcript, amplitude fine ou argument outil dans la télémétrie.
- Le view model ne peut pas exécuter d'outil.
- Success seulement après ACK/relecture.
- Le transcript ne vaut jamais consentement.

## Critères de vérification de l'implémentation

- [ ] Tous les états du diagramme possèdent source et tests.
- [ ] Événements tardifs/désordonnés rejetés.
- [ ] Barge-in visuel < 100 ms et SLO audio tenus.
- [ ] Erreur/reconnexion ne tombent pas en idle.
- [ ] Reduced Motion, transcript et Stop certifiés.
- [ ] Flag renderer indépendant du flag transport.

## Réexamen

Réexaminer si le runtime canonique change de sémantique d'événements, si un port d'amplitude fiable
devient indisponible, si la projection ajoute une latence audio, ou avant toute tentative de donner
une autorité de commande au renderer.

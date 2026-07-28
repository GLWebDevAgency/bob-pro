# Stratégie de tests et de validation

> Statut : **Proposed**
> Périmètre : design, motion, navigation, contenu, accessibilité, performance et non-régression

## Principe

Les tests ne prouvent pas seulement que l'animation se joue. Ils prouvent que l'état final est
correct avec animation complète, réduite, interrompue ou absente, et que le métier reste inchangé.

## Pyramide

| Niveau | Objet | Vitesse | Autorité |
| --- | --- | --- | --- |
| Statique | Imports, tokens, route matrix, types et clés i18n. | Très rapide | CI chaque PR |
| Unitaire | Projections, policies, reducers, timings et fallbacks. | Rapide | CI chaque PR |
| Composant | Sémantique, états, focus, cleanup et snapshots. | Rapide/moyen | CI ciblée |
| Intégration | Navigation, data state, mutations et layout. | Moyen | CI/preview |
| Visuel | Rendu déterministe multi-size/modes. | Moyen | PR de migration |
| E2E natif | Parcours réels sur build preview. | Lent | Gate de slice/vague |
| Appareil/perf | Sensation, audio, haptique, GPU, batterie. | Manuel/automatisé | Gate canary |

## Tests statiques

- Garde d'import Clean Architecture.
- Interdiction des durées/easing inline hors allowlist.
- Interdiction d'import transitif Reanimated/Haptics/Glass.
- Route matrix exhaustive par rapport aux fichiers `app`.
- Chaque clé de statut existe dans les trois personnalités.
- Chaque motion intent possède une variante reduced.
- Chaque surface adaptative possède fallback opaque.
- Chaque ID G/V/S/T apparaît dans la matrice de traçabilité.
- Chaque ID possède exactement une ligne dans le registre de preuves ; `Verified` implique manifest,
  build, owner, reviewers et verdict admissible.
- Aucun WP/gate inconnu, doublon d'ID ou cycle de dépendances ; les enfants respectent
  `WP-####-NN`.
- Aucun ADR ne devient `Accepted` sans owner nommé et preuves minimales de décision ; les critères
  post-implémentation restent séparés.
- Aucun nouvel usage des composants deprecated.

## Tests unitaires

### Motion policy

- full, crossfade_only, off ;
- changement de préférence ;
- interruption/redirection ;
- entrée/sortie symétrique ;
- stagger cap ;
- validation des valeurs bornées.

### StatusBar/surfaces

- fond clair/sombre ;
- modal transparente ;
- transition route ;
- reduce transparency ;
- capability Glass/Blur absente ;
- increase contrast.

### Bob projection

- chaque phase canonique ;
- événement dupliqué ;
- événement tardif/génération ancienne ;
- perte réseau/reconnexion ;
- barge-in ;
- error ne devient pas idle ;
- success seulement après ACK ;
- input/output amplitude distincts ;
- cleanup.

### Content state

- mapping erreur → message/action ;
- unknown après timeout ;
- statut temporel ;
- snapshots Pote/Pro/Direct ;
- absence de millésime figé dans les clés durables.

## Tests composants

Pour chaque primitive :

- nominal ;
- press/selected/focused ;
- disabled ;
- loading ;
- success autoritaire ;
- recoverable/terminal error ;
- grandes polices ;
- Reduce Motion/Transparency ;
- VoiceOver/TalkBack props ;
- unmount pendant animation ;
- double tap ;
- absence d'haptique non autorisée.

### Sheet

- detents ; drag ; vélocité ; scrim ; clavier ; focus ; Escape ; back Android ; dirty state ;
rotation ; reduced motion ; une seule sheet ; retour focus.

### Tab bar

- sélection ; retap ; badge ; état préservé ; deep link ; clavier ; safe area ; rotation ;
screen reader ; flag figé au démarrage.

### Layout transition

- ajout, suppression, tri, expansion ;
- keys stables ;
- scroll offset ;
- focus ;
- interruption ;
- grande liste ;
- reduced motion.

## Tests intégration

| Parcours | Assertions critiques |
| --- | --- |
| Today priorité | Pending, ACK, check, repli, tri, compteur et erreur. |
| Client → fiche | Source/destination, back, scroll conservé, objet absent. |
| Document → dossier | Relocalisation après succès, échec reste source, compteur exact. |
| Devis lignes | Ajout/suppression, totals identiques, draft, clavier, double tap. |
| Facture génération | Idempotence, pending, résultat unique, détail exact. |
| Notification lue | Optimisme borné, rollback, badge synchronisé. |
| Scan | Permission, capture, upload, analyse longue, retry, document créé. |
| Assistant | Streaming blocs, auto-scroll conditionnel, card growth, erreur. |
| Bob Live | Connexion, écoute, commit, outil, parole, barge-in, reprise, fin. |

## Régression visuelle

### Captures déterministes

- Motion OFF pour le snapshot final.
- Horloge, données et IDs stabilisés uniquement en environnement test.
- Aucune fixture de capture ne pénètre l'artefact production.
- Comparer géométrie, rôle de couleur, typography et état.

### Variantes

| Axe | Valeurs minimales |
| --- | --- |
| Taille | Téléphone compact, standard, grand, tablette. |
| OS | iOS cible minimum/actuel, Android minimum/médian/actuel. |
| Police | Standard, ~150 %, ~200 %. |
| Apparence | Light ; dark si activé. |
| Accessibilité | Reduce Motion, Reduce Transparency, Increase Contrast. |
| Data | Loading, empty, data, error, offline, pending, success. |

Un diff visuel accepté porte une justification. Les seuils automatiques ne remplacent pas la revue
de sens.

## Validation d'utilisabilité et de compréhension

Les tests techniques ne prouvent pas que la hiérarchie est comprise. Chaque pilote de vague et
chaque parcours financier, documentaire ou vocal fortement remanié fait donc l'objet d'une session
basée sur des tâches avec des utilisateurs représentatifs de la cible validée par Produit.

### Protocole minimal

- comparer la baseline et le prototype/build sans expliquer la nouvelle interface ;
- inclure des personnes novices et régulières, sur téléphone personnel ou appareil équivalent ;
- demander des tâches concrètes : identifier la priorité, retrouver un client, expliquer un statut,
  créer/réviser un document, récupérer une erreur, interrompre Bob ;
- observer réussite, hésitations, retours arrière, erreurs, compréhension du statut, confiance et
  capacité à prédire la conséquence du CTA ;
- tester au moins une erreur, un état `pending` et un statut `unknown`, pas seulement le happy path ;
- ne collecter aucune donnée de production ; utiliser fixtures consenties et sessions enregistrées
  seulement avec accord, durée de conservation et accès définis ;
- séparer problème de compréhension, préférence esthétique et bug fonctionnel dans la synthèse.

Le nombre de participants est calibré avec la recherche produit ; il n'est pas utilisé pour faire
passer un résultat qualitatif pour une preuve statistique. Une confusion sur un montant, une
confirmation, une permission, un statut de succès ou l'écoute Bob est un écart P0/P1 à corriger,
même si une seule personne la révèle.

### Preuves de sortie

- script et profils de recrutement non identifiants ;
- synthèse par tâche et sévérité ;
- clips/captures expurgés si consentis ;
- décision de conception et lien vers les exigences concernées ;
- comparaison à la baseline ;
- retest des écarts critiques avant canary.

Un A/B test de conversion ne peut jamais autoriser un dark pattern, une perte d'accessibilité ou un
libellé moins vrai.

## E2E natif

Parcours minimum :

1. cold auth/onboarding ;
2. Today → priorité → résultat ;
3. Clients → fiche → action ;
4. Ventes → devis/facture → détail ;
5. création facture/devis avec reprise de brouillon ;
6. Documents → scan → analyse → classement ;
7. Argent → période/scénario ;
8. Assistant texte → proposition → confirmation ;
9. Bob Live → mission → barge-in → résultat/erreur ;
10. Compte/réglages → sauvegarde ;
11. deep links callback/recovery/legacy voice ;
12. background/foreground et process restart.

## Matrice appareils

| Classe | But |
| --- | --- |
| iPhone compact 60 Hz | Petit viewport et performance de base. |
| iPhone standard 60 Hz | Référence principale. |
| iPhone ProMotion | Fluidité 120 Hz et adaptation. |
| iPad/split view | Composition adaptative. |
| Android minimum supporté | Fallback, mémoire, navigation système. |
| Android médian réel | Cible artisan et performance principale. |
| Android haut de gamme/latest | APIs/matières récentes. |

Les modèles exacts sont figés à Vague 0 selon analytics de parc, disponibilité et minimum produit.

## Accessibilité manuelle

Pour chaque parcours critique :

- VoiceOver et TalkBack depuis cold start ;
- ordre/focus ;
- labels, valeurs et états ;
- grands textes ;
- actions swipe/drag alternatives ;
- Reduce Motion/Transparency ;
- contraste et différenciation sans couleur ;
- dictée/Voice Control si formulaire ;
- captions/Stop/retry Bob.

La passe est signée par personne/date/appareil/build et produit des écarts traçables.

## Bob Live/acoustique

- Micro permission allow/deny/blocked.
- Silence, bruit, parole courte/longue.
- Input amplitude et output amplitude.
- Faux barge-in/écho : zéro toléré selon invariant existant.
- Interruption répétée.
- Bluetooth, haut-parleur, écouteur si supportés.
- Appels/route audio/background.
- Réseau lent/perdu/repris.
- Session renderer legacy/v2.
- Reduced Motion pendant session.
- Haptique désactivée puis active, observation perturbation micro.
- SLO p50/p95 avec Voice Trace.

## Finance et sécurité

Chaque écran financier/sensible inclut :

- mêmes montants avant/après refonte ;
- même use case voix/tap ;
- confirmation inchangée ;
- idempotence/double soumission ;
- conflit de révision ;
- timeout résultat inconnu ;
- relecture serveur ;
- aucun succès prématuré ;
- RLS/tenant inchangés ;
- aucune donnée fictive ;
- logs/analytics sans donnée sensible.

## Performance

Exécuter les scénarios `PERF-01` à `PERF-12` du document performance avec :

- build release ;
- trois warm runs ;
- mémoire avant/après répétition ;
- frames JS/UI ;
- température/batterie pour voix/scan ;
- Voice Trace pour Bob ;
- comparaison version legacy/nouvelle.

## Gates CI proposées

1. format/lint/typecheck ;
2. tests tokens/UI/mobile ciblés ;
3. garde d'imports ;
4. route/ID matrices ;
5. snapshots i18n critiques ;
6. visual tests stables ;
7. `expo-doctor` et `expo install --check` après changement natif ;
8. preview builds iOS/Android avant canary ;
9. suites globales avant merge/release ;
10. preuve appareil hors CI pour les gates acoustiques/haptiques.

## Dossier de preuve

Le stockage et le suivi suivent le [registre de preuves](./18-evidence-register.md) et le
[manifest normatif](./evidence/README.md). Un artefact non référencé par un manifest n'a pas de
valeur de gate.

Chaque work package fournit :

- commit/build ;
- IDs audit ;
- captures avant/après ;
- vidéo nominal/reduced/interruption ;
- résultats tests ;
- appareil/OS ;
- profiling ;
- revue accessibilité ;
- risques résiduels ;
- flag et rollback ;
- verdict signé.

## Critères de sortie

- [ ] Tous les niveaux pertinents de la pyramide sont verts.
- [ ] Les parcours métier et erreurs majeures sont couverts.
- [ ] La matrice appareils/modes est complète.
- [ ] Tests financiers et Bob Live satisfont leurs invariants.
- [ ] Visual diffs expliqués et approuvés.
- [ ] Validation de compréhension effectuée pour les pilotes et flux à fort enjeu, écarts critiques retestés.
- [ ] Performance et accessibilité signées sur appareils.
- [ ] Dossier de preuve lié dans la traçabilité.

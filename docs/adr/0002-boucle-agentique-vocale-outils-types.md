# ADR-0002 : Bob orchestre des missions complètes avec des outils typés

## Statut

Proposed — 2026-07-17. Verdict GPT favorable avec amendements à la proposition Claude. Le statut
ne passe à `Accepted` qu'après challenge Claude, gel des contrats de sécurité et validation du cas
canonique catalogue. Aucun ancien classifieur n'est supprimé avant une migration verticale verte.

## Contexte

Le pipeline actuel sépare classification d'intention, matchers d'écran et extraction de champs.
Il peut reconnaître des commandes ciblées, mais perd de l'information entre les étages et ne sait
pas poursuivre naturellement une mission de l'étape initiale à sa fin.

La cible produit est plus large qu'« ajouter une ligne ». Un artisan doit pouvoir dire d'une
traite :

> Fais un devis pour Camping Les Pins avec deux heures de main-d'œuvre plomberie, un chauffe-eau
> 200 litres, 30 % d'acompte et une validité de trente jours.

Bob doit extraire tout ce qui est déjà dit, rechercher les données utiles, faire avancer le même
wizard que le doigt et ne reprendre la parole de l'utilisateur que pour :

- une ambiguïté réelle ;
- une donnée obligatoire réellement absente ;
- une confirmation proportionnée au risque ;
- une dépendance externe impossible à simuler, comme une signature client.

Le cas d'acceptation n°1 est « ajoute deux heures de main-d'œuvre » avec recherche prioritaire dans
le catalogue, une à trois propositions et une sélection équivalente à la voix ou au doigt.

Mistral documente le function calling et le supporte notamment avec Mistral Small 4
(`mistral-small-2603`) et Mistral Medium 3.5 (`mistral-medium-3-5`). Small 3.2, envisagé pendant
le cadrage initial, est déprécié depuis le 30 avril 2026 et n'est donc pas une cible de
production. La boucle assistant → appel d'outil → résultat d'outil → assistant rend
l'architecture possible, mais ne prouve ni sa qualité sur le français métier ni sa latence :
ces deux propriétés doivent être certifiées par nos évaluations.

## Décision drivers

- missions bout-en-bout, pas collection de commandes isolées ;
- parité stricte : voix et doigt invoquent la même commande applicative ;
- un seul cerveau conversationnel et aucun prix, identifiant ou droit inventé par le LLM ;
- feedback utile en moins de deux secondes sur le chemin vocal nominal ;
- corrections, interruptions et changements manuels sans écraser un état plus récent ;
- confirmation groupée aux bons moments, jamais après chaque champ ;
- provider neutral : même protocole pour Mistral et OpenAI ;
- reprise après réseau/app kill, idempotence et audit des effets ;
- migration écran par écran avec rollback.

## Options considérées

### Étendre les regex et le classifieur d'intentions

Rejeté comme architecture cible. Les parseurs déterministes utiles restent des fast paths, mais un
classifieur ne doit plus être la porte obligatoire vers une capacité. Il ne peut pas orchestrer
une recherche, interpréter son résultat, demander un choix puis poursuivre le plan sans multiplier
des machines de dialogue divergentes.

### Laisser le LLM piloter librement toute l'application

Rejeté. Le modèle peut proposer un plan et choisir un outil, jamais devenir l'autorité métier. Les
préconditions, droits, transitions, calculs, idempotency keys et confirmations restent dans le
harness et les use cases déterministes.

### Une boucle agentique composée uniquement d'outils atomiques

Non retenu seule. Un devis dicté en une phrase provoquerait trop d'allers-retours modèle et une
latence médiocre. Les outils atomiques restent nécessaires aux corrections, mais les parcours
fréquents utilisent aussi des outils macro orientés résultat.

### Boucle hybride : fast paths + outils macro + outils atomiques

Retenu. Le même contrat produit un résultat structuré, quel que soit le chemin. Un fast path local
peut répondre immédiatement aux formulations fréquentes ; la boucle LLM traite les demandes
complexes et poursuit après chaque résultat d'outil.

## Décision

### 1. Une mission est l'unité conversationnelle

Le vocabulaire sépare deux cycles de vie qui ne doivent jamais être confondus :

- `VoiceSession` est la session de transport Bob Live (`sessionHandle`) ;
- `AgentMission` est la mission métier, qui peut survivre à une navigation et à une reconnexion.

Bob maintient une `AgentMission` fencée par tenant, utilisateur, identité de mission et génération.
L'objectif de mission est indépendant de l'écran : il doit survivre aux navigations qu'il provoque
et au remplacement d'une `VoiceSession`. Seuls les appels d'outils locaux sont fencés par écran
attendu, révision de contexte et révision de brouillon. La mission porte un objectif, des étapes
typées, les données déjà acquises et un état :

```text
planning → running ↔ waiting_user → review_required → running → completed
                    ↘ waiting_external ↗
                    ↘ blocked | cancelled
```

Après chaque résultat d'outil, le runner décide de poursuivre, demander une information, présenter
un diff, attendre un événement externe ou terminer. La boucle est bornée par nombre d'étapes,
deadline et budget. Une interruption utilisateur annule la génération en cours avant de replanifier.

Au démarrage, le runner transforme la dictée globale en objectif, slots acquis et graphe de
dépendances. Il groupe les lectures indépendantes, accumule les champs manquants et présente une
seule interaction quand plusieurs précisions peuvent être demandées ensemble. Il ne redemande
jamais une information déjà dite et validée. Un changement manuel devient un nouvel événement de
mission : Bob relit l'état courant et poursuit au lieu de rejouer son ancien plan.

Le checkpoint de mission est structuré, chiffré, lié au tenant/utilisateur et borné par TTL. Il
contient objectifs, slots, révisions, appels/résultats et interactions en attente, jamais la chaîne
de pensée du modèle. La reprise effectue un handshake avec l'état métier réel. Toute proposition,
confirmation ou option périmée est recalculée et représentée, jamais exécutée au redémarrage.

En mode connecté, l'API est l'unique propriétaire de l'`AgentMission` canonique et l'avance par
compare-and-swap durable sur sa génération/révision. Le mobile exécute les outils locaux et tient
un inbox/outbox de requêtes, résultats et reçus tenant-scopés ; il ne peut pas faire avancer seul
la mission globale. Après reconnexion, le handshake compare les reçus ainsi que les révisions de
contexte, brouillon et catalogue avant toute reprise. Hors ligne, Bob peut uniquement préparer un
staging local sans effet externe ; sa promotion en mission connectée exige une réconciliation
explicite et une nouvelle présentation des confirmations devenues caduques.

Une mission peut couvrir devis, facture, création client, catalogue, document/dépense,
notification ou paiement. Elle ne prétend jamais franchir un événement externe : une signature ou
un paiement place la mission en `waiting_external`, puis un événement authentifié peut la reprendre.

| Boucle                                   | Faisable                     | État actuel                                                     | Fin autonome honnête                                                                                                  |
| ---------------------------------------- | ---------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Devis                                    | Oui pour préparer            | step-by-step présent ; brief global et cartes de choix manquent | client/lignes/catalogue/TVA/acompte/validité → revue ; envoi confirmé séparé ; signature client en `waiting_external` |
| Facture depuis devis                     | Oui sous précondition        | use case actuel exige un devis signé                            | devis signé authentique → revue → génération confirmée → envoi séparé                                                 |
| Facture directe depuis brief             | Cible, gap bloquant          | aucun use case manuel équivalent aujourd'hui                    | use case manuel/core à construire avant tout outil vocal                                                              |
| Client                                   | Oui, périmètre actuel limité | UI actuelle : nom + type ; contact/SIRET/dédoublonnage manquent | création nom/type ; enrichissement et dédoublonnage restent une cible                                                 |
| Catalogue                                | Oui                          | recherche/tap locaux présents ; dialogue top 3 manque           | recherche/création/modification ; aucun écrasement sans diff                                                          |
| Document/dépense                         | Oui après capture/import     | OCR/classement partiels ; mission unifiée manque                | explication → dossier/catégorie → revue → archivage/original conservé                                                 |
| Notification/relance                     | Oui                          | lecture/navigation présentes ; orchestration à compléter        | lecture → proposition de relance → envoi confirmé                                                                     |
| Paiement                                 | Partiel                      | enregistrement présent ; banque externe                         | préparation/enregistrement confirmé puis attente du prestataire réel                                                  |
| Signature, dépôt fiscal, clôture externe | Avec attente                 | préparation partielle                                           | préparation complète puis `waiting_external` ou validation expert/humaine                                             |

Une phrase contenant dix informations produit dix slots en mémoire et non dix questions. L'ordre
du wizard devient une présentation de l'état, pas l'ordre imposé à la parole de l'utilisateur.

### 2. Outils macro pour les parcours complets, atomiques pour les corrections

Les parcours majeurs exposent un outil macro, par exemple :

- `quote.prepare_from_brief` ;
- `invoice.prepare_from_brief` / `invoice.prepare_from_quote` ;
- `customer.prepare_create` ;
- `document.prepare_filing` ;
- `expense.prepare_from_document`.

`quote.prepare_from_brief` reçoit tous les slots extraits en un appel : référence client, lignes,
acompte, validité, contexte TVA, notes et intention d'envoi. Le use case décompose ensuite le
travail avec les moteurs déterministes et renvoie soit un choix, soit les champs manquants, soit un
diff global prêt à confirmer. Bob ne fait donc pas un tour LLM par champ.

Un outil `*.prepare_*` est pur vis-à-vis des effets externes : il calcule un staging ou un brouillon,
mais ne signe, n'envoie, n'émet et n'encaisse rien. Les mutations confirmées sont des outils
séparés. Chacune porte `invocationId`/idempotency key, digest de l'intention et du plan, versions
de schéma/outil, révisions de base, TTL et produit un reçu durable réconciliable. Un lot
partiellement committé reprend étape par étape ; il ne rejoue jamais aveuglément les effets déjà
acquittés.

La signature du client ne peut jamais être synthétisée depuis une confirmation orale de
l'artisan, un nom de client ou une intention d'envoi. `quote.prepare_from_brief` finit au
brouillon/revue ; `quote.send` est confirmé séparément ; la signature authentifiée reprend la
mission via `waiting_external`. Une facture depuis devis ne devient éligible qu'après cette preuve.
Tous les termes contractuels — lignes, TVA, validité, acompte et mentions — sont gelés et présentés
avant l'envoi/signature. Une modification ultérieure invalide la demande ou la preuve de signature
au lieu de l'attacher à un devis dont les termes ont changé.
De même, `document.prepare_filing` ne classe rien : `document.file` est une mutation séparée,
confirmée et auditée.

Les outils atomiques (`catalog.search`, `quote.line.prepare`, `quote.term.update`, etc.) servent à
une correction, à une reprise partielle ou à un cas non couvert par le macro. Les lectures peuvent
être parallélisées ; les mutations restent séquentielles et fencées.

### 3. Frontières de vérité

- Cible : `packages/core` possède les commandes, valeurs métier, résultats, diffs et invariants. Aucun
  JSON Schema fournisseur n'y entre.
- `packages/ai` décrit les outils provider-neutral, leurs schémas JSON stricts, le runner de
  mission, les codecs d'interaction et la politique de confirmation.
- `apps/mobile` lie les outils locaux au catalogue et au brouillon affiché ; le tap et la voix
  appellent le même handler.
- `apps/api` lie les outils serveur aux use cases, RLS, outbox et propositions opaques.
- Les adapters Mistral/OpenAI ne font que traduire le contrat commun vers leur function calling.

Cette frontière est à construire, pas un acquis : les `QuoteDraftCommand` et diffs riches actuels
vivent encore dans l'application mobile, tandis que `AgentSurface` expose des closures `match/run`
et `say` non sérialisables. Leur migration vers des contrats typés, réconciliables et testables est
une étape explicite avant d'activer le runner sur un parcours de production.

Un argument LLM n'est jamais une preuve. Les montants viennent d'un énoncé validé ou d'une entrée
catalogue authentique ; les candidats sont référencés par identifiant et snapshot, jamais recopiés
librement par le modèle. Toute réponse est revalidée contre la révision courante avant effet.
Les sorties de recherche client/catalogue/OCR sont des données non fiables, jamais des
instructions : elles sont sanitisées, bornées au top K utile et résistent aux injections de prompt.

Les outils locaux passent par un broker mobile borné : `missionId`, `toolCallId`, génération,
écran attendu, `contextRevision`, `draftRevision`, deadline et allowlist. Le runner attend l'ACK
du nouvel écran avant de poursuivre après une navigation. La mission reste la même ; seul l'appel
qui cible l'ancien écran devient caduc.

Le protocole conversationnel ADR-0001 ne transporte pas encore ces outils locaux ni les
interactions riches. Il doit être amendé avant l'implémentation avec au minimum les événements
corrélés et durables suivants :

- `tool.request` : identité mission/appel, outil, arguments validés, cible mobile ou serveur,
  génération, révisions attendues et deadline ;
- `tool.result` : identité appel, statut typé, résultat borné/sanitisé et révisions observées ;
- `interaction.present` : identité interaction, type fermé, options gelées, révision et expiration ;
- `interaction.resolve` : identité interaction, `choiceId`, source voix ou tap et révision ;
- `tool.cancelled` et ACK/replay explicites pour distinguer inconnu, annulé et terminé.

Les `toolCallId` et `interactionId` sont idempotents. Un replay restitue le résultat journalisé
sans réexécuter l'effet ; une génération ancienne ou une révision périmée échoue fermée. Une
perte de socket ne transforme jamais un appel incertain en succès. Les payloads sont bornés,
versionnés et sans secret. Enfin, un outil serveur ne fait jamais confiance à un résultat mobile
pour franchir RLS, confirmer une identité ou autoriser une mutation serveur.

### 4. Catalogue : interaction canonique bimodale

`catalog.search` s'exécute localement tant que le catalogue reste dans AsyncStorage. Il classe
uniquement les entrées personnelles chiffrables ; une suggestion métier indicative ne fournit
jamais silencieusement un prix.

Le stockage actuel `bob.catalogue.perso` est une clé globale et ne peut donc pas alimenter ce cas
en production. Avant activation, le catalogue est migré vers une identité
`(companyId, userId, schemaVersion)` dans un stockage chiffré ou serveur. Les caches mémoire sont
purgés au logout ; la clé legacy est mise en quarantaine ou abandonnée si son propriétaire ne peut
pas être prouvé. `catalog.search` échoue fermé si l'identité ou la révision manque.

Le matcher actuel par sous-chaîne ne suffit pas. La migration introduit un scorer déterministe
testé : normalisation accents/unités/synonymes métier, tokens significatifs, compatibilité de
catégorie et unité, seuil de match fort et marge entre rangs. Le top 3 transporte identifiant,
snapshot/fingerprint et révision de catalogue ; aucun score LLM ne déclenche seul un match fort.

- match fort unique : carte « Heure de main-d'œuvre plomberie — 55 €/h » avec diff exact ;
- deux ou trois matchs plausibles : cartes numérotées + « Créer une ligne libre » ;
- aucun match : extraction libre et demande du seul champ manquant ;
- « le premier », le libellé prononcé ou un tap émettent le même `choiceId` gelé ;
- un changement de catalogue ou de brouillon invalide le choix avant son application.

La carte conversationnelle grandit dans l'overlay Bob. Elle rend un protocole fermé
`AgentInteraction` (`choice`, `missing_fields`, `review`, `progress`, `error`) ; le LLM ne fournit
ni JSX ni layout. Chaque option reste accessible à Dynamic Type, VoiceOver et TalkBack.

Pour plusieurs candidats, la sélection prépare la ligne puis le diff final est confirmé. Pour un
match unique dont le diff complet a déjà été rendu et lu, le « oui » peut constituer cette
confirmation si la policy de risque l'autorise. Une ligne libre n'est pas automatiquement ajoutée
au catalogue : l'enregistrement catalogue est une action séparée.

### 5. Confirmation et fluidité

Le runner ne demande pas une validation à chaque étape :

- lire, chercher, filtrer et naviguer : automatique ;
- calculer/prévisualiser un staging sans modifier le brouillon : automatique et visible ;
- muter un brouillon local : selon policy ; sous `confirm_all`, diff puis confirmation ;
- ambiguïté : choix uniquement ;
- mutation financière/externe : diff groupé puis confirmation ;
- irréversible ou fortement sensible : challenge visuel/biométrique selon la policy.

Une dictée complète prépare donc tout le devis et produit une seule revue globale, sauf ambiguïté
catalogue/client ou donnée légalement indispensable. Les modifications manuelles republient la
révision et la boucle reprend depuis l'état réel au lieu d'écraser l'utilisateur.

Une confirmation opaque lie tenant/utilisateur, outil et versions de schéma, digest des arguments
et du plan, révisions de base et TTL. Un « oui » n'est valide qu'après la présentation d'une unique
proposition exacte, son ACK UI/audio et la vérification de révisions inchangées.

Une interruption annule génération, TTS et résultats tardifs, mais ne prétend jamais rollbacker un
effet déjà committé. Le runner réconcilie les reçus avant de replanifier. Une correction supersède
la proposition active ; « annule » demande ou déduit sans ambiguïté s'il annule une proposition,
une étape réversible ou la mission entière.

### 6. Routage modèle

- fast path local pour commandes fréquentes, réponses ordinales, oui/non, corrections et
  catalogue disponible localement ;
- Mistral Small 4 (`mistral-small-2603`) candidat au tool calling simple, température nulle et
  appels parallèles désactivés par défaut ; il n'est activé qu'après corpus vert ;
- escalade vers Mistral Medium 3.5 (`mistral-medium-3-5`) sur signaux observables : schéma
  invalide, outil absent malgré capacité,
  ambiguïté multi-domaine ou échec répété. Aucune « confiance » auto-déclarée du modèle ;
- Large réservé aux missions complexes qui dépassent les SLO ou au conseil, pas au hot path par
  défaut ;
- modèles datés en production, alias `latest` uniquement en canary ;
- même politique pour OpenAI avec un adapter différent, jamais deux fournisseurs dans une mission.

Le runner reste chez Bob plutôt que dans un Agent Mistral géré afin de conserver sécurité,
observabilité, portabilité et contrôle des données. Le Chat/Conversations API peut être un adapter
ultérieur, pas une nouvelle autorité.

### 7. SLO, progression et budgets

- acquittement local (« je m'en occupe » ou UI progress) p95 ≤ 300 ms ;
- première interaction utile, ancrée sur une donnée/outcome réel, p95 ≤ 2 s sur la route
  nominale ; un simple « je m'en occupe » ne compte pas comme résultat utile ;
- barge-in → silence Bob p95 ≤ 200 ms sur appareils certifiés ;
- fin de mission, coût et nombre d'appels mesurés séparément de l'acquittement ;
- un seul appel modèle avant le premier choix/diff pour un outil macro ;
- progression visible si une mission dépasse 500 ms ;
- nombre d'appels et durée totale bornés, puis repli honnête vers l'écran manuel sans perdre le
  brouillon ;
- métriques par fournisseur, modèle, outil, écran, réseau, appareil et version de schéma.

Ces valeurs sont des gates Bob à mesurer, pas des performances supposées du fournisseur.

### 8. Évaluations par trajectoire

La certification porte sur la trajectoire complète, pas seulement sur l'intent : texte STT →
outils choisis → arguments → résultats → questions → confirmations → état métier final.

Corpus initial minimum : 250 formulations artisan réelles couvrant devis, facture et client, avec
nombres en lettres, accents perdus, homophones, corrections, interruptions et ambiguïtés. Gates :

- outil correct ≥ 98 % sur capacités connues ;
- exactitude des slots obligatoires ≥ 97 % ;
- exactitude des montants, identifiants et choix critiques = 100 % avant effet ;
- rappel catalogue top 3 ≥ 98 %, précision du match fort ≥ 95 % ;
- questions inutiles < 5 % ;
- zéro mutation non confirmée, hors tenant ou fondée sur un montant inventé ;
- voix et tap aboutissent au même journal de commandes ;
- SLO p50/p95 tenus sur appareils et réseaux représentatifs.

Le corpus comporte un holdout non vu pendant le prompt tuning, des injections dans noms/libellés
et OCR, coupures réseau/app kill, résultats dupliqués ou tardifs, choix périmés, édition manuelle
concurrente et tentatives cross-tenant. Un LLM-as-judge peut aider au diagnostic qualitatif, jamais
servir de gate de sécurité ou d'exactitude financière.

Le premier golden test est le scénario catalogue du fondateur. Le second est un devis complet
dicté d'une traite avec plusieurs lignes, acompte, validité, une ambiguïté puis une correction.

## Migration

1. Neutraliser le flux legacy `/voix` qui auto-signe actuellement avec le nom du client ; test
   obligatoire : une confirmation artisan n'appelle jamais `SignQuote`.
2. Réordonner le wizard cible : client/lignes/termes → revue → envoi → signature externe ;
   aucune preuve ne peut précéder une modification d'acompte, de validité ou de contenu.
3. Isoler le catalogue par entreprise/utilisateur et traiter la clé legacy sans ownership prouvable.
4. Amender ADR-0001 avec les appels d'outils locaux, interactions, ACK/replay et fences ci-dessus.
5. Migrer/réconcilier les commandes et diffs mobiles actuels avec les frontières core/AI cibles.
6. Figer l'autorité CAS de l'API, `AgentMission`, checkpoint/reprise, `AgentToolContract`,
   `AgentInteraction` et matrice de risques.
7. Construire le runner provider-neutral et le harness d'évals en shadow mode.
8. Migrer verticalement le devis : brief complet, catalogue top 3, UI choix/revue, voix et tap ;
   séparer strictement envoi, signature externe et facture.
9. Construire les use cases manuels manquants, puis migrer facture et client.
10. Migrer documents/dépenses, notifications et catalogue.
11. Remplacer les matchers/classifieurs écran par écran seulement après parité et SLO verts.
12. Activer par feature flag, canary modèle daté et kill switch ; conserver le staging offline.

## Conséquences

### Positives

- Bob peut terminer un parcours entier avec très peu d'interruptions ;
- un seul contrat aligne manuel, voix, Mistral et OpenAI ;
- les outils macro gardent une latence compatible avec une conversation ;
- les décisions financières restent déterministes, auditables et réversibles avant confirmation.

### Négatives

- nouveau runtime de mission, protocole d'interactions riches et persistance fencée ;
- corpus d'évals et matrice de parité coûteux à maintenir ;
- coexistence temporaire entre anciens matchers et nouveaux outils ;
- catalogue local exige un round-trip d'outil côté mobile pour la boucle serveur.

### Risques et mitigations

- **Boucle infinie** : limite d'étapes, deadline, détection de répétition et annulation.
- **Trop de questions** : outils macro, mémoire des slots et métrique de clarification inutile.
- **Choix catalogue périmé** : identifiant + fingerprint + révision du brouillon.
- **Hallucination d'arguments** : schémas stricts, allowlists et revalidation core.
- **Confirmation fatigante** : diff groupé et policy par risque.
- **Latence réseau** : fast path, outil macro, progression immédiate et escalade mesurée.
- **Divergence manuel/voix** : registre de capacité unique et tests de journal de commandes.
- **Signature usurpée** : preuve client externe obligatoire, jamais déduite d'un acquiescement artisan.
- **Effet incertain après interruption** : reçus durables et réconciliation avant replanification.
- **Split-brain API/mobile** : autorité CAS unique de l'API et mobile incapable d'avancer la mission.
- **Catalogue d'un autre compte** : identité tenant/utilisateur, purge logout et échec fermé.

## Références

- [Mistral — Function Calling](https://docs.mistral.ai/studio-api/conversations/function-calling)
- [Mistral — Build an agent with tools](https://docs.mistral.ai/getting-started/quickstarts/developer/build-an-agent)
- [Mistral Small 4 — model card](https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03)
- [Mistral Small 3.2 — dépréciation](https://docs.mistral.ai/models/model-cards/mistral-small-3-2-25-06)
- `design_handoff_bob_pro/REUNION_NLU_VOCALE_20260716.md`
- ADR-0001 — transport conversationnel Bob Live Mistral.

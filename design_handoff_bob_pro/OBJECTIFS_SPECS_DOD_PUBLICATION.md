# CAP PUBLICATION — OBJECTIFS, SPECS ET DEFINITION OF DONE

**Statut : Accepted**

**Décision fondateur : 2026-07-21**

**Contre-signature Claude : 2026-07-25** — décision fondateur CONFIRMÉE oralement (session du
25/07, audit de main), ce qui solde le « À confirmer #10 » de la matrice, avec deux amendements
fondateur :

1. **Voxtral tour-par-tour n'est pas retiré** : la bascule GPT Realtime ↔ Voxtral tour-par-tour
   est une **configuration d'ADMINISTRATION** (jamais un sélecteur utilisateur) — aujourd'hui les
   variables Railway (`BOB_LIVE_ENABLED`/`BOB_LIVE_PROVIDER`), demain le **dashboard admin** (à
   construire) qui permettra de tester l'un ou l'autre sans redéploiement. Les flags concernés
   portent un marqueur `FUTUR DASHBOARD ADMIN` dans `env.ts`.
2. **Le duplex Mistral (« Voxtral live ») devient un chantier parallèle long terme**, construit
   tranquillement hors chemin critique ; sa version complète remplacera le tour-par-tour, sans
   jamais conditionner la publication.

Rappel de dépendance : la DoD §6.3 (« Bob Live passe sur appareils ») reste suspendue à
l'actation par le fondateur de la **clé OpenAI production + budget** (D3 du PROGRAMME).

**Portée : prochaine version publique de Bob Pro**

Ce document est la source de vérité du train de publication. Il remplace toute instruction
antérieure contradictoire sur la priorité des fournisseurs vocaux, l'ordre des chantiers et le
mode de collaboration Git. Les documents historiques restent utiles pour leur architecture et
leurs preuves, mais ne peuvent pas réintroduire un chantier hors du chemin critique défini ici.

La [matrice des flags V1](MATRICE_FLAGS_V1.md) décrit l'état réellement configuré tant que la
bascule GPT Realtime n'a pas été livrée. Elle sera modifiée **dans le même lot atomique** que le
code, les gardes d'environnement et les tests anti-drift ; une spec ne doit jamais faire croire
qu'un fournisseur est actif avant que le runtime ne le prouve.

## 1. Objectif produit

Publier le plus rapidement possible une version **stable, fiable et exploitable avec des données
réelles**, dont le différenciateur est une conversation vocale GPT Realtime fluide qui comprend
l'écran courant, accompagne un parcours complet et fait exécuter les mêmes use cases que
l'interface manuelle, avec les mêmes confirmations et les mêmes garde-fous.

La vitesse recherchée est une vitesse de convergence : un seul tronc canonique, une seule priorité
vocale, des lots verticaux courts et des critères de sortie binaires. Une fonctionnalité seulement
présente dans le code, non branchée ou non prouvée sur le chemin réel n'est pas livrée.

## 2. Résultats attendus, dans l'ordre

| ID  | Résultat                                        | Mesure de réussite                                                                                                                                           |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O1  | Vérité Git retrouvée                            | `main` contient tous les lots retenus, compile depuis un checkout propre et devient l'unique base des nouvelles branches.                                    |
| O2  | Facturation conforme et complète                | Le lot Factur-X / PDF-A-3 / TVA / BT-23 est verticalement branché, testé et certifié sans identifiant fiscal inventé.                                        |
| O3  | GPT Realtime est le chemin vocal de publication | Une session utilise OpenAI de l'entrée audio à la sortie audio, sans clé ni service Mistral implicite.                                                       |
| O4  | Bob accompagne une mission continue             | Navigation, changement d'écran, contexte, choix structurés, diff et confirmation restent corrélés jusqu'à réussite, abandon explicite ou erreur récupérable. |
| O5  | Voice Trace rend la qualité pilotable           | Chaque tour produit une trace corrélée ; p50/p95, interruptions, erreurs et dégradations sont observables sans audio ni secret dans les logs.                |
| O6  | Zéro donnée fabriquée en production             | Écrans, API, calculs et réponses Bob utilisent la base du tenant ; absence et erreur sont affichées honnêtement.                                             |
| O7  | Release reproductible                           | Le commit publié passe build, tests, migrations, boot avec l'environnement cible, smoke tests et QA sur appareils réels.                                     |
| O8  | Facturation électronique légalement opérante    | Une PA réelle est intégrée derrière un port, les flux sortants/entrants/statuts/e-reporting sont réconciliés et aucune promesse 2026 ne repose sur un stub.  |

## 3. Périmètre du train

### 3.1 Inclus

- fermeture du lot Factur-X : PDF/A-3, XML embarqué, profil réglementaire, TVA société/client,
  code BT-23 explicite et figé, migrations additives et preuves de conformité ;
- réconciliation Git sur `main`, sauvegarde avant réécriture d'historique et réduction des anciens
  worktrees sans supprimer de travail non intégré ;
- GPT Realtime en plein duplex : streaming audio, VAD, barge-in, arrêt de lecture, reprise et
  fermeture de session déterministes ;
- Voice Trace de bout en bout avec budgets de latence et corrélation mobile/API/provider/outils ;
- contexte d'écran continu, navigation non destructive et boucle agentique typée pour les parcours
  prioritaires ;
- parité voix/tap, propositions inviolables, diffs réels et confirmation obligatoire des mutations ;
- données tenant réelles, états chargement/vide/erreur/données et absence de fixtures dans les
  artefacts de production ;
- accès anticipé sans abonnement payant dans la première version publique, avec état vide honnête
  pour les factures d'abonnement.
- choix d'une PA externe portable ; B2Brouter eDocSync est le candidat prioritaire soumis au gate
  `G-PA-01` de [sa spec](SPEC_CONNECTEUR_PA_B2BROUTER.md). Une diffusion publique portant la
  promesse « conforme 2026 » exige que cette intégration soit certifiée.

### 3.2 Explicitement différé

- **Mistral Realtime V3** : code et décisions préservés, aucune nouvelle implémentation avant la
  publication. Réévaluation post-publication comme solution propriétaire/européenne ou repli si
  GPT Realtime ne satisfait pas les mesures de qualité, coût, disponibilité ou gouvernance ;
- mélange automatique OpenAI/Mistral dans une même session ;
- activation publique des paiements et plans : l'architecture peut rester branchée, mais la V1 est
  en accès anticipé sans plan tant que le train paiement n'est pas certifié ;
- refonte du logo, reprise directement par le fondateur ;
- ajout opportuniste sans lien avec un critère de publication.

## 4. Spécification normative

### 4.1 Sélection du fournisseur vocal

1. Une session de publication choisit `openai` une seule fois au démarrage.
2. En mode OpenAI, capture/transport, compréhension temps réel et synthèse vocale ne dépendent
   d'aucune clé Mistral. Une absence de clé OpenAI refuse clairement l'ouverture de Bob Live.
3. Une panne ne déclenche jamais un changement silencieux de fournisseur. Le produit propose une
   reconnexion, un mode manuel ou un repli explicitement annoncé et mesuré.
4. Les outils métier restent provider-neutral : changer de transport vocal ne change ni les use
   cases, ni les politiques de confirmation, ni les preuves d'audit.
5. Les flags Mistral full-duplex/V3 restent désactivés dans les profils de publication et sont
   protégés contre une activation accidentelle.

### 4.2 Mission conversationnelle continue

Une mission possède un identifiant, un état, une révision de contexte, une révision de brouillon et
un journal d'appels d'outils. Après une navigation, le runner attend l'ACK du nouvel écran, recharge
son contexte réel, puis poursuit la même mission. Il ne repart pas comme une nouvelle conversation.

Pour une demande complète — devis, facture, client, document — Bob :

1. extrait tous les faits exprimés en une fois ;
2. relit les données réelles nécessaires ;
3. exécute automatiquement les lectures et navigations sans risque ;
4. présente un choix structuré seulement en cas d'ambiguïté réelle ;
5. demande uniquement les champs indispensables manquants ;
6. construit un brouillon ou staging, jamais un effet final caché ;
7. affiche et vocalise un diff vérifiable ;
8. recueille la confirmation via le même `choiceId` ou `proposalId` au tap et à la voix ;
9. exécute le use case idempotent, puis relit la base pour annoncer le résultat réel.

La sélection catalogue suit le même protocole : zéro candidat = création libre proposée ; un match
fort = suggestion explicite ; plusieurs candidats = options réelles numérotées ; aucun choix
silencieux du LLM.

### 4.3 Sécurité et vérité métier

- Les lectures peuvent être automatiques. Toute mutation passe par un outil typé et audité.
- Les actions financières, fiscales, contractuelles ou destructrices exigent toujours une
  confirmation explicite, même en mode vocal autonome.
- Les montants, identifiants, libellés de catalogue et statuts annoncés viennent d'un résultat
  d'outil ou de la base, jamais de la prose du modèle.
- Chaque écriture rejouable porte une clé d'idempotence et une révision attendue.
- Une référence hors tenant, périmée ou absente échoue fermée.
- Aucun transcript, audio brut, token ou secret n'entre dans les métriques ou logs applicatifs.

### 4.4 Voice Trace et objectifs de service

Chaque tour corrèle au minimum : session, mission, tenant pseudonymisé, tour, transport, modèle,
horodatages capture/VAD/connexion/premier token/premier audio/fin, appels d'outils, interruption,
repli, erreur et cause normalisée.

| Indicateur device réel                   | Cible p50 |  Cible p95 | Règle                                                     |
| ---------------------------------------- | --------: | ---------: | --------------------------------------------------------- |
| Fin de parole → premier audio Bob        |  ≤ 900 ms | ≤ 1 800 ms | mesuré sur réseau réaliste, hors warm-up identifié        |
| Parole utilisateur → silence Bob         |  ≤ 250 ms |   ≤ 500 ms | arrêt audio réellement observé, pas seulement ACK logique |
| Exécution fantôme                        |         0 |          0 | bloque la release                                         |
| Confirmation perdue ou rejouée deux fois |         0 |          0 | bloque la release                                         |
| Faux succès après perte réseau           |         0 |          0 | bloque la release                                         |

Une cible de latence non atteinte ne peut pas être transformée en succès documentaire : la mesure,
le device, le réseau, le commit et la distribution doivent accompagner le verdict.

### 4.5 Données et états d'interface

- Les chemins de production n'importent ni fixture, ni repository in-memory, ni constante de démo.
- `missing` et `error` donnent `unavailable`, jamais `0` ni un montant crédible inventé.
- Chaque écran de publication couvre chargement, vide, erreur récupérable et données.
- Les valeurs affichées sont relues après mutation ; les optimismes UI restent temporaires et
  réconciliés avec le serveur.
- Le compte propriétaire voit uniquement les données persistées de sa société sous RLS forcée.

### 4.6 Factur-X, règlement et archivage

1. Une facture professionnelle éligible produit un Factur-X **EN16931** PDF/A-3b ; une facture
   B2C produit un PDF seul et rejoint un flux e-reporting PA distinct. Aucun endpoint ou identifiant
   fiscal n'est inventé pour transformer un B2C en B2B.
2. Le profil, la nature BT-23, le traitement TVA, les antécédents, les lignes sources et les
   totaux payables sont des faits d'émission persistés. Un rechargement SQL restitue exactement
   le même XML, PDF, payable et schéma comptable.
3. Les situations facturent de vraies bases de ligne. La finale ne porte que les bases
   résiduelles et toutes les références BG-3 ; les situations ne sont jamais déduites une
   seconde fois. Un marché facturé à 100 % ne produit pas une finale à zéro.
4. La retenue de garantie sépare la créance légale, le payable immédiat et l'allocation des
   encaissements entre comptes `411` et `4117`. La somme des allocations doit égaler le paiement.
5. Une reprise d'acompte dans une finale professionnelle reste fail-closed avant numérotation
   tant que le profil Factur-X EXTENDED et la chaîne PA `386 → finale → 503` ne sont pas
   certifiés. Le produit ne présente pas ce parcours comme disponible pendant cette fermeture.
6. L'archive B2B/B2G attend PDF + XML ; l'archive B2C attend PDF seul. Le périmètre d'un job est
   immuable et la base recalcule sa preuve. Cette preuve relationnelle n'est pas qualifiée WORM
   tant que l'object-lock ou l'archive probante PA n'est pas certifié.
7. L’activation Archive V2 suit deux trains : le premier ferme les sorties HTTP B2C avec un
   marqueur readiness compatible N-1 ; le second applique le schéma, rescane les octets réels,
   atteste les PDF historiques sous le tenant exact, retire N-1 puis active V2 de façon monotone.
8. Le scanner pré-activation inventorie Storage↔SQL dans les deux sens, refuse les orphelins et
   écarts taille/SHA/MIME/version, et exécute Mustang + FNFE sur chaque paire professionnelle.
   Son mode par défaut est sans écriture ; son mode apply ne peut écrire que le lot atomique
   d’attestations exactes et ne supprime jamais un original.
9. Le scanner de release tourne dans un service Railway one-shot isolé, jamais sur GitHub. Sa preuve
   append-only est liée au SHA, au déploiement, à l’identité de base et au bucket ; GitHub ne reçoit
   qu’une enveloppe allowlistée sans donnée métier. Après activation, le mode V2 relit intégralement
   les octets, rejoue les validateurs externes, vérifie les rails relationnels et la baseline du SHA
   d’activation, puis détecte tout remplacement d’un original après sa version immuable sans
   restaurer la capacité historique. Un déclencheur Storage et un verrou global ferment la course
   audit/cutover ; le scan V1 exige un second snapshot et l’activation refait Storage↔SQL sous
   verrou. Le rapport détaillé reste append-only, sous RLS forcée sans policy, et réservé au rôle
   privilégié. Les rôles Data API n’ont ni mutation des singletons, ni accès aux tables privées,
   ni EXECUTE sur l’inventaire fermé des RPC archive.

## 5. Séquence d'exécution imposée

1. Graver ce cap, l'ADR fournisseur et le DoD.
2. Terminer le lot Factur-X/TVA déjà commencé ; fermer tous ses P0/P1 vérifiés.
3. Le tester, le committer atomiquement et créer une sauvegarde Git nommée.
4. Actualiser `main`, rebaser le lot, résoudre les conflits par intention métier et repasser les
   validations depuis l'état rebasé.
5. Intégrer et pousser `main`, puis inventorier/sauvegarder/supprimer les worktrees obsolètes.
6. Créer **une seule branche courte** depuis le nouveau `main` pour GPT Realtime + Voice Trace.
7. Livrer des tranches verticales démontrables, intégrer sur `main`, supprimer la branche, répéter.

Le cadrage contractuel et l'accès sandbox PA peuvent avancer en parallèle sans ouvrir une seconde
lane d'écriture. L'implémentation du connecteur suit une branche courte dédiée après consolidation
du tronc ; elle devient bloquante avant toute promesse publique de transmission automatique.

Pendant qu'un agent écrit, l'autre relit et challenge en lecture seule. La passation du bâton est
explicite. Un worktree séparé n'est créé que pour une isolation indispensable et disparaît dès
l'intégration.

## 6. Definition of Done — binaire

### 6.1 Lot de code

- [ ] Une spec courte lie le changement à un objectif `O*` et énumère ses cas limites.
- [ ] Le domaine reste framework-free ; UI, API et Bob appellent le même use case.
- [ ] Aucun mock/fixture/repository in-memory n'est atteignable depuis l'artefact de production.
- [ ] Tests ciblés verts, puis `pnpm typecheck`, `pnpm test` et `pnpm build` verts depuis un checkout
      propre du commit candidat.
- [ ] Toute migration est additive, rejouable et certifiée sur PostgreSQL réel avec le rôle runtime.
- [ ] Les quatre états UX, i18n, accessibilité, confirmation et parité voix/tap sont couverts quand
      la tranche comporte une interface.
- [ ] Une review adversariale correctness/sécurité/architecture/UX a vérifié que le code est appelé.
- [ ] Commit atomique, claim libéré, handoff et preuves consignés.

### 6.2 GPT Realtime + Voice Trace

- [ ] Une clé OpenAI suffit à la session complète ; aucune requête Mistral n'est observée.
- [ ] Ouverture, reconnexion, arrière-plan, interruption, hangup et perte réseau convergent vers un
      état terminal unique et testable.
- [ ] Le micro ne se ferme pas spontanément et un seul overlay Bob existe sur chaque écran autorisé.
- [ ] Une mission devis complète traverse au moins navigation → client → catalogue/ligne → TVA →
      revue → confirmation sans perdre son contexte.
- [ ] Les mêmes choix peuvent être résolus au doigt ou à la voix avec le même identifiant.
- [ ] Les SLO de la section 4.4 sont mesurés sur au moins un iPhone réel et un Android réel.
- [ ] Voice Trace permet de diagnostiquer chaque échec en une lecture et ne journalise aucune donnée
      vocale sensible.
- [ ] Le chemin Mistral V3 est OFF et un test anti-drift empêche son activation dans la build.

### 6.3 Publication

- [ ] `main` distant correspond exactement au commit candidat et aucun lot requis ne vit uniquement
      dans un worktree ou une branche locale.
- [ ] Le schéma cible est migré avant le writer ; le code N-1 reste compatible pendant la fenêtre.
- [ ] L'artefact exact boote localement avec la forme complète de l'environnement de production.
- [ ] `/health/ready` prouve commit, mode de données réel et dépendances obligatoires.
- [ ] Chaque one-shot Railway démarré est réconcilié avant toute activation irréversible :
      annulation/arrêt corrélé au SHA, puis deux observations sans instance active, que le scanner
      ait réussi, refusé ou été interrompu.
- [ ] Cold onboarding, données réelles, devis, facture, document et Bob Live passent sur appareils.
- [ ] CGU/confidentialité/support, crash reporting, alertes et runbook sont actifs.
- [ ] Zéro P0/P1 ouvert ; les limites restantes sont écrites et non présentées comme fonctionnelles.

### 6.4 Plateforme Agréée

- [ ] Le gate fournisseur `G-PA-01` est documenté et signé ; la présence sur une liste ou une page
      commerciale ne remplace pas le contrat, le DPA, le SLA et la preuve sandbox.
- [ ] Provisioning/Annuaire, B2B, B2C, international, avoir, acompte, réception, refus, paiement et
      reprise après panne passent la matrice de la spec PA.
- [ ] Webhooks signés, outbox/inbox, idempotence, réconciliation et RLS sont certifiés.
- [ ] Le document légal exact et son hash sont conservés dans Bob ; aucun 2xx ne devient un succès
      avant relecture du statut et des erreurs asynchrones.
- [ ] Sans connecteur certifié, les textes restent factuels (« Factur-X généré », « PA à connecter »)
      et ne promettent ni e-reporting automatique ni conformité 2026 complète.

### 6.5 Factur-X et règlement

- [ ] Les corpus XSD/Schematron FNFE-MPE et les validateurs tiers sont versionnés, hashés,
      réellement exercés et bloquent la CI sur XML **et** PDF/A-3b.
- [ ] Une facture rechargée depuis PostgreSQL reproduit les faits d'émission, antécédents,
      lignes sources, totaux payables et allocations de paiement au centime.
- [ ] Finale après plusieurs situations, retenue partielle, avoir d'acompte et séparation B2C
      passent les tests domaine, API, persistance et PostgreSQL réel.
- [ ] Aucun acompte professionnel ne peut conduire à une finale annoncée comme disponible mais
      impossible à émettre ; la capacité reste fermée jusqu'à sa certification EXTENDED/PA.
- [ ] Les preuves d'archive distinguent explicitement cohérence DB et conservation WORM des
      octets ; aucune copie produit ou support ne confond les deux.
- [ ] Train 0 prouvé sur toutes les répliques (`documentArchiveB2cHttpFence=v1`, mono-SHA), puis
      migrations expand et activation V2 seulement après retrait complet de N-1.
- [ ] Préflight audience exécuté avant l’expand : aucune facture émise legacy sans audience revue,
      et aucune audience `NULL` tolérée sur un schéma déjà étendu.
- [ ] Scanner pré-activation exécuté sur le bucket et la base cibles : snapshot read-only,
      Storage↔SQL bidirectionnel, octets réellement relus, attestations atomiques via app-role,
      second snapshot stable, Mustang/FNFE historiques, preuve DB append-only et enveloppe Railway
      corrélée ;
      `p0Issues=0` au rapport final, aucun original ou secret dans les artefacts GitHub.
- [ ] Après activation, le scanner V2 relit les mêmes octets et validateurs sans pouvoir écrire
      d’attestation ; sa baseline, son rapport privé et son SHA d’activation sont cohérents, le
      déclencheur `storage.objects` et le verrou audit/cutover sont certifiés sur PostgreSQL réel.
- [ ] Le bucket runtime est identique au bucket audité ; sous les verrous d’activation, zéro
      orphelin Storage et zéro référence SQL sans objet. Les ACL Supabase
      `anon/authenticated/service_role`, RLS forcée des tables privées et allowlist RPC sont
      certifiées sur PostgreSQL.

## 7. Registre de preuve

Chaque objectif passe par quatre états seulement : `specified`, `implemented`, `certified`,
`released`. Le passage d'état exige un lien vers un commit et une preuve ; le pourcentage estimé ne
remplace jamais ce registre.

| Objectif                      | État au 2026-07-28                                                                                                                                                                                                     | Prochaine preuve attendue                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1 — vérité Git               | specified                                                                                                                                                                                                              | branche de sauvegarde + graphe rebasé + `main` poussé                                                                                              |
| O2 — Factur-X/TVA             | implemented, PostgreSQL 17 et one-shot localement certifiés ; incompatibilité Bubblewrap/Railway prouvée et correction bornée `implemented` dans `SPEC_ARCHIVE_AUDIT_RAILWAY_STABILIZATION.md`                         | scanner Railway vide/B2C sans exécutable tiers, puis vraie paire Mustang/FNFE sous launcher Railway Landlock+seccomp + train 0/1 + checkout propre |
| O3 — GPT Realtime             | implemented partiellement — isolation fournisseur, WebRTC `sendrecv`, chaîne auditée OpenAI TTS → Whisper Bob-managed privé → renderer et readiness fail-closed testés ; runtime natif fermé                           | image Whisper + round-trip certifiés sur staging, puis dispatcher/ACK natifs, barge-in audité AEC et QA device sans requête Mistral                |
| O4 — mission continue         | certified sur staging pour M1-B — recovery `30334601843`, vraie mission WebRTC + ACK contexte/RLS `30335132334`, retour OFF et Bob Live restauré ; M1-C sélection client voix↔tactile fusionné dans `main@e163f929`, mais pas encore certifié device ; K1 identité `MissionKind`, adaptateur devis et registre Realtime réellement appelé fusionnés par PR #26 dans `main@c1fd88de` ; K2 `implemented` dans `agent/gpt/mission-foreground-k2` : ownership exhaustif de 51 outils runtime, proposition scellée, foreground global/dual-lock et discrimination des futurs kinds, avec PostgreSQL réel 50/50, use cases core 56/56 et garde Prisma 11/11 verts ; deux reviews indépendantes sans P0/P1 | CI exacte, puis phase A staging Supabase non-superuser → drain TTL → activation M1-B bornée/retour OFF ; ensuite scénario devis E2E voix/tap sur données réelles et QA device |
| O5 — Voice Trace              | implemented partiellement                                                                                                                                                                                              | corrélation E2E + dashboard p50/p95 + tests de confidentialité                                                                                     |
| O6 — données réelles          | implemented partiellement                                                                                                                                                                                              | garde d'artefact + certification écran/API tenant vierge et peuplé                                                                                 |
| O7 — release reproductible    | implemented — preuves historiques M1-B/archive/release staging `30351623978` et CI `main@83ef4afe` vertes ; accélération locale verte, revue adversariale GO, CI/mesure staging encore dues                            | PR unique : CI complète puis staging exact-SHA ≤ 35 min, merge et nettoyage ; aucune production                                                    |
| O8 — Plateforme Agréée réelle | specified                                                                                                                                                                                                              | gate G-PA-01 + contrat/sandbox + premier flux légal réconcilié                                                                                     |

## 8. Changement de cap

Toute modification du fournisseur de publication, réactivation de Mistral V3, ajout de périmètre ou
affaiblissement d'un critère DoD exige : décision écrite, impact sur la matrice de flags, nouveau
critère d'acceptation et preuve de non-régression. Une discussion orale ou un worktree existant ne
constitue pas une décision.

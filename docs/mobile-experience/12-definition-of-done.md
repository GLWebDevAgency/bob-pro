# Definition of Done — expérience mobile

> Statut : **Proposed**
> Nature : critères binaires ; une case non prouvée reste ouverte
>
> **Amendement A6 — 2026-07-29.** Deux cases sont précisées par A1/A2 (Reduce Transparency, blur
> profilé) et une case de matière est **ajoutée** à la DoD composant. **Aucune case n'est
> supprimée ni assouplie** : la preuve exigée devient plus facile à produire parce que la matière
> est plus simple, pas parce que l'exigence baisse.

## Règle

« Implémenté », « visible », « semble fluide » ou « tests unitaires verts » ne signifie pas Done.
Une tranche est Done lorsque comportement, design, accessibilité, performance, vérité métier,
preuve appareil et rollback sont fermés.

## Matrice d'applicabilité

`A` est toujours applicable, `C` s'applique lorsque le déclencheur indiqué existe, `—` est hors
nature du lot. Une équipe ne choisit pas librement les sections à appliquer.

| Type de WP | Doc | Architecture | Composant | Motion | Écran | Finance/fiscal/contractuel | Bob Live | A11y | Perf | Content | Tests/preuve | Rollout |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Décision/baseline sans runtime (`WP-0001–0008`) | A | C si ADR/frontière | — | — | — | C si données sensibles | C si voix | C si prototype | C si mesure/spike | C si copy | A | — |
| Primitive/fondation E01–E04/E12 | A | A | A | C si rendu change | — | C si montant/statut | C si consommée par Bob | A | A | C si visible | A | A si code livré |
| Capability Bob E05 | A | A | C | A | C si route/overlay | C si action sensible | A | A | A | A | A | A |
| Slice écran E06–E11 | A | C si frontière/dépendance | C si primitive change | C si mouvement visible | A | C selon domaine | C si voix/Bob | A | A | A | A | A |
| Finance/fiscal/contractuel | A | C | C | C | A | A | C si parité voix | A | A | A | A | A |
| Auth/scanner/donnée sensible | A | A si permission/session/native | C | C | A | C selon effet contractuel | C si voix | A | A | A | A + Security/Privacy | A |
| Certification pilote/finale (`WP-0009/0010` et enfants) | A | A | C | A | A | C selon slices | A pour WP-0009 | A | A | A | A | A |

## Règle `N/A`, limitation et waiver

- Applicabilité et verdict sont deux axes séparés : `Applicable|N/A`, puis, seulement lorsque
  l'élément est applicable, `NOT RUN|PASS|PASS-LIMITED|FAIL|BLOCKED`. `N/A` n'est jamais un
  verdict et `PASS-LIMITED` n'est jamais un synonyme de `N/A`.
- `N/A` exige : critère exact, déclencheur factuellement absent, justification, preuve, owner nommé,
  approbation QA et approbation du spécialiste concerné. Il est inscrit dans le manifest et le
  [registre de preuves](./18-evidence-register.md).
- `N/A` est interdit pour les bloqueurs automatiques, un P0/P1, la vérité d'un succès, une
  confirmation sensible, l'isolation tenant, l'accessibilité d'un changement visible ou le rollback
  d'un runtime activé.
- `PASS-LIMITED` est permis uniquement pour un écart P2/P3 sans perte fonctionnelle, sécurité,
  accessibilité ou vérité. Il exige Product owner, QA owner et owner spécialiste nommés, une preuve
  compensatoire, un risque lié et une expiration au plus tard à la prochaine release ou sous 30
  jours, la première échéance prévalant.
- À expiration, la ligne devient `FAIL` ou `BLOCKED` si elle n'est pas fermée ; aucun renouvellement
  silencieux.
- Les mots « pertinent », « stable », « significatif » ou « principal » sont résolus par la matrice,
  le scope Accepted et `PERF-CALIBRATION`, jamais par une impression du reviewer.

## DoD documentaire

- [ ] IDs G/V/S/T liés.
- [ ] Owner nommé, statut, date et commit de référence présents dans l'en-tête ou le registre
  documentaire central ; un simple rôle « pressenti » ne suffit pas pour `Accepted`.
- [ ] Problème, but, non-goals et dépendances écrits.
- [ ] États nominal/loading/empty/error/offline/pending/success définis selon la matrice
  d'applicabilité, ou chaque `N/A` approuvé individuellement.
- [ ] Entrée, sortie, interruption, retour et restauration définis.
- [ ] Motion normal/reduced/off définis.
- [ ] Fallback OS/capability défini.
- [ ] Critères d'acceptation binaires.
- [ ] Plan de tests, performance et observabilité.
- [ ] Flag, rollout, rollback et risques.
- [ ] Reader test sans ambiguïté.

## DoD architecture

- [ ] ADR accepté pour toute décision structurante.
- [ ] Clean Architecture et garde d'imports respectées.
- [ ] Aucun contrat backend implicite ajouté par l'UI.
- [ ] Runtime/provider ne connaît aucun détail visuel.
- [ ] UI ne devient pas autorité métier/transport.
- [ ] Dépendances directes compatibles Expo et pinées.
- [ ] Migration progressive, pas de big bang.
- [ ] Fallback et suppression future du legacy documentés.
- [ ] Threat/privacy review si données/observabilité touchées.

## DoD composant partagé

- [ ] API documentée et sémantique.
- [ ] Tokens uniquement, aucune valeur arbitraire non justifiée.
- [ ] **(ajouté A1 · 2026-07-29)** **Matière conforme** : la surface vient de `surfaceTint` /
      `BobSurface` ; zéro `rgba` translucide, zéro import `expo-glass-effect`, zéro dépendance à
      une capability de matière. Un composant qui n'aurait d'aspect correct qu'avec une matière
      système n'est pas Done.
- [ ] Nominal, press, focus, selected, disabled, loading, success et error.
- [ ] Entrée et sortie si l'une existe.
- [ ] Interruption/unmount sans fuite.
- [ ] Grandes polices et wrapping.
- [ ] Cible tactile, label, role, state et focus accessibles.
- [ ] Reduce Motion/Transparency/Increase Contrast.
- [ ] Haptique sémantique et facultative.
- [ ] Tests unitaires/composants/visuels.
- [ ] Profiling release.
- [ ] Galerie et exemple d'usage.
- [ ] Ancien composant deprecated/migré selon plan.

## DoD motion

- [ ] Le rôle perceptif est nommé.
- [ ] L'état source est nommé.
- [ ] L'effet commence sans bloquer l'interaction.
- [ ] Il est interruptible/redirigeable lorsque nécessaire.
- [ ] Le résultat final est exact animation full/reduced/off.
- [ ] La sortie existe et le layout ne saute pas.
- [ ] Focus/scroll conservés.
- [ ] Aucune boucle hors écran.
- [ ] Budgets frame/mémoire tenus.
- [ ] Aucun montant intermédiaire ambigu.

## DoD écran

- [ ] Job principal compris au premier viewport.
- [ ] Une action principale contextuelle.
- [ ] Conclusion avant preuves techniques.
- [ ] Route, header, StatusBar et présentation conformes à la matrice.
- [ ] Scroll/keyboard/safe area/rotation testés.
- [ ] Loading, empty, data, error, offline et permission selon besoin.
- [ ] Pending/success/error dérivés de la source autoritaire.
- [ ] Deep link, back, background et restauration.
- [ ] Dynamic Type ~200 %, VoiceOver/TalkBack et gestes alternatifs.
- [ ] Captures multi-size/modes approuvées.
- [ ] Analytics non dupliquées et sans PII.
- [ ] Tests E2E du happy path et erreurs principales.
- [ ] Flag/rollback si migration risquée.

## DoD flux financier, fiscal ou contractuel

- [ ] Montants et arrondis identiques avant/après.
- [ ] Use case et politique de confirmation inchangés.
- [ ] Parité voix/tap respectée selon périmètre accepté.
- [ ] Double soumission impossible.
- [ ] Idempotence et révision testées.
- [ ] Timeout devient inconnu/récupération, jamais faux succès.
- [ ] Success après ACK/relecture.
- [ ] Aucun calcul dans l'animation.
- [ ] Copy sobre et revue finance/juridique.
- [ ] RLS/tenant et logs inchangés/sûrs.
- [ ] Test ciblé financier obligatoire.

## DoD Bob Live

- [ ] Renderer provider-neutral ; provider du train respecté par le runtime.
- [ ] Un seul overlay global.
- [ ] Permission, connexion, écoute, silence, commit, reasoning, outil, parole, barge-in,
  reconnexion, erreur et fin distincts.
- [ ] Chaque phase possède une source runtime réelle.
- [ ] Input/output amplitude distincts ou dégradation documentée.
- [ ] Transcript/captions et Stop accessibles.
- [ ] Error ne retourne pas silencieusement à idle.
- [ ] Barge-in visuel < 100 ms et SLO audio existants tenus.
- [ ] Aucun audio/transcript/amplitude fine dans la télémétrie.
- [ ] Reduced Motion complet.
- [ ] Session stable pendant changement de route/background.
- [ ] Même interaction typée voix/tap.
- [ ] Aucun succès outil avant ACK/relecture.
- [ ] Device matrix acoustique signée.
- [ ] Kill switch visuel indépendant du transport testé.

## DoD accessibilité

- [ ] Cibles 44 pt/48 dp selon plateforme et contrôles.
- [ ] Contraste texte/composants certifié.
- [ ] Information non dépendante de la couleur.
- [ ] Dynamic Type et Bold Text.
- [ ] Reduce Motion et crossfade préféré.
- [ ] **(amendé A1 · 2026-07-29)** Reduce Transparency : captures avant/après **identiques** — les
      surfaces sont opaques par construction, il n'y a pas de fallback à exercer. Seule exception :
      une retombée de bord en mode flouté, qui doit rendre son repli opaque unique.
- [ ] VoiceOver/TalkBack : ordre, labels, valeurs, focus, annonces.
- [ ] Gestes avec alternatives tap.
- [ ] Clavier/autofill/dictée selon écran.
- [ ] Erreurs et statuts annoncés sans spam.
- [ ] Passe manuelle signée sur appareil.

## DoD performance

- [ ] Baseline avant/après au même commit/scénario/appareil.
- [ ] Build release/preview, pas dev.
- [ ] Budgets 60 Hz tenus ; comportement 120 Hz observé.
- [ ] Android médian et iPhone réel.
- [ ] Pas de boucle/listener après blur/background/unmount.
- [ ] Mémoire conforme au seuil et au protocole figés dans `PERF-CALIBRATION` après répétition.
- [ ] **(amendé A2 · 2026-07-29)** Images profilées ; toute retombée de bord en mode flouté
      profilée **sous scroll continu** (médiane et pire run) et conforme au § Budget de la retombée
      de bord. Le verre système n'est pas concerné : il n'est pas employé.
- [ ] Bob/scan : CPU, GPU, batterie/température mesurés et conformes aux seuils `PERF-CALIBRATION`.
- [ ] SLO voix absolus et régression relative tenus.
- [ ] Dashboard/alertes/rollback opérationnels.

## DoD content

- [ ] Statut relié à une source réelle.
- [ ] Conclusion → impact → action → détail.
- [ ] Trois personnalités, même sens.
- [ ] Aucun jargon technique au premier niveau.
- [ ] Aucun millésime durable figé.
- [ ] Erreur précise et réparable.
- [ ] Aucun « fait/payé/conforme/en ligne » ambigu.
- [ ] Snapshots i18n critiques.
- [ ] Revue métier/juridique selon contexte.

## DoD tests et preuve

- [ ] Tests statiques, unitaires et composants pertinents.
- [ ] Intégration/E2E du chemin réel.
- [ ] Visual regression multi-size/modes.
- [ ] Accessibility manual pass.
- [ ] Profiling release.
- [ ] Dossier de preuve complet.
- [ ] Reader test documentaire.
- [ ] Revue adversariale design/tech/métier.
- [ ] Aucun P0/P1 ouvert.

## DoD rollout

- [ ] Flag OFF dans la première build contenant le code.
- [ ] Fallback testé et fonctionnel.
- [ ] R0/R1/R2/R3/R4 selon roadmap ou dérogation écrite.
- [ ] Métriques legacy/nouveau séparées.
- [ ] Stop conditions et owner d'astreinte connus.
- [ ] Rollback exercé en staging/canary.
- [ ] Aucune migration chaude de navigator/session Bob.
- [ ] Deux releases stables avant retrait legacy, sauf décision explicite plus stricte.
- [ ] Docs et traçabilité mises à jour dans le même lot.

## Ce qui bloque automatiquement Done

- Succès visuel déclenché par timer ou tap.
- État vocal inventé.
- Action sensible rendue moins sûre.
- Valeur financière divergente.
- Geste Retour/deep link cassé.
- Information perdue en Reduce Motion/lecteur d'écran.
- Performance prouvée seulement sur simulateur.
- Dépendance alpha sans fallback.
- PII/transcript/audio dans les métriques.
- Aucun rollback.
- Test financier/sécurité absent sans justification écrite acceptée.

## Verdict

Pour une exigence ou un critère `Applicable`, le verdict final utilise seulement :

- `PASS` : toutes les cases pertinentes prouvées ;
- `PASS WITH ACCEPTED LIMITATION` / `PASS-LIMITED` : limitation conforme à la règle ci-dessus,
  signée par les trois rôles requis et non expirée ;
- `FAIL` : une gate manque ou une preuve est non reproductible ;
- `BLOCKED` : dépendance externe empêche la preuve.

Un pourcentage, une impression ou une vidéo isolée ne remplace pas ce verdict.

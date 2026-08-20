# SPEC U1-k — drain tactile d'un run imprésentable

- **Date** : 2026-08-20
- **Baseline** : `574f3aa9c`
- **Statut normatif** : `specified` — ce lot ne publie aucune action et ne promeut ni
  certification ni release. Le manifest runtime demeure fermé.
- **Objectif primaire** : O4 — une mission continue dont l'action autoritaire reste dérivable peut
  être abandonnée explicitement même lorsque sa carte métier n'est plus reconstructible ; un état
  illisible reste signalé comme tel, sans action inventée.
- **Contraintes** : O6/O7 — aucune action inventée côté client, aucun succès optimiste et preuves
  reproductibles.
- **Parents** : `OBJECTIFS_SPECS_DOD_PUBLICATION.md` O4/O6/O7,
  `SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md` §5.2/§5.3/§14/§17.1/§21,
  SPEC U1-f §1/§4/§8 et SPEC U1-h §6/§7.

## 1. Défaut fermé par ce lot

Le serveur peut rendre un run courant avec `presentation: null` lorsque son état ou son payload ne
permet plus de reconstruire honnêtement une carte. Le hook mobile transforme alors ce résultat en
`unpresentable` mais jette le run et les ports de commande ; l'écran ne propose que « Réessayer ».
Le coordinateur, lui, déduit encore l'action depuis `presentation.intent`. Il ne peut donc pas
émettre le `cancel_run` existant sans réinventer l'action côté client.

Ce n'est pas un simple état d'erreur transitoire :

- un `single_business_action` courant n'a pas de présentation customer-contact et rencontre déjà
  cette impasse ;
- les payloads de présentation ont une rétention bornée alors que le reader de foreground ne
  filtre pas encore les échéances idle/hard et qu'aucun émetteur d'expiration n'est publié ;
- après purge légitime d'un payload ancien, « Réessayer » peut donc rester sans effet indéfiniment
  et le run continuer à occuper le foreground.

## 2. Une seule autorité pour l'identité d'action

Le client ne maintient plus de table `intent -> actionId@version`. La vue du run reçoit :

```ts
actionReference: JarvisDefinitionActionReference | null
```

Le serveur calcule ce champ exclusivement avec la même résolution de définition que l'admission et
le worker : `resolveJarvisDefinition(...).actionReference(envelope, null)`. Il n'utilise ni le
payload de présentation, ni une constante transport, ni un mapping mobile.

- définition et état reconnus : écho de l'action exacte du run ;
- définition ou état illisible : `null`, sans approximation ; cette corruption exige un repair
  administratif hors lot et n'est jamais maquillée en annulation ;
- run terminal : `null`, selon le principe de moindre autorité ;
- l'admission recharge toujours le run sous verrou et recoupe l'écho avant toute transition.

L'écho autorise seulement la construction d'une enveloppe déjà validée par le gateway. Il ne
constitue ni une publication, ni un droit, ni un contournement du kill switch.

## 3. Contrat wire lockstep

`actionReference` est une clé requise de `JarvisRunWireView` et `JarvisRunView`. Le codec accepte
exactement :

- `null` ; ou
- un objet exact `{ actionId, actionVersion }` dont les deux valeurs forment une référence Jarvis
  canonique.

Toute clé absente/étrangère, forme partielle ou valeur non canonique rend la vue illisible. Le
changement est volontairement **lockstep pré-V1** : client N et serveur N sont livrés ensemble en
staging isolé ; aucun champ optionnel, route v2, dual-read ou fallback N-1 n'est ajouté. Une
certification ou release reste bloquée par la gate client du parent §17.1 : force-update global
prouvé sur les clients installés, ou fenêtre bornée d'anciennes routes read-only avec bandeau.

## 4. Frame de contrôle et annulation

Le mobile sépare deux contrats :

- une frame de contrôle `{ run, ports }`, suffisante pour identifier et annuler ; l'hôte conserve
  séparément son callback `refresh` pour la relecture ;
- la frame customer-contact complète, qui ajoute une présentation et reste seule admissible pour
  ACK écran, modification, confirmation ou rejet.

Le coordinateur reçoit `cancel(run, ports)` et construit la commande depuis
`run.actionReference`. Il supprime `actionForIntent` et les constantes d'action locales.

- action absente, run terminal ou ports absents : refus local, zéro appel réseau ;
- un retry de transport réutilise le même `commandId` ;
- conflit/revision stale : le coordinateur rend l'échec ; l'hôte déclenche une relecture, jamais
  une seconde intention aveugle ;
- réponse admise : aucune disparition ou réussite optimiste ; seule la relecture du run décide
  qu'il est terminal, absent ou encore `cancelling`.

## 5. Carte de drain honnête et accessible

L'état `unpresentable` conserve la frame de contrôle. Une carte dédiée affiche :

- un message borné indiquant que les détails ne sont pas disponibles ;
- **Réessayer**, strictement read-only ;
- si `actionReference` est non nul, **Annuler la demande**, qui émet uniquement `cancel_run` ;
- sinon, une annulation désactivée et un message honnête indiquant que la demande doit être relue ou
  réparée, avec zéro appel réseau.

La carte n'offre jamais Confirmer, Modifier, Rejeter ou `record_presentation_ack`. Elle ne promet
jamais « rien ne sera enregistré » : si l'autorisation a déjà gagné la course, l'annulation peut
seulement passer le run en `cancelling` et observer le résultat réel de l'effet déjà parti.

Le drain reste visible dans le flux normal et dans toutes les branches d'entitlement/loading qui
masqueraient autrement la mission. Un paywall peut fermer une nouvelle capacité ; il ne peut pas
retirer à l'utilisateur le moyen de fermer un run déjà présent. La carte expose des labels
accessibles, un état occupé, des erreurs relançables et n'utilise ni information sensible ni
animation obligatoire.

## 6. Périmètre et hors lot

Dans le lot : projection serveur, type/codec/API-client, coordinateur/hook mobile, carte de drain,
intégration assistant et preuves ciblées.

Hors lot : nouveau reducer ou endpoint, changement de commande, migration/schema DB, TTL sweeper,
annuaire de dispatch, catalogue, policy de publication, flag, activation, compatibilité N-1,
suppression de l'ancien moteur et release.

## 7. Critères d'acceptation binaires

- [ ] Customer-contact création/modification et `single_business_action` projettent leur action
      exacte depuis la définition serveur ; état/définition illisible projette `null`.
- [ ] Le codec exige la nouvelle clé et refuse toute forme ou référence non canonique.
- [ ] Un run vivant avec `presentation: null` conserve `{ run, ports }` et rend la carte de drain.
- [ ] « Réessayer » relit seulement ; « Annuler » envoie `cancel_run` avec kind/version/révision et
      l'action renvoyée par le serveur.
- [ ] Un retry réseau réutilise le même `commandId` ; stale/conflit relit sans resoumettre une
      nouvelle intention.
- [ ] Action absente ou run terminal : zéro appel réseau.
- [ ] Aucun chemin imprésentable n'émet ACK, confirmation, rejet ou succès optimiste.
- [ ] Loading, entitlement non vérifié et paywall ne masquent pas le drain d'un run existant.
- [ ] Le parcours customer-contact présentable reste inchangé.
- [ ] Aucun mapping `presentation.intent -> action` ni aucune autorité locale d'action ne subsiste
      dans le chemin de reprise/annulation mobile ; la borne de capacité d'ouverture reste hors lot.

## 8. Definition of Done

- [ ] Spec U1-k commitée avant le premier changement de code, statut conservé à `specified`.
- [ ] Tests serveur : projection customer create/update, SBA, définition/état illisible et run
      terminal.
- [ ] Tests codec/HTTP : objet exact, `null`, clés manquantes/étrangères et valeurs invalides.
- [ ] Tests coordinateur/hook : cancel, retry même commandId, stale/read, action absente, terminal,
      conservation de la frame imprésentable.
- [ ] Tests UI : Retry + Annuler, aucun bouton d'autorisation ou d'effet métier
      (Confirmer/Modifier/Rejeter/ACK), état occupé/erreur, drain visible sous les branches
      d'entitlement.
- [ ] Typechecks API, API-client et mobile, lint ciblé et `git diff --check` verts.
- [ ] Contre-revue indépendante sans P0/P1 ; aucune modification Claude recouverte ; limites de
      compatibilité et publication consignées.

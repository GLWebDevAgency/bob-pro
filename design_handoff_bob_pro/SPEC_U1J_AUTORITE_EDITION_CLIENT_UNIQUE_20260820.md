# SPEC U1-j — autorité unique d'édition client

- **Date** : 2026-08-20
- **Baseline** : `7d00b83c6`
- **Statut normatif** : `specified` — ce lot ne publie aucune action et ne promeut ni
  certification ni release. Le manifest runtime reste vide.
- **Objectif primaire** : O4 — une mission continue exécute la même autorité métier que le geste
  manuel et annonce uniquement son résultat réel.
- **Contraintes** : O6/O7 — zéro vérité inventée, courses fermées et preuves reproductibles.
- **Parents** : `OBJECTIFS_SPECS_DOD_PUBLICATION.md` §4.2/§4.3/§6,
  `SPEC_JARVIS_UNIVERSEL_ORCHESTRATION_20260817.md` §4.2/§4.4/§5.3/§9.1/§21,
  SPEC U1-i §2/§5.

## 1. Défaut fermé par ce lot

À la baseline, `BackendService.updateCustomer` verrouille la société, refuse un compte clôturé,
prouve l'intégrité des archives de devis signés puis de factures émises et appelle enfin
`UpdateCustomer`. L'effet `client-modifier@1` appelle bien le même use case et son CAS de révision,
mais dans une transaction distincte qui ne porte aucune de ces quatre barrières.

Une confirmation Jarvis peut donc encore modifier une fiche qu'un geste manuel doit refuser. La
présence du même use case de domaine ne suffit pas : l'autorité applicative complète inclut le
périmètre tenant, le verrou société, la clôture, les archives et le point d'écriture CAS.

Ce lot extrait cette autorité une seule fois et fait déléguer les deux entrées. Il ne crée ni moteur
vocal, ni use case Jarvis, ni façade vers `BackendService`.

## 2. Autorité applicative canonique

L'autorité d'édition client reçoit un `companyId` explicite, la fiche normalisée et, pour l'effet
différé, une `expectedRevision`. Elle exécute exactement cet ordre :

1. ouvrir le contexte tenant de `companyId` ;
2. ouvrir une transaction unique ;
3. charger la société `FOR UPDATE` ;
4. refuser une société absente puis une société clôturée ;
5. prouver les archives de tous les devis signés ;
6. prouver les archives de toutes les factures émises ;
7. appeler l'unique `UpdateCustomer`, en mode historique ou `executeAtRevision` ;
8. committer ensemble les barrières et l'écriture.

Le CAS reste le dernier arbitre au point d'écriture. `count = 0` reste
`target_revision_stale`, sans relecture-réessai ni création de cible. Le verrou société est pris
avant toute lecture d'archives afin qu'une clôture concurrente ne puisse pas gagner entre la garde
et l'écriture. Aucun appel réseau n'est ajouté à la transaction ; les preuves lisent le stockage
de documents déjà requis par le parcours manuel.

## 3. Source unique des barrières d'archives

Les implémentations aujourd'hui privées dans `BackendService` sont déplacées sans changer leur
sémantique vers une autorité d'intégrité documentaire injectée :

- calcul des artefacts attendus pour facture émise et devis signé ;
- cardinalité, identité, version et clé de stockage du document ;
- lecture vérifiée de l'objet stocké et contrôle de sa représentation PDF ;
- attestation PDF de facture et cohérence du XML embarqué ;
- contrôle des jobs d'archive en attente et concordance de leur SHA final.

`BackendService` et l'autorité d'édition consomment cette même implémentation. Aucune copie des
règles, aucun wrapper spécifique à Jarvis et aucun accès de l'adapter Jarvis à
`BackendService` ne sont admis.

## 4. Contrat de refus et vérité du worker

Les refus restent structurés et stables jusqu'au worker :

- révision périmée : `target_revision_stale` ;
- client absent : `customer_missing` ;
- société absente : `company_missing` ;
- société clôturée : `company_closed` ;
- archive de devis signé incomplète : `signed_quote_archive_missing` ;
- archive de facture émise incomplète : `issued_invoice_archive_missing` ;
- dépendance indisponible : issue `unavailable`, jamais succès ;
- autre refus domaine : code domaine préfixé et borné, sans prose libre.

Un refus produit zéro mutation client et conserve les règles de reprise U1-i : une issue
indéterminable reste `outcome_unknown`, jamais un retry aveugle.

## 5. Périmètre et hors lot

Dans le lot : extraction de l'intégrité documentaire, autorité d'édition client, délégation du
geste manuel et de l'effet Jarvis, câblage d'injection et preuves ciblées.

Hors lot : création client/contact/chantier, communication, controller ou codec U1-h, mobile,
annuaire/catalogue/reducer, schéma PostgreSQL, migration, flag, manifeste de publication, activation
et release. Le manifest runtime demeure fermé.

## 6. Critères d'acceptation binaires

- [ ] Le geste manuel et l'effet `client-modifier@1` appellent la même autorité applicative
      d'édition ; aucun des deux ne recopie son ordre transactionnel.
- [ ] L'adapter Jarvis n'instancie ni `UpdateCustomer` ni une variante métier propre à Jarvis.
- [ ] Chaque règle d'intégrité d'archive listée au §3 possède une seule implémentation, consommée
      par le parcours manuel et l'autorité canonique.
- [ ] L'ordre observé est tenant -> transaction -> verrou société -> clôture -> devis signés ->
      factures émises -> écriture/CAS.
- [ ] Société absente ou clôturée : refus nommé, zéro lecture d'archive après la clôture et zéro
      mutation client, pour les deux entrées.
- [ ] Archive de devis signé incomplète : refus `signed_quote_archive_missing`, sans contrôle de
      facture ni mutation ; archive de facture émise incomplète : refus
      `issued_invoice_archive_missing`, sans mutation.
- [ ] Deux écritures partant de la même révision conservent le CAS U1-i : une seule gagne, l'autre
      rend `target_revision_stale`, sans retry.
- [ ] Une course réelle avec fermeture de société prouve que les deux mutations se sérialisent sur
      le même verrou et qu'aucune édition ne commite après une clôture gagnante.
- [ ] Le diff ne touche ni controller/codec U1-h, ni mobile, ni directory/catalogue/reducer, ni
      schéma/flag/manifest.

## 7. Definition of Done

- [ ] Spec U1-j commitée avant le premier changement de code, statut conservé à `specified`.
- [ ] Tests unitaires ciblés de l'autorité, de la délégation Jarvis et des refus nommés verts.
- [ ] Régressions d'archives de devis signés et de factures/Factur-X vertes.
- [ ] Preuve PostgreSQL discriminante : verrou société concurrent, clôture gagnante, CAS stale et
      barrières d'archives, sous tenant/RLS réels lorsque l'environnement local le permet.
- [ ] Typecheck API, lint ciblé et `git diff --check` verts.
- [ ] Commits petits et cohérents ; aucune modification Claude recouverte ; handoff final avec les
      preuves et les limites non vérifiées.

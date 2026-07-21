# CONNECTEUR PLATEFORME AGRÉÉE — B2BROUTER EDOCSYNC

**Statut : Specified — décision d'architecture acceptée, fournisseur soumis au gate G-PA-01**

**Date : 2026-07-21**

**Objectif lié : O8 — chaîne de facturation électronique légalement opérante**

## 1. Décision

Bob Pro ne devient pas lui-même Plateforme Agréée et ne reconstruit pas les flux DGFiP. Il reste
la source de vérité métier et délègue le transport réglementaire à une PA via un port
interchangeable. **B2Brouter eDocSync est le candidat prioritaire** parce que son offre publique
couvre le modèle éditeur en marque blanche, le provisioning des comptes, l'Annuaire, les flux
français 1/6/10, la réception, les webhooks, les formats structurés et l'archive légale.

L'acceptation définitive de B2Brouter exige le passage du gate commercial, sécurité et sandbox
`G-PA-01`. Une page marketing ou une documentation fournisseur ne constitue pas une preuve de
production.

Sources primaires consultées :

- [offre eDocSync marque blanche](https://www.b2brouter.net/fr/edocsync-pdp/) ;
- [guide API France DGFiP](https://docs.b2brouter.net/en/developers/guides-by-country/france/dgfip-e-invoicing-and-e-reporting/) ;
- [réception et cycle de vie](https://docs.b2brouter.net/en/developers/common-use-cases/receive-integrate-and-manage-received-invoices/) ;
- [liste officielle des Plateformes Agréées](https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees).

## 2. Ce que Bob conserve et ce qu'il délègue

| Responsabilité | Bob Pro | PA |
| --- | --- | --- |
| Devis, facture, lignes, TVA, avoir, numérotation, règles métier | **Source de vérité** | Consommateur |
| Choix utilisateur de la nature d'opération et fait BT-23 figé | **Source de vérité** | Mapping/validation |
| UX, voix, confirmations, audit utilisateur | **Source de vérité** | Invisible en marque blanche |
| PDF de présentation et export Factur-X local | Oui | Peut produire le format transmis |
| Provisioning PA et inscription/transfert Annuaire | Orchestration + consentement | **Exécution réglementaire** |
| Routage PPF/Peppol/PA, Flux 1, CDAR/Flux 6 | Non | **Source de vérité transport** |
| E-reporting B2C/international et paiements, Flux 10 | Données métier exactes | **Transmission réglementaire** |
| Réception réseau des factures fournisseur | Import et traitement métier | **Transport et original légal** |
| Document exact légalement transmis/reçu | Copie immuable + hash | **Producteur/détenteur transport** |

Après une transmission, Bob ne présente jamais une régénération locale comme le document légal.
Il télécharge l'artefact exact retourné par la PA, le stocke dans le coffre, calcule son hash et
lie la version à la tentative de transmission et à l'identifiant externe.

## 3. Architecture cible

Le domaine ne connaît ni `B2Brouter`, ni clé API, ni payload fournisseur. Un port applicatif expose
des capacités métier stables :

- provisionner ou relire le compte PA d'une société ;
- relire l'état d'inscription à l'Annuaire ;
- préparer/résoudre un destinataire sans choisir silencieusement un homonyme ;
- soumettre une facture émise ou un avoir à partir de son snapshot figé ;
- relire et réconcilier une transmission ;
- télécharger le document légal exact ;
- ingérer une facture reçue et son original ;
- publier un statut de cycle de vie ou un encaissement total ;
- relire l'état des rapports fiscaux.

L'adapter `B2BrouterEInvoiceGateway` vit côté infrastructure API. Il traduit les erreurs, statuts,
codes et identifiants B2Brouter vers les contrats Bob. Aucune UI, aucun agent et aucun use case ne
manipule directement un identifiant B2Brouter.

Les tables additives minimales sont :

1. liaison tenant ↔ compte PA, avec environnement et état d'onboarding ;
2. tentative de transmission immuable, clé d'idempotence, révision facture et identifiant externe ;
3. inbox webhook dédupliquée et outbox d'appels sortants ;
4. historique append-only des statuts externes ;
5. référence coffre + hash du document légal ;
6. curseur de réconciliation par compte et type de flux.

Toutes portent le tenant, des FK composites anti-IDOR et FORCE RLS. Les secrets restent côté
serveur, chiffrés et séparés par environnement.

## 4. Stratégie de soumission à décider par le spike

B2Brouter accepte un JSON métier ou l'import d'un Factur-X PDF/A-3/CII. Le spike sandbox compare
les deux chemins sur la même matrice de factures.

Le chemin **JSON canonique** est préféré s'il conserve exactement nos montants, mentions, avoirs,
acomptes et la nature d'opération par facture : il évite de maintenir en double la couche de
transport réglementaire. L'import de notre Factur-X devient le choix seulement si le JSON ne
permet pas de porter sans ambiguïté S1/B1/M1, les cas de paiement/acompte/correction ou une mention
requise.

Dans les deux cas :

- Bob valide son snapshot avant l'appel ;
- la PA revalide et produit le verdict transport ;
- toute réponse 2xx avec un tableau `errors` non vide est un échec ;
- le résultat est relu et le document légal téléchargé avant d'annoncer la réussite ;
- le générateur Factur-X Bob reste certifié pour le coffre, l'aperçu, l'export et la portabilité,
  mais ne remplace jamais la preuve PA.

## 5. Fiabilité et sécurité

- Version API épinglée explicitement dans `X-B2B-API-Version` ; aucune version implicite de groupe.
- Une clé distincte sandbox/staging/production, jamais livrée au mobile.
- Chaque appel sortant part d'une outbox durable. Tant que l'API ne garantit pas une vraie clé
  d'idempotence, une réponse perdue déclenche une réconciliation par compte + numéro + snapshot,
  jamais un second POST aveugle.
- Les `429` et `5xx` utilisent backoff borné + jitter ; les `4xx` métier sont terminaux jusqu'à
  correction explicite.
- Le `X-B2B-API-Request-Id` est conservé dans la trace structurée.
- Le webhook vérifie la signature HMAC-SHA256 sur les octets bruts, une fenêtre temporelle, la
  déduplication et le tenant lié au compte externe. Il répond 2xx seulement après écriture durable.
- Les doublons, retards et événements hors ordre convergent par machine à états monotone ; un
  polling de réconciliation couvre les webhooks perdus.
- Une activation susceptible de transférer l'inscription Annuaire exige un consentement explicite
  et affiche la PA actuelle, la cible et les conséquences.
- L'absence de port, de compte PA, de clé, de mapping tenant ou de document légal échoue fermée.

## 6. Parcours verticaux à certifier

1. Onboarding d'une société réelle de test → compte PA → Annuaire → état relu dans Bob.
2. B2B France services, biens et mixte → S1/B1/M1 exacts → dépôt → réception des statuts.
3. Acompte, finale et avoir lié à sa facture exacte, sans mutation du snapshot Bob.
4. B2C France et international → rapport Flux 10 transaction ; service encaissé → paiement.
5. Facture fournisseur reçue → webhook → original téléchargé/hashé → analyse Bob →
   accepter/refuser avec motif → statut PA relu.
6. Webhook dupliqué, hors ordre, signé avec une mauvaise clé, trop ancien ou rattaché à un autre
   tenant → aucun effet non autorisé.
7. Timeout après POST, `429`, `5xx`, `422`, erreur asynchrone et reprise worker → zéro doublon,
   zéro faux succès.
8. Suppression/rotation de clé et indisponibilité PA → lecture locale disponible, émission marquée
   indisponible, reprise réconciliée.

## 7. Gate fournisseur G-PA-01

Le fournisseur est accepté seulement si les réponses contractuelles et les preuves sandbox
couvrent :

- contrat eDocSync marque blanche, prix par tenant/document/flux et coût des environnements ;
- SLA, support critique, RTO/RPO, statut de service et mécanisme d'export de sortie ;
- DPA/RGPD, lieux de traitement et d'hébergement, sous-traitants, notification d'incident et
  sort des données à la résiliation ;
- portée exacte de l'archivage dix ans et récupération massive des originaux, CDAR et rapports ;
- provisioning automatisé à notre volume, séparation des tenants et rotation des clés ;
- sémantique documentée des retries webhook, ordre, doublons, rétention et rotation du secret ;
- idempotence de création ou procédure officielle de réconciliation ;
- support prouvé de la matrice §6, notamment BT-23 par facture, avoirs, acomptes et e-reporting
  des paiements ;
- export complet permettant de remplacer B2Brouter par une autre PA sans changer le domaine Bob.

## 8. Definition of Done

- [ ] Port provider-neutral, adapter B2Brouter et fake **de test uniquement** couverts par les
      mêmes tests de contrat.
- [ ] OpenAPI fournisseur épinglée ; dérive de version détectée en CI.
- [ ] Migrations additives, FORCE RLS et anti-IDOR certifiés sur PostgreSQL réel.
- [ ] Outbox/inbox, idempotence, concurrence et réconciliation certifiées avec doubles puis sandbox.
- [ ] Signature webhook, timestamp, replay, rotation et mapping tenant testés adversarialement.
- [ ] Les huit parcours §6 passent dans le sandbox/staging PA avec les artefacts et statuts relus.
- [ ] Chaque document légal exact est archivé et hashé ; aucun succès n'est dérivé d'un simple 2xx.
- [ ] Dashboard opérationnel : backlog, âge, taux d'erreur, statuts terminaux, webhooks rejetés et
      réconciliation, sans données fiscales sensibles dans les labels.
- [ ] Runbook panne/rotation/rejeu/sortie fournisseur et alertes sont testés.
- [ ] Les copies « automatique » ou « conforme 2026 » ne sont activées qu'avec cette DoD verte.

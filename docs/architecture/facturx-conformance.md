# Conformité Factur-X — contrat de génération et preuves

Bob Pro génère, pour les factures professionnelles éligibles, un document hybride
**Factur-X profil EN16931** : XML CII UN/CEFACT embarqué dans un PDF/A-3b. Le profil BASIC
historique n'est plus le profil d'émission. Un particulier B2C ne reçoit pas un faux Factur-X :
son PDF est archivé séparément et son e-reporting passera par la Plateforme Agréée.

Cette capacité ne vaut pas, à elle seule, transmission réglementaire. Tant que le connecteur PA
n'est pas certifié, Bob peut dire « Factur-X généré et validé », jamais « transmis » ni
« conforme 2026 de bout en bout ».

## 1. Construction déterministe

`facturXDataFromInvoice()` projette le snapshot d'émission figé de `Invoice`, `Company` et du
client professionnel vers `FacturXInvoiceData` :

- aucun SIREN, identifiant TVA ou endpoint n'est dérivé ou inventé ;
- BT-23 porte la nature d'opération choisie et figée à l'émission ;
- HT, TVA, TTC et payable sont réconciliés au centime avec le domaine ;
- les situations antérieures deviennent des lignes résiduelles et plusieurs références BG-3,
  sans double déduction ;
- l'avoir référence exactement sa facture source ; un avoir d'acompte utilise le type `503` ;
- une facture d'acompte autonome utilise le type `386` ;
- une finale qui reprend un acompte reste bloquée avant numérotation tant que sa projection
  Factur-X EXTENDED ventilée par TVA et par antécédent n'est pas certifiée. BT-113, une ligne
  négative ou une remise globale ne servent jamais de raccourci.

`validateFacturXEn16931()` est une garde interne rapide. Elle vérifie notamment les champs
obligatoires, les codes, les identités et endpoints, les catégories TVA, les totaux, la relation
entre types de document et références antérieures, ainsi que la liste BT-23 du corpus français
FNFE-MPE 1.4. Une garde interne reste une prévalidation, pas une homologation externe.

## 2. Enveloppe PDF/A-3b

`PdfRenderer` embarque les polices Schibsted/Hanken utilisées par Bob, joint
`factur-x.xml` avec `AFRelationship=Alternative`, publie le paquet XMP Factur-X EN16931 et
applique directement l'enveloppe PDF/A-3b :

- profil ICC sRGB2014 versionné, authentifié par taille et SHA-256 ;
- `OutputIntent` sRGB ;
- identifiant trailer stable et séparé par le XML figé ;
- espace couleur du groupe de transparence sur chaque page ;
- polices embarquées par sous-ensemble.

Un asset ICC absent ou alté fait échouer le rendu. Bob ne livre jamais un PDF ordinaire sous
une étiquette PDF/A. Aucun binaire de post-traitement externe n'est requis au runtime.

## 3. Certification indépendante bloquante

Le job CI `facturx-conformance` part d'un checkout propre et :

1. construit l'API et l'artefact de certification séparé `@bob/core/testing` ;
2. génère un vrai échantillon B2B depuis les agrégats Bob ;
3. valide le CII contre le XSD, le Schematron EN16931 et les règles BR-FR Flux 2 du corpus
   **FNFE-MPE 1.4.0.02**, tous les artefacts et moteurs étant épinglés par SHA-256 ;
4. exécute une fixture négative qui doit déclencher `BR-FR-32-GLOBALID`, preuve que le
   Schematron courant a réellement été exercé ;
5. valide séparément XML et PDF avec **Mustang CLI 2.24.0**, empreinte épinglée ;
6. refuse tout rapport tronqué, aucune règle exécutée, version inattendue, échec Schematron
   ou verdict veraPDF différent de `PDF/A-3b compliant`.

Les rapports sont interprétés par des gardes testées. La simple sortie zéro d'un outil tiers ne
suffit pas à certifier le document.

## 4. Archivage et frontière PA

Pour une facture B2B/B2G, le job d'archive n'est complet qu'après conservation et preuve des deux
artefacts attendus, PDF et XML. Pour une facture B2C, le périmètre distinct exige uniquement le
PDF et interdit de le requalifier ensuite en archive Factur-X complète.

La base lie job, document et version, recalcule le digest canonique et borne les transitions par
fonctions transactionnelles. Cela prouve la cohérence de la métadonnée ; ce n'est pas encore une
preuve WORM des octets. L'object-lock ou l'archive probante fournie par la PA reste nécessaire pour
revendiquer cette propriété.

Après transmission PA, l'autorité documentaire devient l'artefact exact retourné par la PA,
téléchargé, hashé et relié à la tentative et aux statuts externes. Une régénération locale ne
sera jamais présentée comme l'original légal transmis.

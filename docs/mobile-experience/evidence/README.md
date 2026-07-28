# Convention du dossier de preuves

Statut : **Proposed**
Owner attendu : QA owner · **à affecter**

## Arborescence normative

```text
evidence/
├── README.md
└── <release-stable>/
    ├── _shared/
    │   └── <artifact-id>/
    ├── G01/
    │   └── manifest.md
    ├── V01/
    │   └── manifest.md
    ├── S01/
    │   └── manifest.md
    └── T01/
        └── manifest.md
```

Un artefact commun volumineux peut vivre sous `_shared/<artifact-id>` ; chaque manifest concerné le
référence. Aucun ID ne dépend uniquement d'un lien éphémère de messagerie, d'un poste local ou d'un
ticket privé.

## Manifest obligatoire

```md
# Evidence manifest — <ID> — <release>

Requirement ID:
Requirement version/date:
Work package(s):
Owner named:
Reviewers and roles:
Applicability: Applicable | N/A
Applicability decision/justification/evidence:
Verdict if Applicable: NOT RUN | PASS | PASS-LIMITED | FAIL | BLOCKED
Verdict date:

Commit:
App build/version:
Feature flags and values:
Backend/runtime reference:
Fixture/data classification:

Platforms:
Devices/OS:
Accessibility preferences:
Network/audio conditions:

Tests executed:
- command/scenario:
- result URI:

Visual/device evidence:
- before:
- after:
- full/reduced/off:
- error/interruption/rollback:

Performance evidence:
- PERF-CALIBRATION version:
- trace/dashboard:
- result against threshold:

Functional invariants:
- source of authority:
- ACK/re-read:
- idempotence/confirmation where applicable:

Privacy review:
Rollback exercised:
Open risks:

Waiver ID/reason/compensation/approvers/expiry:
Signatures:
```

`N/A` est une valeur d'applicabilité, pas un verdict. Si elle est retenue, le manifest conserve
l'ID, nomme les décideurs, prouve l'absence factuelle du déclencheur et renvoie à la disposition
`Deferred` ou `Rejected` du registre. Une preuve applicable utilise toujours l'un des cinq verdicts
listés ci-dessus. `PASS-LIMITED` n'est admissible que dans les conditions et avant l'expiration
définies par la [DoD](../12-definition-of-done.md).

## Données interdites

Ne jamais stocker dans ce dossier :

- audio brut, transcript ou amplitude fine Bob ;
- nom, e-mail, téléphone, adresse, SIRET réel, identifiant tenant/client/document ;
- montant ou document de production ;
- token, secret, URL signée, payload outil ou erreur fournisseur brute ;
- enregistrement utilisateur sans consentement, durée de conservation et accès documentés.

Les captures utilisent des fixtures synthétiques clairement marquées et impossibles à confondre
avec une donnée de production. Les métadonnées d'image/vidéo sont expurgées si nécessaire.

## Qualité et rétention

- Une preuve est reproductible : scénario, build, appareil et résultat sont nommés.
- Un montage promotionnel ne remplace pas une vidéo brute du scénario certifié.
- Les preuves `FAIL` et `BLOCKED` sont conservées pour expliquer la décision.
- La rétention est fixée avec QA/Security avant le premier canary.
- Toute correction qui change le résultat lie l'ancien manifest et crée une nouvelle révision ; elle
  ne réécrit pas silencieusement l'historique.

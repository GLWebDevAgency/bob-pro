# DPIA — Traitements algorithmiques (IA, OCR, voix)

Analyse d'impact relative à la protection des données (RGPD art. 35) pour les traitements assistés par
IA de Bob Pro. Une DPIA formelle est recommandée car ces traitements combinent données financières et
sous-traitance (dont potentiellement hors-UE pour le LLM).

## 1. Description des traitements

| Traitement | Entrée | Sortie | Décision automatisée ? |
|---|---|---|---|
| Classification d'intention (LLM) | Texte de commande minimisé | Intention + référence (n° facture/nom) | **Non** — propose une action, exécutée par le domaine déterministe après confirmation |
| OCR de pièces | Image du reçu/justificatif | Champs extraits (montant, TVA, fournisseur) | Non — l'utilisateur valide la dépense |
| STT (reconnaissance vocale) | Audio | Texte | Non |
| TTS (synthèse vocale) | Texte (issu du domaine) | Audio | Non |

**Aucune décision produisant des effets juridiques n'est prise de façon exclusivement automatisée** (art. 22) :
l'IA *propose*, l'humain *confirme*, le domaine déterministe *exécute*. Les actions sensibles (émission de
facture, encaissement, envoi tiers) exigent une confirmation explicite — plancher de sécurité inviolable,
y compris en mode « auto » (voir [autonomy.ts](../../packages/ai/src/agent/autonomy.ts)).

## 2. Nécessité et proportionnalité

- **Finalité légitime** : réduire la charge administrative de l'artisan (assistance), sans se substituer
  à sa décision.
- **Minimisation** : seul le strict nécessaire est transmis (texte de commande minimisé par `redactPII` ;
  jamais la base clients ni les documents). La voix par défaut ne quitte pas l'appareil.
- **Alternative sans IA** : l'app est **pleinement utilisable sans assistant** (parité manuelle complète) ;
  l'IA est activable/désactivable. C'est un facteur clé de proportionnalité.

## 3. Risques et mesures

| Risque | Gravité | Mesure en place |
|---|---|---|
| Fuite de PII vers un LLM tiers (hors-UE) | Élevée | `redactPII` (e-mail/tél/IBAN/SIREN masqués) ; texte seul ; mode on-device disponible ; recommandation LLM UE |
| Hallucination d'un montant | Élevée | Montants **jamais** produits par le LLM ; `renderWithGuard` rejette tout montant hors-domaine ; évals CI anti-hallucination |
| Contournement du plancher de sécurité (injection) | Élevée | Confirmation obligatoire des actions sensibles ; évals **adversariales** en CI (injection, jailbreak, bypass) — [eval-adversarial.test.ts](../../packages/ai/src/eval/eval-adversarial.test.ts) |
| Exfiltration / hors-périmètre | Moyenne | Périmètre strictement admin/financier ; hors-scope → écarté ; évals dédiées |
| Conservation excessive de l'audio | Moyenne | Audio **non persisté** (STT → texte) |
| Transfert hors-UE (Anthropic US) | Moyenne | CCT + mesures ; option fournisseur UE ; désactivation intégrale possible |

## 4. Traçabilité et droits

- **Journalisation** : chaque décision/action de l'agent est inscrite dans un journal append-only immuable
  et rejouable (auditable) — [packages/ai/src/runtime](../../packages/ai/src/runtime).
- **Transparence** : les paliers de risque (`riskTier`) et les confirmations typées rendent explicite
  l'impact d'une action avant exécution (aperçu avant/après + écriture comptable prévisionnelle).
- **Droits des personnes** : accès/rectification via l'espace client ; effacement dans les limites des
  obligations légales de conservation (10 ans pour les pièces comptables).

## 5. Conclusion

Le dispositif est **proportionné** : IA optionnelle, minimisation active, absence de décision automatisée
à effet juridique, plancher de sécurité inviolable, traçabilité complète. Le risque résiduel principal est
le **transfert hors-UE du LLM** — à traiter par un fournisseur UE (Mistral) et/ou le mode on-device, en plus
des mesures contractuelles. Réviser cette DPIA à chaque évolution des finalités IA ou des sous-traitants.

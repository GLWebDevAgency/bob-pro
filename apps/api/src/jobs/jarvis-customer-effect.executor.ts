/**
 * Jarvis U1-d — exécuteur d'effet du vertical fiche client (spec Jarvis §5.3/§9.1,
 * SPEC_U1D_CALLERS_REELS_20260819 §3 « EXÉCUTEUR D'EFFET »).
 *
 * Le module enregistre cet exécuteur pour deux candidates techniques, pas une de plus :
 * `client-creer@1` et `client-modifier@1`. Cette présence ne publie aucune capacité : l'autorité
 * de release runtime reste fermée, l'admission profonde tranche toute nouvelle commande, et
 * élargir `U1_CANDIDATE_ACTIONS` reste une décision de lot explicite.
 *
 * AUTORITÉ MÉTIER — l'exécuteur n'écrit RIEN lui-même. Il soumet la commande aux use cases
 * canoniques de la fiche client :
 *   · création  : `Customer.of` + `customers.save`, avec l'identifiant dérivé de l'effet ;
 *   · édition   : le use case pur `UpdateCustomer.executeAtRevision` (@bob/core), avec sa garde
 *     légale du TYPE (A3/A4) et un commit CAS.
 * Le verrou société, le refus de compte clôturé et les barrières d'archives du parcours manuel
 * `BackendService.updateCustomer` ne sont PAS encore partagés par cet adapter. La publication
 * reste donc fermée jusqu'à leur extraction commune.
 * Le port `JarvisCustomerEffectAuthority` ci-dessous est la surface exacte consommée. L'adapter
 * pose uniquement la portée tenant `companyId`; le principal a été authentifié et lié au run en
 * amont par l'admission, mais n'est pas réinstallé par cette autorité métier.
 *
 * COORDINATEUR IDEMPOTENT §9.1 — « même effectId et même intention ⇒ même customerId ; crash ou
 * réponse perdue ⇒ replay sans doublon ». Il n'existe AUCUNE colonne pour mémoriser « quel effet
 * a créé quelle fiche », et une mémoire écrite APRÈS la création laisserait précisément la
 * fenêtre de crash que la règle interdit. L'identifiant de la fiche créée est donc DÉRIVÉ de
 * l'effectId (`deriveJarvisEffectCustomerId`, UUID v8, patron `deriveJarvisSystemCommandId`) :
 *   · rejouer le même effet retrouve la MÊME fiche — la relecture suffit, zéro seconde écriture ;
 *   · la réconciliation d'un worker mort entre l'autorisation et le résultat (U1-c, revue C10)
 *     devient une simple lecture (`reconcileEffect`), que le worker ROUTE désormais lui-même
 *     (revue C9 : reçu trouvé ⇒ résultat ; absence prouvée ⇒ rejeu du même effectId) ;
 *   · une écriture d'issue indécidable (exception, autorité indisponible) se tranche par cette
 *     MÊME lecture avant d'annoncer quoi que ce soit — jamais « je n'ai pas pu enregistrer »
 *     sur une fiche déjà créée (revue C10, `decideAfterIndecidableWrite`) ;
 *   · le signal de succès reste reconstructible depuis la seule ligne persistée, puisque le
 *     `customerId` se redérive de l'`effectId` (verrou identifié en tête de
 *     jarvis-work-item-dispatch.service.ts).
 * L'édition n'est PAS rejouable par simple répétition : elle porte la révision scellée jusqu'au
 * CAS du repository. Sans reçu purpose-specific par `effectId`, une reprise indécidable reste
 * inconnue et ne lance jamais un second UPDATE.
 *
 * FAIL-CLOSED — rien n'est deviné et rien n'est perdu : tout champ CONFIRMÉ qui n'atterrirait
 * pas dans l'écriture canonique (canal postal, n° de TVA sans SIREN, type légal non proposé)
 * arrête l'effet AVANT toute écriture (`failed_terminal`), jamais un enregistrement partiel et
 * silencieux de ce que l'artisan a validé à l'écran.
 *
 * GATE DE CRÉATION FERMÉ — `CustomerContactProposedFieldsV1` ne propose PAS le
 * type légal du client (b2c/b2b/b2g). Or `Customer.of` l'exige, et §8 interdit qu'un défaut non
 * confirmé entre dans un fait engageant : le type décide de la rétractation et de la TVA, et
 * devient immuable dès la première pièce signée. La création est donc REFUSÉE tant que la frame
 * ne le porte pas (`customer_type_unproposed`) ; le harnais de certification, lui, le fournit
 * explicitement (`certificationCustomerType`, même doctrine que `allowCertificationAuthority`).
 * Refermer le gate = un champ de plus dans la frame, puis `resolveProposedCustomerType` le lit —
 * rien d'autre ne bouge ici.
 *
 * CÂBLÉ MAIS NON PUBLIÉ : le worker et l'adapter existent afin que les preuves d'intégration
 * exercent la vraie chaîne. Le manifest runtime fermé empêche toute nouvelle action utilisateur ;
 * l'existence du code ne vaut ni activation, ni certification, ni release.
 */
import {
  CUSTOMER_CONTACT_ACTION_VERSION,
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  isU1CandidateAction,
  parseCustomerContactState,
  sha256Hex,
  type CustomerContactProposedFieldsV1,
  type CustomerContactStateV1,
  type CustomerProps,
  type CustomerType,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisProposalPayloadStorePort,
  computeCustomerContactUpdateTargetDigest,
  type CustomerContactEffectOutcome,
} from '@bob/core';

import type {
  JarvisEffectExecutionInput,
  JarvisSucceededEffectQuery,
  JarvisEffectExecutionOutcome,
  JarvisEffectExecutor,
  JarvisEffectReconciliation,
} from './jarvis-work-item-dispatch.service';

// ---------------------------------------------------------------------------
// Identifiant dérivé — le coordinateur idempotent §9.1, sans table
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const CUSTOMER_ID_NAMESPACE = 'bob.jarvis.customer-effect.customer-id.v1';

/**
 * `customerId` de la fiche créée par CET effet — fonction pure, totale et stable : deux
 * exécutions du même `effectId` visent la même ligne, sur n'importe quel worker, après
 * n'importe quel crash. Forme UUID v8 (variante 8, version 8), exactement comme
 * `deriveJarvisSystemCommandId` : un identifiant dérivé s'annonce comme tel.
 */
export function deriveJarvisEffectCustomerId(effectId: string): string {
  if (!UUID.test(effectId)) {
    throw new Error('effectId Jarvis invalide : UUID canonique attendu pour dériver la fiche.');
  }
  const hex = sha256Hex(JSON.stringify([CUSTOMER_ID_NAMESPACE, effectId]));
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function effectDigest(parts: readonly unknown[]): string {
  return sha256Hex(JSON.stringify(parts));
}

/** Digest de succès — redérivable de la ligne persistée (effectId ⇒ customerId ⇒ digest). */
export function jarvisCustomerEffectSuccessDigest(effectId: string, customerId: string): string {
  return effectDigest(['bob.jarvis.customer-effect.succeeded.v1', effectId, customerId]);
}

export function jarvisCustomerEffectFailureDigest(effectId: string, reasonCode: string): string {
  return effectDigest(['bob.jarvis.customer-effect.failed.v1', effectId, reasonCode]);
}

export function jarvisCustomerEffectUnknownDigest(effectId: string, reasonCode: string): string {
  return effectDigest(['bob.jarvis.customer-effect.outcome-unknown.v1', effectId, reasonCode]);
}

// ---------------------------------------------------------------------------
// Port d'autorité métier — surface EXACTE consommée sur les use cases canoniques
// ---------------------------------------------------------------------------

/** Champs canoniques d'une fiche, tels que les prennent les deux use cases de l'autorité. */
export type JarvisCustomerFields = Omit<CustomerProps, 'id' | 'companyId'>;

export interface JarvisCustomerSnapshot {
  readonly customerId: string;
  readonly fields: JarvisCustomerFields;
}

/**
 * Issue d'une écriture canonique :
 *  · `written` — la fiche est enregistrée (ou l'était déjà à l'identique) ;
 *  · `refused` — le DOMAINE refuse (validation, garde légale du type A3/A4, barrière d'archives
 *    A8, société clôturée) : aucune écriture n'a eu lieu, l'échec est terminal et honnête ;
 *  · `unavailable` — panne : l'issue réelle est INDÉCIDABLE (l'écriture a pu partir), jamais un
 *    retry aveugle derrière (§5.3).
 */
export type JarvisCustomerWriteResult =
  | { readonly status: 'written' }
  | { readonly status: 'refused'; readonly reasonCode: string }
  | { readonly status: 'unavailable' };

export interface JarvisCustomerEffectTarget {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly customerId: string;
}

/**
 * Surface consommée sur l'autorité customer canonique. L'adapter (vague B) ouvre la portée
 * tenant/principal puis délègue :
 *  · `readCustomer`  -> `Persistence.customers.findById` scopé tenant ;
 *  · `createCustomer` -> `BackendService.createCustomer`, à UNE différence près, ASSUMÉE et
 *    unique : l'identifiant est IMPOSÉ par le coordinateur §9.1 au lieu d'être minté par
 *    `UuidGenerator`. C'est précisément cette différence qui rend l'effet idempotent ; le reste
 *    (`Customer.of` puis `customers.save`, mêmes invariants que l'écran) est inchangé ;
 *  · `updateCustomerAtRevision` -> l'autorité applicative partagée avec le geste manuel : tenant,
 *    verrou société, clôture, archives puis `UpdateCustomer.executeAtRevision` et commit CAS.
 */
export interface JarvisCustomerEffectAuthority {
  readCustomer(target: JarvisCustomerEffectTarget): Promise<JarvisCustomerSnapshot | null>;
  /**
   * Révision PERSISTÉE de la fiche (U1-f). Elle n'appartient pas au domaine — c'est un compteur
   * d'écriture, comme `updatedAt` — mais le reçu de succès du run l'exige (§5.3 :
   * `outcome.customerRevision`) : c'est ce qui referme le run sur la VÉRITÉ écrite, et non sur
   * un digest opaque. Optionnelle : une autorité qui ne sait pas la rendre laisse le signal
   * inconstructible, donc le work item DÛ — jamais un reçu inventé.
   */
  readCustomerRevision?(target: JarvisCustomerEffectTarget): Promise<number | null>;
  createCustomer(
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
  ): Promise<JarvisCustomerWriteResult>;
  updateCustomerAtRevision(
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
    expectedRevision: number,
  ): Promise<JarvisCustomerWriteResult>;
}

export interface JarvisCustomerEffectDeps {
  /** Lecture stateless du run (zéro verrou, zéro écriture) : l'intention fait AUTORITÉ. */
  readonly admission: JarvisAdmissionUnitOfWorkPort;
  /** Charge scellée de la proposition — le PII confirmé, jamais reconstruit d'ailleurs. */
  readonly payloads: JarvisProposalPayloadStorePort;
  readonly customers: JarvisCustomerEffectAuthority;
  /**
   * HARNAIS DE CERTIFICATION UNIQUEMENT — type légal de la fiche créée, en attendant que la
   * frame le PROPOSE (voir `resolveProposedCustomerType`). Même doctrine que
   * `allowCertificationAuthority` de l'admission : absent de tout câblage de production, où la
   * création reste refusée `customer_type_unproposed` plutôt que de deviner un régime légal.
   */
  readonly certificationCustomerType?: CustomerType;
}

// ---------------------------------------------------------------------------
// Projection champs proposés -> fiche canonique : totale, sans invention ni perte
// ---------------------------------------------------------------------------

type FieldsProjection =
  | { readonly ok: true; readonly fields: JarvisCustomerFields }
  | { readonly ok: false; readonly reasonCode: string };

/**
 * Type légal du client (b2c/b2b/b2g) : fait ENGAGEANT (§8) — il décide du régime de rétractation
 * et de la TVA, et il devient immuable dès la première pièce signée (UpdateCustomer, A3/A4). Il
 * ne se devine NI d'une raison sociale, NI d'un numéro de TVA : il est proposé, présenté, puis
 * confirmé. `CustomerContactProposedFieldsV1` ne le porte pas encore — la création est donc
 * refusée fail-closed (`customer_type_unproposed`) tant que la frame ne le propose pas ; cette
 * lecture défensive devient sa lecture directe le jour où le champ existe, sans autre changement.
 */
function resolveProposedCustomerType(fields: CustomerContactProposedFieldsV1): CustomerType | null {
  const proposed = (fields as { readonly customerType?: unknown }).customerType;
  return proposed === 'b2c' || proposed === 'b2b' || proposed === 'b2g' ? proposed : null;
}

/**
 * Refus des champs confirmés que l'écriture canonique ne saurait pas porter — le silence serait
 * pire que l'échec : l'artisan a VU et VALIDÉ ces champs à l'écran.
 *  · `billingChannel = 'postal'` : le domaine ne connaît que email | chorus | portail ;
 *  · `vatNumber` : `Customer.of` exige un SIREN avec un n° de TVA français, et aucune frame U1-d
 *    ne propose de SIREN — enregistrer la fiche sans la TVA confirmée serait une perte muette.
 */
function refuseUnsupportedProposals(fields: CustomerContactProposedFieldsV1): string | null {
  if (fields.billingChannel === 'postal') return 'billing_channel_unsupported';
  if (fields.vatNumber !== null) return 'vat_number_requires_siren';
  return null;
}

function trimmedOrUndefined(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

/** Création : fiche MINIMALE, exactement comme l'écran Clients et l'outil vocal `creer_client`. */
function projectCreateFields(
  fields: CustomerContactProposedFieldsV1,
  certificationCustomerType: CustomerType | undefined,
): FieldsProjection {
  const unsupported = refuseUnsupportedProposals(fields);
  if (unsupported !== null) return { ok: false, reasonCode: unsupported };
  const type = resolveProposedCustomerType(fields) ?? certificationCustomerType ?? null;
  if (type === null) return { ok: false, reasonCode: 'customer_type_unproposed' };
  const name = fields.displayName ?? fields.legalName;
  if (name === null) return { ok: false, reasonCode: 'customer_name_unproposed' };
  return {
    ok: true,
    fields: {
      type,
      name,
      // L'adresse est requise par le domaine mais pas par la création minimale : elle part vide
      // et se complète sur la fiche (même choix littéral que `creer_client`,
      // backend.service.ts:5189) — jamais une adresse inventée.
      address: {
        line1: fields.addressLine ?? '',
        zip: fields.postalCode ?? '',
        city: fields.city ?? '',
      },
      ...(fields.email === null ? {} : { email: fields.email }),
      ...(fields.phone === null ? {} : { phone: fields.phone }),
      ...(fields.recipientName === null ? {} : { contactName: fields.recipientName }),
      ...(fields.billingChannel === null ? {} : { billingChannel: { type: 'email' as const } }),
    },
  };
}

/**
 * Édition : `UpdateCustomer` est un REMPLACEMENT complet revalidé (jamais un merge côté domaine)
 * — la fiche courante est donc relue et seuls les champs PROPOSÉS la recouvrent. `null` = « non
 * proposé », jamais « effacer » : un effacement est une intention distincte, hors U1-d.
 */
function projectUpdateFields(
  current: JarvisCustomerFields,
  fields: CustomerContactProposedFieldsV1,
): FieldsProjection {
  const unsupported = refuseUnsupportedProposals(fields);
  if (unsupported !== null) return { ok: false, reasonCode: unsupported };
  const proposedType = resolveProposedCustomerType(fields);
  const name = fields.displayName ?? fields.legalName ?? current.name;
  const address =
    fields.addressLine === null && fields.postalCode === null && fields.city === null
      ? current.address
      : {
          ...current.address,
          ...(fields.addressLine === null ? {} : { line1: fields.addressLine }),
          ...(fields.postalCode === null ? {} : { zip: fields.postalCode }),
          ...(fields.city === null ? {} : { city: fields.city }),
        };
  const email = trimmedOrUndefined(fields.email) ?? current.email;
  const phone = trimmedOrUndefined(fields.phone) ?? current.phone;
  const contactName = trimmedOrUndefined(fields.recipientName) ?? current.contactName;
  return {
    ok: true,
    fields: {
      ...current,
      type: proposedType ?? current.type,
      name,
      address,
      ...(email === undefined ? {} : { email }),
      ...(phone === undefined ? {} : { phone }),
      ...(contactName === undefined ? {} : { contactName }),
      ...(fields.billingChannel === null ? {} : { billingChannel: { type: 'email' as const } }),
    },
  };
}

// ---------------------------------------------------------------------------
// Réconciliation par effectId (U1-c, revue C10 : « U1-d doit trancher »)
// ---------------------------------------------------------------------------

/**
 * Verdict rendu au worker quand une ligne `authorized` est reprise après la mort de son porteur
 * (type CANONIQUE du worker : `JarvisEffectReconciliation`, routé par
 * `reconcileReclaimedAuthorized` — revue C9) :
 *  · `landed` — la fiche dérivée EXISTE : l'effet est parti et a abouti, le résultat est décidé ;
 *  · `not_landed` — création : aucune fiche à l'identifiant dérivé, donc rien n'est parti ;
 *  · `undecidable` — la base ne répond pas : on ne clôt rien (jamais une issue inventée).
 */
export type JarvisCustomerEffectReconciliation = JarvisEffectReconciliation;

// ---------------------------------------------------------------------------
// L'exécuteur
// ---------------------------------------------------------------------------

export class JarvisCustomerEffectExecutor implements JarvisEffectExecutor {
  constructor(private readonly deps: JarvisCustomerEffectDeps) {}

  async execute(input: JarvisEffectExecutionInput): Promise<JarvisEffectExecutionOutcome> {
    const { coordinates, lease } = input;
    const mode = customerEffectMode(lease.actionId, lease.actionVersion);
    if (mode === null) {
      return failed(lease.effectId, 'action_not_open');
    }
    const intent = await this.readIntent(input, mode);
    if (intent.kind === 'refused') return failed(lease.effectId, intent.reasonCode);
    if (intent.kind === 'unavailable') return undecided(lease.effectId, intent.reasonCode);

    const target: JarvisCustomerEffectTarget = {
      companyId: coordinates.companyId,
      ownerUserId: coordinates.ownerUserId,
      customerId: intent.customerId,
    };
    let existing: JarvisCustomerSnapshot | null;
    try {
      existing = await this.deps.customers.readCustomer(target);
    } catch {
      return undecided(lease.effectId, 'customer_read_failed');
    }

    if (mode === 'create') {
      // Coordinateur §9.1 : la fiche dérivée existe déjà ⇒ CET effet a déjà atterri. Zéro
      // écriture, même customerId — un replay ne double jamais une fiche client.
      if (existing !== null) {
        return succeeded(lease.effectId, target.customerId);
      }
      const projected = projectCreateFields(intent.fields, this.deps.certificationCustomerType);
      if (!projected.ok) return failed(lease.effectId, projected.reasonCode);
      return this.write(lease.effectId, target, projected.fields, 'create', null);
    }

    if (existing === null) return failed(lease.effectId, 'customer_missing');
    const projected = projectUpdateFields(existing.fields, intent.fields);
    if (!projected.ok) return failed(lease.effectId, projected.reasonCode);
    if (intent.expectedRevision === null) return failed(lease.effectId, 'target_revision_missing');
    return this.write(
      lease.effectId,
      target,
      projected.fields,
      'update',
      intent.expectedRevision,
    );
  }

  /**
   * Réconciliation d'un effet dont le résultat n'a jamais été persisté. Pure lecture : elle
   * n'écrit rien et ne clôt rien elle-même — elle rend au worker de quoi décider.
   */
  /**
   * U1-f — DÉCRIT L'EFFET RÉUSSI pour que le worker puisse refermer le run sur la VÉRITÉ écrite.
   *
   * Le reçu de succès de `customer_contact` exige l'identité ET la révision de la fiche (§5.3) :
   * un `resultDigest` opaque ne les porte pas, et le worker ne peut pas les inventer. Cette
   * description est RECONSTRUCTIBLE sans lease ni mémoire — exactement ce qu'exige la redelivery
   * après un redémarrage :
   *   · en création, le `customerId` est DÉRIVÉ de l'`effectId` (namespace d'idempotence) ;
   *   · en modification, il est porté par l'intention du run, relue en stateless.
   * La révision écrite est DÉTERMINISTE : 1 en création, `target.revision + 1` en modification.
   * La relecture tardive prouve seulement que cette révision a existé ; elle ne remplace pas le
   * reçu par une correction humaine plus récente.
   *
   * `null` à la moindre incertitude — fiche absente, autorité muette, run illisible : le signal
   * reste alors inconstructible et le work item DÛ. Un reçu approximatif refermerait un run sur
   * une révision fausse, et la garde §9.1 deviendrait aveugle pour la proposition suivante.
   */
  async describeSucceededEffect(
    input: JarvisSucceededEffectQuery,
  ): Promise<CustomerContactEffectOutcome | null> {
    const { coordinates, effectId } = input;
    const readRevision = this.deps.customers.readCustomerRevision?.bind(this.deps.customers);
    if (readRevision === undefined) return null;
    const state = await this.readRunState(
      coordinates.companyId,
      coordinates.ownerUserId,
      coordinates.runId,
    );
    if (state.kind !== 'read' || state.state === null) return null;
    // IDEMPOTENCE D'ABORD. La révision du reçu sert au domaine à reconnaître un REJEU : un second
    // signal identique est un no-op. Si on relisait la base à chaque redelivery, une écriture
    // survenue entre-temps (l'artisan corrige sa fiche) donnerait une révision différente, et le
    // rejeu cesserait d'être reconnu comme tel. Quand le run porte DÉJÀ le reçu de cet effet, il
    // fait donc foi : on le rend tel quel, à l'octet.
    const dejaRecu = state.state.receipt;
    if (dejaRecu !== null && dejaRecu.effectId === effectId) {
      return {
        kind: 'succeeded',
        customerId: dejaRecu.customerId,
        customerRevision: dejaRecu.customerRevision,
      };
    }
    const intent = state.state.intent;
    // Le `customerId` suit la MÊME règle que l'écriture — sinon la description décrirait une
    // autre fiche que celle qui a été touchée.
    const customerId =
      intent.mode === 'update' ? intent.target.customerId : deriveJarvisEffectCustomerId(effectId);
    const writtenRevision = intent.mode === 'update' ? intent.target.revision + 1 : 1;
    if (!Number.isSafeInteger(writtenRevision) || writtenRevision < 1) return null;
    // L'effet doit être VÉRIFIABLE : une fiche absente ou moins avancée que le postimage attendu
    // signifie qu'aucun succès ne peut être acquitté. Une révision PLUS avancée appartient à une
    // correction ultérieure et ne réécrit pas l'histoire de cet effet.
    try {
      const currentRevision = await readRevision({
        companyId: coordinates.companyId,
        ownerUserId: coordinates.ownerUserId,
        customerId,
      });
      if (
        currentRevision === null
        || !Number.isSafeInteger(currentRevision)
        || currentRevision < writtenRevision
      ) {
        return null;
      }
      return { kind: 'succeeded', customerId, customerRevision: writtenRevision };
    } catch {
      return null;
    }
  }

  /**
   * AXE `targetDigest` DE LA REVALIDATION (§5.3) — le worker recalcule le sceau de cible AVANT
   * d'écrire, et annule (`target_digest_drift`) s'il a bougé. Sans cette méthode, le worker
   * SAUTAIT silencieusement la vérification : le sceau était posé par le domaine, transporté par
   * la ligne… et jamais confronté à la réalité. Un axe de sûreté que personne ne sait recalculer
   * est un axe mort.
   *
   * Le sceau est `(customerId, révision vérifiée)` : on relit donc la révision COURANTE et on
   * reproduit le calcul du domaine. Si la fiche a été modifiée entre la confirmation et
   * l'exécution, les digests divergent et l'effet est annulé plutôt que d'écraser un travail que
   * l'artisan n'a jamais vu. Aucune révision lisible ⇒ `null`, ce que le worker traite comme une
   * divergence : on n'écrit pas sur une cible qu'on ne peut pas vérifier.
   */
  async recalculateTargetDigest(input: JarvisEffectExecutionInput): Promise<string | null> {
    const { coordinates, lease } = input;
    // Le sceau n'existe QUE pour une modification : ailleurs, il n'y a rien à revalider et
    // `null` dit exactement cela — le worker ne compare alors rien (il ne rentre dans cet axe
    // que si la ligne porte un `targetDigest`).
    if (customerEffectMode(lease.actionId, lease.actionVersion) !== 'update') return null;
    // « JE NE SAIS PAS » N'EST PAS « ÇA A CHANGÉ ». Le worker traite tout écart au sceau comme
    // une dérive et ANNULE l'effet ; rendre `null` sur une simple panne de lecture annulerait
    // donc une écriture que l'artisan a confirmée. On LÈVE : le worker traduit l'exception en
    // réessai motivé (`target_digest_recalculation_failed`), et l'effet reste dû.
    const readRevision = this.deps.customers.readCustomerRevision?.bind(this.deps.customers);
    if (readRevision === undefined) {
      throw new Error('jarvis_customer_effect_revision_unreadable:authority_without_revision');
    }
    const state = await this.readRunState(
      coordinates.companyId,
      coordinates.ownerUserId,
      coordinates.runId,
    );
    if (state.kind !== 'read' || state.state === null) {
      throw new Error('jarvis_customer_effect_revision_unreadable:run_unreadable');
    }
    const intent = state.state.intent;
    if (intent.mode !== 'update') return null;
    const revision = await readRevision({
      companyId: coordinates.companyId,
      ownerUserId: coordinates.ownerUserId,
      customerId: intent.target.customerId,
    });
    if (revision === null) {
      // Fiche introuvable : ce n'est pas une panne de lecture, c'est une cible qui n'est plus là.
      // Le sceau ne peut plus correspondre, et l'annulation est la bonne réponse.
      return null;
    }
    return computeCustomerContactUpdateTargetDigest(intent.target.customerId, revision);
  }

  async reconcileEffect(
    input: JarvisEffectExecutionInput,
  ): Promise<JarvisCustomerEffectReconciliation> {
    const { coordinates, lease } = input;
    const mode = customerEffectMode(lease.actionId, lease.actionVersion);
    if (mode === null) return { kind: 'undecidable' };
    // Sans reçu purpose-specific par effectId, une fiche existante ne permet pas de distinguer
    // « mon UPDATE a committé » de « une autre main a écrit ». Rejouer serait un lost-update.
    if (mode === 'update') return { kind: 'undecidable' };
    const customerId = deriveJarvisEffectCustomerId(lease.effectId);
    try {
      const existing = await this.deps.customers.readCustomer({
        companyId: coordinates.companyId,
        ownerUserId: coordinates.ownerUserId,
        customerId,
      });
      return existing === null
        ? { kind: 'not_landed' }
        : { kind: 'landed', outcome: succeeded(lease.effectId, customerId) };
    } catch {
      return { kind: 'undecidable' };
    }
  }

  private async write(
    effectId: string,
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
    mode: CustomerEffectMode,
    expectedRevision: number | null,
  ): Promise<JarvisEffectExecutionOutcome> {
    let result: JarvisCustomerWriteResult;
    try {
      result =
        mode === 'create'
          ? await this.deps.customers.createCustomer(target, fields)
          : expectedRevision === null
            ? { status: 'refused', reasonCode: 'target_revision_missing' }
            : await this.deps.customers.updateCustomerAtRevision(
                target,
                fields,
                expectedRevision,
              );
    } catch {
      // Une exception APRÈS l'autorisation est indécidable par principe : l'écriture a pu
      // partir — on la TRANCHE par une lecture avant d'annoncer quoi que ce soit (revue C10).
      return this.decideAfterIndecidableWrite(effectId, target, mode, 'customer_authority_failed');
    }
    if (result.status === 'written') return succeeded(effectId, target.customerId);
    if (result.status === 'refused') return failed(effectId, result.reasonCode);
    // `unavailable` = l'autorité elle-même déclare l'issue inconnue : même traitement.
    return this.decideAfterIndecidableWrite(
      effectId,
      target,
      mode,
      'customer_authority_unavailable',
    );
  }

  /**
   * INDÉCIDABLE ⇒ ON LIT D'ABORD (revue C10, §5.3 « il réconcilie d'abord l'autorité métier avec
   * le même effectId »). Annoncer un échec sans cette lecture, c'est risquer de dire « je n'ai
   * pas pu enregistrer » alors que la fiche existe : l'artisan la recréerait à la main.
   *
   * CRÉATION — la lecture EXISTE et elle est exacte : `customerId` est DÉRIVÉ de l'`effectId`
   * (coordinateur §9.1), donc `readCustomer` interroge la clé d'idempotence elle-même. Fiche
   * trouvée ⇒ l'écriture a bien atterri, le succès est le mot juste (même digest qu'un chemin
   * nominal). Absence lue ⇒ rien n'a été commité à cette clé : `outcome_unknown` MOTIVÉ
   * (`_not_landed`) plutôt qu'un succès inventé — une transaction encore en vol ne peut pas être
   * exclue par une lecture, et §5.3 réserve `failed_terminal` aux refus du domaine, jamais aux
   * pannes. Lecture impossible ⇒ `_unreadable` : on ne sait rien, on le dit.
   *
   * ÉDITION — TROU ASSUMÉ ET NOMMÉ : l'idempotence de l'édition tient à la cible, pas à une clé
   * dérivée, et la fiche existe des DEUX côtés de l'écriture. Relire ne distinguerait pas « mon
   * écriture a atterri » d'« une autre main a écrit la même chose », et le postimage seul ne dit
   * pas QUI l'a écrit : trancher exigerait que l'autorité rende la révision/le reçu de son
   * écriture (`updateCustomerAtRevision` ne rend aujourd'hui qu'un statut). L'issue reste donc
   * `outcome_unknown` motivée. Une reprise après mort du worker reste elle aussi `undecidable` :
   * sans reçu purpose-specific, répéter l'UPDATE pourrait écraser une correction plus récente.
   * On ne promet donc pas un rattrapage qui n'existe pas et on ne rejoue rien à l'aveugle.
   */
  private async decideAfterIndecidableWrite(
    effectId: string,
    target: JarvisCustomerEffectTarget,
    mode: CustomerEffectMode,
    cause: 'customer_authority_failed' | 'customer_authority_unavailable',
  ): Promise<JarvisEffectExecutionOutcome> {
    if (mode === 'update') return undecided(effectId, cause);
    let landed: JarvisCustomerSnapshot | null;
    try {
      landed = await this.deps.customers.readCustomer(target);
    } catch {
      return undecided(effectId, `${cause}_unreadable`);
    }
    if (landed !== null) return succeeded(effectId, target.customerId);
    return undecided(effectId, `${cause}_not_landed`);
  }

  /**
   * Intention RÉELLE de l'effet : relue du run admis (autorité serveur) puis recoupée avec le
   * work item. Le work item seul ne suffit pas — il ne porte ni la cible d'une édition ni la
   * proposition courante ; et la charge scellée ne se lit qu'avec le digest que le run promet.
   */
  private async readIntent(
    input: JarvisEffectExecutionInput,
    mode: CustomerEffectMode,
  ): Promise<CustomerEffectIntent> {
    const { coordinates, lease } = input;
    const payloadRef = parsePayloadRef(lease.payloadRef);
    if (payloadRef === null) return refuse('payload_ref_invalid');

    const runRead = await this.readRunState(
      coordinates.companyId,
      coordinates.ownerUserId,
      coordinates.runId,
    );
    if (runRead.kind !== 'read') return runRead.intent;
    const state = runRead.state;
    // L'effet exécuté est bien CELUI du run (§5.3 : staleness par effectId, jamais par révision).
    if (state.effectId !== lease.effectId) return refuse('effect_id_mismatch');
    if (state.intent.mode !== mode) return refuse('intent_mode_mismatch');
    const proposal = state.proposal;
    if (proposal === null) return refuse('proposal_absent');
    // Le work item et le run doivent désigner LA MÊME proposition scellée : deux sources, un
    // seul sceau — sinon la charge lue ne serait pas celle qui a été confirmée.
    if (
      payloadRef.proposalId !== proposal.proposalId ||
      payloadRef.fieldsDigest !== proposal.fieldsDigest
    ) {
      return refuse('payload_ref_mismatch');
    }

    const payload = await this.deps.payloads.readProposalPayload({
      companyId: coordinates.companyId,
      ownerUserId: coordinates.ownerUserId,
      runId: coordinates.runId,
      proposalId: proposal.proposalId,
      fieldsDigest: proposal.fieldsDigest,
    });
    // Charge absente, altérée ou périmée (greffe G4) : AUCUN effet sur des champs non prouvés.
    if (payload === null) return refuse('payload_unavailable');
    if (payload.sensitiveDigest !== proposal.sensitiveDigest) {
      return refuse('sensitive_digest_mismatch');
    }

    const customerId =
      state.intent.mode === 'update'
        ? state.intent.target.customerId
        : deriveJarvisEffectCustomerId(lease.effectId);
    if (state.intent.mode === 'update') {
      const expectedRevision = state.intent.target.revision;
      if (proposal.targetRevision !== expectedRevision) {
        return refuse('target_revision_mismatch');
      }
      if (expectedRevision >= 2_147_483_647) {
        return refuse('target_revision_overflow');
      }
      const expectedTargetDigest = computeCustomerContactUpdateTargetDigest(
        customerId,
        expectedRevision,
      );
      if (lease.targetDigest !== expectedTargetDigest) {
        return refuse('target_digest_mismatch');
      }
      return {
        kind: 'ready',
        customerId,
        fields: payload.fields,
        expectedRevision,
      };
    }
    return { kind: 'ready', customerId, fields: payload.fields, expectedRevision: null };
  }

  /** Lecture stateless du run, traduite en intention refusée/indisponible plutôt qu'en exception. */
  private async readRunState(
    companyId: string,
    ownerUserId: string,
    runId: string,
  ): Promise<RunStateRead> {
    try {
      const read = await this.deps.admission.readJarvisStateless(
        { companyId, ownerUserId },
        (view) => view.runById(runId),
      );
      const run = read.value;
      if (run === null) return { kind: 'absent', intent: refuse('run_missing') };
      if (run.kind !== 'customer_contact') {
        return { kind: 'absent', intent: refuse('run_kind_unsupported') };
      }
      const state = parseCustomerContactState(run.state);
      return state === null
        ? { kind: 'absent', intent: refuse('run_state_unreadable') }
        : { kind: 'read', state };
    } catch {
      return {
        kind: 'absent',
        intent: { kind: 'unavailable', reasonCode: 'run_read_failed' },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Détails privés
// ---------------------------------------------------------------------------

type CustomerEffectMode = 'create' | 'update';

type CustomerEffectIntent =
  | {
      readonly kind: 'ready';
      readonly customerId: string;
      readonly fields: CustomerContactProposedFieldsV1;
      readonly expectedRevision: number | null;
    }
  | { readonly kind: 'refused'; readonly reasonCode: string }
  | { readonly kind: 'unavailable'; readonly reasonCode: string };

type RunStateRead =
  | { readonly kind: 'read'; readonly state: CustomerContactStateV1 }
  | { readonly kind: 'absent'; readonly intent: CustomerEffectIntent };

function refuse(reasonCode: string): CustomerEffectIntent {
  return { kind: 'refused', reasonCode };
}

/**
 * Borne technique : `U1_CANDIDATE_ACTIONS` d'abord (source unique, greffe G2), puis l'appartenance
 * au vertical `customer_contact@1`. Tout le reste reste sans exécuteur — `executor_unregistered`.
 */
function customerEffectMode(actionId: string, actionVersion: number): CustomerEffectMode | null {
  if (!isU1CandidateAction(actionId, actionVersion)) return null;
  if (actionVersion !== CUSTOMER_CONTACT_ACTION_VERSION) return null;
  if (actionId === CUSTOMER_CONTACT_CREATE_ACTION_ID) return 'create';
  if (actionId === CUSTOMER_CONTACT_UPDATE_ACTION_ID) return 'update';
  return null;
}

function parsePayloadRef(
  value: unknown,
): { readonly proposalId: string; readonly fieldsDigest: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const proposalId = record['proposalId'];
  const fieldsDigest = record['fieldsDigest'];
  if (typeof proposalId !== 'string' || typeof fieldsDigest !== 'string') return null;
  return { proposalId, fieldsDigest };
}

function succeeded(effectId: string, customerId: string): JarvisEffectExecutionOutcome {
  return {
    status: 'succeeded',
    resultDigest: jarvisCustomerEffectSuccessDigest(effectId, customerId),
  };
}

function failed(effectId: string, reasonCode: string): JarvisEffectExecutionOutcome {
  return {
    status: 'failed_terminal',
    resultDigest: jarvisCustomerEffectFailureDigest(effectId, reasonCode),
  };
}

function undecided(effectId: string, reasonCode: string): JarvisEffectExecutionOutcome {
  return {
    status: 'outcome_unknown',
    resultDigest: jarvisCustomerEffectUnknownDigest(effectId, reasonCode),
  };
}

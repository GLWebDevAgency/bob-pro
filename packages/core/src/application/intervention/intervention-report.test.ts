import { describe, expect, it } from 'vitest';
import { Chantier } from '../../domain/chantier/chantier';
import { Company } from '../../domain/company/company';
import { Customer } from '../../domain/customer/customer';
import { Document } from '../../domain/document/document';
import { Intervention, type InterventionProps } from '../../domain/intervention/intervention';
import { type Notification } from '../ports/output';
import { type ChantierRepository, type ChantierNoteRepository, type CompanyRepository, type CustomerRepository } from '../ports/repositories';
import { type DocumentStoragePort, type StoredObject } from '../ports/document-storage';
import { type WorksiteMediaStorage } from '../ports/worksite-media';
import { type InterventionRepository, type CompanyInterventionSettings } from './intervention-repository';
import {
  GenerateInterventionReport,
  type InterventionReportData,
  type InterventionReportState,
} from './generate-intervention-report';
import {
  SendInterventionReport,
  interventionReportDedupeKey,
} from './send-intervention-report';
import { SignIntervention } from './sign-intervention';

/**
 * [Revue adversariale 28/07 — findings 1-3] Trois défauts de la fiche ARCHIVÉE, chacun prouvé
 * AVANT d'être corrigé :
 *  1. l'archivage écrivait la fiche SANS transaction, SANS verrou et SANS CAS — une signature
 *     concurrente arrivée pendant le rendu (I/O longue) était ÉCRASÉE (perte de preuve).
 *     La contre-preuve est une COURSE réellement exécutée (deux écritures concurrentes) ;
 *  2. le mail NOMMAIT la pièce autrement que la pièce elle-même (titre relu au moment de
 *     l'envoi vs nom de fichier figé à l'archivage) ;
 *  3. la clé de déduplication ne portait pas le DESTINATAIRE : envoyer la même fiche à un
 *     second contact levait une exception technique de l'outbox.
 */

const COMPANY = 'co-1';
const SITE = 'site-bastille';
const CUSTOMER = 'cust-ratp';
const INTERVENTION = '5f0c9a52-8e5c-4a4f-9d21-3f6b1a2c4d5e';
const TRACE_SHA = 'a'.repeat(64);
const PDF_SHA = 'b'.repeat(64);

function companyOf(): Company {
  const company = Company.of({
    id: COMPANY,
    name: 'Fontaines & Co',
    legalForm: 'SASU',
    siren: '732829320',
    siret: '73282932000074',
    trade: 'autre',
    vatRegime: 'reel_normal',
    email: 'contact@fontaines.example',
    address: { line1: '1 rue de la Pompe', zip: '75016', city: 'Paris' },
  });
  if (!company.ok) throw new Error('fixture société invalide');
  return company.value;
}

function customerOf(): Customer {
  const customer = Customer.of({
    id: CUSTOMER,
    companyId: COMPANY,
    type: 'b2b',
    name: 'RATP CAP',
    email: 'compta@ratp.example',
    address: { line1: '1 place de la Bastille', zip: '75011', city: 'Paris' },
  });
  if (!customer.ok) throw new Error('fixture client invalide');
  return customer.value;
}

function chantierOf(): Chantier {
  return Chantier.rehydrate({
    id: SITE,
    companyId: COMPANY,
    name: 'RATP Bastille',
    customerId: CUSTOMER,
    address: '1 place de la Bastille, 75011 Paris',
    notes: null,
    status: 'open',
    openedAt: '2026-07-01',
  });
}

function completedProps(overrides: Partial<InterventionProps> = {}): InterventionProps {
  return {
    id: INTERVENTION,
    companyId: COMPANY,
    chantierId: SITE,
    customerId: CUSTOMER,
    contractId: null,
    equipmentId: null,
    kind: 'Visite d’entretien',
    status: 'completed',
    plannedAt: '2026-08-04T07:00:00.000Z',
    technicianLabel: 'Papa',
    startedAt: '2026-08-04T07:04:00.000Z',
    finishedAt: '2026-08-04T08:12:00.000Z',
    checklist: [{ label: 'Détartrage', done: true }],
    summary: 'Pression basse au démarrage, réglée.',
    signature: null,
    reportDocumentId: null,
    billedInvoiceId: null,
    revision: 3,
    ...overrides,
  };
}

/** Double d'outbox FIDÈLE au contrat réel : unicité (companyId, kind, dedupeKey) + empreinte
 *  de charge utile. Un même couple avec un CONTENU différent lève — comme PrismaNotificationJob. */
class OutboxDouble {
  readonly orders: {
    companyId: string;
    kind: string;
    dedupeKey: string;
    notification: Notification;
  }[] = [];

  private readonly byKey = new Map<string, string>();

  private static fingerprint(notification: Notification): string {
    return JSON.stringify([
      notification.channel,
      notification.to,
      notification.subject,
      notification.body,
    ]);
  }

  enqueue = async (order: {
    companyId: string;
    kind: 'intervention-report';
    dedupeKey: string;
    notification: Notification;
  }): Promise<{ jobId: string; status: 'pending' | 'done' | 'failed' }> => {
    const identity = `${order.companyId}|${order.kind}|${order.dedupeKey}`;
    const fingerprint = OutboxDouble.fingerprint(order.notification);
    const known = this.byKey.get(identity);
    if (known !== undefined && known !== fingerprint) {
      throw new Error(`NotificationDedupeConflictError: ${order.dedupeKey}`);
    }
    if (known === undefined) {
      this.byKey.set(identity, fingerprint);
      this.orders.push(order);
      return { jobId: `job-${this.byKey.size}`, status: 'pending' };
    }
    // Rejeu EXACT du même geste : idempotent, aucun second envoi.
    return { jobId: `job-${[...this.byKey.keys()].indexOf(identity) + 1}`, status: 'pending' };
  };
}

interface Env {
  interventions: InterventionRepository;
  store: Map<string, Intervention>;
  documents: Map<string, Document>;
  bytesByKey: Map<string, Uint8Array>;
  settings: { current: CompanyInterventionSettings | null };
  outbox: OutboxDouble;
  renderCount: () => number;
  generate(hooks?: { onRender?: () => Promise<void> }): GenerateInterventionReport;
  send(): SendInterventionReport;
  sign(): SignIntervention;
  uowDepth: () => number;
}

function makeEnv(seedProps: InterventionProps = completedProps()): Env {
  const store = new Map<string, Intervention>([
    [seedProps.id, Intervention.rehydrate(seedProps)],
  ]);
  const documents = new Map<string, Document>();
  const bytesByKey = new Map<string, Uint8Array>();
  const settings: { current: CompanyInterventionSettings | null } = { current: null };
  const outbox = new OutboxDouble();
  let renders = 0;

  // Verrou de LIGNE simulé : `runInTransaction` sérialise réellement les sections critiques
  // (modèle du SELECT … FOR UPDATE) — sans quoi la course ne prouverait rien.
  let queue: Promise<unknown> = Promise.resolve();
  let depth = 0;
  const uow = {
    runInTransaction: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = queue.then(async () => {
        depth += 1;
        try {
          return await fn();
        } finally {
          depth -= 1;
        }
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run as Promise<T>;
    },
  };

  const interventions: InterventionRepository = {
    findById: async (companyId, id) => {
      const found = store.get(id);
      return found && found.companyId === companyId ? Intervention.rehydrate(found.toProps()) : null;
    },
    lockById: async (companyId, id) => {
      const found = store.get(id);
      return found && found.companyId === companyId ? Intervention.rehydrate(found.toProps()) : null;
    },
    create: async () => ({ outcome: 'created' }),
    save: async (intervention) => {
      store.set(intervention.id, Intervention.rehydrate(intervention.toProps()));
    },
    listByChantier: async () => [],
    listByCompany: async () => [],
    detachByInvoice: async () => undefined,
  };

  const companies: CompanyRepository = {
    findById: async () => companyOf(),
    lockById: async () => companyOf(),
    lockForShareById: async () => companyOf(),
    list: async () => [companyOf()],
    save: async () => undefined,
  };
  const customers: Pick<CustomerRepository, 'findById'> = { findById: async () => customerOf() };
  const chantiers: ChantierRepository = {
    findById: async () => chantierOf(),
    listByCompany: async () => [chantierOf()],
    save: async () => undefined,
  };
  const notes: Pick<ChantierNoteRepository, 'listByChantier'> = { listByChantier: async () => [] };
  const media: WorksiteMediaStorage = {
    save: async () => undefined,
    listByChantier: async () => [],
    findById: async () => null,
    remove: async () => undefined,
    countByCompany: async () => new Map(),
  };
  const storage: DocumentStoragePort = {
    put: async ({ key, bytes, contentType }): Promise<StoredObject> => {
      bytesByKey.set(key, bytes);
      return { key, sizeBytes: bytes.byteLength, sha256: PDF_SHA, contentType, created: true };
    },
    get: async (_companyId, key) => {
      const bytes = bytesByKey.get(key);
      return bytes === undefined
        ? null
        : { key, bytes, sizeBytes: bytes.byteLength, sha256: PDF_SHA, contentType: 'application/pdf' };
    },
    getSignedUrl: async () => 'https://example.test/signed',
    stat: async () => null,
    remove: async () => undefined,
  };

  const documentIds = {
    documentId: (companyId: string, interventionId: string, state: InterventionReportState) =>
      `doc-${companyId}-${interventionId}-${state}`,
    versionId: (companyId: string, interventionId: string, state: InterventionReportState) =>
      `ver-${companyId}-${interventionId}-${state}`,
  };

  const clock = { now: () => '2026-08-04T09:00:00.000Z', today: () => '2026-08-04' };

  return {
    interventions,
    store,
    documents,
    bytesByKey,
    settings,
    outbox,
    renderCount: () => renders,
    uowDepth: () => depth,
    generate: (hooks) =>
      new GenerateInterventionReport({
        interventions,
        companies,
        customers,
        chantiers,
        notes,
        media,
        interventionSettings: { find: async () => settings.current, save: async () => undefined },
        renderer: {
          renderInterventionReport: async (_data: InterventionReportData) => {
            renders += 1;
            // I/O LONGUE : c'est pendant cette fenêtre que la signature concurrente arrive.
            if (hooks?.onRender) await hooks.onRender();
            return new Uint8Array([37, 80, 68, 70, renders]);
          },
        },
        documents: {
          insertInitialOrConfirmExact: async (document) => {
            const existing = documents.get(document.id);
            if (existing) return { status: 'exact', document: existing };
            documents.set(document.id, document);
            return { status: 'inserted', document };
          },
          findById: async (companyId, id) => {
            const found = documents.get(id);
            return found && found.toProps().companyId === companyId ? found : null;
          },
        },
        folders: { findById: async () => null },
        linkTargets: { exists: async () => true },
        storage,
        documentIds,
        hash: { sha256HexOfBytes: () => PDF_SHA },
        clock,
        uow,
      }),
    send: () =>
      new SendInterventionReport({
        interventions,
        companies,
        customers,
        chantiers,
        interventionSettings: { find: async () => settings.current, save: async () => undefined },
        documentIds: { documentId: documentIds.documentId },
        archive: {
          loadArchivedReportPdf: async (companyId, documentId) => {
            const found = documents.get(documentId);
            if (!found || found.toProps().companyId !== companyId) {
              return { ok: false, error: { kind: 'unavailable', service: 'intervention-report-archive' } };
            }
            const props = found.toProps();
            const bytes = bytesByKey.get(props.storageKey);
            if (bytes === undefined) {
              return { ok: false, error: { kind: 'unavailable', service: 'intervention-report-archive' } };
            }
            return {
              ok: true,
              value: {
                attachment: {
                  filename: props.filename,
                  mimeType: props.mimeType,
                  contentBase64: Buffer.from(bytes).toString('base64'),
                },
                sha256: props.sha256,
              },
            };
          },
        },
        outbox: { enqueue: outbox.enqueue },
      }),
    sign: () =>
      new SignIntervention({
        interventions,
        companies,
        uow,
        clock,
      }),
  };
}

describe('[finding 1] COURSE réelle — la signature concurrente n’est JAMAIS écrasée', () => {
  it('rendu long + signature concurrente : la preuve survit, l’archivage rend un CONFLIT explicite', async () => {
    const env = makeEnv();
    let releaseRender = (): void => {};
    const renderStarted = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let letRenderFinish = (): void => {};
    const renderGate = new Promise<void>((resolve) => {
      letRenderFinish = resolve;
    });

    // ① Écrivain A : archivage de la fiche `completed` — bloqué DANS le rendu (I/O longue).
    const archiving = env.generate({
      onRender: async () => {
        releaseRender();
        await renderGate;
      },
    }).execute({ companyId: COMPANY, interventionId: INTERVENTION });

    await renderStarted;

    // ② Écrivain B, CONCURRENT : le client signe sur le pad pendant que le PDF se rend.
    const signed = await env.sign().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
      expectedRevision: 3,
      signerName: 'M. Responsable',
      proofSha256: TRACE_SHA,
    });
    expect(signed.ok).toBe(true);
    expect(env.store.get(INTERVENTION)!.status).toBe('signed');

    // ③ Le rendu se termine : l'archivage veut poser sa référence sur un agrégat PÉRIMÉ.
    letRenderFinish();
    const result = await archiving;

    // La PREUVE est intacte : ni le statut, ni la signature n'ont été rétrogradés.
    const after = env.store.get(INTERVENTION)!;
    expect(after.status).toBe('signed');
    expect(after.signature).not.toBeNull();
    expect(after.signature?.sha256).toBe(TRACE_SHA);
    // Et le conflit est EXPLICITE (jamais un écrasement silencieux, jamais un demi-succès).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'conflict', entity: 'intervention' });
  });

  it('la reprise après conflit archive l’état COURANT (signed) et pose sa référence', async () => {
    const env = makeEnv();
    let letRenderFinish = (): void => {};
    const renderGate = new Promise<void>((resolve) => {
      letRenderFinish = resolve;
    });
    let releaseRender = (): void => {};
    const renderStarted = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const archiving = env.generate({
      onRender: async () => {
        releaseRender();
        await renderGate;
      },
    }).execute({ companyId: COMPANY, interventionId: INTERVENTION });
    await renderStarted;
    await env.sign().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
      expectedRevision: 3,
      signerName: 'M. Responsable',
      proofSha256: TRACE_SHA,
    });
    letRenderFinish();
    await archiving;

    const retry = await env.generate().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.state).toBe('signed');
    const after = env.store.get(INTERVENTION)!;
    expect(after.status).toBe('signed');
    expect(after.signature).not.toBeNull();
    expect(after.reportDocumentId).toBe(retry.value.documentId);
  });

  it('l’écriture de la référence se fait DANS la transaction (verrou + CAS), jamais dehors', async () => {
    const env = makeEnv();
    const depths: number[] = [];
    const interventions = env.interventions;
    const originalSave = interventions.save.bind(interventions);
    interventions.save = async (intervention) => {
      depths.push(env.uowDepth());
      await originalSave(intervention);
    };
    const generated = await env.generate().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
    });
    expect(generated.ok).toBe(true);
    expect(depths).toEqual([1]);
  });

  it('réparation d’un latch interrompu : même chorégraphie transactionnelle', async () => {
    const env = makeEnv();
    const first = await env.generate().execute({ companyId: COMPANY, interventionId: INTERVENTION });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Référence perdue (crash entre l'archive et la pose) : la reprise la repose, sans re-rendu.
    const detached = Intervention.rehydrate({
      ...env.store.get(INTERVENTION)!.toProps(),
      reportDocumentId: null,
    });
    env.store.set(INTERVENTION, detached);
    const depths: number[] = [];
    const originalSave = env.interventions.save.bind(env.interventions);
    env.interventions.save = async (intervention) => {
      depths.push(env.uowDepth());
      await originalSave(intervention);
    };
    const repaired = await env.generate().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
    });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.alreadyArchived).toBe(true);
    expect(env.renderCount()).toBe(1);
    expect(env.store.get(INTERVENTION)!.reportDocumentId).toBe(first.value.documentId);
    expect(depths).toEqual([1]);
  });
});

describe('[finding 2] le mail NOMME la pièce comme la pièce — une seule source : l’archive', () => {
  it('titre changé APRÈS archivage : l’objet du mail garde le nom de la pièce jointe', async () => {
    const env = makeEnv();
    env.settings.current = {
      companyId: COMPANY,
      reportTitle: 'Certificat sanitaire',
      checklistTemplates: {},
      revision: 1,
    };
    const generated = await env.generate().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.filename).toBe('certificat-sanitaire-2026-08-04.pdf');

    // La société renomme son modèle APRÈS coup : l'archive, elle, est immuable (A8).
    env.settings.current = {
      companyId: COMPANY,
      reportTitle: 'Attestation de désinfection',
      checklistTemplates: {},
      revision: 2,
    };
    const sent = await env.send().execute({ companyId: COMPANY, interventionId: INTERVENTION });
    expect(sent.ok).toBe(true);
    const order = env.outbox.orders[0]!;
    const attachment = order.notification.attachments![0]!;
    expect(attachment.filename).toBe('certificat-sanitaire-2026-08-04.pdf');
    // Le mail ne peut pas appeler la pièce autrement que la pièce ne s'appelle.
    expect(order.notification.subject).toContain('Certificat sanitaire');
    expect(order.notification.subject).not.toContain('Attestation de désinfection');
    expect(order.notification.body).not.toContain('attestation de désinfection');
  });

  it('titre INCHANGÉ : le libellé humain exact (accents compris) est conservé', async () => {
    const env = makeEnv();
    env.settings.current = {
      companyId: COMPANY,
      reportTitle: 'Attestation de désinfection',
      checklistTemplates: {},
      revision: 1,
    };
    await env.generate().execute({ companyId: COMPANY, interventionId: INTERVENTION });
    const sent = await env.send().execute({ companyId: COMPANY, interventionId: INTERVENTION });
    expect(sent.ok).toBe(true);
    const order = env.outbox.orders[0]!;
    expect(order.notification.subject).toContain('Attestation de désinfection');
    expect(order.notification.body).toContain('attestation de désinfection');
  });
});

describe('[finding 3] la clé de déduplication porte le DESTINATAIRE', () => {
  it('MÊME fiche à un SECOND contact : deux envois, aucune exception technique', async () => {
    const env = makeEnv();
    await env.generate().execute({ companyId: COMPANY, interventionId: INTERVENTION });
    const first = await env.send().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
      recipientEmail: 'gardien@ratp.example',
    });
    expect(first.ok).toBe(true);
    const second = await env.send().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
      recipientEmail: 'technique@ratp.example',
    });
    expect(second.ok).toBe(true);
    expect(env.outbox.orders).toHaveLength(2);
    expect(env.outbox.orders.map((order) => order.notification.to)).toEqual([
      'gardien@ratp.example',
      'technique@ratp.example',
    ]);
    expect(new Set(env.outbox.orders.map((order) => order.dedupeKey)).size).toBe(2);
  });

  it('RETRY du même geste vers le MÊME destinataire : toujours idempotent (un seul envoi)', async () => {
    const env = makeEnv();
    await env.generate().execute({ companyId: COMPANY, interventionId: INTERVENTION });
    const first = await env.send().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
      recipientEmail: 'gardien@ratp.example',
    });
    const retry = await env.send().execute({
      companyId: COMPANY,
      interventionId: INTERVENTION,
      // Même destinataire, casse et espaces différents : c'est le MÊME geste.
      recipientEmail: '  Gardien@RATP.example  ',
    });
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(env.outbox.orders).toHaveLength(1);
  });

  it('la clé reste lisible et stable (préfixe historique + destinataire)', () => {
    const key = interventionReportDedupeKey(INTERVENTION, PDF_SHA, 'Gardien@RATP.example');
    expect(key).toBe(`intervention:${INTERVENTION}:report:${PDF_SHA}:to:gardien@ratp.example`);
    expect(key).toBe(interventionReportDedupeKey(INTERVENTION, PDF_SHA, ' gardien@ratp.example '));
  });
});

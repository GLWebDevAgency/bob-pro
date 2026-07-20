import { formatEUR, isValidDateOnly } from '@bob/core';

export const MISSION_LETTER_DISCLAIMER =
  'Modèle indicatif à adapter et faire valider — ne constitue pas un conseil juridique.';

export const MISSION_KINDS = [
  'bookkeeping',
  'review',
  'annual_accounts',
  'tax_returns',
  'social',
] as const;

export type MissionKind = (typeof MISSION_KINDS)[number];

export interface MissionLetterCabinet {
  name: string;
  charteredAccountantName: string;
  /** Mention libre : numéro et/ou Conseil régional d'inscription à l'Ordre. */
  orderRegistration: string;
  address: string;
  email?: string;
}

export interface MissionLetterClient {
  name: string;
  legalForm: string;
  siren: string;
  activity: string;
  address: string;
  representativeName?: string;
}

export type MissionLetterFees =
  | {
      kind: 'fixed';
      amountExcludingTaxCents: number;
      frequency: 'monthly' | 'quarterly' | 'annual';
      paymentTerms: string;
      revisionTerms: string;
      expensesPolicy: string;
    }
  | {
      kind: 'hourly';
      hourlyRateExcludingTaxCents: number;
      estimatedHours: number | null;
      paymentTerms: string;
      revisionTerms: string;
      expensesPolicy: string;
    };

export interface MissionLetterDuration {
  startsOn: string;
  term: 'fixed' | 'indefinite';
  endsOn: string | null;
  renewal: 'none' | 'tacit';
  noticeMonths: number;
  terminationTerms: string;
}

export interface MissionLetterMediation {
  mediatorName: string;
  contact: string;
  website?: string;
}

export interface MissionLetterDataProtection {
  /** Le rôle exact dépend des traitements et doit être confirmé par le cabinet. */
  role: 'independent_controller' | 'processor' | 'to_be_determined';
  privacyContact: string;
  recipients: string;
  retentionPolicy: string;
  transferPolicy: string;
}

export interface MissionLetterInput {
  generatedOn: string;
  reference?: string;
  cabinet: MissionLetterCabinet;
  client: MissionLetterClient;
  missions: MissionKind[];
  fees: MissionLetterFees;
  duration: MissionLetterDuration;
  workingArrangements?: {
    documentsDue: string;
    exchangeChannel: string;
    deliveryCommitment: string;
  };
  mediation?: MissionLetterMediation;
  dataProtection?: MissionLetterDataProtection;
  signature?: {
    place: string;
    signedOn: string | null;
  };
}

export interface MissionLetterSection {
  id: string;
  title: string;
  paragraphs: string[];
  items: string[];
}

export interface MissionLetterSignature {
  party: 'cabinet' | 'client';
  label: string;
  signerName: string;
  place: string;
  signedOn: string;
  approvalMention: 'Bon pour accord';
}

/** Document de présentation uniquement composé de texte ; il ne contient aucun fragment HTML. */
export interface MissionLetterDocument {
  title: 'LETTRE DE MISSION';
  reference: string;
  generatedOn: string;
  disclaimer: typeof MISSION_LETTER_DISCLAIMER;
  introduction: string[];
  sections: MissionLetterSection[];
  signatures: [MissionLetterSignature, MissionLetterSignature];
}

export class MissionLetterInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'MissionLetterInputError';
  }
}

const MISSION_COPY: Record<MissionKind, { label: string; scope: string }> = {
  bookkeeping: {
    label: 'Tenue de la comptabilité',
    scope:
      'Saisie, classement et contrôle des opérations à partir des pièces remises par le client, selon la répartition des tâches convenue.',
  },
  review: {
    label: 'Révision comptable',
    scope:
      'Revue des comptes, contrôles de cohérence et demande des justificatifs nécessaires à la préparation des conclusions de la mission.',
  },
  annual_accounts: {
    label: 'Établissement des comptes annuels',
    scope:
      "Préparation du bilan, du compte de résultat et de l'annexe lorsqu'elle est requise, à partir des informations validées par le client.",
  },
  tax_returns: {
    label: 'Déclarations fiscales',
    scope:
      'Préparation et, lorsque le mandat et les accès requis sont formalisés, télétransmission des déclarations fiscales comprises dans la mission.',
  },
  social: {
    label: 'Mission sociale',
    scope:
      'Travaux sociaux expressément convenus, à préciser avec le calendrier de paie, les effectifs et la répartition des responsabilités.',
  },
};

const FREQUENCY_LABEL: Record<'monthly' | 'quarterly' | 'annual', string> = {
  monthly: 'par mois',
  quarterly: 'par trimestre',
  annual: 'par an',
};

function requireText(value: string | undefined, field: string, maxLength = 2_000): string {
  if (value === undefined || value.trim().length === 0) {
    throw new MissionLetterInputError(field, 'Ce champ est requis.');
  }
  if (value.length > maxLength) {
    throw new MissionLetterInputError(
      field,
      `Ce champ ne peut pas dépasser ${maxLength} caractères.`,
    );
  }
  return plainText(value);
}

/**
 * Neutralise balises et caractères de contrôle. Le résultat reste du texte à rendre via JSX
 * (`{value}`) ou `<pre>` ; ce module ne produit jamais de HTML.
 */
export function plainText(value: string): string {
  const withoutControls = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const forbidden =
        codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f;
      return forbidden ? ' ' : character;
    })
    .join('');
  return withoutControls
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function validateInput(input: MissionLetterInput): void {
  if (!isValidDateOnly(input.generatedOn)) {
    throw new MissionLetterInputError(
      'generatedOn',
      'La date de génération doit être au format AAAA-MM-JJ.',
    );
  }
  requireText(input.cabinet.name, 'cabinet.name', 200);
  requireText(input.cabinet.charteredAccountantName, 'cabinet.charteredAccountantName', 200);
  requireText(input.cabinet.orderRegistration, 'cabinet.orderRegistration', 300);
  requireText(input.cabinet.address, 'cabinet.address', 500);
  if (input.cabinet.email !== undefined) requireText(input.cabinet.email, 'cabinet.email', 320);
  requireText(input.client.name, 'client.name', 200);
  requireText(input.client.legalForm, 'client.legalForm', 100);
  requireText(input.client.activity, 'client.activity', 500);
  requireText(input.client.address, 'client.address', 500);
  if (input.client.representativeName !== undefined) {
    requireText(input.client.representativeName, 'client.representativeName', 200);
  }
  if (input.reference !== undefined) requireText(input.reference, 'reference', 200);
  if (!/^\d{9}$/.test(input.client.siren.replace(/\s/g, ''))) {
    throw new MissionLetterInputError('client.siren', 'Le SIREN doit contenir neuf chiffres.');
  }
  if (input.missions.length === 0) {
    throw new MissionLetterInputError('missions', 'Au moins une mission doit être sélectionnée.');
  }
  if (new Set(input.missions).size !== input.missions.length) {
    throw new MissionLetterInputError(
      'missions',
      'Une mission ne peut être sélectionnée qu’une fois.',
    );
  }
  for (const mission of input.missions) {
    if (!(MISSION_KINDS as readonly string[]).includes(mission)) {
      throw new MissionLetterInputError('missions', `Mission inconnue : ${String(mission)}.`);
    }
  }
  if (input.fees.kind === 'fixed') {
    if (
      !Number.isSafeInteger(input.fees.amountExcludingTaxCents) ||
      input.fees.amountExcludingTaxCents <= 0
    ) {
      throw new MissionLetterInputError(
        'fees.amountExcludingTaxCents',
        'Le forfait HT doit être positif.',
      );
    }
  } else {
    if (
      !Number.isSafeInteger(input.fees.hourlyRateExcludingTaxCents) ||
      input.fees.hourlyRateExcludingTaxCents <= 0
    ) {
      throw new MissionLetterInputError(
        'fees.hourlyRateExcludingTaxCents',
        'Le taux horaire HT doit être positif.',
      );
    }
    if (
      input.fees.estimatedHours !== null &&
      (!Number.isFinite(input.fees.estimatedHours) || input.fees.estimatedHours <= 0)
    ) {
      throw new MissionLetterInputError(
        'fees.estimatedHours',
        "L'estimation d'heures doit être positive ou nulle.",
      );
    }
  }
  requireText(input.fees.paymentTerms, 'fees.paymentTerms');
  requireText(input.fees.revisionTerms, 'fees.revisionTerms');
  requireText(input.fees.expensesPolicy, 'fees.expensesPolicy');
  if (!isValidDateOnly(input.duration.startsOn)) {
    throw new MissionLetterInputError('duration.startsOn', 'La date de début est invalide.');
  }
  if (input.duration.term === 'fixed') {
    if (input.duration.endsOn === null || !isValidDateOnly(input.duration.endsOn)) {
      throw new MissionLetterInputError(
        'duration.endsOn',
        'Une mission à durée déterminée exige une date de fin.',
      );
    }
    if (input.duration.endsOn < input.duration.startsOn) {
      throw new MissionLetterInputError(
        'duration.endsOn',
        'La date de fin doit suivre la date de début.',
      );
    }
  } else if (input.duration.endsOn !== null) {
    throw new MissionLetterInputError(
      'duration.endsOn',
      'Une mission à durée indéterminée ne porte pas de date de fin.',
    );
  }
  if (input.duration.term === 'indefinite' && input.duration.renewal !== 'none') {
    throw new MissionLetterInputError(
      'duration.renewal',
      'Une mission à durée indéterminée ne peut pas être renouvelée tacitement.',
    );
  }
  if (
    !Number.isInteger(input.duration.noticeMonths) ||
    input.duration.noticeMonths < 0 ||
    input.duration.noticeMonths > 24
  ) {
    throw new MissionLetterInputError(
      'duration.noticeMonths',
      'Le préavis doit être compris entre 0 et 24 mois.',
    );
  }
  requireText(input.duration.terminationTerms, 'duration.terminationTerms');
  if (input.workingArrangements !== undefined) {
    requireText(input.workingArrangements.documentsDue, 'workingArrangements.documentsDue');
    requireText(input.workingArrangements.exchangeChannel, 'workingArrangements.exchangeChannel');
    requireText(
      input.workingArrangements.deliveryCommitment,
      'workingArrangements.deliveryCommitment',
    );
  }
  if (input.mediation !== undefined) {
    requireText(input.mediation.mediatorName, 'mediation.mediatorName', 300);
    requireText(input.mediation.contact, 'mediation.contact', 500);
    if (input.mediation.website !== undefined)
      requireText(input.mediation.website, 'mediation.website', 500);
  }
  if (input.dataProtection !== undefined) {
    requireText(input.dataProtection.privacyContact, 'dataProtection.privacyContact', 500);
    requireText(input.dataProtection.recipients, 'dataProtection.recipients');
    requireText(input.dataProtection.retentionPolicy, 'dataProtection.retentionPolicy');
    requireText(input.dataProtection.transferPolicy, 'dataProtection.transferPolicy');
  }
  if (input.signature !== undefined) requireText(input.signature.place, 'signature.place', 200);
  if (input.signature?.signedOn !== null && input.signature?.signedOn !== undefined) {
    if (!isValidDateOnly(input.signature.signedOn)) {
      throw new MissionLetterInputError('signature.signedOn', 'La date de signature est invalide.');
    }
  }
}

function buildFeesParagraphs(fees: MissionLetterFees): string[] {
  const price =
    fees.kind === 'fixed'
      ? `Les honoraires sont fixés à ${formatEUR(fees.amountExcludingTaxCents)} HT ${FREQUENCY_LABEL[fees.frequency]}.`
      : `Les honoraires sont calculés au taux de ${formatEUR(fees.hourlyRateExcludingTaxCents)} HT par heure${
          fees.estimatedHours === null
            ? ''
            : `, sur une estimation de ${fees.estimatedHours} heure(s)`
        }.`;
  return [
    `${price} La TVA applicable est ajoutée au taux en vigueur.`,
    `Facturation et règlement : ${plainText(fees.paymentTerms)}`,
    `Révision des honoraires : ${plainText(fees.revisionTerms)}`,
    `Frais et débours : ${plainText(fees.expensesPolicy)}`,
    "Toute prestation hors périmètre fait l'objet d'un accord préalable sur sa nature et sa tarification.",
  ];
}

function buildDurationParagraphs(duration: MissionLetterDuration): string[] {
  const term =
    duration.term === 'fixed'
      ? `La mission débute le ${duration.startsOn} et prend fin le ${duration.endsOn ?? ''}.`
      : `La mission débute le ${duration.startsOn} pour une durée indéterminée.`;
  const renewal =
    duration.renewal === 'tacit'
      ? 'Elle est renouvelée tacitement selon la même périodicité, sauf dénonciation dans les conditions ci-dessous.'
      : "Aucune reconduction tacite n'est prévue.";
  return [
    term,
    renewal,
    `Préavis convenu : ${duration.noticeMonths} mois. ${plainText(duration.terminationTerms)}`,
    'La fin de la mission ne dispense pas les parties de régler les travaux réalisés, de restituer les éléments dus et d’organiser la continuité des obligations en cours.',
  ];
}

function buildMediationParagraphs(mediation: MissionLetterMediation | undefined): string[] {
  const paragraphs = [
    'En cas de différend, les parties s’engagent à formuler d’abord une réclamation écrite et à rechercher une solution amiable avant toute procédure.',
    "Une médiation ou un autre mode amiable peut être sollicité lorsqu'il est applicable à la qualité des parties et à la nature du litige.",
  ];
  if (mediation === undefined) {
    paragraphs.push(
      'Coordonnées du médiateur ou du dispositif amiable compétent : [à compléter et vérifier avant signature].',
    );
  } else {
    paragraphs.push(
      `Médiateur ou dispositif indiqué par le cabinet : ${plainText(mediation.mediatorName)} — ${plainText(mediation.contact)}${
        mediation.website === undefined ? '' : ` — ${plainText(mediation.website)}`
      }.`,
    );
  }
  paragraphs.push(
    'La médiation de la consommation vise les litiges entre un consommateur et un professionnel ; son applicabilité à un client professionnel ne doit pas être présumée.',
  );
  return paragraphs;
}

function buildDataProtectionParagraphs(
  cabinet: MissionLetterCabinet,
  dataProtection: MissionLetterDataProtection | undefined,
): string[] {
  const contact =
    dataProtection?.privacyContact ?? cabinet.email ?? '[point de contact RGPD à compléter]';
  const role =
    dataProtection?.role === 'independent_controller'
      ? 'Le cabinet agit comme responsable de traitement pour les traitements dont il détermine les finalités et les moyens.'
      : dataProtection?.role === 'processor'
        ? "Pour les traitements réalisés exclusivement sur instruction du client, le cabinet agit comme sous-traitant ; une annexe conforme à l'article 28 du RGPD doit préciser les instructions et garanties applicables."
        : 'Le rôle de chaque partie (responsable de traitement ou sous-traitant) doit être qualifié traitement par traitement et complété avant signature.';
  return [
    role,
    'Les données sont traitées pour exécuter la mission, respecter les obligations légales et professionnelles et gérer la relation contractuelle. Seules les données nécessaires doivent être communiquées.',
    `Destinataires : ${plainText(dataProtection?.recipients ?? '[destinataires et sous-traitants à compléter]')}`,
    `Conservation : ${plainText(dataProtection?.retentionPolicy ?? '[durées ou critères de conservation à compléter]')}`,
    `Transferts hors Espace économique européen : ${plainText(dataProtection?.transferPolicy ?? '[à vérifier et compléter]')}`,
    `Les personnes concernées peuvent exercer leurs droits auprès de ${plainText(contact)} et introduire une réclamation auprès de la CNIL.`,
  ];
}

/** Construit un document texte structuré, sans lecture de l'horloge et sans interpolation HTML. */
export function buildMissionLetter(input: MissionLetterInput): MissionLetterDocument {
  validateInput(input);
  const cabinetName = plainText(input.cabinet.name);
  const expertName = plainText(input.cabinet.charteredAccountantName);
  const clientName = plainText(input.client.name);
  const clientRepresentative = plainText(
    input.client.representativeName ?? '[représentant à compléter]',
  );
  const signaturePlace = plainText(input.signature?.place ?? '[lieu à compléter]');
  const signatureDate = input.signature?.signedOn ?? '[date à compléter]';
  const reference = plainText(
    input.reference ?? `${input.client.siren.replace(/\s/g, '')}-${input.generatedOn}`,
  );
  const arrangements = input.workingArrangements;

  const sections: MissionLetterSection[] = [
    {
      id: 'object',
      title: '1. Objet et cadre de la mission',
      paragraphs: [
        `Le client confie au cabinet les missions limitativement énumérées ci-dessous à compter du ${input.duration.startsOn}.`,
        "La présente lettre définit le périmètre, les modalités d'exécution, les droits et les obligations de chaque partie. Les travaux sont conduits selon les règles professionnelles applicables au cabinet.",
        'Tout mandat de représentation ou de télétransmission qui dépasse les missions décrites doit être formalisé selon les exigences applicables.',
      ],
      items: [],
    },
    {
      id: 'scope',
      title: '2. Périmètre des missions',
      paragraphs: [
        "Les prestations non listées sont exclues jusqu'à acceptation écrite d'un complément de mission.",
      ],
      items: input.missions.map(
        (mission) => `${MISSION_COPY[mission].label} — ${MISSION_COPY[mission].scope}`,
      ),
    },
    {
      id: 'arrangements',
      title: '3. Organisation, répartition des tâches et délais',
      paragraphs: [
        `Remise des pièces par le client : ${plainText(arrangements?.documentsDue ?? '[calendrier à compléter]')}`,
        `Canal d'échange convenu : ${plainText(arrangements?.exchangeChannel ?? '[canal sécurisé à compléter]')}`,
        `Engagement de restitution du cabinet : ${plainText(arrangements?.deliveryCommitment ?? '[délais à compléter]')}`,
        'Le respect des délais du cabinet suppose la remise complète et exploitable des informations selon le calendrier convenu. Toute pièce tardive peut décaler les travaux après information du client.',
      ],
      items: [],
    },
    {
      id: 'client_obligations',
      title: '4. Obligations du client',
      paragraphs: [],
      items: [
        'Remettre des informations et justificatifs complets, exacts et sincères dans les délais convenus, et signaler sans délai tout événement significatif.',
        'Conserver les originaux et respecter les obligations qui demeurent à sa charge ; valider les comptes, déclarations et options soumis à son approbation.',
        'Donner les accès et mandats strictement nécessaires, licites et sécurisés, puis informer le cabinet de toute révocation.',
        'Garantir la licéité de la collecte et de la transmission des données personnelles communiquées au cabinet.',
        'Rester responsable des décisions de gestion et du paiement des impôts, cotisations, salaires et dettes aux échéances applicables.',
      ],
    },
    {
      id: 'cabinet_obligations',
      title: '5. Obligations du cabinet',
      paragraphs: [],
      items: [
        'Exécuter avec compétence, diligence et indépendance les seules missions convenues, dans la limite des informations reçues.',
        'Respecter le secret professionnel et la confidentialité, sous réserve des communications imposées ou autorisées par les textes applicables.',
        'Alerter le client des anomalies ou informations manquantes significatives identifiées dans le périmètre de la mission.',
        'Sécuriser les accès et données confiés selon des mesures adaptées et limiter leur accès aux personnes qui en ont besoin.',
        'Restituer ou mettre à disposition les éléments du client selon les modalités convenues lors de la fin de mission, sous réserve des règles applicables.',
      ],
    },
    {
      id: 'fees',
      title: '6. Honoraires et conditions financières',
      paragraphs: buildFeesParagraphs(input.fees),
      items: [],
    },
    {
      id: 'duration',
      title: '7. Durée, renouvellement et résiliation',
      paragraphs: buildDurationParagraphs(input.duration),
      items: [],
    },
    {
      id: 'confidentiality',
      title: '8. Confidentialité et conservation des pièces',
      paragraphs: [
        'Chaque partie protège les informations confidentielles reçues et ne les utilise que pour exécuter la relation contractuelle, sauf obligation légale, professionnelle ou accord écrit.',
        'La répartition des originaux, copies, archives et modalités de restitution doit être précisée dans les procédures de travail du dossier.',
      ],
      items: [],
    },
    {
      id: 'mediation',
      title: '9. Réclamations, médiation et litiges',
      paragraphs: buildMediationParagraphs(input.mediation),
      items: [],
    },
    {
      id: 'data_protection',
      title: '10. Données personnelles (RGPD)',
      paragraphs: buildDataProtectionParagraphs(input.cabinet, input.dataProtection),
      items: [],
    },
    {
      id: 'acceptance',
      title: '11. Acceptation',
      paragraphs: [
        'Les parties reconnaissent avoir lu la présente lettre et ses éventuelles annexes, compris le périmètre de la mission et accepté les obligations et conditions financières qui y figurent.',
      ],
      items: [],
    },
  ];

  return {
    title: 'LETTRE DE MISSION',
    reference,
    generatedOn: input.generatedOn,
    disclaimer: MISSION_LETTER_DISCLAIMER,
    introduction: [
      `Entre ${cabinetName}, représenté par ${expertName}, expert-comptable inscrit à l'Ordre (${plainText(input.cabinet.orderRegistration)}), sis ${plainText(input.cabinet.address)}, ci-après « le cabinet »,`,
      `et ${clientName}, ${plainText(input.client.legalForm)}, SIREN ${input.client.siren.replace(/\s/g, '')}, exerçant l'activité « ${plainText(input.client.activity)} », sis ${plainText(input.client.address)}, représenté par ${clientRepresentative}, ci-après « le client ».`,
    ],
    sections,
    signatures: [
      {
        party: 'cabinet',
        label: `Pour ${cabinetName}`,
        signerName: expertName,
        place: signaturePlace,
        signedOn: signatureDate,
        approvalMention: 'Bon pour accord',
      },
      {
        party: 'client',
        label: `Pour ${clientName}`,
        signerName: clientRepresentative,
        place: signaturePlace,
        signedOn: signatureDate,
        approvalMention: 'Bon pour accord',
      },
    ],
  };
}

/** Export texte brut pour impression via `<pre>{text}</pre>` ou téléchargement `.txt`. */
export function renderMissionLetterPlainText(document: MissionLetterDocument): string {
  const lines: string[] = [
    document.title,
    `Référence : ${document.reference}`,
    `Établie le : ${document.generatedOn}`,
    '',
    document.disclaimer,
    '',
    ...document.introduction,
    '',
  ];
  for (const section of document.sections) {
    lines.push(section.title);
    lines.push(...section.paragraphs);
    lines.push(...section.items.map((item) => `• ${item}`));
    lines.push('');
  }
  lines.push('SIGNATURES');
  for (const signature of document.signatures) {
    lines.push(
      signature.label,
      `Signataire : ${signature.signerName}`,
      `Fait à ${signature.place}, le ${signature.signedOn}`,
      `${signature.approvalMention} :`,
      '',
      'Signature :',
      '',
    );
  }
  lines.push(document.disclaimer);
  return lines.join('\n');
}

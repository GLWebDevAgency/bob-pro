import { addDays, deriveFiscalCalendar, isValidDateOnly, type FiscalDeadline } from '@bob/core';
import type { CabinetFiscalProfile } from './types';

export const FISCAL_CALENDAR_DISCLAIMER =
  "Échéancier indicatif à confirmer dans l'espace professionnel impots.gouv.fr et auprès du cabinet.";

export interface CabinetFiscalCalendarInput {
  fiscal: CabinetFiscalProfile;
  /** Début inclus, injecté explicitement au format AAAA-MM-JJ. */
  asOf: string;
  /** Horizon explicite, en jours calendaires, bornes incluses. */
  horizonDays: number;
}

export type FiscalCalendarLimitationCode =
  'ir_not_derived' | 'assumed_dates' | 'amounts_unavailable';

export interface FiscalCalendarLimitation {
  code: FiscalCalendarLimitationCode;
  message: string;
}

export interface CabinetFiscalCalendar {
  window: { from: string; to: string; horizonDays: number };
  deadlines: FiscalDeadline[];
  limitations: FiscalCalendarLimitation[];
  disclaimer: typeof FISCAL_CALENDAR_DISCLAIMER;
}

export class FiscalCalendarInputError extends Error {
  constructor(
    readonly field: 'asOf' | 'horizonDays',
    message: string,
  ) {
    super(message);
    this.name = 'FiscalCalendarInputError';
  }
}

/**
 * Adaptateur cabinet du moteur fiscal core. Le choix IR ne change jamais artificiellement
 * la forme juridique : il masque seulement les échéances IS que le moteur v1 déduit de cette
 * forme, puis expose clairement le trou de couverture IR.
 */
export function deriveCabinetFiscalCalendar(
  input: CabinetFiscalCalendarInput,
): CabinetFiscalCalendar {
  if (!isValidDateOnly(input.asOf)) {
    throw new FiscalCalendarInputError('asOf', 'La date de début doit être au format AAAA-MM-JJ.');
  }
  if (!Number.isInteger(input.horizonDays) || input.horizonDays < 0 || input.horizonDays > 1_095) {
    throw new FiscalCalendarInputError(
      'horizonDays',
      "L'horizon doit être un nombre entier de jours compris entre 0 et 1 095.",
    );
  }

  const derived = deriveFiscalCalendar({
    company: {
      legalForm: input.fiscal.legalForm,
      vatRegime: input.fiscal.vatRegime,
      dateCreation: input.fiscal.dateCreation,
    },
    asOf: input.asOf,
    horizonDays: input.horizonDays,
    fiscalYearEnd: input.fiscal.fiscalYearEnd,
    urssafPeriodicity: input.fiscal.urssafPeriodicity,
  });

  const deadlines =
    input.fiscal.incomeTaxRegime === 'IR'
      ? derived.filter((deadline) => deadline.kind !== 'is')
      : derived;
  const limitations: FiscalCalendarLimitation[] = [];

  if (input.fiscal.incomeTaxRegime === 'IR') {
    limitations.push({
      code: 'ir_not_derived',
      message:
        "Le moteur fiscal v1 ne dérive pas encore les déclarations de résultat propres à l'IR. Les échéances IS sont masquées ; vérifiez la liasse 2031/2035 et la 2042-C-PRO avec le cabinet.",
    });
  }
  if (deadlines.some((deadline) => deadline.confidence === 'assumed')) {
    limitations.push({
      code: 'assumed_dates',
      message:
        "Certaines dates sont des hypothèses : la date exacte dépend de la situation du client ou d'une information encore manquante.",
    });
  }
  limitations.push({
    code: 'amounts_unavailable',
    message: "Aucun montant à payer n'est calculé par cet échéancier v1.",
  });

  return {
    window: {
      from: input.asOf,
      to: addDays(input.asOf, input.horizonDays),
      horizonDays: input.horizonDays,
    },
    deadlines,
    limitations,
    disclaimer: FISCAL_CALENDAR_DISCLAIMER,
  };
}

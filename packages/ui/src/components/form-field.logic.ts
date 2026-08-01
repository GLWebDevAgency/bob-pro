/**
 * FormField / DateField — logique PURE (Lot 0, plan DA 01/08). Le champ de formulaire du
 * kit : LABEL VISIBLE PERSISTANT (sept champs d'equipements n'avaient qu'un placeholder —
 * anonymes dès la première lettre, hostiles aux gants et aux interruptions), input
 * tokenisé, slot d'erreur DANGER (role alert). Le masque de date est PUREMENT VISUEL :
 * il formate AAAA-MM-JJ pendant la frappe, ne valide rien, ne bloque rien.
 */

/** Cible tactile minimale de l'input (littéral des champs d'equipements : minHeight 44). */
export const FORM_FIELD_MIN_HEIGHT = 44;
export const FORM_FIELD_RADIUS = 12;
export const FORM_FIELD_PADDING_HORIZONTAL = 12;

export interface FormFieldBorderPalette {
  /** controls.cardBorder — bord au repos. */
  cardBorder: string;
  /** semantic.danger — bord quand le champ porte une erreur. */
  danger: string;
}

/** Bord de l'input : danger dès qu'une erreur est présente, sinon le bord de carte. */
export function formFieldBorderColor(hasError: boolean, palette: FormFieldBorderPalette): string {
  return hasError ? palette.danger : palette.cardBorder;
}

/**
 * Masque de date AAAA-MM-JJ, PUREMENT VISUEL : ne garde que les chiffres (8 max),
 * insère les tirets après l'année (4) et le mois (6). Idempotent — réappliquer le
 * masque à sa propre sortie rend la même chaîne (la frappe ET la correction passent
 * par le même chemin).
 */
export function applyDateMask(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

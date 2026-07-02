/**
 * SegmentedControl — logique pure (§11). Aucun import react-native.
 */
export interface SegmentOption<K extends string = string> {
  readonly key: K;
  readonly label: string;
}

/** Un segment est actif quand sa clé est la valeur sélectionnée. */
export function isSegmentActive<K extends string>(optionKey: K, value: K): boolean {
  return optionKey === value;
}

/** Index du segment actif (-1 si la valeur ne correspond à aucune option). */
export function activeSegmentIndex<K extends string>(
  options: readonly SegmentOption<K>[],
  value: K,
): number {
  return options.findIndex((option) => option.key === value);
}

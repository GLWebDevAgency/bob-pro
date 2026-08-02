import { describe, expectTypeOf, it } from 'vitest';
import type { SearchFieldProps } from './search-field';

type ClearableSearchFieldProps = Extract<SearchFieldProps, { readonly onClear: () => void }>;
type StaticSearchFieldProps = Extract<SearchFieldProps, { readonly onClear?: undefined }>;

describe('SearchField — contrat i18n du bouton effacer', () => {
  it('exige un libellé accessible localisé pour tout champ effaçable', () => {
    expectTypeOf<ClearableSearchFieldProps['clearAccessibilityLabel']>().toEqualTypeOf<string>();
  });

  it("n'accepte aucun libellé d'effacement sans action associée", () => {
    expectTypeOf<StaticSearchFieldProps['clearAccessibilityLabel']>().toEqualTypeOf<undefined>();
  });
});

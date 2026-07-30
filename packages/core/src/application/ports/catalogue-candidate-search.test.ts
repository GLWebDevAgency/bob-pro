import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_SEARCH_EXPANSIONS,
  MAX_CUSTOM_PRESTATION_LABEL_LENGTH,
} from '../catalogue/derive-catalogue';
import {
  CATALOGUE_CANDIDATE_QUERY_MAX_LENGTH,
  CATALOGUE_CANDIDATE_TOKEN_MAX_LENGTH,
} from './catalogue-candidate-search';

describe('catalogue candidate search bounds', () => {
  it('source la requête sur le libellé métier et couvre la pire expansion Unicode', () => {
    const maximumExpansionLength = Math.max(
      1,
      ...CATALOGUE_SEARCH_EXPANSIONS.map((rule) => (
        rule.slice(rule.indexOf('=') + 1).length
      )),
    );

    expect(CATALOGUE_CANDIDATE_QUERY_MAX_LENGTH)
      .toBe(MAX_CUSTOM_PRESTATION_LABEL_LENGTH);
    expect(CATALOGUE_CANDIDATE_TOKEN_MAX_LENGTH)
      .toBe(CATALOGUE_CANDIDATE_QUERY_MAX_LENGTH * maximumExpansionLength);
  });
});

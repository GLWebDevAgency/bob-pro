import { describe, expect, it } from 'vitest';
import {
  canonicalConversationTimeZoneSelection,
  conversationTimeZoneOptions,
} from './conversation-time-zone-options';

describe('conversationTimeZoneOptions', () => {
  it('épingle la suggestion valide et trouve Paris par segment', () => {
    expect(conversationTimeZoneOptions({
      query: '',
      suggestedTimeZone: 'Europe/Paris',
    })[0]).toEqual({
      timeZone: 'Europe/Paris',
      suggested: true,
      exact: false,
    });
    expect(conversationTimeZoneOptions({
      query: 'paris',
      suggestedTimeZone: null,
    })).toContainEqual({
      timeZone: 'Europe/Paris',
      suggested: false,
      exact: false,
    });
  });

  it('accepte une saisie exacte validée même hors du snapshot et borne le rendu', () => {
    expect(conversationTimeZoneOptions({
      query: 'Etc/GMT+1',
      suggestedTimeZone: null,
      limit: 3,
    })[0]?.exact).toBe(true);
    expect(conversationTimeZoneOptions({
      query: '',
      suggestedTimeZone: null,
      limit: 3,
    })).toHaveLength(3);
  });

  it('canonicalise les noms IANA historiques sans fabriquer de défaut ni accepter un offset', () => {
    expect(canonicalConversationTimeZoneSelection(' CET ')).toBe(
      new Intl.DateTimeFormat('en-US', { timeZone: 'CET' })
        .resolvedOptions()
        .timeZone,
    );
    expect(canonicalConversationTimeZoneSelection('+02:00')).toBeNull();
    expect(conversationTimeZoneOptions({
      query: 'introuvable',
      suggestedTimeZone: null,
    })).toEqual([]);
  });
});

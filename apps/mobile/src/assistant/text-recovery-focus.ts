/**
 * Intention éphémère process-local : aucune commande, transcription ni donnée métier dans l'URL.
 * Plusieurs demandes avant le prochain focus se coalescent ; le premier focus les consomme.
 */
let pendingTextRecoveryFocus = false;

export function requestAssistantTextRecoveryFocus(): void {
  pendingTextRecoveryFocus = true;
}

export function consumeAssistantTextRecoveryFocus(): boolean {
  if (!pendingTextRecoveryFocus) return false;
  pendingTextRecoveryFocus = false;
  return true;
}

export function focusAssistantTextRecoveryIfRequested(focus: () => boolean): boolean {
  if (!pendingTextRecoveryFocus || !focus()) return false;
  pendingTextRecoveryFocus = false;
  return true;
}

/** Attend le rendu autorisé du champ : une visite focalisée mais encore en entitlement loading
 * ne consomme jamais l'intention de récupération. */
export function useAssistantTextRecoveryFocus(
  ready: boolean,
  inputRef: RefObject<{ focus(): void } | null>,
): void {
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setTimeout(() => {
      focusAssistantTextRecoveryIfRequested(() => {
        const input = inputRef.current;
        if (input === null) return false;
        input.focus();
        return true;
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [inputRef, ready]);
}

/**
 * Sur l'écran Assistant, l'orbe globale est volontairement masquée. Cette autorité assure donc la
 * même sortie accessible : une nouvelle erreur silencieuse est annoncée une fois, puis le champ
 * texte est focalisé sans relancer le microphone.
 */
export function useAssistantVoiceErrorRecovery(input: {
  readonly ready: boolean;
  readonly message: string | null;
  readonly inputRef: RefObject<{ focus(): void } | null>;
  readonly announce: (message: string) => void;
}): void {
  const lastAnnouncementRef = useRef<string | null>(null);
  useEffect(() => {
    const message = input.message?.trim() ?? '';
    if (!input.ready || message === '') {
      lastAnnouncementRef.current = null;
      return undefined;
    }
    if (lastAnnouncementRef.current === message) return undefined;
    lastAnnouncementRef.current = message;
    const timer = setTimeout(() => {
      input.announce(message);
      input.inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [input.announce, input.inputRef, input.message, input.ready]);
}
import { useEffect, useRef, type RefObject } from 'react';

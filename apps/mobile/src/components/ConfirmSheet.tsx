import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import type { ActionDiff, ConfirmationChallenge } from '@bob/ai';
import { Button, Card, Sheet, font, useTheme } from '@bob/ui';
import { ActionDiffView } from './ActionDiffView';

/**
 * Feuille de confirmation VÉRIFIABLE — la « preuve » avant d'agir. Elle rend :
 *  - l'ActionDiff (avant → après : reste dû, statut, numéro…) produit par @bob/ai,
 *  - un ConfirmationChallenge TYPÉ : tap simple, re-confirmation du MONTANT (encaissement),
 *    ou double validation d'une action fiscale irréversible (émission).
 * Exposée via un provider + hook useConfirm() → confirm(request): Promise<boolean>.
 * Même feuille pour les flux manuel et vocal : une seule promesse, réglée exactement une fois.
 */
export interface ConfirmRequest {
  readonly title: string;
  readonly message?: string;
  readonly diff?: ActionDiff | null;
  readonly challenge: ConfirmationChallenge;
  readonly destructive?: boolean;
}

interface ActiveConfirmation {
  readonly id: number;
  readonly request: ConfirmRequest;
}

interface PendingResolver {
  readonly id: number;
  readonly resolve: (confirmed: boolean) => void;
}

const ConfirmContext = createContext<(request: ConfirmRequest) => Promise<boolean>>(() =>
  Promise.resolve(false),
);

export function useConfirm(): (request: ConfirmRequest) => Promise<boolean> {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveConfirmation | null>(null);
  const pendingRef = useRef<PendingResolver | null>(null);
  const nextIdRef = useRef(0);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        // Fail-closed : deux taps dans le même frame ne remplacent jamais la demande visible
        // et ne laissent aucune Promise orpheline. La seconde demande est refusée immédiatement.
        if (pendingRef.current !== null) {
          resolve(false);
          return;
        }

        const id = nextIdRef.current + 1;
        nextIdRef.current = id;
        pendingRef.current = { id, resolve };
        setActive({ id, request });
      }),
    [],
  );

  const settle = useCallback((id: number, confirmed: boolean): void => {
    const pending = pendingRef.current;
    // Un callback de fermeture de l'ancienne animation ne peut jamais régler la demande suivante.
    if (pending === null || pending.id !== id) return;

    pendingRef.current = null;
    setActive((current) => (current?.id === id ? null : current));
    pending.resolve(confirmed);
  }, []);

  useEffect(
    () => () => {
      // Une navigation ou un logout pendant la confirmation reste une annulation explicite :
      // aucune écriture ne peut attendre indéfiniment une Promise dont l'UI a disparu.
      const pending = pendingRef.current;
      pendingRef.current = null;
      pending?.resolve(false);
    },
    [],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmSheet
        requestId={active?.id ?? null}
        request={active?.request ?? null}
        onResolve={settle}
      />
    </ConfirmContext.Provider>
  );
}

interface ConfirmationCheckboxProps {
  readonly checked: boolean;
  readonly label: string;
  readonly onToggle: () => void;
  readonly color: string;
}

function ConfirmationCheckbox({ checked, label, onToggle, color }: ConfirmationCheckboxProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        opacity: pressed ? 0.78 : 1,
      })}
    >
      <View
        accessible={false}
        style={{
          width: 24,
          height: 24,
          borderRadius: 7,
          borderWidth: 2,
          borderColor: checked ? color : colors.slate500,
          backgroundColor: checked ? color : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Ionicons name="checkmark" size={16} color={colors.surface} /> : null}
      </View>
      <Text style={[font('sub'), { color: colors.ink800, flex: 1, flexShrink: 1, lineHeight: 20 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

interface ConfirmSheetProps {
  readonly requestId: number | null;
  readonly request: ConfirmRequest | null;
  readonly onResolve: (requestId: number, confirmed: boolean) => void;
}

export function ConfirmSheet({ requestId, request, onResolve }: ConfirmSheetProps) {
  const { colors, semantic } = useTheme();
  const [consent, setConsent] = useState<{
    readonly requestId: number | null;
    readonly checked: boolean;
  }>({
    requestId: null,
    checked: false,
  });
  // Sheet conserve ses enfants pendant l'animation de sortie. Garder la dernière demande évite
  // un flash vide sans permettre de la confirmer : l'id expiré est rejeté par `settle`.
  const [lastCommittedRequest, setLastCommittedRequest] = useState<ActiveConfirmation | null>(
    request !== null && requestId !== null ? { id: requestId, request } : null,
  );
  useEffect(() => {
    if (request !== null && requestId !== null) {
      setLastCommittedRequest({ id: requestId, request });
    }
  }, [request, requestId]);
  const displayed =
    request !== null && requestId !== null ? { id: requestId, request } : lastCommittedRequest;
  const displayedRequest = displayed?.request ?? null;
  const displayedRequestId = displayed?.id ?? null;
  // Le consentement est lié à l'id : une nouvelle demande est désarmée dès son premier rendu,
  // avant même qu'un effet React puisse s'exécuter.
  const checked = requestId !== null && consent.requestId === requestId && consent.checked;

  const challenge = displayedRequest?.challenge;
  const needsGate = challenge?.kind === 'amount' || challenge?.kind === 'fiscal';
  const canConfirm = request !== null && (!needsGate || checked);
  const danger = displayedRequest?.destructive === true || challenge?.kind === 'fiscal';
  const accent = danger ? semantic.danger : semantic.ai;

  const resolveCurrent = (confirmed: boolean): void => {
    if (displayedRequestId === null) return;
    onResolve(displayedRequestId, confirmed);
  };

  return (
    <Sheet
      visible={request !== null}
      onClose={() => resolveCurrent(false)}
      accessibilityLabel={displayedRequest?.title ?? 'Confirmation'}
      closeAccessibilityLabel="Annuler et fermer"
    >
      {displayedRequest !== null ? (
        <Card elevation="e1" padding={16} style={{ marginBottom: 4 }}>
          <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900 }]}>
            {displayedRequest.title}
          </Text>
          {displayedRequest.message ? (
            <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginTop: 6 }]}>
              {displayedRequest.message}
            </Text>
          ) : null}

          <ActionDiffView diff={displayedRequest.diff} />

          {challenge?.kind === 'amount' ? (
            <View style={{ marginTop: 12 }}>
              <ConfirmationCheckbox
                checked={checked}
                onToggle={() => {
                  if (requestId === null) return;
                  setConsent((current) => ({
                    requestId,
                    checked: current.requestId === requestId ? !current.checked : true,
                  }));
                }}
                label={`Je confirme encaisser ${formatEUR(challenge.expectedCents)}`}
                color={accent}
              />
            </View>
          ) : null}
          {challenge?.kind === 'fiscal' ? (
            <View style={{ marginTop: 12 }}>
              <Text
                style={[font('meta'), { color: semantic.danger, lineHeight: 18, marginBottom: 4 }]}
              >
                {challenge.reason || 'Action définitive et irréversible.'}
              </Text>
              <ConfirmationCheckbox
                checked={checked}
                onToggle={() => {
                  if (requestId === null) return;
                  setConsent((current) => ({
                    requestId,
                    checked: current.requestId === requestId ? !current.checked : true,
                  }));
                }}
                label="Je confirme cette action définitive"
                color={accent}
              />
            </View>
          ) : null}

          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: 10,
              marginTop: 16,
            }}
          >
            <View style={{ flexGrow: 1, flexBasis: 140 }}>
              <Button title="Annuler" variant="secondary" onPress={() => resolveCurrent(false)} />
            </View>
            <View style={{ flexGrow: 1, flexBasis: 140 }}>
              <Button
                title="Confirmer"
                variant={danger ? 'danger' : 'primary'}
                disabled={!canConfirm}
                onPress={() => resolveCurrent(true)}
              />
            </View>
          </View>
        </Card>
      ) : null}
    </Sheet>
  );
}

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import type { ActionDiff, ConfirmationChallenge } from '@bob/ai';
import { useTheme } from '../theme';
import { Card, Button, font } from './ui';
import { ActionDiffView } from './ActionDiffView';

/**
 * Feuille de confirmation VÉRIFIABLE — la « preuve » avant d'agir. Elle rend :
 *  - l'ActionDiff (avant → après : reste dû, statut, numéro…) produit par @bob/ai,
 *  - un ConfirmationChallenge TYPÉ : tap simple, re-confirmation du MONTANT (encaissement),
 *    ou double validation d'une action fiscale irréversible (émission).
 * Exposée via un provider + hook useConfirm() → confirm(request): Promise<boolean>.
 * Même sheet réutilisable plus tard par le flux vocal (bob-agent).
 */
export interface ConfirmRequest {
  readonly title: string;
  readonly message?: string;
  readonly diff?: ActionDiff | null;
  readonly challenge: ConfirmationChallenge;
  readonly destructive?: boolean;
}

const ConfirmContext = createContext<(req: ConfirmRequest) => Promise<boolean>>(() => Promise.resolve(false));
export function useConfirm(): (req: ConfirmRequest) => Promise<boolean> {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback(
    (r: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        // Concurrence : une feuille est déjà ouverte (2 taps avant montage, ou 2 lignes tapées coup sur coup).
        // On refuse proprement le 2e appel (résolu false) plutôt que d'écraser le résolveur -> aucune promesse fuit.
        if (resolver.current) {
          resolve(false);
          return;
        }
        resolver.current = resolve;
        setReq(r);
      }),
    [],
  );
  const resolve = useCallback((ok: boolean) => {
    setReq(null);
    const r = resolver.current;
    resolver.current = null;
    r?.(ok);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmSheet req={req} onResolve={resolve} />
    </ConfirmContext.Provider>
  );
}

function Checkbox({ checked, label, onToggle, color }: { checked: boolean; label: string; onToggle: () => void; color: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 7,
          borderWidth: 2,
          borderColor: checked ? color : colors.line,
          backgroundColor: checked ? color : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Ionicons name="checkmark" size={16} color="#fff" /> : null}
      </View>
      <Text style={[font('sub'), { color: colors.ink800, flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

function ConfirmSheet({ req, onResolve }: { req: ConfirmRequest | null; onResolve: (ok: boolean) => void }) {
  const { colors, semantic } = useTheme();
  const [checked, setChecked] = useState(false);

  // Réinitialise la case à chaque nouvelle demande (un défi n'hérite jamais d'un consentement précédent).
  useEffect(() => {
    setChecked(false);
  }, [req]);

  const ch = req?.challenge;
  const needsGate = ch?.kind === 'amount' || ch?.kind === 'fiscal';
  const canConfirm = !needsGate || checked;
  const danger = req?.destructive || ch?.kind === 'fiscal';
  const accent = danger ? semantic.danger : semantic.ai;

  return (
    <Modal visible={req !== null} transparent animationType="slide" onRequestClose={() => onResolve(false)}>
      <Pressable
        onPress={() => onResolve(false)}
        accessibilityLabel="Fermer"
        style={{ flex: 1, backgroundColor: 'rgba(12,35,64,0.45)', justifyContent: 'flex-end' }}
      >
        {/* Pressable interne (stopPropagation) : taper la feuille ne ferme pas. */}
        <Pressable onPress={() => {}} style={{ padding: 16 }}>
          {req ? (
            <Card>
              <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{req.title}</Text>
              {req.message ? (
                <Text style={[font('sub'), { color: colors.slate500, marginTop: 6 }]}>{req.message}</Text>
              ) : null}

              <ActionDiffView diff={req.diff} />

              {ch?.kind === 'amount' ? (
                <View style={{ marginTop: 12 }}>
                  <Checkbox
                    checked={checked}
                    onToggle={() => setChecked((c) => !c)}
                    label={`Je confirme encaisser ${formatEUR(ch.expectedCents)}`}
                    color={accent}
                  />
                </View>
              ) : null}
              {ch?.kind === 'fiscal' ? (
                <View style={{ marginTop: 12 }}>
                  <Text style={[font('meta'), { color: semantic.danger, marginBottom: 4 }]}>
                    {ch.reason || 'Action définitive et irréversible.'}
                  </Text>
                  <Checkbox
                    checked={checked}
                    onToggle={() => setChecked((c) => !c)}
                    label="Je confirme cette action définitive"
                    color={accent}
                  />
                </View>
              ) : null}

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                <View style={{ flex: 1 }}>
                  <Button title="Annuler" variant="secondary" onPress={() => onResolve(false)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Confirmer"
                    variant={danger ? 'danger' : 'primary'}
                    disabled={!canConfirm}
                    onPress={() => onResolve(true)}
                  />
                </View>
              </View>
            </Card>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

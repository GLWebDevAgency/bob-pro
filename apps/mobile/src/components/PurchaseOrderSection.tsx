/**
 * B8 — section « Bon de commande » (numéro d'engagement grands comptes), partagée par le
 * détail devis et le détail facture. Le numéro est SAISI UNE FOIS (devis dès signature/envoi,
 * ou facture brouillon) puis repris automatiquement sur la facture — sans lui, la facture
 * d'un grand compte (RATP, collectivité, major du BTP) est rejetée ou retardée (Chorus Pro).
 *
 * La section est PRÉSENTATIONNELLE : l'écran appelant possède l'état de la feuille, les
 * mutations (mêmes use cases que Bob — parité d'actions) et la confirmation de retrait.
 * États : vide (CTA d'ajout) · remplie (numéro + date + document du coffre) · lecture seule
 * (facture émise « figé à l'émission », devis déjà facturé → géré sur la facture).
 */
import { useEffect, useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { DocumentView, PurchaseOrderRef, PurchaseOrderRefInput } from '@bob/core';
import { MAX_PURCHASE_ORDER_NUMBER_LENGTH } from '@bob/core';
import { t } from '@bob/i18n';
import {
  Button,
  Card,
  FadeIn,
  PressableScale,
  SectionHeader,
  Sheet,
  font,
  useTheme,
} from '@bob/ui';
import { FileIcon, ChevronRightIcon, LockIcon } from './icons';
import {
  buildPurchaseOrderRefInput,
  displayPurchaseOrderReceivedDate,
  parsePurchaseOrderReceivedDate,
} from './purchase-order-form.logic';

// ── Carte de section (rendue dans `extra` de PieceDetailView — même gabarit que les
//    sections existantes : Card + SectionHeader) ─────────────────────────────────────────

export interface PurchaseOrderCardProps {
  readonly purchaseOrder: PurchaseOrderRef | null;
  /** Saisie/modification autorisée (devis envoyé/vu/signé non facturé, facture brouillon). */
  readonly editable: boolean;
  /** Facture émise/avoir : mention « figé à l'émission » (lecture seule). */
  readonly frozen?: boolean;
  /** Devis déjà facturé : édition redirigée vers la facture (note honnête, pas de 409 surprise). */
  readonly invoicedNote?: boolean;
  /** Corps de l'état vide (devis vs facture — clés po.emptyQuoteBody / po.emptyInvoiceBody). */
  readonly emptyBody: string;
  /** Documents du coffre (résolution du nom du document lié). */
  readonly documents: readonly DocumentView[];
  readonly onAdd: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onOpenDocument?: ((documentId: string) => void) | undefined;
}

export function PurchaseOrderCard({
  purchaseOrder,
  editable,
  frozen = false,
  invoicedNote = false,
  emptyBody,
  documents,
  onAdd,
  onEdit,
  onRemove,
  onOpenDocument,
}: PurchaseOrderCardProps) {
  const { personality, colors, semantic, controls } = useTheme();

  // Rien à montrer ni à saisir : pas de carte fantôme (l'écran appelant filtre déjà, on
  // reste défensif ici).
  if (!purchaseOrder && !editable) return null;

  const linkedDocument = purchaseOrder?.documentId
    ? (documents.find((d) => d.id === purchaseOrder.documentId) ?? null)
    : null;
  const linkedDocumentName =
    linkedDocument?.displayName ?? t('po.documentFallbackName', { personality });

  return (
    <FadeIn>
      <Card style={{ marginBottom: 12 }}>
        <SectionHeader title={t('po.sectionTitle', { personality })} />
        {purchaseOrder ? (
          <View>
            <Text
              style={{
                ...font('body', 700),
                fontSize: 15,
                color: colors.ink900,
                fontVariant: ['tabular-nums'],
              }}
            >
              {purchaseOrder.number}
            </Text>
            {purchaseOrder.receivedAt ? (
              <Text style={[font('meta', 500), { color: colors.slate500, marginTop: 3 }]}>
                {t('po.receivedOn', {
                  personality,
                  params: { date: displayPurchaseOrderReceivedDate(purchaseOrder.receivedAt) },
                })}
              </Text>
            ) : null}
            {purchaseOrder.documentId ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('po.openDocument', {
                  personality,
                  params: { name: linkedDocumentName },
                })}
                disabled={!onOpenDocument}
                onPress={() => onOpenDocument?.(purchaseOrder.documentId!)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 9,
                  marginTop: 10,
                  minHeight: 44,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: controls.cardBorder,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                <FileIcon color={semantic.b2b} size={16} />
                <Text
                  numberOfLines={1}
                  style={{ ...font('sub', 600), fontSize: 13.5, color: colors.ink800, flex: 1 }}
                >
                  {linkedDocumentName}
                </Text>
                {onOpenDocument ? <ChevronRightIcon color={controls.chevron} /> : null}
              </PressableScale>
            ) : null}
            {frozen ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
                <LockIcon color={semantic.warning} />
                <Text style={[font('meta', 600), { color: colors.slate500, flex: 1 }]}>
                  {t('po.frozenNote', { personality })}
                </Text>
              </View>
            ) : null}
            {invoicedNote ? (
              <Text style={[font('meta', 600), { color: colors.slate500, marginTop: 10 }]}>
                {t('po.quoteInvoicedNote', { personality })}
              </Text>
            ) : null}
            {editable ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    title={t('po.editCta', { personality })}
                    variant="secondary"
                    size="compact"
                    onPress={onEdit}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title={t('po.removeCta', { personality })}
                    variant="danger"
                    size="compact"
                    onPress={onRemove}
                  />
                </View>
              </View>
            ) : null}
          </View>
        ) : (
          <View>
            <Text style={[font('sub', 500), { fontSize: 13.5, color: colors.slate500, lineHeight: 19 }]}>
              {invoicedNote ? t('po.quoteInvoicedNote', { personality }) : emptyBody}
            </Text>
            {!invoicedNote ? (
              <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                <Button
                  title={t('po.addCta', { personality })}
                  variant="secondary"
                  size="compact"
                  onPress={onAdd}
                />
              </View>
            ) : null}
          </View>
        )}
      </Card>
    </FadeIn>
  );
}

// ── Feuille de saisie (numéro + date facultative + document du coffre) ────────────────────

export interface PurchaseOrderSheetProps {
  readonly visible: boolean;
  /** Référence existante (modification) — null en ajout. */
  readonly initial: PurchaseOrderRef | null;
  /** Documents du coffre proposés par le sélecteur (l'appelant fournit la liste réelle). */
  readonly documents: readonly DocumentView[];
  readonly saving: boolean;
  /** Erreur de mutation (message serveur déjà traduit) — affichée sans fermer la feuille. */
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onInputChange?: (() => void) | undefined;
  readonly onSubmit: (input: PurchaseOrderRefInput) => void;
}

/** Tri coffre : plus récents d'abord — le bon de commande vient d'être scanné, en tête. */
function sortVaultDocuments(documents: readonly DocumentView[]): DocumentView[] {
  return [...documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function PurchaseOrderSheet({
  visible,
  initial,
  documents,
  saving,
  error,
  onClose,
  onInputChange,
  onSubmit,
}: PurchaseOrderSheetProps) {
  const { personality, colors, semantic, controls } = useTheme();
  const [number, setNumber] = useState('');
  const [date, setDate] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [touched, setTouched] = useState({ number: false, date: false });
  // Sélecteur du coffre INTERNE à la feuille (pas de Modals empilés) : la feuille bascule
  // entre le formulaire et la liste des documents, retour sans perdre la saisie.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Réamorce les champs à chaque ouverture — jamais un résidu d'une saisie précédente.
  useEffect(() => {
    if (!visible) return;
    setNumber(initial?.number ?? '');
    setDate(initial?.receivedAt ? displayPurchaseOrderReceivedDate(initial.receivedAt) : '');
    setDocumentId(initial?.documentId ?? null);
    setTouched({ number: false, date: false });
    setPickerOpen(false);
  }, [visible, initial]);

  const sortedDocuments = useMemo(() => sortVaultDocuments(documents), [documents]);
  const selectedDocument = documentId
    ? (documents.find((d) => d.id === documentId) ?? null)
    : null;
  const selectedDocumentName =
    selectedDocument?.displayName ?? t('po.documentFallbackName', { personality });

  const numberValid = number.replace(/\s+/gu, ' ').trim().length > 0;
  const dateValid = parsePurchaseOrderReceivedDate(date).ok;
  const valid = numberValid && dateValid;

  const markTouched = (field: 'number' | 'date'): void => {
    setTouched((current) => ({ ...current, [field]: true }));
    onInputChange?.();
  };

  const submit = (): void => {
    setTouched({ number: true, date: true });
    const built = buildPurchaseOrderRefInput({ number, receivedDate: date, documentId });
    if (!built.ok) return;
    onSubmit(built.value);
  };

  const sheetTitle = t(initial ? 'po.sheetTitleEdit' : 'po.sheetTitleAdd', { personality });

  return (
    <Sheet
      visible={visible}
      onClose={() => {
        if (saving) return;
        onClose();
      }}
      accessibilityLabel={sheetTitle}
      closeAccessibilityLabel={t('piece.close', { personality })}
    >
      {pickerOpen ? (
        <View>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12 }]}
          >
            {t('po.documentPickerTitle', { personality })}
          </Text>
          {sortedDocuments.length === 0 ? (
            <Text style={[font('sub', 500), { color: colors.slate500, lineHeight: 19 }]}>
              {t('po.documentPickerEmpty', { personality })}
            </Text>
          ) : (
            sortedDocuments.slice(0, 30).map((doc) => (
              <PressableScale
                key={doc.id}
                accessibilityRole="button"
                accessibilityLabel={doc.displayName}
                onPress={() => {
                  setDocumentId(doc.id);
                  setPickerOpen(false);
                  onInputChange?.();
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 44,
                  paddingVertical: 9,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.lineSoft,
                }}
              >
                <FileIcon color={documentId === doc.id ? semantic.b2b : colors.slate400} size={16} />
                <Text
                  numberOfLines={1}
                  style={{
                    ...font('sub', documentId === doc.id ? 700 : 600),
                    fontSize: 13.5,
                    color: documentId === doc.id ? semantic.b2b : colors.ink800,
                    flex: 1,
                  }}
                >
                  {doc.displayName}
                </Text>
                <ChevronRightIcon color={controls.chevron} />
              </PressableScale>
            ))
          )}
          <View style={{ marginTop: 14 }}>
            <Button
              title={t('po.documentPickerBack', { personality })}
              variant="secondary"
              onPress={() => setPickerOpen(false)}
            />
          </View>
        </View>
      ) : (
        <View>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12 }]}
          >
            {sheetTitle}
          </Text>

          <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
            {t('po.numberLabel', { personality })}
          </Text>
          <TextInput
            value={number}
            onChangeText={(value) => {
              setNumber(value);
              markTouched('number');
            }}
            onBlur={() => setTouched((current) => ({ ...current, number: true }))}
            maxLength={MAX_PURCHASE_ORDER_NUMBER_LENGTH}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder={t('po.numberPlaceholder', { personality })}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('po.numberLabel', { personality })}
            style={[
              font('body'),
              {
                minHeight: 44,
                color: colors.ink900,
                borderWidth: 1,
                borderColor: touched.number && !numberValid ? semantic.danger : colors.line,
                borderRadius: 12,
                paddingHorizontal: 12,
              },
            ]}
          />
          {touched.number && !numberValid ? (
            <Text
              accessibilityRole="alert"
              style={[font('meta', 600), { color: semantic.danger, marginTop: 4 }]}
            >
              {t('po.numberInvalid', { personality })}
            </Text>
          ) : null}

          <Text style={[font('meta'), { color: colors.slate400, marginTop: 12, marginBottom: 4 }]}>
            {t('po.dateLabel', { personality })}
          </Text>
          <TextInput
            value={date}
            onChangeText={(value) => {
              setDate(value);
              markTouched('date');
            }}
            onBlur={() => setTouched((current) => ({ ...current, date: true }))}
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            placeholder={t('po.datePlaceholder', { personality })}
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('po.dateLabel', { personality })}
            style={[
              font('body'),
              {
                minHeight: 44,
                color: colors.ink900,
                borderWidth: 1,
                borderColor: touched.date && !dateValid ? semantic.danger : colors.line,
                borderRadius: 12,
                paddingHorizontal: 12,
              },
            ]}
          />
          {touched.date && !dateValid ? (
            <Text
              accessibilityRole="alert"
              style={[font('meta', 600), { color: semantic.danger, marginTop: 4 }]}
            >
              {t('po.dateInvalid', { personality })}
            </Text>
          ) : null}

          <Text style={[font('meta'), { color: colors.slate400, marginTop: 12, marginBottom: 4 }]}>
            {t('po.documentLabel', { personality })}
          </Text>
          {documentId ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 9,
                minHeight: 44,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: controls.cardBorder,
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <FileIcon color={semantic.b2b} size={16} />
              <Text
                numberOfLines={1}
                style={{ ...font('sub', 600), fontSize: 13.5, color: colors.ink800, flex: 1 }}
              >
                {selectedDocumentName}
              </Text>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: documentId ? 8 : 0 }}>
            <Button
              title={t(documentId ? 'po.documentChangeCta' : 'po.documentPickCta', { personality })}
              variant="secondary"
              size="compact"
              onPress={() => setPickerOpen(true)}
            />
            {documentId ? (
              <Button
                title={t('po.documentClearCta', { personality })}
                variant="secondary"
                size="compact"
                onPress={() => {
                  setDocumentId(null);
                  onInputChange?.();
                }}
              />
            ) : null}
          </View>

          {error ? (
            <View
              accessible
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{
                marginTop: 12,
                borderRadius: 12,
                padding: 10,
                backgroundColor: semantic.dangerBg,
              }}
            >
              <Text style={[font('meta', 600), { color: semantic.danger }]}>{error}</Text>
            </View>
          ) : null}

          <View style={{ marginTop: 16 }}>
            <Button
              title={t('po.saveCta', { personality })}
              loading={saving}
              disabled={!valid || saving}
              onPress={submit}
            />
          </View>
        </View>
      )}
    </Sheet>
  );
}

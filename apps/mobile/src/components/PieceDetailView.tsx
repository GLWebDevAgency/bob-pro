/**
 * PieceDetailView — la VUE partagée du détail de pièce (claim C16, réf dc.html §showPiece).
 * Paramétrée par PieceView (@bob/core buildPieceView — use case pur, parité d'actions) :
 * header sticky (croix, kind, n°, badge statut) → nav croisée (devis↔facture, avoir,
 * situation) → parties (partyLine adaptatif) → lignes catégorisées + totaux (+ acompte) →
 * suivi de paiement (plafonné netToPay) → e-reporting OU frise PDP/Chorus → mentions
 * (badge FIGÉ À L'ÉMISSION) → barre sticky (PDF + actions réelles injectées).
 * 100 % @bob/ui + tokens pieceDetail — zéro hex, zéro fixture (la vue reçoit du réel).
 */
import { useRef, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
// R6 : Swipeable CLASSIQUE (pas ReanimatedSwipeable — reanimated est une dépendance fantôme,
// non déclarée dans ce workspace mobile).
import { Swipeable } from 'react-native-gesture-handler';
import { Feather } from '@expo/vector-icons';
import {
  formatEUR,
  type PieceLinkedRef,
  type PieceLineView,
  type PieceTransmissionStep,
  type PieceView,
} from '@bob/core';
import { conformityCard, patterns, pieceDetail, shadowNative } from '@bob/tokens';
import { t, type Personality } from '@bob/i18n';
import { useIdentity } from '../data/identity';
import { StatusBadge, font, useTheme } from '@bob/ui';
import {
  ChartIcon,
  ChevronRightIcon,
  CloseIcon,
  DepositIcon,
  FileIcon,
  LinkIcon,
  LockIcon,
  ReturnArrowIcon,
  RotateIcon,
  SendIcon,
} from './icons';
import { useBobAwareScrollInsets } from './use-bob-aware-scroll-insets';

const KIND_KEY = {
  devis: 'piece.kindDevis',
  facture: 'piece.kindFacture',
  acompte: 'piece.kindAcompte',
  avoir: 'piece.kindAvoir',
  situation: 'piece.kindSituation',
} as const;

const STATUS_KEY = {
  draft: 'piece.statusDraft',
  issued: 'piece.statusIssued',
  partially_paid: 'piece.statusPartiallyPaid',
  paid: 'piece.statusPaid',
  late: 'piece.statusLate',
  cancelled: 'piece.statusCancelled',
  sent: 'piece.statusSent',
  viewed: 'piece.statusViewed',
  signed: 'piece.statusSigned',
  refused: 'piece.statusRefused',
  expired: 'piece.statusExpired',
} as const;

const CAT_KEY = {
  labor: 'piece.catLabor',
  supply: 'piece.catSupply',
  travel: 'piece.catTravel',
  disbursement: 'piece.catDisbursement',
  subscription: 'piece.catSubscription',
} as const;

const TYPE_KEY = { b2b: 'piece.typeB2b', b2c: 'piece.typeB2c', b2g: 'piece.typeB2g' } as const;

const STEP_KEY = {
  emise: 'piece.stepEmise',
  transmise: 'piece.stepTransmise',
  recue: 'piece.stepRecue',
  acceptee: 'piece.stepAcceptee',
  payee: 'piece.stepPayee',
} as const;

/** Carte blanche standard de l'écran (radius 18, e1, bordure carte). */
function PieceCard({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  const { colors, controls } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        ...(padded ? { padding: 16 } : {}),
        marginBottom: 12,
        ...shadowNative.e1,
      }}
    >
      {children}
    </View>
  );
}

/** Carte de navigation croisée (devis lié / avoir / situation). */
function LinkedCard({
  bg,
  border,
  chipBg,
  icon,
  label,
  labelColor,
  value,
  valueColor,
  chevronColor,
  onPress,
  gradient,
}: {
  bg?: string;
  gradient?: readonly [string, string];
  border: string;
  chipBg: string;
  icon: ReactNode;
  label: string;
  labelColor: string;
  value: string;
  valueColor: string;
  chevronColor: string;
  onPress?: () => void;
}) {
  const content = (
    <>
      <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: chipBg, alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ ...font('meta', 600), color: labelColor }}>{label}</Text>
        <Text style={{ ...font('sub', 700), fontSize: 14.5, color: valueColor, fontVariant: ['tabular-nums'] }} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <ChevronRightIcon color={chevronColor} size={17} strokeWidth={2.4} />
    </>
  );
  const frame = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 11,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: border,
    paddingVertical: 12,
    paddingHorizontal: 15,
    marginBottom: 14,
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${value}`} {...(onPress ? { onPress } : {})}>
      {gradient ? (
        <LinearGradient colors={[...gradient]} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={frame}>
          {content}
        </LinearGradient>
      ) : (
        <View style={[frame, { backgroundColor: bg }]}>{content}</View>
      )}
    </Pressable>
  );
}

function LineRowContent({
  line,
  personality,
  last,
  action,
}: {
  line: PieceLineView;
  personality: Personality;
  last: boolean;
  action?: ReactNode;
}) {
  const { colors, controls } = useTheme();
  return (
    <View style={{ paddingVertical: 12, backgroundColor: colors.surface, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.lineSoft }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ ...font('body', 600), fontSize: 14, color: colors.ink800, lineHeight: 19 }}>{line.label}</Text>
          <View
            style={{
              alignSelf: 'flex-start',
              marginTop: 5,
              backgroundColor: controls.segmentedTrack,
              borderRadius: 6,
              paddingVertical: 2,
              paddingHorizontal: 7,
            }}
          >
            <Text style={{ ...font('meta', 700), fontSize: 10.5, color: colors.slate500 }}>
              {t(CAT_KEY[line.category], { personality })}
            </Text>
          </View>
          <Text style={{ ...font('meta', 500), fontSize: 11.5, color: colors.slate500, marginTop: 5 }}>
            {t('piece.lineQuantityPrice', {
              personality,
              params: {
                qty: String(line.qty).replace('.', ','),
                unit: line.unit ?? 'u.',
                price: formatEUR(line.unitPriceHTCents),
              },
            })}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800, fontVariant: ['tabular-nums'] }}>
            {formatEUR(line.totalHTCents)}
          </Text>
          <Text style={{ ...font('meta', 500), fontSize: 11.5, color: colors.slate500 }}>
            {t('piece.vatPerLine', { personality, params: { rate: line.vatRatePct } })}
          </Text>
          </View>
          {action}
        </View>
      </View>
    </View>
  );
}

/**
 * R6 : ligne de devis BROUILLON éditable au swipe (droite→gauche révèle Modifier/Supprimer) —
 * l'appelant ne passe `editable` que si `quote.status === 'draft'` (l'UI n'affiche jamais ce
 * que le domaine interdit : Quote.updateLine/removeLine gardent assertDraft). Swipeable
 * CLASSIQUE (react-native-gesture-handler) — PAS ReanimatedSwipeable, reanimated est une
 * dépendance fantôme non déclarée dans ce workspace mobile.
 */
function LineRow({
  line,
  personality,
  last,
  editable,
  onEditLine,
  onDeleteLine,
}: {
  line: PieceLineView;
  personality: Personality;
  last: boolean;
  editable?: boolean;
  onEditLine?: (lineId: string) => void;
  onDeleteLine?: (lineId: string) => void;
}) {
  const { colors, semantic, controls } = useTheme();
  const swipeRef = useRef<Swipeable>(null);

  if (!editable) return <LineRowContent line={line} personality={personality} last={last} />;

  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={() => (
        <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('devis.lineSwipeEdit', { personality, params: { label: line.label } })}
            onPress={() => {
              swipeRef.current?.close();
              onEditLine?.(line.id);
            }}
            style={{ width: 64, alignItems: 'center', justifyContent: 'center', backgroundColor: controls.segmentedTrack }}
          >
            <Feather name="edit-2" size={18} color={colors.ink600} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('devis.lineSwipeDelete', { personality, params: { label: line.label } })}
            onPress={() => {
              swipeRef.current?.close();
              onDeleteLine?.(line.id);
            }}
            style={{ width: 64, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.dangerBg }}
          >
            <Feather name="trash-2" size={18} color={semantic.danger} />
          </Pressable>
        </View>
      )}
    >
      <LineRowContent
        line={line}
        personality={personality}
        last={last}
        action={(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('devis.lineSwipeEdit', { personality, params: { label: line.label } })}
            accessibilityHint={t('devis.lineEditVisibleHint', { personality })}
            hitSlop={4}
            onPress={() => onEditLine?.(line.id)}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? controls.segmentedTrack : colors.surface,
            })}
          >
            <Feather name="edit-2" size={18} color={colors.ink600} />
          </Pressable>
        )}
      />
    </Swipeable>
  );
}

function TransmissionDots({ steps, personality }: { steps: readonly PieceTransmissionStep[]; personality: Personality }) {
  const { colors, semantic, controls } = useTheme();
  const dotColor = (state: PieceTransmissionStep['state']): string =>
    state === 'done' ? semantic.success : state === 'current' ? semantic.b2b : controls.ringTrack;
  const txtColor = (state: PieceTransmissionStep['state']): string =>
    state === 'todo' ? colors.slate300 : state === 'current' ? semantic.b2b : colors.slate500;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
      {steps.map((step) => (
        <View key={step.key} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
          <View style={{ width: 15, height: 15, borderRadius: 8, backgroundColor: dotColor(step.state) }} />
          <Text style={{ ...font('meta', 700), fontSize: 9.5, color: txtColor(step.state), textAlign: 'center', lineHeight: 12 }}>
            {t(STEP_KEY[step.key], { personality })}
          </Text>
        </View>
      ))}
    </View>
  );
}

export interface PieceDetailViewProps {
  view: PieceView;
  onClose: () => void;
  /** Pont réel « créer la facture finale » (rendu si view.nextStep) — action injectée par la route. */
  nextStepAction?: ReactNode;
  /** Navigation croisée — le parent route (devis ↔ facture). */
  onOpenQuote?: (ref: PieceLinkedRef) => void;
  onOpenInvoice?: (ref: PieceLinkedRef) => void;
  /** Actions réelles injectées (QuoteActions/InvoiceActions — source unique, parité Bob). */
  actions?: ReactNode;
  /** Ouvre le PDF archivé (si un document lié existe au coffre). */
  onOpenPdf?: (() => void) | undefined;
  /** Envoie le PDF au client (A4) — feuille de partage native sur le vrai fichier. */
  onSharePdf?: (() => void) | undefined;
  /** Partage le LIEN de consultation (devis/facture, canal universel sans e-mail) — génère/rote
   * le view-link puis ouvre le Share natif. Distinct de onSharePdf (fichier brut) : le lien
   * fonctionne même sans PDF archivé, et le destinataire consulte + télécharge lui-même. */
  onShareLink?: (() => void) | undefined;
  /** Sections réelles supplémentaires (aperçu comptable…) rendues sous les mentions. */
  extra?: ReactNode;
  /** R6 : lignes éditables au swipe — VRAI uniquement quand l'appelant sait que c'est un devis
   * BROUILLON (quote.status === 'draft'). L'UI n'affiche jamais ce que le domaine interdit. */
  editableLines?: boolean;
  onEditLine?: (lineId: string) => void;
  onDeleteLine?: (lineId: string) => void;
}

export function PieceDetailView({
  view,
  onClose,
  onOpenQuote,
  onOpenInvoice,
  actions,
  onOpenPdf,
  onSharePdf,
  onShareLink,
  extra,
  nextStepAction,
  editableLines,
  onEditLine,
  onDeleteLine,
}: PieceDetailViewProps) {
  const { personality, colors, semantic, controls } = useTheme();
  const identity = useIdentity();
  const insets = useSafeAreaInsets();
  const kindLabel = t(KIND_KEY[view.kind], { personality });
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: 120 });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        stickyHeaderIndices={[0]}
      >
        {/* Header sticky : croix · kind + n° · badge statut */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingTop: insets.top + 8,
            paddingHorizontal: 18,
            paddingBottom: 14,
            backgroundColor: colors.bg,
            borderBottomWidth: 1,
            borderBottomColor: controls.ringTrack,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fermer"
            onPress={onClose}
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: controls.ringTrack,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CloseIcon color={colors.slate500} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[font('eyebrow'), { letterSpacing: 0.3, color: colors.slate400 }]}>{kindLabel}</Text>
            <Text style={{ ...font('bigNum'), fontSize: 18, color: colors.ink800, fontVariant: ['tabular-nums'] }} numberOfLines={1}>
              {view.number ?? t('piece.draftNumber', { personality })}
            </Text>
          </View>
          <StatusBadge label={t(STATUS_KEY[view.status.key], { personality })} variant={view.status.tone === 'warning' ? 'particulier' : view.status.tone === 'b2b' ? 'b2b' : view.status.tone} />
        </View>

        <View style={{ paddingHorizontal: 18, paddingTop: 16 }}>
          {/* Nav croisée */}
          {view.linkedQuote ? (
            <LinkedCard
              gradient={[conformityCard.bgTop, conformityCard.bgBottom]}
              border={conformityCard.border}
              chipBg={semantic.b2gBg}
              icon={<ReturnArrowIcon color={semantic.b2g} />}
              label={t('piece.linkedQuote', { personality })}
              labelColor={pieceDetail.linkedLabelInk}
              value={view.linkedQuote.number ?? ''}
              valueColor={semantic.aiInk}
              chevronColor={semantic.b2g}
              {...(onOpenQuote ? { onPress: () => onOpenQuote(view.linkedQuote!) } : {})}
            />
          ) : null}
          {view.linkedInvoices.map((linked) => (
            <LinkedCard
              key={linked.id}
              gradient={[conformityCard.bgTop, conformityCard.bgBottom]}
              border={conformityCard.border}
              chipBg={semantic.b2gBg}
              icon={<ReturnArrowIcon color={semantic.b2g} />}
              label={
                linked.kind === 'deposit'
                  ? t('piece.kindAcompte', { personality })
                  : linked.kind === 'credit_note'
                    ? t('piece.kindAvoir', { personality })
                    : linked.kind === 'situation'
                      ? t('piece.kindSituation', { personality })
                      : t('piece.linkedInvoice', { personality })
              }
              labelColor={pieceDetail.linkedLabelInk}
              value={`${linked.number ?? ''}${linked.ttcCents !== undefined ? ` · ${formatEUR(linked.ttcCents)}` : ''}`}
              valueColor={semantic.aiInk}
              chevronColor={semantic.b2g}
              {...(onOpenInvoice ? { onPress: () => onOpenInvoice(linked) } : {})}
            />
          ))}
          {view.depositDeduction?.invoiceRef ? (
            <LinkedCard
              gradient={[conformityCard.bgTop, conformityCard.bgBottom]}
              border={conformityCard.border}
              chipBg={semantic.b2gBg}
              icon={<ReturnArrowIcon color={semantic.b2g} />}
              label={t('piece.linkedDeposit', { personality })}
              labelColor={pieceDetail.linkedLabelInk}
              value={view.depositDeduction.invoiceRef.number ?? ''}
              valueColor={semantic.aiInk}
              chevronColor={semantic.b2g}
              {...(onOpenInvoice ? { onPress: () => onOpenInvoice(view.depositDeduction!.invoiceRef!) } : {})}
            />
          ) : null}
          {view.creditNote ? (
            <LinkedCard
              bg={semantic.warningBg}
              border={pieceDetail.creditBorder}
              chipBg={pieceDetail.creditChipBg}
              icon={<RotateIcon color={pieceDetail.creditInk} />}
              label={t('piece.linkedAvoir', { personality })}
              labelColor={pieceDetail.creditInk}
              value={`${view.creditNote.number ?? ''}${view.creditNote.ttcCents !== undefined ? ` · −${formatEUR(Math.abs(view.creditNote.ttcCents))}` : ''}`}
              valueColor={pieceDetail.creditInkStrong}
              chevronColor={pieceDetail.creditInk}
              {...(onOpenInvoice ? { onPress: () => onOpenInvoice(view.creditNote!) } : {})}
            />
          ) : null}
          {view.situation ? (
            <LinkedCard
              bg={pieceDetail.situationBg}
              border={pieceDetail.situationBorder}
              chipBg={pieceDetail.situationChipBg}
              icon={<ChartIcon color={semantic.b2b} />}
              label={t('piece.linkedSituation', { personality })}
              labelColor={pieceDetail.situationInk}
              value={view.situation.number ?? ''}
              valueColor={semantic.b2b}
              chevronColor={semantic.b2b}
              {...(onOpenInvoice ? { onPress: () => onOpenInvoice(view.situation!) } : {})}
            />
          ) : null}

          {/* Parties */}
          <PieceCard padded={false}>
            <View style={{ paddingHorizontal: 16, paddingTop: 5 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  paddingVertical: 11,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.lineSoft,
                }}
              >
                <View>
                  <Text style={{ ...font('meta', 600), fontSize: 11, color: colors.slate300 }}>
                    {t('piece.issuer', { personality })}
                  </Text>
                  <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>{identity.companyName ?? '—'}</Text>
                </View>
              </View>
              <View style={{ paddingVertical: 11 }}>
                <Text style={{ ...font('meta', 600), fontSize: 11, color: colors.slate300 }}>
                  {t('piece.customer', { personality })}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                  <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>{view.customerName}</Text>
                  {view.customerType ? (
                    <StatusBadge label={t(TYPE_KEY[view.customerType], { personality })} variant={view.customerType === 'b2c' ? 'particulier' : view.customerType} />
                  ) : null}
                </View>
                {view.partyLine ? (
                  <Text style={{ ...font('meta', 500), fontSize: 12.5, color: colors.slate400, marginTop: 3 }}>
                    {view.partyLine}
                  </Text>
                ) : null}
              </View>
            </View>
          </PieceCard>

          {/* Lignes + totaux */}
          <PieceCard padded={false}>
            <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14 }}>
              {view.lines.map((line, i) => (
                <LineRow
                  key={line.id}
                  line={line}
                  personality={personality}
                  last={i === view.lines.length - 1}
                  editable={editableLines}
                  onEditLine={onEditLine}
                  onDeleteLine={onDeleteLine}
                />
              ))}
              <View style={{ paddingTop: 12, borderTopWidth: view.lines.length > 0 ? 1 : 0, borderTopColor: colors.lineSoft }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                  <Text style={[font('sub'), { color: colors.slate500 }]}>{t('piece.totalHt', { personality })}</Text>
                  <Text style={{ ...font('sub', 600), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                    {formatEUR(view.totals.ht)}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                  <Text style={[font('sub'), { color: colors.slate500 }]}>{t('piece.totalVat', { personality })}</Text>
                  <Text style={{ ...font('sub', 600), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                    {formatEUR(view.totals.vat)}
                  </Text>
                </View>
                {view.amountDue.isPartialOfTtc ? (
                  // Acompte/situation/finale après acompte : le TTC du CHANTIER n'est qu'un
                  // contexte — le héros de la pièce est son net à payer (A1/A2-C16).
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                    <Text style={[font('sub'), { color: colors.slate500 }]}>{t('piece.chantierTtc', { personality })}</Text>
                    <Text style={{ ...font('sub', 600), color: colors.ink800, fontVariant: ['tabular-nums'] }}>
                      {formatEUR(view.totals.ttc)}
                    </Text>
                  </View>
                ) : null}
                {view.depositDeduction ? (
                  // La trace du déjà-facturé : tout le flow est corrélé (devis → acompte →
                  // situations → solde). Réf citée si unique, libellé composite sinon (A5).
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                    <Text style={[font('sub'), { color: colors.slate500 }]}>
                      {view.depositDeduction.invoiceRef?.number
                        ? t('piece.depositDeducted', {
                            personality,
                            params: { number: ` (${view.depositDeduction.invoiceRef.number})` },
                          })
                        : t('piece.alreadyInvoiced', { personality })}
                    </Text>
                    <Text style={{ ...font('sub', 700), color: semantic.success, fontVariant: ['tabular-nums'] }}>
                      −{formatEUR(view.depositDeduction.amountCents)}
                    </Text>
                  </View>
                ) : null}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 6,
                    paddingTop: 9,
                    borderTopWidth: 1,
                    borderTopColor: colors.lineSoft,
                  }}
                >
                  <Text style={{ ...font('body', 700), fontSize: 15, color: colors.ink800 }}>
                    {t(view.amountDue.isPartialOfTtc ? 'piece.amountDuePartial' : 'piece.totalTtc', { personality })}
                  </Text>
                  <Text
                    style={{
                      ...font('bigNum'),
                      fontSize: 19,
                      color: view.signedAmountCents < 0 ? semantic.dangerVivid : colors.ink900,
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    {view.signedAmountCents < 0
                      ? `−${formatEUR(Math.abs(view.signedAmountCents))}`
                      : formatEUR(view.amountDue.cents)}
                  </Text>
                </View>
                {view.deposit ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 7,
                      marginTop: 10,
                      backgroundColor: semantic.successBg,
                      borderRadius: 10,
                      paddingVertical: 9,
                      paddingHorizontal: 12,
                    }}
                  >
                    <DepositIcon color={semantic.success} size={15} />
                    <Text style={{ ...font('meta', 600), fontSize: 12.5, color: semantic.success, flex: 1 }}>
                      {t('piece.deposit', {
                        personality,
                        params: { pct: view.deposit.pct, amount: formatEUR(view.deposit.amountCents) },
                      })}
                    </Text>
                  </View>
                ) : null}
                {view.situationProgressPct !== null ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 7,
                      marginTop: 10,
                      backgroundColor: pieceDetail.situationBg,
                      borderRadius: 10,
                      paddingVertical: 9,
                      paddingHorizontal: 12,
                    }}
                  >
                    <ChartIcon color={semantic.b2b} size={15} />
                    <Text style={{ ...font('meta', 600), fontSize: 12.5, color: semantic.b2b, flex: 1 }}>
                      {t('piece.progress', { personality, params: { pct: view.situationProgressPct } })}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          </PieceCard>

          {/* Suivi de paiement */}
          {view.suivi ? (
            <PieceCard>
              <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800, marginBottom: 11 }}>
                {t('piece.paymentTitle', { personality })}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingVertical: 6,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.lineSoft,
                }}
              >
                <Text style={[font('sub'), { color: colors.slate500 }]}>{t('piece.paidLabel', { personality })}</Text>
                <Text style={{ ...font('sub', 700), color: semantic.success, fontVariant: ['tabular-nums'] }}>
                  {formatEUR(view.suivi.paidCents)}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 9 }}>
                <Text style={{ ...font('sub', 700), color: colors.ink800 }}>{t('piece.remainingLabel', { personality })}</Text>
                <Text style={{ ...font('bigNum'), fontSize: 18, color: colors.ink900, fontVariant: ['tabular-nums'] }}>
                  {formatEUR(view.suivi.remainingCents)}
                </Text>
              </View>
              {view.suivi.isPaid ? (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 11,
                    backgroundColor: semantic.successBg,
                    borderRadius: 10,
                    paddingVertical: 9,
                    paddingHorizontal: 12,
                  }}
                >
                  <Text style={{ ...font('meta', 600), fontSize: 12.5, color: semantic.success }}>
                    {t('piece.paidDone', { personality })}
                  </Text>
                </View>
              ) : null}
            </PieceCard>
          ) : null}

          {/* Pont réel : acompte payé → la suite du chantier (A1-C16) */}
          {view.nextStep && nextStepAction ? (
            <PieceCard>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 12 }}>
                <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: semantic.successBg, alignItems: 'center', justifyContent: 'center' }}>
                  <FileIcon color={semantic.success} size={17} />
                </View>
                <Text style={{ ...font('sub', 600), fontSize: 13.5, color: colors.slate500, flex: 1, lineHeight: 19 }}>
                  {t('piece.nextStepBody', {
                    personality,
                    params: { amount: formatEUR(view.nextStep.remainingToInvoiceCents) },
                  })}
                </Text>
              </View>
              {nextStepAction}
            </PieceCard>
          ) : null}

          {/* e-reporting (B2C) OU frise PDP/Chorus */}
          {view.isEreporting ? (
            <PieceCard>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: semantic.warningBg, alignItems: 'center', justifyContent: 'center' }}>
                  <ChartIcon color={semantic.warning} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>
                    {t('piece.ereportingTitle', { personality })}
                  </Text>
                  <Text style={{ ...font('meta', 500), fontSize: 12.5, color: pieceDetail.creditInk, lineHeight: 17 }}>
                    {t('piece.ereportingBody', { personality })}
                  </Text>
                </View>
              </View>
            </PieceCard>
          ) : null}
          {view.transmission ? (
            <PieceCard>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 15 }}>
                <View style={{ width: 26, height: 26, borderRadius: 8, backgroundColor: semantic.b2bBg, alignItems: 'center', justifyContent: 'center' }}>
                  <SendIcon color={semantic.b2b} />
                </View>
                <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>
                  {t(view.transmission.channel === 'chorus_pro' ? 'piece.transmissionChorus' : 'piece.transmissionPa', { personality })}
                </Text>
              </View>
              <TransmissionDots steps={view.transmission.steps} personality={personality} />
            </PieceCard>
          ) : null}

          {/* Mentions légales */}
          {view.mentions.length > 0 ? (
            <PieceCard>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <Text style={[font('eyebrow'), { letterSpacing: 0.3, color: colors.slate400 }]}>
                  {t('piece.mentionsTitle', { personality })}
                </Text>
                {view.frozen ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      backgroundColor: semantic.warningBg,
                      borderRadius: 6,
                      paddingVertical: 2,
                      paddingHorizontal: 7,
                    }}
                  >
                    <LockIcon color={semantic.warning} />
                    <Text style={{ ...font('meta', 700), fontSize: 10, color: semantic.warning }}>
                      {t('piece.frozenBadge', { personality }).toUpperCase()}
                    </Text>
                  </View>
                ) : null}
              </View>
              {view.mentions.map((mention) => (
                <View key={mention} style={{ flexDirection: 'row', gap: 8, paddingVertical: 5 }}>
                  <Text style={{ color: controls.chevron }}>•</Text>
                  <Text style={{ ...font('meta', 500), fontSize: 12.5, color: colors.slate500, lineHeight: 18, flex: 1 }}>
                    {mention}
                  </Text>
                </View>
              ))}
            </PieceCard>
          ) : null}

          {extra}
        </View>
      </ScrollView>

      {/* Barre d'actions sticky (fondu bg) : PDF + actions réelles injectées */}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <LinearGradient
          pointerEvents="none"
          colors={[...patterns.bottomTabBar.fade] as [string, string, ...string[]]}
          locations={[...patterns.bottomTabBar.fadeLocations] as [number, number, ...number[]]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View pointerEvents="box-none" style={{ flexDirection: 'row', gap: 10, paddingTop: 14, paddingHorizontal: 18, paddingBottom: 28, alignItems: 'flex-end' }}>
          {onOpenPdf ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('piece.actionPdf', { personality })}
              onPress={onOpenPdf}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: controls.buttonSecondaryBorder,
                borderRadius: 15,
                paddingVertical: 15,
                paddingHorizontal: 18,
                minHeight: 44,
              }}
            >
              <FileIcon color={colors.ink600} size={17} />
              <Text style={{ ...font('sub', 700), fontSize: 14.5, color: colors.ink600 }}>
                {t('piece.actionPdf', { personality })}
              </Text>
            </Pressable>
          ) : null}
          {onSharePdf ? (
            /* A4 : le client reçoit le VRAI fichier (feuille de partage native) — icône
               seule, même gabarit que le bouton PDF (l'action primaire reste à droite). */
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('piece.actionSharePdf', { personality })}
              onPress={onSharePdf}
              style={{
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: controls.buttonSecondaryBorder,
                borderRadius: 15,
                paddingVertical: 15,
                paddingHorizontal: 15,
                minHeight: 44,
              }}
            >
              <SendIcon color={colors.ink600} size={17} />
            </Pressable>
          ) : null}
          {onShareLink ? (
            /* Lien de consultation (canal universel, sans e-mail) — même gabarit icône seule
               que le partage PDF, à côté de lui. */
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('piece.actionShareLink', { personality })}
              onPress={onShareLink}
              style={{
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: controls.buttonSecondaryBorder,
                borderRadius: 15,
                paddingVertical: 15,
                paddingHorizontal: 15,
                minHeight: 44,
              }}
            >
              <LinkIcon color={colors.ink600} size={17} />
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }}>{actions}</View>
        </View>
      </View>
    </View>
  );
}

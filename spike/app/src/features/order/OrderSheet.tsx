// THROWAWAY SPIKE. Native order ticket opened by the chart's on-chart BUY/SELL tap
// (the /trading terminal's "One-Click off" path, where a Buy opens the host's ticket).
// It never sends anything: confirm shows a mock "Order placed (spike, not sent)".
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TradeRequest, TradeSide } from '~/dom/chart/types';

const C = {
  bg: '#0b0f14',
  surface: '#121821',
  border: '#1f2a37',
  text: '#e6edf3',
  muted: '#8b98a5',
  up: '#22c55e',
  down: '#ef4444',
  accent: '#3b82f6',
};

type OrderType = 'MARKET' | 'LIMIT';
type Product = 'MIS' | 'CNC' | 'NRML';

export interface PlacedOrder {
  side: TradeSide;
  symbol: string;
  exchange: string;
  qty: number;
  type: OrderType;
  price: number | null;
  product: Product;
}

interface Props {
  /** Render with key={request.tappedAt} so each tap starts a fresh ticket. */
  request: TradeRequest;
  /** DOM tap -> native handler latency, shown for information. */
  tapLatencyMs: number | null;
  onClose: () => void;
  onPlaced: (order: PlacedOrder) => void;
}

const fmt = (n: number) => n.toFixed(2);

function Segmented<T extends string>({
  options,
  value,
  onChange,
  activeColor = C.accent,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  activeColor?: string;
}) {
  return (
    <View style={s.segment}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={o}
            onPress={() => {
              if (!on) void Haptics.selectionAsync();
              onChange(o);
            }}
            style={[s.segBtn, on && { backgroundColor: activeColor }]}
          >
            <Text style={[s.segTxt, on && { color: '#fff' }]}>{o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function OrderSheet({ request, tapLatencyMs, onClose, onPlaced }: Props) {
  const insets = useSafeAreaInsets();
  const [qtyText, setQtyText] = useState(() => String(request.qty));
  const [type, setType] = useState<OrderType>('MARKET');
  const [priceText, setPriceText] = useState(() => fmt(request.price));
  const [product, setProduct] = useState<Product>('MIS');
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);

  const side = request.side;
  const sideColor = side === 'BUY' ? C.up : C.down;
  const qty = Math.max(0, Math.floor(Number(qtyText) || 0));
  const limitPrice = Number(priceText);
  const priceOk = type === 'MARKET' || (Number.isFinite(limitPrice) && limitPrice > 0);
  const canConfirm = qty > 0 && priceOk;

  const step = (d: number) => {
    void Haptics.selectionAsync();
    setQtyText(String(Math.max(1, qty + d)));
  };

  const confirm = () => {
    if (!canConfirm) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const order: PlacedOrder = {
      side,
      symbol: request.symbol,
      exchange: request.exchange,
      qty,
      type,
      price: type === 'LIMIT' ? Math.round(limitPrice * 20) / 20 : null,
      product,
    };
    // No network call: this is the spike's stand-in for POST /api/v1/placeorder.
    setPlaced(order);
    onPlaced(order);
    setTimeout(() => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success), 60);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={s.grabber} />
          {placed ? (
            <View style={{ gap: 14 }}>
              <Text style={[s.title, { color: C.up }]}>Order placed (spike, not sent)</Text>
              <Text style={s.body}>
                {placed.side} {placed.qty} {placed.symbol} ({placed.exchange}) {placed.type}
                {placed.price != null ? ` @ ${fmt(placed.price)}` : ''} · {placed.product}
              </Text>
              <Text style={s.muted}>Nothing left this phone. No order API was called.</Text>
              <Pressable style={[s.confirm, { backgroundColor: C.border }]} onPress={onClose}>
                <Text style={s.confirmTxt}>Done</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              <View style={s.row}>
                <View style={[s.sideBadge, { backgroundColor: sideColor }]}>
                  <Text style={s.sideTxt}>{side}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.title}>
                    {request.symbol} <Text style={s.muted}>{request.exchange}</Text>
                  </Text>
                  <Text style={s.muted}>
                    Chart price at tap {fmt(request.price)}
                    {tapLatencyMs != null ? ` · tap to native ${tapLatencyMs} ms` : ''}
                  </Text>
                </View>
              </View>

              <View style={s.row}>
                <Text style={s.label}>Qty</Text>
                <View style={s.stepper}>
                  <Pressable style={s.stepBtn} onPress={() => step(-1)}>
                    <Text style={s.stepTxt}>−</Text>
                  </Pressable>
                  <TextInput
                    value={qtyText}
                    onChangeText={(t) => setQtyText(t.replace(/[^0-9]/g, ''))}
                    keyboardType="number-pad"
                    style={s.qtyInput}
                    selectTextOnFocus
                  />
                  <Pressable style={s.stepBtn} onPress={() => step(1)}>
                    <Text style={s.stepTxt}>+</Text>
                  </Pressable>
                </View>
              </View>

              <View style={s.row}>
                <Text style={s.label}>Type</Text>
                <View style={{ flex: 1 }}>
                  <Segmented options={['MARKET', 'LIMIT'] as const} value={type} onChange={setType} />
                </View>
              </View>

              {type === 'LIMIT' && (
                <View style={s.row}>
                  <Text style={s.label}>Price</Text>
                  <TextInput
                    value={priceText}
                    onChangeText={(t) => setPriceText(t.replace(/[^0-9.]/g, ''))}
                    keyboardType="decimal-pad"
                    style={[s.priceInput, !priceOk && { borderColor: C.down }]}
                    selectTextOnFocus
                  />
                </View>
              )}

              <View style={s.row}>
                <Text style={s.label}>Product</Text>
                <View style={{ flex: 1 }}>
                  <Segmented options={['MIS', 'CNC', 'NRML'] as const} value={product} onChange={setProduct} />
                </View>
              </View>

              <Pressable
                onPress={confirm}
                style={({ pressed }) => [
                  s.confirm,
                  { backgroundColor: sideColor, opacity: canConfirm ? (pressed ? 0.8 : 1) : 0.4 },
                ]}
              >
                <Text style={s.confirmTxt}>
                  {side} {qty || '-'} @ {type === 'MARKET' ? 'MARKET' : priceOk ? fmt(limitPrice) : '?'}
                </Text>
              </Pressable>
              <Text style={[s.muted, { textAlign: 'center' }]}>Spike: confirming sends nothing.</Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sideBadge: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  sideTxt: { color: '#fff', fontWeight: '800', fontSize: 15, letterSpacing: 0.5 },
  title: { color: C.text, fontSize: 17, fontWeight: '700' },
  body: { color: C.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  muted: { color: C.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  label: { color: C.muted, width: 64, fontSize: 13 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bg,
  },
  stepTxt: { color: C.text, fontSize: 22, fontWeight: '600' },
  qtyInput: {
    minWidth: 84,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    textAlign: 'center',
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    backgroundColor: C.bg,
  },
  priceInput: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    paddingHorizontal: 12,
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    backgroundColor: C.bg,
  },
  segment: { flexDirection: 'row', borderRadius: 10, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  segBtn: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  segTxt: { color: C.muted, fontWeight: '700', fontSize: 13 },
  confirm: { height: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  confirmTxt: { color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: 0.3 },
});

// THROWAWAY SPIKE. Small presentational pieces for the Results tab (cards, segmented control, chips, buttons).
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C } from './theme';

export function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Text style={s.cardTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' | 'down' }) {
  const color = tone === 'warn' ? C.warn : tone === 'down' ? C.down : C.muted;
  return <Text style={[s.note, { color }]}>{children}</Text>;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[s.seg, disabled && s.dim]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            disabled={disabled}
            onPress={() => {
              if (!on) onChange(o.value);
            }}
            style={({ pressed }) => [s.segItem, on && s.segOn, pressed && !on && s.pressed]}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled }}
          >
            <Text style={[s.segTxt, on && s.segTxtOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type ChipKind = 'pass' | 'fail' | 'soft' | 'none';

export function Chip({ kind, label }: { kind: ChipKind; label: string }) {
  const color = kind === 'pass' ? C.up : kind === 'fail' ? C.down : kind === 'soft' ? C.warn : C.muted;
  return (
    <View style={[s.chip, { borderColor: color }]}>
      <Text style={[s.chipTxt, { color }]}>{label}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
}) {
  const bg = kind === 'primary' ? C.accent : 'transparent';
  const border = kind === 'danger' ? C.down : kind === 'ghost' ? C.border : C.accent;
  const color = kind === 'danger' ? C.down : C.text;
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: border }, (pressed || disabled) && s.pressed]}
      accessibilityRole="button"
    >
      <Text style={[s.btnTxt, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function KV({ k, v, color }: { k: string; v: ReactNode; color?: string }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvK}>{k}</Text>
      <Text style={[s.kvV, color ? { color } : null]} selectable>
        {v}
      </Text>
    </View>
  );
}

export const s = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  label: { color: C.muted, fontSize: 12, marginTop: 10, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  note: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  dim: { opacity: 0.4 },
  pressed: { opacity: 0.6 },
  seg: { flexDirection: 'row', borderColor: C.border, borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  segItem: { flex: 1, paddingVertical: 9, alignItems: 'center', backgroundColor: C.bg },
  segOn: { backgroundColor: C.accent },
  segTxt: { color: C.muted, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  segTxtOn: { color: '#ffffff' },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  chipTxt: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  btn: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  btnTxt: { fontSize: 14, fontWeight: '700' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, gap: 12 },
  kvK: { color: C.muted, fontSize: 13 },
  kvV: { color: C.text, fontSize: 13, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' },
});

// The API key field (design 7.1 step 3, 7.2): masked, with no length hint, and a Show toggle.
// Shown, it is a plain input that no keyboard learns from, so scan-text can fill it.
import { useState } from 'react'
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { looksPasted } from '~/core/credentials/keyFormat'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { COPY } from '../copy'

export function KeyField({
  value,
  onChangeText,
  editable = true,
  testID = 'key-input',
}: {
  value: string
  /** `pasted` is true when this one change added 32 characters or more. */
  onChangeText: (text: string, pasted: boolean) => void
  editable?: boolean
  testID?: string
}) {
  const { c } = useTheme()
  const [shown, setShown] = useState(false)
  return (
    <View style={styles.wrap}>
      <View style={[styles.row, { borderColor: c.input }]}>
        <TextInput
          testID={testID}
          accessibilityLabel="API key"
          placeholder="Paste your API key"
          placeholderTextColor={c.mutedForeground}
          value={value}
          onChangeText={(next) => onChangeText(next, looksPasted(value, next))}
          editable={editable}
          secureTextEntry={!shown}
          autoCorrect={false}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          importantForAutofill="no"
          keyboardType={shown && Platform.OS === 'android' ? 'visible-password' : 'default'}
          style={[styles.input, { color: c.foreground }]}
        />
        <Pressable
          testID="key-show"
          accessibilityRole="button"
          accessibilityLabel={shown ? 'Hide the key' : 'Show the key'}
          hitSlop={8}
          onPress={() => setShown((s) => !s)}
        >
          <Text style={styles.toggle}>{shown ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>
      <Text variant="caption" tone="muted">
        {COPY.scanHint}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  input: { flex: 1, minHeight: 48, fontSize: 15 },
  toggle: { fontWeight: '600' },
})

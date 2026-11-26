import { StyleSheet, TextInput } from 'react-native'
import { useTheme } from '~/ui/theme'

/** A server or live-feed address: no autocorrect, no capitals, the URL keyboard. */
export function UrlField({
  value,
  onChangeText,
  placeholder,
  label,
  editable = true,
  testID,
}: {
  value: string
  onChangeText: (text: string) => void
  placeholder: string
  label: string
  editable?: boolean
  testID: string
}) {
  const { c } = useTheme()
  return (
    <TextInput
      testID={testID}
      accessibilityLabel={label}
      value={value}
      onChangeText={onChangeText}
      editable={editable}
      placeholder={placeholder}
      placeholderTextColor={c.mutedForeground}
      autoCorrect={false}
      spellCheck={false}
      autoCapitalize="none"
      autoComplete="off"
      keyboardType="url"
      style={[styles.input, { borderColor: c.input, color: c.foreground }]}
    />
  )
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 15 },
})

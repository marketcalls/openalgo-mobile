// A server older than 2.0.0.0, or one that shows no 2.0.0.0 marker (design 7.1 step 2).
import { useRouter } from 'expo-router'
import { ScrollView, StyleSheet } from 'react-native'
import { MIN_SERVER_VERSION } from '~/core/config/constants'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { useOnboarding } from '../context'
import { COPY } from '../copy'

export function UpdateScreen() {
  const { draft } = useOnboarding()
  const router = useRouter()
  const version = draft.tooOldVersion
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text>
        {version
          ? `This server runs OpenAlgo ${version}. The app needs ${MIN_SERVER_VERSION} or later.`
          : `This server needs OpenAlgo ${MIN_SERVER_VERSION} or later.`}
      </Text>
      <Text>{COPY.tooOldNative}</Text>
      <Text>{COPY.tooOldDocker}</Text>
      <Button testID="update-back" title="Back" variant="secondary" onPress={() => router.back()} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
})

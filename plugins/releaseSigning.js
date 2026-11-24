// Pure Gradle text transform for the generated android/app/build.gradle.
// Without OA_KEYSTORE_PATH the release build keeps the template's debug key.

const MARKER = '// openalgo release signing'
const RELEASE_CONFIG = `        release {
            ${MARKER}
            storeFile System.getenv('OA_KEYSTORE_PATH') ? file(System.getenv('OA_KEYSTORE_PATH')) : null
            storePassword System.getenv('OA_KEYSTORE_PASSWORD')
            keyAlias System.getenv('OA_KEY_ALIAS')
            keyPassword System.getenv('OA_KEY_PASSWORD')
        }
`
const SIGNING =
  "signingConfig System.getenv('OA_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug"
const NOT_FOUND = 'release signing anchors not found'

function closingBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

function blockBounds(text, header, from = 0) {
  const at = text.indexOf(header, from)
  if (at < 0) return null
  const open = text.indexOf('{', at)
  const close = closingBrace(text, open)
  return close < 0 ? null : { at, open, close }
}

function applyReleaseSigning(gradle) {
  const signing = blockBounds(gradle, 'signingConfigs {')
  const types = blockBounds(gradle, 'buildTypes {')
  const release = types && blockBounds(gradle, 'release {', types.open)
  if (!signing || !release || release.close > types.close) throw new Error(NOT_FOUND)

  const releaseBody = gradle.slice(release.open, release.close)
  const hasConfig = gradle.slice(signing.open, signing.close).includes(MARKER)
  const alreadyWired = releaseBody.includes(SIGNING)
  if (!alreadyWired && !releaseBody.includes('signingConfig signingConfigs.debug')) {
    throw new Error(NOT_FOUND)
  }

  // Edit the later block first so earlier offsets stay valid.
  let out = gradle
  if (!alreadyWired) {
    const wired = releaseBody.replace('signingConfig signingConfigs.debug', SIGNING)
    out = out.slice(0, release.open) + wired + out.slice(release.close)
  }
  if (!hasConfig) {
    const lineStart = out.lastIndexOf('\n', signing.close) + 1
    out = out.slice(0, lineStart) + RELEASE_CONFIG + out.slice(lineStart)
  }
  return out
}

module.exports = { applyReleaseSigning }

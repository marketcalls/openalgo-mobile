#!/usr/bin/env bash
# Phone-width web preview of the app (dev only, 0 B in any release bundle), with each DOM page
# (the chart, the tools) in an iframe running the exact www.bundle page the APK ships, against the
# mock server. It never writes to the working tree: it builds from `git archive $REF` into
# $OUT/src (git-ignored .cache/preview by default) and serves the result.
#
#   npm run preview:web                       # build HEAD, then serve (Ctrl-C stops both)
#   REF=phase1/v0.2.0 npm run preview:web
#   SKIP_BUILD=1 npm run preview:web          # serve the last build again
#   OUT=<scratch dir> npm run preview:web     # build somewhere else
#
# Then open http://127.0.0.1:5097 and onboard once: server http://oa-preview.local:5097 (then
# "I understand"), key `ab` x32, feed ws://oa-preview.local:8799. The mock runs on 5099/8799 and
# never on the real server's ports (5000, 8765). Native chrome under react-native-web is only
# approximate: judge it for content and colour; the DOM pages are the shipped ones.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
REF=${REF:-HEAD}
OUT=${OUT:-$REPO/.cache/preview}
REST_PORT=5099
WS_PORT=8799
PREVIEW_PORT=5097

for p in "$REST_PORT" "$WS_PORT" "$PREVIEW_PORT"; do
  case $p in 5000 | 8765 | 8081) echo "refusing port $p (owner's server or Metro)" >&2; exit 2 ;; esac
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p is in use; stop the old preview first" >&2
    exit 2
  fi
done

if [[ ${SKIP_BUILD:-0} != 1 ]]; then
  echo "== source: $REF -> $OUT/src"
  rm -rf "$OUT"
  mkdir -p "$OUT/src"
  git -C "$REPO" archive "$REF" | tar -x -C "$OUT/src"
  # The extracted frontend (git-ignored; metro.config.js checks it against openalgo.ref).
  cp -R "$REPO/openalgo" "$OUT/src/openalgo"
  ln -s "$REPO/node_modules" "$OUT/src/node_modules"
  # Metro follows the node_modules symlink to the repo, so that folder must be watched too.
  cat >>"$OUT/src/metro.config.js" <<'EOF'
// preview copy only: node_modules is a symlink to the repo's
module.exports.watchFolders = [
  ...(module.exports.watchFolders ?? []),
  require('node:fs').realpathSync(require('node:path').join(__dirname, 'node_modules')),
]
EOF
  if [[ ! -f "$OUT/src/src/dom/bridge/webEntry.web.tsx" ]]; then
    echo "$REF has no src/dom/bridge/webEntry.web.tsx: it predates the web preview" >&2
    exit 2
  fi
  # The DOM pages as they ship: the release tree-shaking flags (package.json export, ci.yml), cold.
  # Without them the preview shows bytes no APK carries (a tree-shaken export once dropped every
  # page's prelude, and the preview did not), so the pages also pass the DOM export check here.
  echo "== export android (for www.bundle, the DOM pages, tree-shaken as they ship)"
  (cd "$OUT/src" && EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 EXPO_UNSTABLE_TREE_SHAKING=1 \
    npx expo export --clear --platform android --output-dir "$OUT/android" >"$OUT/android.log" 2>&1)
  (cd "$OUT/src" && node scripts/check-dom-export.mjs "$OUT/android")
  echo "== export web"
  (cd "$OUT/src" && npx expo export --platform web --output-dir "$OUT/web" >"$OUT/web.log" 2>&1)
  cp -R "$OUT/android/www.bundle" "$OUT/web/www.bundle"
  node "$HERE/dom-manifest.mjs" "$OUT/web"
  if grep -l "connect-src" "$OUT"/web/_expo/static/js/web/*.js >/dev/null 2>&1; then
    echo "WARNING: a DOM entry is bundled inline in the web app (its CSP would block the app)." >&2
    echo "         Import it through an entries.tsx / entries.web.tsx pair (features/tools)." >&2
  fi
fi

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

(cd "$OUT/src" && PORT=$REST_PORT WS_PORT=$WS_PORT HOST=127.0.0.1 node dev/mock-server/main.mjs) &
pids+=($!)
ROOT="$OUT/web" PORT=$PREVIEW_PORT UPSTREAM="http://127.0.0.1:$REST_PORT" node "$HERE/serve.mjs" &
pids+=($!)
echo "== onboarding: server http://oa-preview.local:$PREVIEW_PORT, key ab x32, feed ws://oa-preview.local:$WS_PORT"
wait

// Import boundaries (design 7.4). Paths are matched as (?:^|/)src/... so the same rules run on
// the real src and on test/fixtures/boundaries/src.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const SRC = '(?:^|/)src/'
const RN = '(react-native|@react-native[^/]*|expo-[^/]+)'
// WebView content (design 7.7): what runs inside a DOM page.
const DOM_CONTENT = `${SRC}dom/(chart|tools|web)/`
// What native may import from a DOM folder: its 'use dom' entry, e.g. dom/chart/ChartDom.tsx.
const DOM_ENTRY = `${SRC}dom/(chart|tools)/[A-Z][A-Za-z]*Dom\\.tsx$`
// The pinned web frontend (./openalgo, `@/`). Its own src/ matches SRC too.
const FRONTEND = '(?:^|/)openalgo/frontend/src/'

// Packages a DOM page cannot run. By name: react-native*, @react-native*/*, expo-*, @expo/*.
// By need, whatever the name (e.g. @shopify/flash-list, expo itself): every package.json
// dependency whose own package.json needs react-native or expo, as a dependency or as a peer that
// is not optional. Universal packages (react, react-dom, zod, openalgo-charts) need neither.
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
const needsNative = (pkg) =>
  ['react-native', 'expo'].some(
    (name) =>
      pkg.dependencies?.[name] ||
      (pkg.peerDependencies?.[name] && !pkg.peerDependenciesMeta?.[name]?.optional),
  )
const NATIVE_FAMILIES = [
  'react-native[^/]*',
  '@react-native[^/]*/[^/]+',
  'expo-[^/]+',
  '@expo/[^/]+',
]
const inFamily = new RegExp(`^(${NATIVE_FAMILIES.join('|')})$`)
const app = readJson(join(__dirname, 'package.json'))
const NATIVE_DEPS = Object.keys({ ...app.dependencies, ...app.devDependencies })
  .filter((name) => !inFamily.test(name))
  .filter((name) => needsNative(readJson(join(__dirname, 'node_modules', name, 'package.json'))))
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const NATIVE_PACKAGES = `(?:^|/)node_modules/(${[...NATIVE_FAMILIES, ...NATIVE_DEPS].join('|')})/`
// expo/dom (and expo/dom/global, /internal, /entry) is the DOM page's own API.
const EXPO_DOM = '(?:^|/)node_modules/expo/(build/)?dom/'

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-feature',
      severity: 'error',
      comment: "A feature may import another feature's index.ts only, never its internals.",
      from: { path: `${SRC}features/([^/]+)/` },
      to: {
        path: `${SRC}features/[^/]+/`,
        pathNot: [`${SRC}features/$1/`, `${SRC}features/[^/]+/index\\.tsx?$`],
      },
    },
    {
      name: 'core-no-features',
      severity: 'error',
      comment: 'core cannot depend on features, app or ui.',
      from: { path: `${SRC}core/` },
      to: { path: `${SRC}(features|app|ui)/` },
    },
    {
      name: 'market-no-features',
      severity: 'error',
      comment: 'The shared trading logic cannot depend on features or app.',
      from: { path: `${SRC}market/` },
      to: { path: `${SRC}(features|app)/` },
    },
    {
      name: 'dom-content-no-secrets',
      severity: 'error',
      comment:
        'WebView content never sees the key, the HTTP client, the server config, the socket or ' +
        'the gateway.',
      from: { path: DOM_CONTENT },
      to: {
        path: [
          `${SRC}core/(credentials|http)/`,
          `${SRC}dom/gateway/`,
          `${SRC}core/(config|realtime)/`,
        ],
      },
    },
    {
      name: 'dom-content-no-secrets-reachable',
      severity: 'error',
      comment:
        'Nor through any chain of imports: WebView content never reaches the key, the HTTP client, ' +
        'the server config, the socket, the services container or the gateway.',
      from: { path: DOM_CONTENT },
      to: {
        reachable: true,
        path: [
          `${SRC}core/(credentials|http|services)/`,
          `${SRC}dom/gateway/`,
          `${SRC}core/(config|realtime)/`,
        ],
      },
    },
    {
      name: 'dom-content-allowlist',
      severity: 'error',
      comment:
        'WebView content imports only its own folder, dom/web, the bridge protocol and the tokens ' +
        '(packages are checked by dom-content-no-native-packages; the protocol and the tokens ' +
        'import nothing at run time, by their own rules).',
      from: { path: DOM_CONTENT },
      to: {
        path: SRC,
        pathNot: [
          `${SRC}dom/$1/`,
          `${SRC}dom/web/`,
          `${SRC}dom/bridge/protocol\\.ts$`,
          `${SRC}ui/tokens\\.ts$`,
          // a package's own src/ folder is not ours, nor is the frontend's (see
          // frontend-runtime-in-dom-tools)
          '(?:^|/)node_modules/',
          FRONTEND,
        ],
      },
    },
    {
      name: 'dom-content-no-native-packages',
      severity: 'error',
      comment:
        'WebView content runs in a browser: no React Native or Expo package (react-native*, ' +
        '@react-native*/*, expo-*, @expo/*, or any dependency that needs react-native or expo). ' +
        'expo/dom is the exception.',
      from: { path: DOM_CONTENT },
      to: { path: NATIVE_PACKAGES, pathNot: EXPO_DOM },
    },
    {
      name: 'dom-protocol-no-runtime-imports',
      severity: 'error',
      comment:
        'Every DOM page loads the bridge protocol, and the DOM rules check only their own imports, ' +
        'so the protocol imports nothing at run time: no zod (that is dom/bridge/schemas.ts, native ' +
        'only), no package, no other module. An import type is erased, so it stays allowed.',
      from: { path: `${SRC}dom/bridge/protocol\\.ts$` },
      to: { dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'ui-tokens-no-runtime-imports',
      severity: 'error',
      comment:
        'DOM pages load the theme tokens too, so tokens.ts imports nothing at run time (an import ' +
        'type stays allowed).',
      from: { path: `${SRC}ui/tokens\\.ts$` },
      to: { dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'dom-entries-only',
      severity: 'error',
      comment: "Native code imports a DOM folder only through its 'use dom' entry (*Dom.tsx).",
      from: { pathNot: DOM_CONTENT },
      to: { path: DOM_CONTENT, pathNot: DOM_ENTRY },
    },
    {
      name: 'dom-no-dynamic-import',
      severity: 'error',
      comment:
        'No import() in WebView content: an Expo DOM page cannot load a lazy chunk, so every ' +
        'chunk is imported eagerly.',
      from: { path: DOM_CONTENT },
      to: { dynamic: true },
    },
    {
      name: 'features-dom-bridge-only',
      severity: 'error',
      comment: 'features reach src/dom only through dom/bridge, dom/gateway and the DOM entries.',
      from: { path: `${SRC}features/` },
      to: { path: `${SRC}dom/`, pathNot: [`${SRC}dom/(bridge|gateway)/`, DOM_ENTRY] },
    },
    {
      name: 'core-logic-pure',
      severity: 'error',
      comment:
        'Pure core logic imports no react-native or expo-*, except use* hooks and bindings.ts.',
      from: {
        path: `${SRC}core/(config|log|http|capabilities|realtime|credentials)/`,
        pathNot: ['/use[^/]*\\.tsx?$', '/bindings\\.ts$'],
      },
      to: {
        path: `(?:^|/)node_modules/${RN}/|^${RN}(/|$)`,
      },
    },
    {
      name: 'frontend-runtime-in-dom-tools',
      severity: 'error',
      comment:
        "The web frontend's code runs in a tool DOM page only: a runtime import of it comes from " +
        'dom/tools (market/options is the next rule). An import type is erased, so it stays ' +
        'allowed (frontend-types-in-routes limits dom/routes to the API modules and types).',
      from: { path: SRC, pathNot: [`${SRC}dom/tools/`, `${SRC}market/options/`] },
      to: { path: FRONTEND, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'frontend-runtime-in-dom-tools',
      severity: 'error',
      comment:
        "market/options runs the web's Black-76 engine (lib/optionGreeks.ts) on every tick, and " +
        'nothing else of the frontend.',
      from: { path: `${SRC}market/options/` },
      to: {
        path: FRONTEND,
        pathNot: `${FRONTEND}lib/optionGreeks\\.ts$`,
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'frontend-types-in-routes',
      severity: 'error',
      comment:
        "The device routes are typed by the web's API modules and types, and import them as types " +
        'only: their runtime (the axios client, the session) never runs on the phone.',
      from: { path: `${SRC}dom/routes/` },
      to: { path: `${FRONTEND}(api|types)/`, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'warn',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // the frontend's own imports are its business: they are never cruised
    doNotFollow: { path: ['node_modules', '^openalgo/'] },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    // Resolve subpaths through package `exports`, as Metro and tsc do (expo-router/native-tabs).
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}

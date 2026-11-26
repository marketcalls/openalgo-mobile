// Import boundaries (design 7.4). Paths are matched as (?:^|/)src/... so the same rules run on
// the real src and on test/fixtures/boundaries/src.
const SRC = '(?:^|/)src/'
const RN = '(react-native|@react-native[^/]*|expo-[^/]+)'
// WebView content (design 7.7): what runs inside a DOM page.
const DOM_CONTENT = `${SRC}dom/(chart|tools|web)/`
// What native may import from a DOM folder: its 'use dom' entry, e.g. dom/chart/ChartDom.tsx.
const DOM_ENTRY = `${SRC}dom/(chart|tools)/[A-Z][A-Za-z]*Dom\\.tsx$`

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
        '(packages are checked by dom-content-no-native-packages).',
      from: { path: DOM_CONTENT },
      to: {
        path: SRC,
        pathNot: [
          `${SRC}dom/$1/`,
          `${SRC}dom/web/`,
          `${SRC}dom/bridge/protocol\\.ts$`,
          `${SRC}ui/tokens\\.ts$`,
          // a package's own src/ folder is not ours
          '(?:^|/)node_modules/',
        ],
      },
    },
    {
      name: 'dom-content-no-native-packages',
      severity: 'error',
      comment: 'WebView content runs in a browser: no react-native or expo-* package.',
      from: { path: DOM_CONTENT },
      to: {
        path: '(?:^|/)node_modules/(react-native[^/]*|@react-native[^/]*|expo-[^/]+|@react-native-async-storage|@react-native-community)/',
      },
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
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    // Resolve subpaths through package `exports`, as Metro and tsc do (expo-router/native-tabs).
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}

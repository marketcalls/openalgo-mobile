// Import boundaries (design 7.4). Paths are matched as (?:^|/)src/... so the same rules run on
// the real src and on test/fixtures/boundaries/src.
const SRC = '(?:^|/)src/'
const RN = '(react-native|@react-native[^/]*|expo-[^/]+)'

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
      name: 'dom-content-no-secrets',
      severity: 'error',
      comment: 'WebView content never sees the key, the HTTP client or the gateway.',
      from: { path: `${SRC}dom/(chart|tools)/` },
      to: { path: [`${SRC}core/(credentials|http)/`, `${SRC}dom/gateway/`] },
    },
    {
      name: 'dom-content-no-secrets-reachable',
      severity: 'error',
      comment:
        'Nor through any chain of imports: WebView content never reaches the key, the HTTP client ' +
        '(and so no socket), the services container or the gateway.',
      from: { path: `${SRC}dom/(chart|tools)/` },
      to: {
        reachable: true,
        path: [`${SRC}core/(credentials|http|services)/`, `${SRC}dom/gateway/`],
      },
    },
    {
      name: 'features-dom-bridge-only',
      severity: 'error',
      comment: 'features reach src/dom only through dom/bridge.',
      from: { path: `${SRC}features/` },
      to: { path: `${SRC}dom/`, pathNot: `${SRC}dom/bridge(/|\\.|$)` },
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

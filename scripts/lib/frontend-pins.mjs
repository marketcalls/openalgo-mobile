// The packages a tool DOM page loads from the app's node_modules (design 7.7), each pinned
// exactly to the version the web frontend locks: frontend/package-lock.json at openalgo.ref.
// react, react-dom, @tanstack/react-query and zustand are not here: they come from the app.
export const TOOL_PACKAGES = [
  '@radix-ui/react-checkbox',
  '@radix-ui/react-dialog',
  '@radix-ui/react-label',
  '@radix-ui/react-popover',
  '@radix-ui/react-select',
  '@radix-ui/react-slot',
  '@radix-ui/react-switch',
  '@radix-ui/react-tabs',
  '@radix-ui/react-tooltip',
  'axios',
  'class-variance-authority',
  'clsx',
  'cmdk',
  'html2canvas-pro',
  'lucide-react',
  'plotly.js',
  'react-plotly.js',
  'react-router',
  'sonner',
  'tailwind-merge',
  'tw-animate-css',
  '@tailwindcss/postcss',
]

/** { name: version } for `names`, as installed by the frontend's lockfile (text). */
export function frontendVersions(lockText, names) {
  const { packages = {} } = JSON.parse(lockText)
  const out = {}
  for (const name of names) {
    const version = packages[`node_modules/${name}`]?.version
    if (!version) throw new Error(`${name} is not in the frontend lockfile`)
    out[name] = version
  }
  return out
}

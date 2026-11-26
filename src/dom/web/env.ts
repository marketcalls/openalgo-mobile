// Gives Vite-style `import.meta.env` a value inside a DOM bundle (design 7.7; port of the spike's
// spike/app/src/dom/tool/env.ts).
//
// babel-preset-expo rewrites every `import.meta` to `globalThis.__ExpoImportMetaRegistry`
// (import-meta-transform-plugin.js), and Expo's registry has only `url`, so web code that reads
// `import.meta.env.X` while it first evaluates would throw. The prelude seeds it before any such
// module loads. `__ExpoImportMetaRegistry` is an Expo internal name.

export const VITE_ENV = {
  MODE: 'production',
  DEV: false,
  PROD: true,
  SSR: false,
  BASE_URL: '/',
  // Empty: same-origin relative URLs, as the web build uses. The bridged fetch answers them.
  VITE_API_URL: '',
}

type Registry = { env?: Record<string, unknown> } & Record<string, unknown>
type Host = { __ExpoImportMetaRegistry?: Registry; location?: { href?: string } }

/** Seeds `import.meta.env` on `g`'s registry, keeping an env already there. `preexisting` says
 *  whether Expo's runtime had installed the registry. */
export function seedImportMetaEnv(
  g: object = globalThis,
  env: Record<string, unknown> = VITE_ENV,
): { preexisting: boolean } {
  const host = g as Host
  const registry = host.__ExpoImportMetaRegistry
  if (typeof registry === 'object' && registry !== null) {
    registry.env ??= { ...env }
    return { preexisting: true }
  }
  host.__ExpoImportMetaRegistry = { url: host.location?.href ?? '', env: { ...env } }
  return { preexisting: false }
}

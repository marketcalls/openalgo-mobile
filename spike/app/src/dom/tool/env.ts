// THROWAWAY SPIKE. Gives the frontend's Vite-style `import.meta.env` a value inside the DOM bundle, so api/client.ts loads unchanged (no shim).
//
// babel-preset-expo rewrites every `import.meta` to `globalThis.__ExpoImportMetaRegistry`
// (see node_modules/babel-preset-expo/build/plugins/import-meta-transform-plugin.js).
// That object only has `url`, so `import.meta.env.VITE_API_URL` in
// frontend/src/api/client.ts would throw "Cannot read properties of undefined"
// while the module is first evaluated. This file must therefore be imported
// BEFORE anything that pulls in '@/api/client' (ToolDom.tsx imports it first).
// It relies on an Expo internal name; the real app should prefer a build-time
// define or a one-character frontend change (`import.meta.env?.VITE_API_URL`).

const VITE_ENV = {
  MODE: 'production',
  DEV: false,
  PROD: true,
  SSR: false,
  BASE_URL: '/',
  // Empty = same-origin relative URLs, exactly what the web build uses. The
  // spike's transport interceptor answers those; a real app would put the
  // user's OpenAlgo server URL here or rewrite URLs in the transport.
  VITE_API_URL: '',
};

type Registry = { env?: Record<string, unknown> } & Record<string, unknown>;
const g = globalThis as unknown as { __ExpoImportMetaRegistry?: Registry };

/** Whether Expo's runtime had already installed the registry (reported in results). */
export const importMetaRegistryPreexisting =
  !!g.__ExpoImportMetaRegistry && typeof g.__ExpoImportMetaRegistry === 'object';

if (importMetaRegistryPreexisting) {
  g.__ExpoImportMetaRegistry!.env ??= { ...VITE_ENV };
} else {
  g.__ExpoImportMetaRegistry = { url: typeof location !== 'undefined' ? location.href : '', env: { ...VITE_ENV } };
}

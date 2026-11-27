// The web frontend reads Vite's import.meta.env (its API base URL and build mode). Frontend files
// that tsc checks, such as the API modules the routes import types from, need it declared.
interface ImportMetaEnv {
  VITE_API_URL?: string
  DEV: boolean
  PROD: boolean
  MODE: string
}

interface ImportMeta {
  env: ImportMetaEnv
}

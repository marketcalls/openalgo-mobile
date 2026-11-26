// Side effects only. Every 'use dom' entry imports this first, so `import.meta.env` is seeded and
// the CSP is in force before any other module of the page evaluates.
import { installCsp } from './csp'
import { seedImportMetaEnv } from './env'

seedImportMetaEnv()
installCsp(document, __DEV__)

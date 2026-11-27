// Every 'use dom' entry imports this first, so `import.meta.env` is seeded and the CSP is in force
// before any other module of the page evaluates.
//
// The entry imports PRELUDE by name and uses it, never as a bare `import '…/prelude'`. Expo 58.1's
// tree shaking (EXPO_UNSTABLE_TREE_SHAKING, on for `npm run export` and every CI build) drops a bare
// import whose module no package.json marks as having side effects, in any module whose first
// import names a binding (treeShakeSerializerPlugin.js keeps the first import's specifier count in
// the traversal's shared opts), and the React Compiler puts `import { c } from
// 'react/compiler-runtime'` first in every entry. The bare import shipped every page with no CSP
// and no env, and the frontend's api/client threw at load. A used binding is kept; the export
// check (scripts/check-dom-export.mjs) finds the policy, the env seed and this literal in each
// exported page, and loads each page in jsdom.
import { installCsp } from './csp'
import { seedImportMetaEnv } from './env'

seedImportMetaEnv()
installCsp(document, __DEV__)

/** The literal the entry writes to `<html data-oa-prelude>`, and the export check finds. */
export const PRELUDE = 'oa-prelude:csp+env'

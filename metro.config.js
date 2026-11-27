// Metro resolves the pinned web frontend for the tool DOM pages (design 7.7): `@/x` is
// openalgo/frontend/src/x (the frontend's own alias) and `~/x` is the app's src/x. Frontend files
// find their packages in the app's node_modules, since ./openalgo has none.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { frontendDirOk } = require('./scripts/openalgo-src.mjs')

const root = __dirname
const frontendSrc = path.join(root, 'openalgo', 'frontend', 'src')
const appSrc = path.join(root, 'src')

const frontend = frontendDirOk(root)
if (!frontend.ok) {
  throw new Error(
    `openalgo/ is missing or not at openalgo.ref: run npm run sync-openalgo -- --extract (${frontend.reason})`,
  )
}

const config = getDefaultConfig(root)

config.watchFolders = [...(config.watchFolders ?? []), frontendSrc]
config.resolver.nodeModulesPaths = [path.join(root, 'node_modules')]

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest
  if (moduleName.startsWith('@/')) {
    return resolve(context, path.join(frontendSrc, moduleName.slice(2)), platform)
  }
  if (moduleName.startsWith('~/')) {
    return resolve(context, path.join(appSrc, moduleName.slice(2)), platform)
  }
  return resolve(context, moduleName, platform)
}

module.exports = config

// THROWAWAY SPIKE. Metro config that lets DOM components import the OpenAlgo web
// frontend's source directly, the way the real app would share code.
//
// - '@/x' resolves to openalgo/frontend/src/x (the frontend's own alias).
// - '~/x' resolves to this app's src/x. Implemented here, not through Expo's
//   tsconfig-paths support (app.json sets experiments.tsconfigPaths: false), because
//   tsconfig.json also maps a few package names to .d.ts files so tsc can type the
//   frontend's files, and Metro must never resolve those as runtime modules.
// - Files under frontend/src find packages in THIS app's node_modules, because
//   the frontend has no node_modules installed.
// - shims.*.json maps a frontend module ('@/api/client') to a local replacement.
//   Every entry there is a change the real app would have to make or abstract;
//   the spike records each one in CHANGES.md.
const path = require('node:path');
const fs = require('node:fs');
const { getDefaultConfig } = require('expo/metro-config');

const APP = __dirname;
const FRONTEND_SRC = path.resolve(APP, '../../../openalgo/frontend/src');
const APP_SRC = path.join(APP, 'src');

const config = getDefaultConfig(APP);

function loadShims() {
  const out = {};
  for (const f of fs.readdirSync(APP).filter((n) => /^shims\..+\.json$/.test(n))) {
    Object.assign(out, JSON.parse(fs.readFileSync(path.join(APP, f), 'utf8')));
  }
  return out;
}
const SHIMS = loadShims();

config.watchFolders = [...(config.watchFolders || []), FRONTEND_SRC];
config.resolver.nodeModulesPaths = [path.join(APP, 'node_modules')];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream || context.resolveRequest;
  if (SHIMS[moduleName]) {
    return resolve(context, path.join(APP, SHIMS[moduleName]), platform);
  }
  if (moduleName.startsWith('@/')) {
    return resolve(context, path.join(FRONTEND_SRC, moduleName.slice(2)), platform);
  }
  if (moduleName.startsWith('~/')) {
    return resolve(context, path.join(APP_SRC, moduleName.slice(2)), platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;

const { withAppBuildGradle } = require('expo/config-plugins')
const { applyReleaseSigning } = require('./releaseSigning')

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = applyReleaseSigning(c.modResults.contents)
    return c
  })
}

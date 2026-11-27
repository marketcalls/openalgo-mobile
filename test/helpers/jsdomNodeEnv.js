// jsdom with Node's network stack, for the compat tests that render a tool page and also run the
// app's own services over the mock: jsdom has no fetch, and a fetch that is Node's takes Node's
// AbortSignal, so those come across together.
const { TestEnvironment } = require('jest-environment-jsdom')

class JsdomNodeEnvironment extends TestEnvironment {
  async setup() {
    await super.setup()
    Object.assign(this.global, {
      fetch,
      Headers,
      Request,
      Response,
      AbortController,
      AbortSignal,
      TextEncoder,
      TextDecoder,
      structuredClone,
    })
  }
}

module.exports = JsdomNodeEnvironment

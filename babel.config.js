// babel-preset-expo is nested under expo, so resolve it from there.
const expoPreset = require.resolve('babel-preset-expo', {
  paths: [require.resolve('expo/package.json')],
})

module.exports = {
  presets: [
    [
      expoPreset,
      // The React Compiler (app.config.ts experiments.reactCompiler) compiles app code only: the
      // web build does not compile the frontend's pages, so neither does the app.
      { 'react-compiler': { sources: (f) => !/\/openalgo\/frontend\//.test(f) } },
    ],
  ],
}

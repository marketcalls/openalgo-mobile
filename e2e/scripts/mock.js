// Maestro script: patches the mock server's controls. Pass the JSON patch as env CONTROL, for
// example `- runScript: {file: scripts/mock.js, env: {CONTROL: '{"analyzer":true}'}}`.
// MOCK is the mock's origin as the host sees it (the emulator's 10.0.2.2 is for the app, not
// for this script, which runs on the runner).
const origin = typeof MOCK === 'undefined' || MOCK === '' ? 'http://localhost:5000' : MOCK
const res = http.post(`${origin}/__mock/control`, {
  headers: { 'Content-Type': 'application/json' },
  body: CONTROL,
})
if (!res.ok) {
  throw new Error(`mock control ${CONTROL} failed: ${res.status} ${res.body}`)
}

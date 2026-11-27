// Whether the page can draw WebGL (design 7.8: Vol Surface's Plotly 3D needs it), for the tool
// page's ready event. The probe's context is let go at once: a WebView keeps only a few alive.
export function probeWebGl(doc: Document): boolean {
  try {
    const gl = doc.createElement('canvas').getContext('webgl')
    if (gl === null) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

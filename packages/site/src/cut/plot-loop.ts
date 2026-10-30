export function playPlot(canvas: HTMLCanvasElement, src: string, reduced: boolean): void {
  const out = canvas.getContext('bitmaprenderer')
  if (!out || typeof OffscreenCanvas === 'undefined') return
  const worker = new Worker(new URL('./plot-worker.ts', import.meta.url), { type: 'module' })
  void fetch(src).then((r) => r.text()).then((json) => { worker.postMessage({ json, font: '/fonts/jetbrains-mono-500-normal.woff2' }) })
  const TOTAL = 360
  let pending = false
  let on = false
  let t0 = performance.now()
  let last = -1
  const want = () => (reduced ? TOTAL - 1 : Math.floor(((performance.now() - t0) / 1000) * 30) % TOTAL)
  const ask = () => {
    const frame = want()
    if (pending || frame === last) return
    pending = true
    worker.postMessage({ frame, w: Math.min(2400, Math.round(canvas.clientWidth * Math.min(2, devicePixelRatio || 1))) })
  }
  worker.onmessage = (e: MessageEvent<{ frame: number; bitmap: ImageBitmap }>) => {
    pending = false
    last = e.data.frame
    canvas.width = e.data.bitmap.width
    canvas.height = e.data.bitmap.height
    out.transferFromImageBitmap(e.data.bitmap)
    canvas.dataset.on = ''
  }
  const tick = () => {
    if (!on) return
    ask()
    requestAnimationFrame(tick)
  }
  new IntersectionObserver(([e]) => {
    const was = on
    on = e?.isIntersecting ?? false
    if (on && !was) { t0 = performance.now() - Math.max(0, last) * (1000 / 30); requestAnimationFrame(tick) }
  }).observe(canvas)
}

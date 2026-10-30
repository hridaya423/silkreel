import { beforeEach } from 'vitest'

class RecordedPath2D {
  readonly ops: Array<{ op: string; args: number[] }> = []

  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'moveTo', args: [x, y] })
  }

  lineTo(x: number, y: number): void {
    this.ops.push({ op: 'lineTo', args: [x, y] })
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.ops.push({ op: 'quadraticCurveTo', args: [cpx, cpy, x, y] })
  }

  arc(x: number, y: number, r: number, start: number, end: number): void {
    this.ops.push({ op: 'arc', args: [x, y, r, start, end] })
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'rect', args: [x, y, w, h] })
  }

  closePath(): void {
    this.ops.push({ op: 'closePath', args: [] })
  }
}

interface RecordedCall {
  method: string
  args: unknown[]
}

export class RecordingCtx {
  readonly calls: RecordedCall[] = []
  readonly props: Record<string, unknown> = {}
  readonly canvas: { width: number; height: number }

  constructor(width = 1080, height = 1350) {
    this.canvas = { width, height }
  }

  set(method: string, value: unknown): void {
    this.props[method] = value
    this.calls.push({ method: `set:${method}`, args: [value] })
  }

  private forward(method: string): (...args: unknown[]) => void {
    return (...args: unknown[]): void => {
      this.calls.push({ method, args })
    }
  }

  reset(): void {
    this.calls.length = 0
    for (const key of Object.keys(this.props)) {
      this.props[key] = undefined
    }
  }

  install(target: Record<string, unknown>): void {
    const methods = [
      'setTransform', 'fillRect', 'clearRect', 'save', 'restore',
      'translate', 'scale', 'rotate',
      'stroke', 'fill', 'fillText', 'strokeText',
      'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'arc', 'rect', 'roundRect',
      'setLineDash', 'drawImage', 'clip'
    ]
    for (const m of methods) target[m] = this.forward(m)
    target.createLinearGradient = (): { addColorStop: (offset: number, color: string) => void } => ({
      addColorStop: (offset: number, color: string) => {
        this.calls.push({ method: 'gradient-stop', args: [offset, color] })
      }
    })
    target.createRadialGradient = (): { addColorStop: (offset: number, color: string) => void } => ({
      addColorStop: (offset: number, color: string) => {
        this.calls.push({ method: 'gradient-stop', args: [offset, color] })
      }
    })
    const props = ['fillStyle', 'strokeStyle', 'shadowColor', 'shadowBlur', 'globalAlpha', 'lineWidth', 'lineCap', 'lineJoin', 'font', 'textAlign', 'textBaseline', 'filter', 'globalCompositeOperation']
    for (const p of props) {
      Object.defineProperty(target, p, {
        get: () => this.props[p],
        set: (v: unknown) => {
          this.set(p, v)
        },
        configurable: true
      })
    }
    target.getImageData = (): { data: Uint8ClampedArray; width: number; height: number } => ({
      data: new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4),
      width: this.canvas.width,
      height: this.canvas.height
    })
    target.putImageData = this.forward('putImageData')
    target.getTransform = (): { a: number } => ({ a: 1 })
  }
}

beforeEach(() => {
  const existing = (globalThis as { __recordingCtx?: RecordingCtx }).__recordingCtx
  const rec = existing ?? new RecordingCtx()
  ;(globalThis as { __recordingCtx?: RecordingCtx }).__recordingCtx = rec
  rec.reset()
  ;(globalThis as unknown as { Path2D: unknown }).Path2D = RecordedPath2D
})

export function currentRecorder(): RecordingCtx {
  const rec = (globalThis as { __recordingCtx?: RecordingCtx }).__recordingCtx
  if (!rec) throw new Error('recorder missing')
  return rec
}

export function asCtx(rec: RecordingCtx): CanvasRenderingContext2D {
  const obj: Record<string, unknown> = {}
  rec.install(obj)
  return obj as unknown as CanvasRenderingContext2D
}

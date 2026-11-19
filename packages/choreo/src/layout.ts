import type { BBox, Vec2 } from '@silk-reel/ingest'
import type { Aspect } from './types'

export const ASPECT_SIZE: Record<Aspect, { width: number; height: number }> = {
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 }
}

export interface Rect { x: number; y: number; w: number; h: number }

/** margins keep clear of platform UI (9:16 has top/bottom chrome); a title reserves the bottom band */
export function safeArea(width: number, height: number, hasTitle: boolean): Rect {
  const tall = height / width > 1.6
  const mx = width * (width > height ? 0.08 : 0.07)
  const top = height * (tall ? 0.12 : 0.08)
  const bottom = height * (tall ? 0.14 : 0.08) + (hasTitle ? height * 0.1 : 0)
  return { x: mx, y: top, w: width - 2 * mx, h: height - top - bottom }
}

export interface BoardFit {
  scale: number   // px per mm
  rotated: boolean
  map: (p: Vec2) => Vec2
}

/** fill the safe area; rotate 90° when that fills it markedly better, unless `turn` is false */
export function fitBoard(bbox: BBox, width: number, height: number, hasTitle: boolean, turn = true): BoardFit {
  const a = safeArea(width, height, hasTitle)
  const bw = Math.max(1e-6, bbox.max.x - bbox.min.x)
  const bh = Math.max(1e-6, bbox.max.y - bbox.min.y)
  const straight = Math.min(a.w / bw, a.h / bh)
  const turned = Math.min(a.w / bh, a.h / bw)
  const rotated = turn && turned > straight * 1.15
  const scale = rotated ? turned : straight
  const bcx = (bbox.min.x + bbox.max.x) / 2
  const bcy = (bbox.min.y + bbox.max.y) / 2
  const cx = a.x + a.w / 2
  const cy = a.y + a.h / 2
  const map = (p: Vec2): Vec2 => {
    const dx = p.x - bcx
    const dy = p.y - bcy
    return rotated ? { x: cx - dy * scale, y: cy + dx * scale } : { x: cx + dx * scale, y: cy + dy * scale }
  }
  return { scale, rotated, map }
}

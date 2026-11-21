import React from 'react'
import { Composition, registerRoot, getInputProps } from 'remotion'
import type { Timeline } from '@silk-reel/choreo'
import { Film } from './FilmComponent'
import { filmFrames } from './end-card'
import type { RenderQuality } from './FilmComponent'

export interface FilmInputProps {
  timeline: Timeline
  /** film grain in the post pass (off for GIF: per-frame noise defeats palette compression) */
  grain?: boolean
  /** trace render quality: 'final' (default) or 'draft' */
  quality?: RenderQuality
  /** final trace renders: accumulation samples per frame */
  samples?: number
  /** look tests: tone curve and studio */
  look?: { tonemap?: 'aces' | 'neutral' | 'agx'; studio?: 'dark' | 'high' }
  /** trace only: render the board-and-parts matte instead of the picture */
  matte?: boolean
}

function readInputProps(source: unknown): FilmInputProps {
  const props = source as Partial<FilmInputProps> | undefined
  if (!props?.timeline) {
    throw new Error('remotion-entry requires inputProps { timeline }')
  }
  return {
    timeline: props.timeline,
    ...(props.grain !== undefined ? { grain: props.grain } : {}),
    ...(props.quality !== undefined ? { quality: props.quality } : {}),
    ...(props.samples !== undefined ? { samples: props.samples } : {}),
    ...(props.look !== undefined ? { look: props.look } : {}),
    ...(props.matte !== undefined ? { matte: props.matte } : {})
  }
}

const EntryFilm: React.FC<Record<string, unknown>> = (props) => {
  const { timeline, grain, quality, samples, look, matte } = readInputProps(props)
  return <Film timeline={timeline} grain={grain ?? true} {...(quality !== undefined ? { quality } : {})} {...(samples !== undefined ? { samples } : {})} {...(look !== undefined ? { look } : {})} {...(matte !== undefined ? { matte } : {})} />
}

const Root: React.FC = () => {
  const defaultProps = readInputProps(getInputProps())
  return (
    <Composition
      id="film"
      component={EntryFilm}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => {
        const { timeline } = readInputProps(props)
        return {
          durationInFrames: filmFrames(timeline),
          fps: timeline.fps,
          width: timeline.width,
          height: timeline.height
        }
      }}
    />
  )
}

registerRoot(Root)

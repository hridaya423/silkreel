import React, { useCallback, useMemo, useState } from 'react'
import { heroChoices, heroPart, MASK_COLORS, TRACE_ACTS } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, MaskColor, PaletteId, StyleId, Timeline } from '@silk-reel/choreo'
import { Film } from '@silk-reel/render'
import { Player } from '@remotion/player'
import type { PlayerRef } from '@remotion/player'
import type { BoardModel } from '@silk-reel/ingest'
import './workspace.css'
import { ASPECTS, castHints, compileStudioFilm, DEFAULT_KNOBS, DEMO_BOARDS, FORMATS, KNOB_RANGES, PALETTE_LIST, STYLES, studioFilmConfig } from './film-config'
import type { ExportFormat, StudioKnobs } from './film-config'
import { cancelJob, downloadUrl, pollJob, submitExport, summarize, useBoardSources, useDebouncedCallback, useDemoOutlines, useRenderApi } from './api'
import type { BoardSummary, DemoOutlines, ExportJob } from './api'

type Screen = 'landing' | 'workspace'

type CompiledFilm = ReturnType<typeof compileStudioFilm>

type ExportState =
  | { status: 'submitting' }
  | { status: 'rendering'; job: ExportJob }
  | { status: 'completed'; job: ExportJob }
  | { status: 'cancelled' }
  | { status: 'failed'; job: ExportJob | null; error: string }

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function stateForExportJob(job: ExportJob): ExportState {
  if (job.status === 'done') return { status: 'completed', job }
  if (job.status === 'error') return { status: 'failed', job, error: job.error ?? 'render failed' }
  if (job.status === 'cancelled') return { status: 'cancelled' }
  return { status: 'rendering', job }
}

export const StudioApp: React.FC = () => {
  const [screen, setScreen] = useState<Screen>('landing')
  const [summary, setSummary] = useState<BoardSummary | null>(null)
  const [knobs, setKnobs] = useState<StudioKnobs>(DEFAULT_KNOBS)
  const [seed, setSeed] = useState(42)
  const [duration, setDuration] = useState<'auto' | number>('auto')
  const [look, setLook] = useState<Look>(DEFAULT_LOOK)
  const [format, setFormat] = useState<ExportFormat>('mp4')
  const [film, setFilm] = useState<CompiledFilm | null>(null)
  const [compileError, setCompileError] = useState<string | null>(null)
  const [compileStale, setCompileStale] = useState(false)
  const [exportState, setExportState] = useState<ExportState | null>(null)
  const exportControllerRef = React.useRef<AbortController | null>(null)
  const exportJobIdRef = React.useRef<string | null>(null)
  const exportInFlightRef = React.useRef(false)
  const sources = useBoardSources()
  const outlines = useDemoOutlines()
  const apiUp = useRenderApi()

  const cancelExport = useCallback(async (showResult: boolean) => {
    const jobId = exportJobIdRef.current
    exportControllerRef.current?.abort()
    exportControllerRef.current = null
    exportJobIdRef.current = null
    exportInFlightRef.current = false
    if (showResult) setExportState({ status: 'cancelled' })
    if (jobId === null) {
      return
    }
    try {
      await cancelJob(jobId)
    } catch (error) {
      if (showResult) {
        setExportState({ status: 'failed', job: null, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }, [])

  React.useEffect(() => () => {
    void cancelExport(false)
  }, [cancelExport])

  const openBoard = useCallback((board: BoardModel, fileName: string) => {
    void cancelExport(false)
    setSummary(summarize(board, fileName))
    setKnobs(DEFAULT_KNOBS)
    setSeed(42)
    setDuration('auto')
    setLook(DEFAULT_LOOK)
    setFilm(null)
    setCompileError(null)
    setCompileStale(true)
    setExportState(null)
    setScreen('workspace')
  }, [cancelExport])

  const config: FilmConfig = useMemo(
    () => studioFilmConfig({ ...look, knobs, seed, duration }),
    [look, knobs, seed, duration]
  )

  React.useEffect(() => {
    if (!exportInFlightRef.current) setExportState(null)
  }, [config, format])

  const recompile = useCallback(() => {
    if (!summary) return
    try {
      setFilm(compileStudioFilm(summary.board, config))
      setCompileError(null)
      setCompileStale(false)
    } catch (err) {
      setFilm(null)
      setCompileError(err instanceof Error ? err.message : String(err))
      setCompileStale(false)
    }
  }, [summary, config])

  const debouncedRecompile = useDebouncedCallback(recompile, 250)

  React.useEffect(() => {
    if (screen !== 'workspace') return
    setCompileStale(true)
    setCompileError(null)
    debouncedRecompile()
  }, [screen, config, debouncedRecompile])

  const startExport = useCallback(async () => {
    if (!summary || !film || compileStale || exportInFlightRef.current) return
    const controller = new AbortController()
    exportControllerRef.current = controller
    exportInFlightRef.current = true
    setExportState({ status: 'submitting' })
    let currentJob: ExportJob | null = null
    try {
      const jobId = await submitExport({
        boardJson: summary.board,
        filmConfig: film.config,
        format
      }, controller.signal)
      if (exportControllerRef.current !== controller) return
      exportJobIdRef.current = jobId
      currentJob = { jobId, status: 'pending', progress: 0, etaSeconds: null, error: null }
      setExportState({ status: 'rendering', job: currentJob })
      const job = await pollJob(jobId, {
        signal: controller.signal,
        onUpdate: (nextJob) => {
          if (exportControllerRef.current !== controller) return
          currentJob = nextJob
          setExportState(stateForExportJob(nextJob))
        }
      })
      if (exportControllerRef.current === controller) setExportState(stateForExportJob(job))
    } catch (err) {
      if (isAbortError(err) || exportControllerRef.current !== controller) return
      setExportState({
        status: 'failed',
        job: currentJob,
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      if (exportControllerRef.current === controller) {
        exportControllerRef.current = null
        exportJobIdRef.current = null
        exportInFlightRef.current = false
      }
    }
  }, [summary, film, compileStale, format])

  if (screen === 'landing' || !summary) {
    return (
      <Landing
        onDemo={async (id, label) => {
          const board = await sources.loadDemo(id)
          if (board) openBoard(board, label)
        }}
        onFile={async (file) => {
          const board = await sources.parseFile(file)
          if (board) openBoard(board, file.name)
        }}
        loadingDemo={sources.loadingDemo}
        parsingFile={sources.parsingFile}
        error={sources.error}
        onDismissError={sources.clearError}
        outlines={outlines}
      />
    )
  }

  return (
    <Workspace
      summary={summary}
      film={film}
      compileError={compileError}
      compileStale={compileStale}
      knobs={knobs}
      onKnobs={(patch) => {
        setKnobs((prev) => ({ ...prev, ...patch }))
      }}
      seed={seed}
      onSeed={setSeed}
      duration={duration}
      onDuration={setDuration}
      look={look}
      onLook={(patch) => {
        setLook((prev) => ({ ...prev, ...patch }))
      }}
      format={format}
      onFormat={setFormat}
      onHome={() => {
        void cancelExport(false)
        setExportState(null)
        setScreen('landing')
      }}
      exportState={exportState}
      apiUp={apiUp}
      onExport={startExport}
      onCancelExport={() => {
        void cancelExport(true)
      }}
    />
  )
}

const Landing: React.FC<{
  onDemo: (id: string, label: string) => Promise<void>
  onFile: (file: File) => Promise<void>
  loadingDemo: string | null
  parsingFile: boolean
  error: string | null
  onDismissError: () => void
  outlines: DemoOutlines | null
}> = ({ onDemo, onFile, loadingDemo, parsingFile, error, onDismissError, outlines }) => {
  const [dragOver, setDragOver] = useState(false)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const busy = loadingDemo !== null || parsingFile

  return (
    <main className="landing">
      <header className="landing-header">
        <div>
          <span className="landing-kicker">procedural pcb film studio</span>
          <h1 className="wordmark">silk reel</h1>
        </div>
        <p className="tagline">Real board geometry, grown into post-ready release films. The source stays yours.</p>
        <div className="lab-status" aria-label="studio format">
          <span>4:5 · 1:1 · 9:16 · 16:9</span>
          <span>30 fps</span>
          <span>mp4 · gif · alpha</span>
        </div>
      </header>
      <div className="intake-grid">
        <section
          className={`drop-zone${dragOver ? ' drag-over' : ''}`}
          aria-busy={parsingFile}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            if (busy) return
            const file = e.dataTransfer.files[0]
            if (file) void onFile(file)
          }}
        >
          <span className="intake-number">source</span>
          <div className="intake-copy">
            <strong>Load a board</strong>
            <p>Drop a .kicad_pcb</p>
          </div>
          <button className="intake-button" disabled={busy} onClick={() => {
            fileInput.current?.click()
          }}>{parsingFile ? 'parsing…' : 'choose file'}</button>
          <input
            ref={fileInput}
            type="file"
            accept=".kicad_pcb"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onFile(file)
              e.currentTarget.value = ''
            }}
          />
        </section>
        <aside className="format-note" aria-label="supported workflow">
          <span>ingest</span><strong>KiCad PCB</strong>
          <span>film</span><strong>trace growth · glyph loop</strong>
          <span>output</span><strong>MP4 · GIF · WebM/ProRes alpha</strong>
          <p>Gerber import is not supported yet.</p>
        </aside>
      </div>
      {error !== null && (
        <div className="error-strip" role="alert">
          <span>{error}</span>
          <button className="ghost" onClick={onDismissError} aria-label="dismiss error">dismiss</button>
        </div>
      )}
      <div className="demo-heading">
        <span>bench stock</span>
        <span>start from a known board</span>
      </div>
      <section className="demo-grid" aria-label="demo boards">
        {DEMO_BOARDS.map((demo, index) => (
          <button
            key={demo.id}
            className={`demo-card demo-card-${index + 1}`}
            onClick={() => {
              void onDemo(demo.id, demo.label)
            }}
            disabled={busy}
          >
            <span className="demo-index">{String(index + 1).padStart(2, '0')}</span>
            <DemoPlot outline={outlines?.[demo.id]} />
            <span className="demo-label">{demo.label}</span>
            <span className="demo-detail">{loadingDemo === demo.id ? 'loading…' : demo.detail}</span>
            <span className="demo-cta">open →</span>
          </button>
        ))}
      </section>
    </main>
  )
}

const DemoPlot: React.FC<{ outline: DemoOutlines[string] | undefined }> = ({ outline }) => (
  <span className="demo-plot" aria-hidden="true">
    {outline !== undefined && (
      <svg viewBox={`-2 -2 ${outline.w + 4} ${outline.h + 4}`} preserveAspectRatio="xMidYMid meet">
        <path d={outline.d} fill="none" stroke="currentColor" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
        {outline.holes.map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} fill="none" stroke="currentColor" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />)}
      </svg>
    )}
  </span>
)

interface WorkspaceProps {
  summary: BoardSummary
  film: CompiledFilm | null
  compileError: string | null
  compileStale: boolean
  knobs: StudioKnobs
  onKnobs: (patch: Partial<StudioKnobs>) => void
  seed: number
  onSeed: (seed: number) => void
  duration: 'auto' | number
  onDuration: (duration: 'auto' | number) => void
  look: Look
  onLook: (patch: Partial<Look>) => void
  format: ExportFormat
  onFormat: (format: ExportFormat) => void
  onHome: () => void
  exportState: ExportState | null
  onExport: () => Promise<void>
  onCancelExport: () => void
  apiUp: boolean | null
}

const Workspace: React.FC<WorkspaceProps> = (props) => {
  const { summary, film, compileError } = props
  const exportBusy = props.exportState?.status === 'submitting' || props.exportState?.status === 'rendering'
  return (
    <main className="workspace">
      <header className="topbar">
        <button className="ghost" onClick={props.onHome}>← boards</button>
        <h1 className="board-name">{summary.fileName}</h1>
        <span className="board-meta">{summary.layerCount} source layers · {summary.elementCount.toLocaleString()} primitives</span>
        <label className="format-select">
          <span className="visually-hidden">export format</span>
          <select
            value={props.format}
            disabled={exportBusy}
            onChange={(e) => {
              props.onFormat(e.target.value as ExportFormat)
            }}
          >
            {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <ExportControl state={props.exportState} onExport={props.onExport} onCancel={props.onCancelExport} disabled={props.compileStale || film === null || props.apiUp === false} />
      </header>
      {props.apiUp === false && (
        <div className="error-strip api-down" role="alert">
          <span>The render API is not running, so export is off. Start it in another terminal: <code>npm run start --workspace=@silk-reel/render-api</code></span>
        </div>
      )}
      <div className="workspace-body">
        <section className="player-pane" aria-label="preview">
          {compileError !== null ? (
            <div className="pane-error" role="alert">{compileError}</div>
          ) : film === null ? (
            <div className="pane-loading" role="status">compiling…</div>
          ) : (
            <PlayerPane timeline={film.timeline} stale={props.compileStale} />
          )}
        </section>
        <aside className="controls-pane">
          {film !== null && film.warnings.length > 0 && (
            <details className="warnings">
              <summary>{film.warnings.length} compile note{film.warnings.length === 1 ? '' : 's'}</summary>
              <ul>
                {film.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}
          <LookPanel look={props.look} onLook={props.onLook} disabled={exportBusy} board={summary.board} />
          <KnobPanel
            style={props.look.style}
            knobs={props.knobs}
            onKnobs={props.onKnobs}
            seed={props.seed}
            onSeed={props.onSeed}
            duration={props.duration}
            onDuration={props.onDuration}
            disabled={exportBusy}
          />
          <BoardLedger summary={summary} elementCount={film !== null && film.timeline.style === 'glyph' ? film.timeline.cast.length : null} />
        </aside>
      </div>
    </main>
  )
}

const BoardLedger: React.FC<{ summary: BoardSummary; elementCount: number | null }> = ({ summary, elementCount }) => (
  <section className="panel board-ledger" aria-labelledby="board-ledger-title">
    <div className="panel-heading">
      <h2 id="board-ledger-title">board inventory</h2>
      {elementCount !== null && <span>{elementCount.toLocaleString()} film elements</span>}
    </div>
    <dl className="ledger-grid">
      <div><dt>footprints</dt><dd>{summary.footprintCount}</dd></div>
      <div><dt>pads</dt><dd>{summary.padCount}</dd></div>
      <div><dt>traces</dt><dd>{summary.traceCount}</dd></div>
      <div><dt>zones</dt><dd>{summary.zoneCount}</dd></div>
      <div><dt>silk marks</dt><dd>{summary.silkMarkCount}</dd></div>
      <div><dt>vias</dt><dd>{summary.viaCount}</dd></div>
      <div><dt>drills</dt><dd>{summary.drillCount}</dd></div>
      <div><dt>nets</dt><dd>{summary.netCount}</dd></div>
    </dl>
    <p className="layer-ledger" title={summary.layerNames.join(', ')}>{summary.layerNames.join(' · ')}</p>
  </section>
)

const PlayerPane: React.FC<{ timeline: Timeline; stale: boolean }> = ({ timeline, stale }) => {
  const playerRef = React.useRef<PlayerRef>(null)
  const posterChosen = React.useRef(false)
  const currentFrameRef = React.useRef(0)
  const [currentFrame, setCurrentFrame] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)

  React.useEffect(() => {
    const player = playerRef.current
    if (player === null) return

    setPlaying(player.isPlaying())
    if (!posterChosen.current) {
      const segments = filmSegments(timeline)
      const poster = segments.find((segment) => segment.id === 'quad' || segment.id === 'hold') ?? segments[segments.length - 1]
      const posterFrame = Math.floor(((poster?.startPhase ?? 0) + (poster?.endPhase ?? 1)) / 2 * timeline.totalFrames)
      player.seekTo(posterFrame)
      currentFrameRef.current = posterFrame
      setCurrentFrame(posterFrame)
      posterChosen.current = true
    } else {
      const clampedFrame = Math.min(currentFrameRef.current, timeline.totalFrames - 1)
      if (clampedFrame !== currentFrameRef.current) {
        player.seekTo(clampedFrame)
        currentFrameRef.current = clampedFrame
        setCurrentFrame(clampedFrame)
      }
    }

    const updateFrame = (event: { detail: { frame: number } }): void => {
      currentFrameRef.current = event.detail.frame
      setCurrentFrame(event.detail.frame)
    }
    const onPlay = (): void => {
      setPlaying(true)
    }
    const onPause = (): void => {
      setPlaying(false)
    }

    player.addEventListener('frameupdate', updateFrame)
    player.addEventListener('play', onPlay)
    player.addEventListener('pause', onPause)
    return () => {
      player.removeEventListener('frameupdate', updateFrame)
      player.removeEventListener('play', onPlay)
      player.removeEventListener('pause', onPause)
    }
  }, [timeline])

  return (
    <div className="player-wrap">
      {stale && <div className="pane-stale" role="status">preview updating…</div>}
      <Player
        ref={playerRef}
        component={Film}
        inputProps={{ timeline }}
        durationInFrames={timeline.totalFrames}
        fps={timeline.fps}
        compositionWidth={timeline.width}
        compositionHeight={timeline.height}
        style={{ width: '100%', maxHeight: 'calc(100dvh - 190px)', aspectRatio: `${timeline.width} / ${timeline.height}` }}
        controls={false}
        loop
        acknowledgeRemotionLicense
      />
      <div className="preview-transport">
        <button
          className="transport-button"
          type="button"
          aria-label={playing ? 'pause preview' : 'play preview'}
          onClick={() => {
            const player = playerRef.current
            if (player === null) return
            if (player.isPlaying()) player.pause()
            else player.play()
          }}
        >
          {playing ? 'pause' : 'play'}
        </button>
        <span className="frame-readout">frame {currentFrame + 1} / {timeline.totalFrames}</span>
      </div>
      <FormationRibbon timeline={timeline} playerRef={playerRef} currentFrame={currentFrame} />
    </div>
  )
}

interface FilmSegment { id: string; beat: number; startPhase: number; endPhase: number }

/** ribbon blocks tile the loop: each glyph formation runs until the next one starts; trace acts laid end to end */
function filmSegments(timeline: Timeline): FilmSegment[] {
  if (timeline.style === 'glyph') {
    const f = timeline.formations
    return f.map((x, i) => ({ id: x.id, beat: x.beat, startPhase: i === 0 ? 0 : x.startPhase, endPhase: f[i + 1]?.startPhase ?? 1 }))
  }
  const a = TRACE_ACTS
  const cuts: Array<[string, number]> = [['drawing', 0], ['mask', a.mask[0]], ['parts', a.place[0]], ['reflow', a.reflow[0]], ['breath', a.reflow[1]], ['power', a.power[0]], ['hold', a.hold[0]]]
  return cuts.map(([id, start], i) => ({ id, beat: i, startPhase: start, endPhase: cuts[i + 1]?.[1] ?? 1 }))
}

const FormationRibbon: React.FC<{ timeline: Timeline; playerRef: React.RefObject<PlayerRef | null>; currentFrame: number }> = ({ timeline, playerRef, currentFrame }) => {
  const total = timeline.totalFrames
  const formations = filmSegments(timeline)
  const seekFromPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    playerRef.current?.seekTo(Math.min(total - 1, Math.floor(progress * total)))
  }
  const p = currentFrame / total
  const active = formations.find((formation) => p >= formation.startPhase && p <= formation.endPhase)
  const activeLabel = active ? active.id : 'film'
  return (
    <div
      className="act-ribbon"
      role="slider"
      tabIndex={0}
      aria-label="film frame"
      aria-valuemin={0}
      aria-valuemax={total - 1}
      aria-valuenow={currentFrame}
      aria-valuetext={`${activeLabel}, frame ${currentFrame + 1} of ${total}`}
      aria-orientation="horizontal"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        seekFromPointer(event)
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) seekFromPointer(event)
      }}
      onKeyDown={(event) => {
        const steps: Partial<Record<React.KeyboardEvent['key'], number>> = {
          ArrowLeft: -1,
          ArrowDown: -1,
          ArrowRight: 1,
          ArrowUp: 1,
          PageDown: -timeline.fps,
          PageUp: timeline.fps
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          playerRef.current?.seekTo(event.key === 'Home' ? 0 : total - 1)
          return
        }
        const step = steps[event.key]
        if (step === undefined) return
        event.preventDefault()
        playerRef.current?.seekTo(Math.max(0, Math.min(total - 1, currentFrame + step)))
      }}
    >
      {formations.map((formation, i) => (
        <span
          key={formation.beat}
          className={`act-block${active?.beat === formation.beat ? ' act-block-active' : ''}`}
          style={{
            width: `${(formation.endPhase - formation.startPhase) * 100}%`,
            background: i % 2 === 0 ? '#2e2e2e' : '#383838',
            cursor: 'ew-resize'
          }}
          title={`${formation.id}: ${(formation.startPhase * 100).toFixed(0)}%–${(formation.endPhase * 100).toFixed(0)}% of the loop`}
        >
          <span className="act-label">{formation.id}</span>
        </span>
      ))}
      <span className="ribbon-playhead" aria-hidden="true" style={{ left: `${((currentFrame + 0.5) / total) * 100}%` }} />
    </div>
  )
}

interface Look {
  style: StyleId
  aspect: Aspect
  palette: PaletteId | undefined
  accent: string | undefined
  title: { name: string; version: string }
  hero: string | undefined
  mask: MaskColor | undefined
}

const DEFAULT_LOOK: Look = { style: 'trace', aspect: '4:5', palette: undefined, accent: undefined, title: { name: '', version: '' }, hero: undefined, mask: undefined }

const ASPECT_BOX: Record<Aspect, [number, number]> = { '4:5': [12, 15], '1:1': [14, 14], '9:16': [9, 16], '16:9': [16, 9] }

const LookPanel: React.FC<{ look: Look; onLook: (patch: Partial<Look>) => void; disabled: boolean; board: BoardModel }> = ({ look, onLook, disabled, board }) => {
  const heroes = useMemo(() => heroChoices(board), [board])
  const autoHero = useMemo(() => heroPart(board, undefined, castHints(board)), [board])
  const boardMask = board.stackup.maskColor?.toLowerCase()
  const defaultPalette = look.style === 'glyph' ? 'mono' : 'copper'
  const activePalette = look.palette ?? defaultPalette
  const activeHead = PALETTE_LIST.find((p) => p.id === activePalette)?.head ?? '#ffffff'
  return (
    <section className="panel look-panel">
      <h2>look</h2>
      <div className="segmented" role="radiogroup" aria-label="style">
        {STYLES.map((st) => (
          <button
            key={st.id}
            role="radio"
            aria-checked={look.style === st.id}
            className={look.style === st.id ? 'seg seg-on' : 'seg'}
            disabled={disabled}
            onClick={() => {
              onLook({ style: st.id })
            }}
          >{st.label}</button>
        ))}
      </div>
      <div className="chip-row" role="radiogroup" aria-label="aspect">
        {ASPECTS.map((a) => {
          const [w, h] = ASPECT_BOX[a]
          return (
            <button
              key={a}
              role="radio"
              aria-checked={look.aspect === a}
              className={look.aspect === a ? 'chip chip-on' : 'chip'}
              disabled={disabled}
              onClick={() => {
                onLook({ aspect: a })
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x={(16 - w) / 2 + 0.5} y={(16 - h) / 2 + 0.5} width={w - 1} height={h - 1} fill="none" stroke="currentColor" />
              </svg>
              {a}
            </button>
          )
        })}
      </div>
      <div className="swatch-row" role="radiogroup" aria-label="palette">
        {PALETTE_LIST.map((pal) => (
          <button
            key={pal.id}
            role="radio"
            aria-checked={activePalette === pal.id}
            title={pal.id}
            className={activePalette === pal.id ? 'swatch swatch-on' : 'swatch'}
            disabled={disabled}
            onClick={() => {
              onLook({ palette: pal.id === defaultPalette ? undefined : pal.id as PaletteId })
            }}
          >
            <span className="swatch-chip" style={{ background: `linear-gradient(90deg, ${pal.bg} 0 34%, ${pal.copper} 34% 67%, ${pal.head} 67%)` }} />
            <span className="swatch-name">{pal.id}</span>
          </button>
        ))}
        <label className="accent-field" title="accent colour (growth heads, hero)">
          <input
            type="color"
            aria-label="accent colour"
            value={look.accent ?? activeHead}
            disabled={disabled}
            onChange={(e) => {
              onLook({ accent: e.target.value })
            }}
          />
          {look.accent !== undefined && (
            <button className="ghost" aria-label="clear accent" disabled={disabled} onClick={() => {
              onLook({ accent: undefined })
            }}>✕</button>
          )}
        </label>
      </div>
      <div className="pick-fields">
        <label className="field">
          <span>hero part</span>
          <select
            value={look.hero ?? ''}
            disabled={disabled}
            onChange={(e) => {
              onLook({ hero: e.target.value === '' ? undefined : e.target.value })
            }}
          >
            <option value="">{`Automatic${autoHero ? ` (${autoHero.ref}${autoHero.value ? ` · ${autoHero.value}` : ''})` : ''}`}</option>
            {heroes.filter((f) => f.ref !== autoHero?.ref).map((f) => <option key={f.ref} value={f.ref}>{f.value ? `${f.ref} · ${f.value}` : f.ref}</option>)}
          </select>
        </label>
        {look.style === 'trace' && (
          <label className="field">
            <span>solder mask</span>
            <select
              value={look.mask ?? ''}
              disabled={disabled}
              onChange={(e) => {
                onLook({ mask: e.target.value === '' ? undefined : e.target.value as MaskColor })
              }}
            >
              <option value="">{boardMask !== undefined ? `From the board file (${boardMask})` : 'From the board file (none set, so green)'}</option>
              {MASK_COLORS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="title-fields">
        <input
          type="text"
          aria-label="title card name"
          placeholder="title card (optional)"
          maxLength={40}
          value={look.title.name}
          disabled={disabled}
          onChange={(e) => {
            onLook({ title: { ...look.title, name: e.target.value } })
          }}
        />
        <input
          type="text"
          aria-label="title card version"
          placeholder="v1.0"
          maxLength={24}
          value={look.title.version}
          disabled={disabled || look.title.name.trim() === ''}
          onChange={(e) => {
            onLook({ title: { ...look.title, version: e.target.value } })
          }}
        />
      </div>
    </section>
  )
}

const KnobPanel: React.FC<{
  style: StyleId
  knobs: StudioKnobs
  onKnobs: (patch: Partial<StudioKnobs>) => void
  seed: number
  onSeed: (seed: number) => void
  duration: 'auto' | number
  onDuration: (duration: 'auto' | number) => void
  disabled: boolean
}> = ({ style, knobs, onKnobs, seed, onSeed, duration, onDuration, disabled }) => {
  const tempo = KNOB_RANGES.tempo
  const tempoValue = knobs.tempo ?? DEFAULT_KNOBS.tempo ?? tempo.min
  return (
    <section className="panel">
      <h2>film</h2>
      <div className="knob-grid">
        <div className="field range-field">
          <label htmlFor="knob-tempo">tempo</label>
          <div className="range-row">
            <input
              id="knob-tempo"
              type="range"
              min={tempo.min}
              max={tempo.max}
              step={tempo.step}
              value={tempoValue}
              disabled={disabled}
              onChange={(e) => {
                onKnobs({ tempo: Number(e.target.value) })
              }}
            />
            <output className="range-value">{tempoValue.toFixed(2)}</output>
          </div>
        </div>
        {style === 'glyph' && (
          <label className="field range-field check-field">
            <input
              type="checkbox"
              checked={(knobs.texts ?? DEFAULT_KNOBS.texts) === 1}
              disabled={disabled}
              onChange={(e) => {
                onKnobs({ texts: e.target.checked ? 1 : 0 })
              }}
            />
            silkscreen texts
          </label>
        )}
        <div className="field">
          <label htmlFor="knob-seed">seed</label>
          <div className="range-row">
            <input
              id="knob-seed"
              type="number"
              min={0}
              value={seed}
              disabled={disabled}
              onChange={(e) => {
                const next = Math.floor(Number(e.target.value))
                if (Number.isFinite(next) && next >= 0) onSeed(next)
              }}
            />
            <button
              className="ghost"
              title="pick a random seed"
              disabled={disabled}
              onClick={() => {
                onSeed(Math.floor(Math.random() * 1_000_000))
              }}
            >
              random
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="knob-duration">duration (s)</label>
          <div className="range-row">
            <input
              id="knob-duration"
              type="number"
              min={6}
              max={20}
              step={0.5}
              value={duration === 'auto' ? '' : duration}
              placeholder="auto"
              disabled={disabled}
              onChange={(e) => {
                const raw = e.target.value
                onDuration(raw === '' ? 'auto' : Number(raw))
              }}
            />
            {duration !== 'auto' && (
              <button className="ghost" aria-label="reset duration to automatic" title="reset to automatic" disabled={disabled} onClick={() => {
                onDuration('auto')
              }}>✕</button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

const ExportControl: React.FC<{ state: ExportState | null; onExport: () => Promise<void>; onCancel: () => void; disabled: boolean }> = ({ state, onExport, onCancel, disabled }) => {
  return (
    <div className="export-control">
      {state === null && (
        <button className="primary" disabled={disabled} onClick={() => {
          void onExport()
        }}>export film</button>
      )}
      {state?.status === 'submitting' && (
        <>
          <span className="export-status" role="status">submitting…</span>
          <button className="ghost" onClick={onCancel}>cancel</button>
        </>
      )}
      {state?.status === 'rendering' && (
        <>
          <span className="export-status" role="status">rendering {state.job.progress > 0 ? `${state.job.progress}%` : '…'}{state.job.etaSeconds !== null ? ` · about ${state.job.etaSeconds} s left` : ''}</span>
          <button className="ghost" onClick={onCancel}>cancel</button>
        </>
      )}
      {state?.status === 'failed' && (
        <>
          <span className="export-error" role="alert">failed: {state.error}</span>
          <button className="ghost" disabled={disabled} onClick={() => {
            void onExport()
          }}>again</button>
        </>
      )}
      {state?.status === 'cancelled' && (
        <>
          <span className="export-status" role="status">cancelled</span>
          <button className="ghost" disabled={disabled} onClick={() => {
            void onExport()
          }}>again</button>
        </>
      )}
      {state?.status === 'completed' && (
        <span className="export-status" role="status">completed</span>
      )}
      {state?.status === 'completed' && (
        <>
          <a className="button-link" href={downloadUrl(state.job.jobId)}>download</a>
          <button className="ghost" disabled={disabled} onClick={() => {
            void onExport()
          }}>again</button>
        </>
      )}
    </div>
  )
}

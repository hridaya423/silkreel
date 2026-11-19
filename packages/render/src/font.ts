import React from 'react'
import { continueRender, delayRender } from 'remotion'
import url from './assets/JetBrainsMono-Medium.woff2'
import boldUrl from './assets/JetBrainsMono-Bold.woff2'
import draftUrl from './assets/SilkDraft.ttf'
import groteskUrl from './assets/Archivo.ttf'

export const FONT = '"SilkMono", ui-monospace, Menlo, monospace'

/** the blueprint's drafting face: Silk Draft, Routed Gothic with a flagged, footed 1 and a slashed 0 so designators read true */
export const DRAFT = '"SilkDraft", "SilkMono", sans-serif'

let loaded: Promise<void> | undefined

export function loadFont(): Promise<void> {
  if (typeof FontFace === 'undefined') return Promise.resolve()
  loaded ??= Promise.all([
    new FontFace('SilkMono', `url(${url})`).load(),
    new FontFace('SilkMono', `url(${boldUrl})`, { weight: '700' }).load(),
    new FontFace('SilkDraft', `url(${draftUrl})`).load(),
    new FontFace('SilkGrotesk', `url(${groteskUrl})`, { weight: '100 900', stretch: '62% 125%' }).load()
  ]).then((faces) => {
    for (const f of faces) document.fonts.add(f)
  })
  return loaded
}

/** loads the bundled faces and holds the render until a frame has been drawn with them; true once they are in */
export function useFont(): boolean {
  const [handle] = React.useState(() => delayRender('font'))
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    void loadFont().finally(() => {
      setReady(true)
    })
  }, [])
  React.useEffect(() => {
    if (ready) continueRender(handle)
  }, [ready, handle])
  return ready
}

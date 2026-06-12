// pdf viewer
// and inline

import { useEffect, useRef, useState, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { offsetToPdfLocation } from './extractor.js'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

const DEFAULT_SCALE = 1.35
const MIN_SCALE = 0.6
const MAX_SCALE = 3.0

// citation token
// given body
// covering the
// for author
function citationBoundsAround(text, offset) {
  if (!text || offset == null) return [offset, offset]
// the matched
// find the
// walk small
  const winStart = Math.max(0, offset - 2)
  const winEnd = Math.min(text.length, offset + 80)
  const slice = text.slice(winStart, winEnd)
  const bracketRel = slice.indexOf('[')
  if (bracketRel !== -1) {
    const start = winStart + bracketRel
    const close = text.indexOf(']', start)
    if (close !== -1 && close - start < 60) return [start, close + 1]
  }
// author year
// find the
  let s = offset
  while (s > winStart && /[A-Za-z.\-'&,\s]/.test(text[s - 1])) s--
  let e = offset
  while (e < winEnd && /[A-Za-z0-9.\-'&,()\s]/.test(text[e])) e++
// cap chars
  if (e - s > 60) e = s + 60
  return [s, e]
}

// given pdfmeta
function itemsInRange(items, s, e) {
  return items.filter(it => it.endOffset >= s && it.startOffset <= e)
}

// group items
function groupItemsByLine(items, yTol = 4) {
  const byPage = new Map()
  for (const it of items) {
    if (!byPage.has(it.page)) byPage.set(it.page, [])
    byPage.get(it.page).push(it)
  }
  const out = []
  for (const [page, list] of byPage) {
    list.sort((a, b) => (b.transform[5] || 0) - (a.transform[5] || 0))
    let line = null
    for (const it of list) {
      const y = it.transform[5] || 0
      if (!line || Math.abs(line.y - y) > yTol) {
        if (line) out.push(line)
        line = { page, y, items: [] }
      }
      line.items.push(it)
    }
    if (line) out.push(line)
  }
  return out
}

// build rectangles
function buildHighlightRects(items, [s, e], scale) {
  const inRange = itemsInRange(items, s, e)
  if (inRange.length === 0) return []
  const lines = groupItemsByLine(inRange)
  const rects = []
  for (const line of lines) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const it of line.items) {
      const [, , , , x, yFromBottom] = it.transform
      const yTop = it.viewportHeight - yFromBottom - it.height
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x + it.width)
      minY = Math.min(minY, yTop)
      maxY = Math.max(maxY, yTop + it.height)
    }
    if (minX === Infinity) continue
    rects.push({
      page: line.page,
      x: minX * scale,
      y: minY * scale,
      w: (maxX - minX) * scale,
      h: (maxY - minY) * scale,
    })
  }
  return rects
}

export default function PDFViewer({ arrayBuffer, pdfMeta, fullText, results, parsedRefs, jumpTarget, inlineHits, onPageChange }) {
  const containerRef = useRef(null)
  const pageRefs = useRef({})
  const [pdf, setPdf] = useState(null)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [pageDims, setPageDims] = useState({})
  const [activePage, setActivePage] = useState(1)
  const [loadError, setLoadError] = useState('')
  const [highlight, setHighlight] = useState(null)

// load pdf
  useEffect(() => {
    if (!arrayBuffer) return
    setLoadError('')
    let cancelled = false
    ;(async () => {
      try {
        let bytes
        try { bytes = new Uint8Array(arrayBuffer.slice(0)) }
        catch { throw new Error('PDF buffer became detached (re-upload the file)') }
        const doc = await pdfjsLib.getDocument({ data: bytes }).promise
        if (!cancelled) setPdf(doc)
      } catch (e) { if (!cancelled) setLoadError(e.message || String(e)) }
    })()
    return () => { cancelled = true }
  }, [arrayBuffer])

// render all
  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    ;(async () => {
      const dims = {}
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancelled) return
        const page = await pdf.getPage(p)
        const viewport = page.getViewport({ scale })
        const pageEl = pageRefs.current[p]
        if (!pageEl) continue
        const canvas = pageEl.querySelector('canvas')
        const textLayerDiv = pageEl.querySelector('.pdf-text-layer')
        if (!canvas) continue
// hidpi backing
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const ctx = canvas.getContext('2d')
        const renderTransform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
        try { await page.render({ canvasContext: ctx, viewport, transform: renderTransform }).promise }
        catch { await page.render({ canvas, viewport, transform: renderTransform }).promise }

// render text
// user can
// pdfjs exposes
        if (textLayerDiv) {
          textLayerDiv.innerHTML = ''
          textLayerDiv.style.width = `${viewport.width}px`
          textLayerDiv.style.height = `${viewport.height}px`
          textLayerDiv.style.setProperty('--scale-factor', String(scale))
          try {
            const content = await page.getTextContent()
            if (typeof pdfjsLib.TextLayer === 'function') {
              const tl = new pdfjsLib.TextLayer({
                textContentSource: content,
                container: textLayerDiv,
                viewport,
              })
              await tl.render()
            }
          } catch (e) {
// text layer
            console.warn('text layer render failed', e)
          }
        }

        dims[p] = { width: viewport.width, height: viewport.height }
      }
      if (!cancelled) setPageDims(dims)
    })()
    return () => { cancelled = true }
  }, [pdf, scale])

// observe active
  useEffect(() => {
    if (!pdf) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (ent.isIntersecting) {
            const p = parseInt(ent.target.dataset.page, 10)
            if (p) { setActivePage(p); onPageChange?.(p); break }
          }
        }
      },
      { root: containerRef.current, threshold: 0.4 }
    )
    for (const p of Object.keys(pageRefs.current)) {
      if (pageRefs.current[p]) obs.observe(pageRefs.current[p])
    }
    return () => obs.disconnect()
  }, [pdf, onPageChange])

// citation token
  useEffect(() => {
    if (!jumpTarget || !pdfMeta || !fullText) return
    const [s, e] = citationBoundsAround(fullText, jumpTarget.offset)
    const rects = buildHighlightRects(pdfMeta.items, [s, e], scale)
    if (rects.length === 0) {
// fall back
      const loc = offsetToPdfLocation(jumpTarget.offset, pdfMeta)
      if (loc?.page) pageRefs.current[loc.page]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
// scroll the
    const firstPage = rects[0].page
    const node = pageRefs.current[firstPage]
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlight({ rects, ts: Date.now() })
    const t = setTimeout(() => setHighlight(null), 3200)
    return () => clearTimeout(t)
  }, [jumpTarget, pdfMeta, fullText, scale])

// cmd ctrl
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setScale(s => {
        const delta = e.deltaY > 0 ? -0.1 : 0.1
        return Math.max(MIN_SCALE, Math.min(MAX_SCALE, +(s + delta).toFixed(2)))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  if (loadError) {
    return <div style={{ padding: 30, color: '#b91c1c', fontSize: 12 }}>PDF render error: {loadError}</div>
  }
  if (!pdf) {
    return <div style={{ padding: 30, color: '#94a3b8', fontSize: 12 }}>Loading PDF…</div>
  }

// static per
// sentence citation
// tinting was

  const zoomBtn = { width: 26, height: 26, border: '1px solid #cbd5e1', background: 'white', color: '#475569', borderRadius: 5, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }

  return (
    <div ref={containerRef} style={{ height: '100%', overflowY: 'auto', overflowX: 'auto', background: '#e2e8f0', padding: 16, position: 'relative' }}>
      
      <div style={{ position: 'sticky', top: 0, marginLeft: 'auto', marginRight: 0, marginBottom: -34, width: 'fit-content', display: 'flex', gap: 6, alignItems: 'center', zIndex: 12, padding: '6px 8px', background: 'rgba(255,255,255,0.95)', borderRadius: 6, border: '1px solid #cbd5e1', boxShadow: '0 2px 8px rgba(15,23,42,0.08)' }}>
        <span style={{ fontSize: 11, color: '#475569', padding: '0 4px' }}>{activePage} / {pdf.numPages}</span>
        <button onClick={() => setScale(s => Math.max(MIN_SCALE, +(s - 0.15).toFixed(2)))} style={zoomBtn} title="Zoom out">−</button>
        <button onClick={() => setScale(DEFAULT_SCALE)} style={{ ...zoomBtn, width: 'auto', padding: '0 6px', fontSize: 10 }} title="Reset zoom">{Math.round(scale * 100)}%</button>
        <button onClick={() => setScale(s => Math.min(MAX_SCALE, +(s + 0.15).toFixed(2)))} style={zoomBtn} title="Zoom in">+</button>
      </div>

      {Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((p) => {
        const d = pageDims[p]
        const hlRects = highlight?.rects?.filter(r => r.page === p) || []
        return (
          <div
            key={p}
            data-page={p}
            ref={(el) => { pageRefs.current[p] = el }}
            style={{
              position: 'relative',
              margin: '0 auto 18px',
              width: d?.width || 612 * scale,
              height: d?.height || 792 * scale,
              background: 'white',
              boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
              borderRadius: 4,
            }}
          >
            <canvas style={{ display: 'block' }} />
            <div className="pdf-text-layer" style={{
              position: 'absolute', top: 0, left: 0,
              overflow: 'hidden',
              opacity: 0.2,
              lineHeight: 1.0,
              pointerEvents: 'auto',
            }} />
            
            {hlRects.map((r, k) => (
              <div key={k} style={{
                position: 'absolute',
                left: r.x, top: r.y, width: r.w, height: r.h,
                background: 'rgba(253, 224, 71, 0.55)',
                mixBlendMode: 'multiply',
                borderRadius: 2,
                pointerEvents: 'none',
                animation: 'fadeIn 0.2s ease',
              }} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

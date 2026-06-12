// file parsers

// all parsers

import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'
import mammoth from 'mammoth/mammoth.browser.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// pdf
// extract the
// this works
async function extractTitleFromFirstPage(pdf) {
  try {
    const page = await pdf.getPage(1)
    const content = await page.getTextContent()
// group consecutive
    const items = content.items.filter(it => 'str' in it && it.str.trim().length > 0)
    if (items.length === 0) return ''
// find max
    let maxSize = 0
    for (const it of items) {
      const size = Math.abs(it.transform?.[3] || it.height || 0)
      if (size > maxSize) maxSize = size
    }
// collect items
    const titleItems = items.filter(it => {
      const size = Math.abs(it.transform?.[3] || it.height || 0)
      return size >= maxSize * 0.9
    })
// take the
    let title = ''
    for (let i = 0; i < titleItems.length; i++) {
      title += (i > 0 ? ' ' : '') + titleItems[i].str
// stop the
      if (i + 1 < titleItems.length) {
        const cur = titleItems[i].transform?.[5] || 0
        const nxt = titleItems[i + 1].transform?.[5] || 0
        if (Math.abs(cur - nxt) > maxSize * 3) break
      }
    }
    return title.replace(/\s+/g, ' ').trim().slice(0, 240)
  } catch { return '' }
}

// returns
// text pageoffsets
// text concatenated
// pageoffsets page
// items per
// geometry pdf
export async function parsePDF(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
// try pdf
  let title = ''
  try {
    const meta = await pdf.getMetadata()
    const t = meta?.info?.Title
    if (typeof t === 'string' && t.trim().length > 4 && !/^untitled$/i.test(t.trim())) {
      title = t.trim().slice(0, 240)
    }
  } catch {}
  if (!title) title = await extractTitleFromFirstPage(pdf)
// also keep
// the heuristic
  let firstPageText = ''
  try {
    const page = await pdf.getPage(1)
    const content = await page.getTextContent()
    firstPageText = content.items.map(it => ('str' in it ? it.str : '')).join(' ').slice(0, 2500)
  } catch {}
// absolute fallback
// chars the
  if (!title && firstPageText) {
    const probe = firstPageText.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (probe.length > 10) title = probe
  }
  let buf = ''
  const pageOffsets = []
  const items = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const pageStart = buf.length
    for (const it of content.items) {
      if (!('str' in it)) continue
      const startOffset = buf.length
      buf += it.str + ' '
      const endOffset = buf.length
      items.push({
        page: p,
        startOffset,
        endOffset,
        str: it.str,
// transform bottom
        transform: it.transform,
        width: it.width,
        height: it.height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      })
    }
    pageOffsets.push({ page: p, start: pageStart, end: buf.length })
    if (p < pdf.numPages) buf += '\n\n'
  }
  return { text: buf, pageOffsets, items, title, firstPageText }
}

// docx
export async function parseDOCX(arrayBuffer) {
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value || ''
}

// tex bibtex
export async function parseText(file) {
  return await file.text()
}

// dispatcher
// returns text
// pdf present
// plus pageoffsets
export async function parseFile(file) {
  const name = file.name || 'input'
  const lower = name.toLowerCase()
  const ext = lower.split('.').pop()
  if (ext === 'pdf') {
    const original = await file.arrayBuffer()
// pdfjs getdocument
// second independent
    const viewerCopy = original.slice(0)
    const parseCopy = original.slice(0)
    const pdf = await parsePDF(parseCopy)
    return {
      text: pdf.text,
      kind: 'pdf',
      name,
      title: pdf.title || '',
      firstPageText: pdf.firstPageText || '',
      pdf: {
        arrayBuffer: viewerCopy,
        pageOffsets: pdf.pageOffsets,
        items: pdf.items,
      },
    }
  }
  if (ext === 'docx' || ext === 'doc') {
    return { text: await parseDOCX(await file.arrayBuffer()), kind: 'docx', name }
  }
  if (ext === 'tex') return { text: await parseText(file), kind: 'tex', name }
  if (ext === 'bib') return { text: await parseText(file), kind: 'bib', name }
  if (ext === 'bbl') return { text: await parseText(file), kind: 'bib', name }
  return { text: await parseText(file), kind: 'txt', name }
}

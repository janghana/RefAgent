// extract individual

// input text
// output raw

// strategy kind
// bib bibtex
// tex bibliography
// pdf text
// docx same
// txt try

import { classify } from './api.js'

const REF_HEADERS = [
  'references', 'bibliography', 'reference list', 'literature cited',
  'works cited', '참고문헌', 'literatur', 'bibliographie',
]

// section locator
// pdf text
// anywhere the
// returns section
// section relative
function locateRefsSection(text) {
// try line
  const lines = text.split('\n')
  let lineOffsets = [0]
  for (let i = 0; i < lines.length; i++) lineOffsets.push(lineOffsets[i] + lines[i].length + 1)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().toLowerCase()
    if (line.length > 60) continue
    for (const h of REF_HEADERS) {
      const stripped = line.replace(/^[\d.\s#*]+/, '').replace(/[:：]\s*$/, '').trim()
      if (stripped === h) {
        const base = lineOffsets[i + 1] || text.length
        return { section: text.slice(base), baseOffset: base }
      }
    }
  }
// substring anchored
// word followed
// earliest because
// references appears
// are usually

// strong signals
// numbered marker
// article entry
// bibitem
// capitalsurname yyyy
// capitalsurname initial
// the signal
  let bestIdx = -1
  let bestScore = -1
  let bestHeader = null
  for (const h of REF_HEADERS) {
    const re = new RegExp(`(?:^|[\\s\\n.])(${h})(?=\\s|$)`, 'gi')
    let m
    while ((m = re.exec(text)) !== null) {
      const hStart = m.index + (m[0].length - h.length)
      const after = text.slice(hStart + h.length, hStart + h.length + 250)
// score signals
      let score = 0
      if (/^\s*\[\s*0?1\s*\]/.test(after)) score += 100
      if (/^\s*@\w+\s*\{/.test(after)) score += 100
      if (/\\bibitem/.test(after)) score += 100
// lncs springer
      if (/^\s+1\.\s+[A-ZÀ-Ý][a-zà-ÿ]+/.test(after)) score += 90
// author year
      if (/^\s+[A-Z][a-z]+[A-Za-z. ,'-]{5,120}(19|20)\d{2}\.\s/.test(after)) score += 80
// simpler surname
      if (/^\s+[A-Z][a-z]+/.test(after) && /(?:19|20)\d{2}\./.test(after)) score += 40
// generic looseness
      if (/(?:19|20)\d{2}/.test(after)) score += 5
// penalty looks
      if (/\bthe\b.*\b(?:study|table|figure|results|paper)\b/i.test(after.slice(0, 80))) score -= 50

      if (score > 30 && (score > bestScore || (score === bestScore && hStart < bestIdx))) {
        bestIdx = hStart
        bestScore = score
        bestHeader = h
      }
    }
  }
  if (bestIdx >= 0) {
    const base = bestIdx + bestHeader.length
    return { section: text.slice(base), baseOffset: base }
  }
// header anywhere
  return { section: text, baseOffset: 0 }
}

// identify likely
function trimToBeforeAppendix(refsText) {
  const stops = [
    /\n\s*appendix\b/i,
    /\n\s*supplementary\s+material/i,
    /\n\s*supplementary\s+information/i,
    /\n\s*author\s+contributions/i,
    /(?:^|\s)attention\s+visualizations(?:\s|$)/i,
// acl emnlp
// these appear
// followed capitalized
// letter avoid
    /\s{2,}[A-H]\s{2,}[A-Z][a-z]+\s+(?:Description|Implementation|Details|Selection|Ablation|Zero-Shot|Qualitative|Examples|Additional|Methodology|Pipeline|Results|Analysis|Hyperparam|Data|Limitations|Prompts)/,
// generic topic
// less common
  ]
  let cut = refsText.length
  for (const re of stops) {
    const m = refsText.match(re)
    if (m && m.index < cut && m.index > 200) cut = m.index
  }
  return refsText.slice(0, cut)
}

// bibtex entry
// returns entries
function splitBibtex(text, baseOffset = 0) {
  const out = []
  const re = /@(\w+)\s*\{([^@]+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const startIdx = m.index
    let depth = 0, end = startIdx
    let inEntry = false
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i]
      if (c === '{') { depth++; inEntry = true }
      else if (c === '}') { depth--; if (inEntry && depth === 0) { end = i + 1; break } }
    }
    if (end > startIdx) out.push({ raw: text.slice(startIdx, end).trim(), offset: baseOffset + startIdx })
  }
  return out
}

function parseBibtexEntry(entry) {
  const raw = entry.raw || entry
  const offset = entry.offset
  const out = { raw, sourceOffset: offset, title: '', authors: '', year: '', doi: '', arxivId: '', venue: '' }
  const field = (name) => {
    const re = new RegExp(`${name}\\s*=\\s*[{"]([\\s\\S]*?)[}"]\\s*(?:,|$)`, 'i')
    const m = raw.match(re)
    if (!m) return ''
    return m[1].replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
  }
  out.title = field('title')
  out.authors = field('author')
  out.year = field('year')
  out.doi = field('doi')
  out.arxivId = field('eprint') || field('arxiv')
  out.venue = field('journal') || field('booktitle')
  return out
}

// bibitem splitter
function splitBibitems(text, baseOffset = 0) {
  const out = []
  const re = /\\bibitem\b/g
  const indices = []
  let m
  while ((m = re.exec(text)) !== null) indices.push(m.index)
  if (indices.length === 0) return out
  indices.push(text.length)
  for (let i = 0; i < indices.length - 1; i++) {
    let entry = text.slice(indices[i], indices[i + 1])
    entry = entry.replace(/\\end\{thebibliography\}[\s\S]*$/, '').trim()
    if (entry.length > 10) out.push({ raw: entry, offset: baseOffset + indices[i] })
  }
  return out
}

function parseBibitemEntry(entry) {
  const raw = entry.raw || entry
  const offset = entry.offset
  const out = { raw, sourceOffset: offset, title: '', authors: '', year: '', doi: '', arxivId: '', venue: '' }
  const cleaned = raw
    .replace(/^\\bibitem(\[[^\]]*\])?\{[^}]*\}/, '')
    .replace(/\\newblock/g, ' ')
    .replace(/\\(em|it|bf|sl|sf|tt|rm|sc)\b\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  out.raw = cleaned
  out.sourceOffset = offset
// try extract
  const yearM = cleaned.match(/\b(19[0-9]{2}|20[0-9]{2})\b/)
  if (yearM) out.year = yearM[1]
// doi
  const doiM = cleaned.match(/(10\.\d{4,}\/[^\s,]+)/)
  if (doiM) out.doi = doiM[1].replace(/[.,]$/, '')
// arxiv
  const arxM = cleaned.match(/arxiv[:\s]*(\d{4}\.\d{4,5})/i)
  if (arxM) out.arxivId = arxM[1]
// heuristic text
  return out
}

// numbered freeform
// works the
// citation number
// confusing body
function splitNumbered(text, baseOffset = 0) {
// two pass
// for variant
  function findHits(rePattern) {
    const out = []
    let m
    const re = new RegExp(rePattern, 'g')
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1] || m[2] || m[3] || m[4], 10)
      if (!n || n === 0) continue
      const startedWithWs = /^\s/.test(m[0])
      out.push({ idx: m.index + (startedWithWs ? 1 : 0), num: n, matchLen: m[0].trimStart().length })
    }
    return out
  }
// try both
// longer monotonic
// pollute the
// fall back
  const strictHits = findHits(`(?:^|\\s)(?:\\[\\s*(\\d+)\\s*\\]|\\(\\s*(\\d+)\\s*\\))`)
  const looseHits = findHits(`(?:^|\\s)(?:(\\d+)\\.\\s+(?=[A-Z\\\\"'\\d])|(\\d+)\\)\\s+(?=[A-Z\\\\"'\\d]))`)

  function bestMonotonicRun(hs) {
    let bs = -1, be = -1
    for (let i = 0; i < hs.length; i++) {
      if (hs[i].num !== 1) continue
      let j = i, expect = 1
      while (j < hs.length && hs[j].num === expect) { j++; expect++ }
      if (j - i > be - bs) { bs = i; be = j }
    }
    return { start: bs, end: be, len: be - bs }
  }
  const strictRun = bestMonotonicRun(strictHits)
  const looseRun = bestMonotonicRun(looseHits)
  let hits, bestStart, bestEnd
  if (looseRun.len > strictRun.len) {
    hits = looseHits; bestStart = looseRun.start; bestEnd = looseRun.end
  } else {
    hits = strictHits; bestStart = strictRun.start; bestEnd = strictRun.end
  }
  if (bestStart < 0) return []
  const runHits = hits.slice(bestStart, bestEnd)
  if (runHits.length < 2) return []

  const out = []
  for (let i = 0; i < runHits.length; i++) {
    const start = runHits[i].idx + runHits[i].matchLen
    const end = i + 1 < runHits.length ? runHits[i + 1].idx : Math.min(text.length, start + 1500)
    const entry = text.slice(start, end).replace(/\s+/g, ' ').trim()
    if (entry.length > 20) out.push({ raw: entry, offset: baseOffset + runHits[i].idx })
  }
  return out
}

// author year
// two strategies
// blank line
// flat text

// for typical
// anchor yyyy
// until see
function splitAuthorYear(text, baseOffset = 0) {
// first try
  const blocks = []
  {
    const re = /\n\s*\n+/g
    let last = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const block = text.slice(last, m.index).replace(/\s+/g, ' ').trim()
      if (block.length > 30) blocks.push({ raw: block, offset: baseOffset + last })
      last = re.lastIndex
    }
    const tail = text.slice(last).replace(/\s+/g, ' ').trim()
    if (tail.length > 30) blocks.push({ raw: tail, offset: baseOffset + last })
  }
  if (blocks.length >= 5) return blocks

// flat text
// look for
// each entry
// anchor entries
// find all
  const flat = text.replace(/\s+/g, ' ')
  const yearRe = /\b(19|20)\d{2}[a-z]?\.\s/g
  const yearPositions = []
  let m
  while ((m = yearRe.exec(flat)) !== null) yearPositions.push({ idx: m.index, end: m.index + m[0].length })
  if (yearPositions.length < 5) return blocks
// each entry
// but the
// walk back
  const startOf = (yearIdx) => {
// walk left
    let p = yearIdx
    while (p > 0) {
      p--
      if (flat[p] === '.' && /\s[A-Z]/.test(flat.slice(p, p + 3))) {
// likely boundary
        return p + 2
      }
      if (yearIdx - p > 400) break
    }
    return Math.max(0, yearIdx - 300)
  }
  const out = []
  for (let i = 0; i < yearPositions.length; i++) {
    const s = startOf(yearPositions[i].idx)
    const e = i + 1 < yearPositions.length ? startOf(yearPositions[i + 1].idx) : Math.min(flat.length, yearPositions[i].end + 600)
    const entry = flat.slice(s, e).trim()
    if (entry.length > 30) out.push({ raw: entry, offset: baseOffset + s })
  }
// dedup overlapping
  const seen = new Set()
  const dedup = []
  for (const e of out) {
    if (seen.has(e.offset)) continue
    seen.add(e.offset); dedup.push(e)
  }
  return dedup.length > blocks.length ? dedup : blocks
}

// light this
function looksLikeReference(entry) {
  const s = entry.raw || entry
  if (!s || s.length < 25) return false
  if (/\b(19|20)\d{2}\b/.test(s)) return true
  if (/10\.\d{4,}/.test(s)) return true
  if (/arxiv/i.test(s)) return true
  return false
}

// plain string
function parsePlainEntry(entry) {
  const raw = entry.raw || entry
  const offset = entry.offset
  const out = { raw, sourceOffset: offset, title: '', authors: '', year: '', doi: '', arxivId: '', venue: '' }
  const yearM = raw.match(/\b(19[0-9]{2}|20[0-9]{2})\b/)
  if (yearM) out.year = yearM[1]
  const doiM = raw.match(/(10\.\d{4,}\/[^\s,;]+)/)
  if (doiM) out.doi = doiM[1].replace(/[.,;]$/, '')
  const arxM = raw.match(/arxiv[:\s]*(\d{4}\.\d{4,5})/i) || raw.match(/\b(\d{4}\.\d{4,5})\b/)
  if (arxM) out.arxivId = arxM[1]
// title heuristic
  const quoted = raw.match(/"([^"]{15,200})"|"([^"]{15,200})"/)
  if (quoted) out.title = (quoted[1] || quoted[2]).trim()
  return out
}

// title detection
// phrases that
// not paper
const VENUE_PATTERNS = [
  /^in\s+(?:proceedings|advances|the\s+\w+\s+(?:conference|workshop|meeting|symposium))/i,
  /^proceedings\s+of\b/i,
  /^advances\s+in\b/i,
  /^international\s+conference\b/i,
  /^conference\s+on\b/i,
  /^workshop\s+on\b/i,
  /^journal\s+of\b/i,
  /^transactions\s+on\b/i,
  /^ieee\s+transactions\b/i,
  /^acm\s+transactions\b/i,
  /\bpages?\s+\d/i,
  /\bvol(?:ume)?\.?\s+\d/i,
  /\bpp\.\s*\d/i,
  /^\d+\(\d+\):\d+/,
]
function looksLikeVenue(s) {
  if (!s) return false
  for (const re of VENUE_PATTERNS) if (re.test(s.trim())) return true
  return false
}

function looksLikeAuthorBlock(s) {
  if (!s) return false
  const t = s.trim()
// heuristic mostly
// has commas
  const commaCount = (t.match(/,/g) || []).length
  const andCount = (t.match(/\band\b/gi) || []).length
  if (commaCount + andCount >= 1 && t.length < 200 && /[A-Z]\.\s|[A-Z][a-z]+\s+[A-Z][a-z]+/.test(t)) return true
  return false
}

// heuristic title
// handles both
// acl ieee
// apa authors
// older code
function guessTitleFromPlain(parsed) {
  if (parsed.title && !looksLikeVenue(parsed.title) && !looksLikeAuthorBlock(parsed.title)) return parsed.title
  let s = parsed.raw
  s = s.replace(/(https?:\/\/\S+)/g, ' ')
       .replace(/10\.\d{4,}\/[^\s,;]+/g, ' ')
       .replace(/arxiv:?\s*\d{4}\.\d{4,5}/gi, ' ')
       .replace(/\s+/g, ' ')
// acl pattern
  if (parsed.year) {
    const re = new RegExp(`\\.\\s${parsed.year}[a-z]?\\.\\s+`)
    const m = s.match(re)
    if (m) {
// everything after
      const afterYear = s.slice(m.index + m[0].length)
// title the
      const dotIdx = afterYear.indexOf('. ')
      const candidate = (dotIdx > 5 ? afterYear.slice(0, dotIdx) : afterYear).trim().replace(/[.,;]$/, '')
      if (candidate.length > 6 && !looksLikeVenue(candidate) && !looksLikeAuthorBlock(candidate)) {
        return candidate
      }
    }
  }
// fallback split
  const parts = s.split(/\.\s+/).map(p => p.trim().replace(/[.,;]$/, '')).filter(p => p.length > 0)
  if (parts.length === 0) return s.slice(0, 200).trim()
  const scored = parts.map((p, i) => {
    let score = p.length
    if (looksLikeVenue(p)) score -= 1000
    if (looksLikeAuthorBlock(p)) score -= 800
    if (i === 0) score -= 50
    if (p.length < 10) score -= 200
    if (p.length > 250) score -= 100
    if (/^\d{4}$/.test(p)) score -= 800
    return { p, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (best && best.score > 0) return best.p
  for (const { p } of scored) {
    if (!looksLikeAuthorBlock(p) && !looksLikeVenue(p) && p.length > 8) return p
  }
  return parts[Math.min(1, parts.length - 1)] || s.slice(0, 200).trim()
}

// main
// deliberately not
// citation strings
// handle without
// pass own
// split the
// capture sourceoffset
export function extractReferences({ text, kind }) {
  if (!text || !text.trim()) return []

  if (kind === 'bib') {
    const entries = splitBibtex(text, 0)
    if (entries.length > 0) return entries.map(parseBibtexEntry)
    const items = splitBibitems(text, 0)
    if (items.length > 0) return items.map(parseBibitemEntry)
  }

  if (kind === 'tex') {
    const items = splitBibitems(text, 0)
    if (items.length > 0) return items.map(parseBibitemEntry)
    const bib = splitBibtex(text, 0)
    if (bib.length > 0) return bib.map(parseBibtexEntry)
  }

  const located = locateRefsSection(text)
  const sectionRaw = trimToBeforeAppendix(located.section)
  const baseOffset = located.baseOffset

  const bib = splitBibtex(sectionRaw, baseOffset)
  if (bib.length > 0) return bib.map(parseBibtexEntry)

  const items = splitBibitems(sectionRaw, baseOffset)
  if (items.length > 0) return items.map(parseBibitemEntry)

  const numbered = splitNumbered(sectionRaw, baseOffset)
  if (numbered.length > 2) {
    return numbered
      .filter(looksLikeReference)
      .map(parsePlainEntry)
  }

  const ay = splitAuthorYear(sectionRaw, baseOffset)
  return ay
    .filter(looksLikeReference)
    .map(parsePlainEntry)
}

// inline citation

// given the
// place the

// patterns supported
// numbered where
// author year
// latex leftover

// return per

function normWord(s) { return (s || '').toLowerCase().replace(/[^a-z]/g, '') }

function authorLastNames(authors) {
  if (!authors) return []
// authors may
  const parts = authors.split(/[,;]| and /i).map(p => p.trim()).filter(Boolean)
  const out = []
  for (const p of parts) {
    const tok = p.split(/\s+/).filter(Boolean)
    if (tok.length === 0) continue
// heuristic the
    const last = tok[tok.length - 1].replace(/[^A-Za-z\-]/g, '')
    if (last.length >= 2) out.push(last)
  }
  return out
}

// build patterns
function inlinePatternsFor(ref, displayIndex) {
  const pats = []

// numbered
// note not
// equations and
// reference citations
  const n = displayIndex
  pats.push({
    label: 'numbered',
    re: new RegExp(`\\[\\s*((?:\\d+\\s*[-–—,;]\\s*)*${n})(?=\\s*[\\],;\\s])`, 'g'),
  })
// also recognize
  pats.push({
    label: 'numbered-range',
    re: new RegExp(`\\[\\s*\\d+\\s*[-–—]\\s*\\d+\\s*\\]`, 'g'),
    rangeCheck: (m) => {
      const mm = m.match(/(\d+)\s*[-–—]\s*(\d+)/)
      if (!mm) return false
      const lo = parseInt(mm[1], 10), hi = parseInt(mm[2], 10)
      return n >= lo && n <= hi
    },
  })

// author year
  const lastNames = authorLastNames(ref.authors)
  const year = String(ref.year || '').match(/\d{4}/)?.[0]
  if (lastNames.length > 0 && year) {
    const first = lastNames[0].replace(/[^A-Za-z]/g, '')
    if (first.length >= 2) {
// smith 2020
      pats.push({
        label: 'author-year',
        re: new RegExp(`\\b${first}(?:\\s+(?:et al\\.?|and\\s+\\w+))?(?:[,.\\s]+|\\s*\\()${year}\\b`, 'g'),
      })
    }
  }

// latex cite
  if (ref.title) {
    const titleKey = ref.title.toLowerCase().match(/[a-z]+/g)?.[0]
    if (titleKey && titleKey.length >= 4 && lastNames[0]) {
      const key = `${lastNames[0].toLowerCase()}\\d{2,4}${titleKey}`
      pats.push({
        label: 'cite-key',
        re: new RegExp(`\\\\cite[a-z]*\\{[^}]*${key}[^}]*\\}`, 'gi'),
      })
    }
  }

  return pats
}

// merge two
// then doi
// found ref
// rule based
export function mergeRefs(a, b) {
  const ARxiv = (r) => (r?.arxivId || '').replace(/v\d+$/, '').toLowerCase()
  const DOI = (r) => (r?.doi || '').toLowerCase()
  const NTITLE = (r) => (r?.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80)

  const out = []
  const byArxiv = new Map(), byDoi = new Map(), byTitle = new Map()

  function findExisting(ref) {
    const ax = ARxiv(ref); if (ax && byArxiv.has(ax)) return byArxiv.get(ax)
    const dx = DOI(ref); if (dx && byDoi.has(dx)) return byDoi.get(dx)
    const tx = NTITLE(ref); if (tx && byTitle.has(tx)) return byTitle.get(tx)
    return null
  }
  function index(ref, idx) {
    const ax = ARxiv(ref); if (ax) byArxiv.set(ax, idx)
    const dx = DOI(ref); if (dx) byDoi.set(dx, idx)
    const tx = NTITLE(ref); if (tx) byTitle.set(tx, idx)
  }

// pass rule
  for (const r of a) {
    const existing = findExisting(r)
    if (existing != null) continue
    out.push({ ...r })
    index(r, out.length - 1)
  }
// pass llm
// llm understands
// for title
  for (const r of b) {
    const existingIdx = findExisting(r)
    if (existingIdx != null) {
      const cur = out[existingIdx]
      out[existingIdx] = {
        ...cur,
        title: r.title || cur.title,
        authors: r.authors || cur.authors,
        year: r.year || cur.year,
        doi: r.doi || cur.doi,
        arxivId: r.arxivId || cur.arxivId,
        venue: r.venue || cur.venue,
        sourceOffset: cur.sourceOffset ?? r.sourceOffset,
      }
      index(out[existingIdx], existingIdx)
      continue
    }
    out.push({ ...r })
    index(r, out.length - 1)
  }
  return out
}

// best effort
// llm extracted
export function backfillSourceOffsets(refs, fullText) {
  for (const r of refs) {
    if (r.sourceOffset != null) continue
// try distinctive
    let probe = (r.raw || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (probe.length < 20) probe = (r.title || '').slice(0, 60)
    if (probe.length < 8) continue
// normalize whitespace
    const hay = fullText.replace(/\s+/g, ' ')
    const idx = hay.indexOf(probe)
    if (idx >= 0) r.sourceOffset = idx
  }
  return refs
}

// public find
// can stay
export function findRefsSectionStart(text) {
  return locateRefsSection(text).baseOffset
}

export function findInlineCitations(bodyText, refs, refsSectionStart = null) {
// restrict search
  const searchText = refsSectionStart != null ? bodyText.slice(0, refsSectionStart) : bodyText
  const out = refs.map(() => [])

  for (let i = 0; i < refs.length; i++) {
    const displayIdx = refs[i].indexInList || (i + 1)
    const pats = inlinePatternsFor(refs[i], displayIdx)
    const found = new Set()
    for (const { re, rangeCheck } of pats) {
      let m
      while ((m = re.exec(searchText)) !== null) {
        if (rangeCheck && !rangeCheck(m[0])) continue
        found.add(m.index)
        if (re.lastIndex === m.index) re.lastIndex++
      }
    }
    out[i] = [...found].sort((a, b) => a - b)
  }
  return out
}

// map char
export function offsetToPdfLocation(offset, pdfMeta) {
  if (!pdfMeta || offset == null) return null
// page lookup
  const page = pdfMeta.pageOffsets?.find(po => offset >= po.start && offset <= po.end)?.page || null
  if (!page) return null
// item containing
  const item = pdfMeta.items?.find(it => offset >= it.startOffset && offset <= it.endOffset)
  if (!item) return { page }
// pdf text
// want viewport
  const [, , , , e, f] = item.transform
  const x = e
  const yFromBottom = f
  const y = item.viewportHeight - yFromBottom - item.height
  return {
    page,
    x,
    y,
    width: item.width,
    height: item.height,
    viewportWidth: item.viewportWidth,
    viewportHeight: item.viewportHeight,
  }
}

// determine best
// priority arxiv
export function refToQuery(parsed) {
  if (parsed.arxivId) return { type: 'arxiv', value: parsed.arxivId }
  if (parsed.doi) return { type: 'doi', value: parsed.doi }
// parsed title
  if (parsed.title && !looksLikeVenue(parsed.title) && parsed.title.length >= 6) {
    const cls = classify(parsed.title)
    return { type: cls.type, value: cls.value }
  }
// else fall
  const cleaned = parsed.raw
    .replace(/(https?:\/\/\S+)/g, ' ')
    .replace(/10\.\d{4,}\/[^\s,;]+/g, ' ')
    .replace(/arxiv:?\s*\d{4}\.\d{4,5}/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { type: 'title', value: cleaned.slice(0, 280) }
}

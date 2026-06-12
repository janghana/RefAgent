// agentic verification

// for each
// choose best
// multi source
// found llm
// output verdict

// design notes
// lenient default
// llm the
// and the
// concurrency throttled

import { fetchByDOI, fetchByArxiv, fetchByTitle } from './api.js'
import { chat, chatJSON, streamChat } from './llm.js'
import { refToQuery } from './extractor.js'
import { getSettings } from './store.js'

// agentic chain

// emits continuous
// can render
// verification work

// the thinking
// pipeline api
// verdict the

export async function runAgentLoop(parsedRefs, ctx) {
  const {
    paperTitle = '',
    onThink,
    onResult,
    strictness = 'lenient',
    signal,
  } = ctx

  const N = parsedRefs.length
// opening narration
  onThink?.(`\n<<AGENT:RefAgent>>\n`)
  const opener = `You are RefAgent — the main citation verifier. You're about to walk through ${N} references from a paper${paperTitle ? ` titled "${paperTitle}"` : ''}. After you finish, a CheckAgent will re-examine anything you couldn't verify, and a ContextAgent will check whether each verified ref actually makes sense in the sentence where it was cited.

You think out loud in English, casually, like a researcher narrating their work for a colleague who's watching. Use phrases like "Alright, ...", "Hmm, ...", "Let me see...", "Okay, that one's...", "Quick check on...", "Looking at...". Stay specific, never generic.

NEVER invent verdicts — you only describe what you're about to do. The actual verification happens in a separate deterministic step.

Open with something like: "Alright, ${N} references on the table. Let me start working through them."`
// the thinking
// feeding incremental
// simpler kick
// narrations between
  if (onThink) {
    try {
      await streamChat(
        [{ role: 'user', content: opener }],
        { onToken: onThink, signal, maxTokens: 220, temperature: 0.55 }
      )
    } catch (e) {  }
  }

// parallel verification
// per ref
// only api
// parallel deterministic
// min down
  const { concurrency = 3 } = ctx
  const indices = Array.from({ length: N }, (_, i) => i)
  let cursor = 0
  const worker = async () => {
    while (true) {
      if (signal?.aborted) return
      const i = cursor++
      if (i >= N) return
      const ref = parsedRefs[i]
      const refLabel = (ref.title || ref.raw || '').slice(0, 90)
// boundary marker
// out order
      onThink?.(`\n<<REF:${i + 1}|${refLabel.replace(/[|<>\n]/g, ' ').slice(0, 80)}>>\n`)
      const channel = ref.arxivId ? `arXiv ID ${ref.arxivId}` :
                       ref.doi ? `DOI ${ref.doi}` : 'title search'
      onThink?.(`Looking up ref #${i + 1} via ${channel}…\n`)
      let result
      try {
        result = await verifyOne(ref, { strictness, useLLM: false, signal })
      } catch (e) {
        result = { parsed: ref, candidate: null, verdict: 'suspicious', confidence: 0, reason: e.message || String(e) }
      }
      onResult?.(i, result)
// local one
      if (result.verdict === 'verified') {
        onThink?.(`✓ Verified: "${(result.candidate?.title || '').slice(0, 80)}"${result.candidate?.year ? ` (${result.candidate.year})` : ''}.\n`)
      } else if (result.verdict === 'suspicious') {
        onThink?.(`⚠ Suspicious: ${(result.reason || '').slice(0, 100)}.\n`)
      } else {
        onThink?.(`✗ Not found: ${(result.reason || '').slice(0, 100)}.\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))

  if (onThink) {
    try {
      await streamChat(
        [{ role: 'user', content: 'All references processed. In one short sentence, wrap up your run.' }],
        { onToken: onThink, signal, maxTokens: 60, temperature: 0.5 }
      )
    } catch {}
  }
}

// llm driven

// strategy feed
// sending the
// llama 70b

// rely findrefssectionstart
// fails fall
// always the

const LLM_CHUNK_LIMIT = 18_000
const LLM_CHUNK_OVERLAP = 1_200

function chunkText(text, size = LLM_CHUNK_LIMIT, overlap = LLM_CHUNK_OVERLAP) {
  if (text.length <= size) return [text]
  const chunks = []
  let i = 0
  while (i < text.length) {
    chunks.push(text.slice(i, i + size))
    if (i + size >= text.length) break
    i += size - overlap
  }
  return chunks
}

// throttle between
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

export async function extractReferencesLLM(fullText, { signal, onProgress, refsSectionStart = null } = {}) {
  const { provider } = getSettings()
  const generousBudget = provider === 'ollama' || provider === 'remote_ollama'
// always restrict
// llm grab
// bibliography entries
// reported entries
  let target
  if (refsSectionStart != null && refsSectionStart < fullText.length) {
    target = fullText.slice(refsSectionStart)
  } else {
    target = fullText.slice(Math.max(0, fullText.length - 35_000))
  }
  const chunkLimit = generousBudget ? 24_000 : 18_000
  const chunks = chunkText(target, chunkLimit, 1_500)
  const maxOut = generousBudget ? 8000 : 2500

  const all = []
  for (let ci = 0; ci < chunks.length; ci++) {
    onProgress?.({ stage: 'llm-extract', chunkIndex: ci + 1, totalChunks: chunks.length })
    const sys = `You extract entries from the reference list of academic papers. The input may use ANY citation style: numbered ([1], 1.), author-year-only ("Smith, J. and Lee, M. 2023. Title..."), or APA. Always return a JSON object: {"references": [...]}. Never invent. Never wrap in prose.`
    const user = `Below is the references / bibliography section of a research paper${chunks.length > 1 ? ` (chunk ${ci + 1}/${chunks.length})` : ''}.

The format may be ACL-style (no numbering, just "Authors. Year. Title. Venue."), IEEE-style (numbered [1]), APA, or anything else. Identify EVERY distinct reference entry.

A new entry starts when:
- A new index marker appears ([2], 2.), OR
- A new author surname (capitalized) appears after the previous entry's period/venue.

For each entry, return:
  { "title": <string>, "authors": <string|null>, "year": <number|null>,
    "doi": <string|null>, "arxivId": <string|null>, "venue": <string|null>,
    "raw": <the original entry text, ~50-300 chars>,
    "indexInList": <1-based position if numbered, else null> }

Important:
- For arxiv preprint references the format is often "...arXiv preprint arXiv:NNNN.NNNNN". Strip "arXiv:" prefix when filling arxivId.
- Strip trailing periods from titles. Capture multi-author author lists fully.
- If this chunk has zero reference-list entries return {"references": []}.

Output ONLY: {"references": [ ... ]}

TEXT:
${chunks[ci]}`

    try {
      const out = await chatJSON(
        [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        { temperature: 0, maxTokens: maxOut, signal }
      )
      const refs = Array.isArray(out.references) ? out.references : []
      for (const r of refs) {
        if (!r || !r.title) continue
// normalize identifiers
// arxivid arxiv
        let arxivId = r.arxivId ? String(r.arxivId) : ''
        const arxivM = arxivId.match(/(\d{4}\.\d{4,5})/)
        arxivId = arxivM ? arxivM[1] : ''
// doi doi
        let doi = r.doi ? String(r.doi) : ''
        const doiM = doi.match(/(10\.\d{4,}\/[^\s,]+)/)
        doi = doiM ? doiM[1].replace(/[.,;]$/, '') : ''
        all.push({
          raw: String(r.raw || r.title || ''),
          title: String(r.title || ''),
          authors: r.authors ? String(r.authors) : '',
          year: r.year ? String(r.year) : '',
          doi,
          arxivId,
          venue: r.venue ? String(r.venue) : '',
          indexInList: typeof r.indexInList === 'number' ? r.indexInList : null,
          sourceOffset: null,
        })
      }
    } catch (e) {
// soft fail
      console.warn('LLM extract chunk failed', e)
    }
// throttle between
    if (ci + 1 < chunks.length) await sleep(7000)
  }
// dedupe normalized
  const seen = new Set()
  const deduped = []
  for (const r of all) {
    const k = r.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 100)
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(r)
  }
  return deduped
}

// string similarity
function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }
function jaccard(a, b) {
  const wa = new Set((a || '').toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wb = new Set((b || '').toLowerCase().split(/\s+/).filter(w => w.length > 2))
  if (wa.size === 0 || wb.size === 0) return 0
  let inter = 0; for (const w of wa) if (wb.has(w)) inter++
  return inter / new Set([...wa, ...wb]).size
}
function titleSim(a, b) {
  const na = norm(a), nb = norm(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.85
  return jaccard(a, b)
}

// heuristic prejudgement
function quickVerdict(parsed, candidate) {
  if (!candidate) return null
// arxiv match
  if (parsed.arxivId && candidate.arxivId && parsed.arxivId.replace(/v\d+$/, '') === candidate.arxivId.replace(/v\d+$/, '')) {
    return { verdict: 'verified', confidence: 0.99, reason: 'arXiv ID exact match' }
  }
// doi match
  if (parsed.doi && candidate.doi && parsed.doi.toLowerCase() === candidate.doi.toLowerCase()) {
    return { verdict: 'verified', confidence: 0.99, reason: 'DOI exact match' }
  }
// high title
  const ts = titleSim(parsed.title || parsed.raw, candidate.title)
  if (ts >= 0.92) {
    if (parsed.year && candidate.year && String(parsed.year) === String(candidate.year)) {
      return { verdict: 'verified', confidence: 0.95, reason: 'Title exact + year match' }
    }
    return { verdict: 'verified', confidence: 0.9, reason: 'Title near-exact match' }
  }
  return null
}

// llm judge
async function llmJudge(parsed, candidate, strictness, signal) {
  const system = `You are a strict but practical academic citation verifier. Always respond with a single JSON object: {"verdict": "verified"|"suspicious"|"not_found", "confidence": 0.0-1.0, "reason": "<one sentence>"}.`
  const user = `Decide whether the CITED reference and the CANDIDATE refer to the SAME work.

CITED (raw text from the paper's reference list):
${(parsed.raw || '').slice(0, 600)}

CITED (parsed):
- title:  ${parsed.title || '(unknown)'}
- year:   ${parsed.year || '(unknown)'}
- doi:    ${parsed.doi || '(none)'}
- arxiv:  ${parsed.arxivId || '(none)'}
- venue:  ${parsed.venue || '(unknown)'}

CANDIDATE (from search):
- title:  ${candidate.title || ''}
- year:   ${candidate.year || ''}
- doi:    ${candidate.doi || '(none)'}
- arxiv:  ${candidate.arxivId || '(none)'}
- venue:  ${candidate.venue || candidate.journal || ''}
- authors: ${candidate.authors || ''}

Rules:
- Same work (titles match in meaning, authors/year roughly consistent) → "verified".
- Different version of the same work (arXiv vs published, year shift of 1) → "verified".
- Clearly different paper or unrelated → "not_found".
- Ambiguous (close but mismatched authors/year/venue, partial title) → "suspicious".
- Be ${strictness === 'lenient' ? 'LENIENT — most candidates should pass unless clearly wrong' : strictness === 'strict' ? 'STRICT — flag anything that does not align exactly' : 'BALANCED'}.`

  const out = await chatJSON(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.1, maxTokens: 200, signal }
  )
  const v = String(out.verdict || '').toLowerCase()
  const verdict = (v === 'verified' || v === 'suspicious' || v === 'not_found') ? v : 'suspicious'
  const confidence = typeof out.confidence === 'number' ? Math.max(0, Math.min(1, out.confidence)) : 0.5
  const reason = String(out.reason || '').slice(0, 240)
  return { verdict, confidence, reason }
}

// single reference
export async function verifyOne(parsed, { strictness = 'lenient', useLLM = true, signal } = {}) {
  const q = refToQuery(parsed)
  let candidate = null
  let fetchError = null
  try {
    if (q.type === 'arxiv') candidate = await fetchByArxiv(q.value)
    else if (q.type === 'doi') candidate = await fetchByDOI(q.value)
    else candidate = await fetchByTitle(q.value)
  } catch (e) {
    fetchError = e.message || String(e)
  }

// nothing found
  if (!candidate) {
    return {
      parsed,
      candidate: null,
      verdict: 'not_found',
      confidence: 0.9,
      reason: `No match in arXiv / CrossRef / Semantic Scholar${fetchError ? ` (${fetchError})` : ''}`,
    }
  }

// quick heuristic
  const quick = quickVerdict(parsed, candidate)
  if (quick) return { parsed, candidate, ...quick }

// strict lenient
  const ts = titleSim(parsed.title || parsed.raw, candidate.title)
// the candidate
// entirely showing
// engine sometimes
// the real
  if (ts < 0.45) {
    return {
      parsed,
      candidate: null,
      verdict: 'not_found',
      confidence: 0.85,
      reason: `No close match found (best candidate "${(candidate.title || '').slice(0, 60)}…" had only ${ts.toFixed(2)} title similarity)`,
    }
  }
// extra guard
// overlap high
// the candidate
  const queryTitle = parsed.title || ''
  if (queryTitle.length < 50 && /\?$/.test(queryTitle.trim())) {
    const lastWord = (s) => (s || '').replace(/[?.!,]+$/, '').trim().split(/\s+/).pop()?.toLowerCase() || ''
    if (lastWord(queryTitle) && lastWord(candidate.title) && lastWord(queryTitle) !== lastWord(candidate.title)) {
      return {
        parsed,
        candidate: null,
        verdict: 'not_found',
        confidence: 0.80,
        reason: `Short question-style title — candidate "${(candidate.title || '').slice(0, 60)}" ends in a different keyword than the cited title.`,
      }
    }
  }

// ambiguous ask
  if (useLLM) {
    try {
      const judged = await llmJudge(parsed, candidate, strictness, signal)
      return { parsed, candidate, ...judged }
    } catch (e) {
// llm unreachable
      if (ts >= 0.6) return { parsed, candidate, verdict: 'verified', confidence: 0.6, reason: `LLM unavailable; title similarity ${ts.toFixed(2)} → lenient pass (${e.message})` }
      if (ts >= 0.4) return { parsed, candidate, verdict: 'suspicious', confidence: 0.55, reason: `LLM unavailable; medium title similarity (${ts.toFixed(2)})` }
      return { parsed, candidate, verdict: 'not_found', confidence: 0.7, reason: `LLM unavailable; low title similarity (${ts.toFixed(2)})` }
    }
  }

// usellm false
  if (ts >= 0.7) return { parsed, candidate, verdict: 'verified', confidence: ts, reason: `title sim ${ts.toFixed(2)}` }
  if (ts >= 0.4) return { parsed, candidate, verdict: 'suspicious', confidence: ts, reason: `title sim ${ts.toFixed(2)}` }
  return { parsed, candidate, verdict: 'not_found', confidence: 1 - ts, reason: `title sim ${ts.toFixed(2)}` }
}

// batch verification
export async function verifyAll(parsedRefs, { strictness = 'lenient', useLLM = true, concurrency = 3, onProgress, signal } = {}) {
  const results = new Array(parsedRefs.length).fill(null)
  let cursor = 0
  let done = 0

  async function worker() {
    while (cursor < parsedRefs.length) {
      const i = cursor++
      if (signal?.aborted) return
      try {
        const r = await verifyOne(parsedRefs[i], { strictness, useLLM, signal })
        results[i] = r
      } catch (e) {
        results[i] = {
          parsed: parsedRefs[i], candidate: null,
          verdict: 'suspicious', confidence: 0,
          reason: `Verifier error: ${e.message || e}`,
        }
      }
      done++
      onProgress?.({ done, total: parsedRefs.length, index: i, result: results[i] })
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, parsedRefs.length)) }, () => worker())
  await Promise.all(workers)
  return results
}

// per ref
// rule based
// splits year
// hand each
// returns new
// heuristic does
// triggers retry
// here false
// mean the
export function titleLooksLikeVenue(title) {
  if (!title || title.length < 4) return false
  const t = title.trim()
// clear venue
  if (/^in\s+(?:[A-Z]|proceedings|advances|the\b)/i.test(t)) return true
  if (/^proceedings\s+(?:of|on)\b/i.test(t)) return true
  if (/^advances\s+in\b/i.test(t)) return true
  if (/^(?:international|annual|north american|european)\s+conference\b/i.test(t)) return true
  if (/^(?:journal|transactions|annals|nature|science|cell|lancet|new england journal)\s+(?:of|on)\b/i.test(t)) return true
// acronym only
  if (/^(?:ICLR|ICML|NeurIPS|NIPS|ACL|EMNLP|NAACL|CVPR|ECCV|ICCV|AAAI|IJCAI|KDD|WWW|SIGIR|EACL)(?:\s*,?\s*(?:19|20)\d{2})?\s*$/i.test(t)) return true
// ends with
  if (/,\s*(?:19|20)\d{2}\s*$/.test(t) && !/[?:]/.test(t)) {
    if (/\b(?:Conference|Workshop|Symposium|Journal|Transactions|Proceedings|Advances|International|Annual)\b/.test(t)) return true
  }
  return false
}

// heuristic does
// used flag
export function titleLooksLikeAuthors(title) {
  if (!title || title.length < 4) return false
  const t = title.trim()
// and others
  if (/,?\s+and\s+\d+\s+others\.?\s*$/i.test(t)) return true
  if (/\bet al\.?\s*$/i.test(t)) return true
// count first
// such patterns
// tripped lone
  const fullNameRe = /\b[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+/g
  const fullNames = (t.match(fullNameRe) || []).length
  if (fullNames >= 3) return true
// three first
  const initialedNames = (t.match(/\b[A-Z]\.\s*[A-Z][a-z]+/g) || []).length
  if (initialedNames >= 3) return true
// commas and
// avoid false
  const commaCount = (t.match(/,/g) || []).length
  const lower = ` ${t.toLowerCase()} `
  const stopwords = [' the ', ' of ', ' in ', ' on ', ' for ', ' to ', ' with ', ' via ', ' using ', ' from ', ' how ', ' as ', ' by ', ' an ', ' is ', ' are ']
  const hasStop = stopwords.some(s => lower.includes(s))
  if (commaCount >= 3 && !hasStop) return true
// multi letter
  const words = t.split(/\s+/).filter(Boolean).map(w => w.replace(/[.,;]$/, ''))
  const multi = words.filter(w => w.length >= 2)
  const namelike = multi.filter(w => /^[A-Z][A-Za-z\-']+$/.test(w))
  if (multi.length >= 5 && namelike.length / multi.length >= 0.6 && !hasStop) return true
  return false
}

// single ref
// batched pass
async function cleanupOneTitle(ref, { signal } = {}) {
  const result = await chatJSON(
    [
      {
        role: 'system',
        content: 'You extract the paper TITLE from a messy bibliography entry. Always return JSON. The title is the descriptive phrase about the paper itself — NEVER the authors, NEVER the venue.',
      },
      {
        role: 'user',
        content: `Below is one raw reference entry from a paper's bibliography. The title you returned earlier (${JSON.stringify(ref.title || '').slice(0, 200)}) looks like an author list. Look again at the raw text and find the actual paper title — it is the descriptive phrase that comes AFTER the author list and year, and BEFORE the venue.

Raw entry:
${(ref.raw || '').slice(0, 1500)}

Return ONLY: {"title": "<paper title>", "authors": "<authors comma-separated>", "year": <number>, "venue": "<venue or null>", "doi": <string or null>, "arxivId": <string or null>}`,
      },
    ],
    { temperature: 0, maxTokens: 600, signal }
  )
  return result
}

export async function cleanupTitlesLLM(refs, { signal, onProgress } = {}) {
  if (!refs.length) return refs
  const { provider } = getSettings()
// mac studio
// one slow
// batch larger
  const BATCH = (provider === 'remote_ollama' || provider === 'ollama') ? 1 : 8
  const out = refs.map(r => ({ ...r }))
  for (let start = 0; start < refs.length; start += BATCH) {
    if (signal?.aborted) break
    const batch = refs.slice(start, start + BATCH)
    onProgress?.({ done: start, total: refs.length })
    const items = batch.map((r, i) => ({ id: start + i, raw: (r.raw || '').slice(0, 600) }))
    let result = null
// retry once
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await chatJSON(
          [
            { role: 'system', content: 'You normalize messy academic reference entries. Always return JSON. Title must be ONLY the paper title — never the author list, never the venue. The venue is whatever the paper APPEARED IN (a conference, journal, or workshop). "Neural Computation", "ICLR", "Nature", "In Proceedings of X", "Advances in Y" are venue names, NEVER titles.' },
            { role: 'user', content: `Each input has a "raw" string from a paper bibliography. The string typically looks like:
"AuthorList. YEAR. Title. Venue. ..."  (ACL style)
or
"AuthorList. Title. Venue. YEAR."  (other styles)

The TITLE is the part that describes the paper (after the year-period, before the venue). It is NOT the author list. Even when the author list is huge (e.g. Llama 3 has 500+ authors), the title comes after.

For each entry below, extract:
{ "id": <copy the input id verbatim>, "title": <paper title as STRING>, "authors": <author list as STRING>, "year": <number>, "doi": <string|null>, "arxivId": <string|null>, "venue": <string|null> }

CRITICAL: you MUST copy "id" from each input entry into the output. The output array MUST have the same length and same order as the input. Authors MUST be a comma-separated string, NOT an array.

INPUT (JSON array):
${JSON.stringify(items, null, 2)}

Return ONLY: {"refs": [...]} ` },
          ],
          { temperature: 0, maxTokens: 5000, signal }
        )
        break
      } catch (e) {
        const msg = e?.message || ''
        if (attempt === 0 && /429|503|504|rate.?limit|too.?many|TPM/i.test(msg)) {
          await sleep(3500)
          continue
        }
        result = null
        break
      }
    }
    try {
      const arr = Array.isArray(result?.refs) ? result.refs : []
// apply index
      for (let k = 0; k < arr.length; k++) {
        const fixed = arr[k]
        if (!fixed) continue
        const fromId = typeof fixed.id === 'number' ? fixed.id : null
        const idx = fromId != null && out[fromId] ? fromId : (batch[k] ? batch[k].sourceOffset != null ? null : null : null)
// map when
        const targetIdx = fromId != null && out[fromId] ? fromId : (start + k)
        if (!out[targetIdx]) continue
        if (fixed.title && typeof fixed.title === 'string' && fixed.title.length > 4) {
// heal pdf
          out[targetIdx].title = fixed.title
            .replace(/(\w)-\s+(\w)/g, '$1$2')
            .replace(/^[\s.,;:]+|[\s.,;:]+$/g, '')
        }
        if (fixed.authors) {
          out[targetIdx].authors = Array.isArray(fixed.authors)
            ? fixed.authors.join(', ')
            : String(fixed.authors)
        }
        if (fixed.year) {
          const y = String(fixed.year).match(/\d{4}/)
          if (y) out[targetIdx].year = y[0]
        }
        if (fixed.doi && !out[targetIdx].doi) {
          const m = String(fixed.doi).match(/(10\.\d{4,}\/[^\s,]+)/)
          if (m) out[targetIdx].doi = m[1].replace(/[.,;]$/, '')
        }
        if (fixed.arxivId && !out[targetIdx].arxivId) {
          const m = String(fixed.arxivId).match(/(\d{4}\.\d{4,5})/)
          if (m) out[targetIdx].arxivId = m[1]
        }
        if (fixed.venue && !out[targetIdx].venue) out[targetIdx].venue = String(fixed.venue)
      }
    } catch (e) {
      console.warn('Title cleanup batch failed', e)
    }
  }
  onProgress?.({ done: refs.length, total: refs.length })

// heuristic fallback
// the proxy
  for (let i = 0; i < out.length; i++) {
    const r = out[i]
    if (r.title && r.title.length > 4 && !titleLooksLikeAuthors(r.title)) continue
    const raw = (r.raw || '').replace(/(\w)-\s+(\w)/g, '$1$2').replace(/\s+/g, ' ').trim()
    if (raw.length < 20) continue
// split followed
// titles like
// strip trailing
    const parts = raw.split(/(?<=[.?!])\s+/)
      .map(p => p.trim().replace(/[.,;]$/, ''))
      .filter(Boolean)
    if (parts.length < 2) continue
// helper segment
    const isVenue = (p) => titleLooksLikeVenue(p) || /^(?:in\s+[A-Z]|proceedings\b|advances\b|journal\b|transactions\b|ieee\b|acm\b|arxiv\b|corr\b|conference\b|workshop\b|pages?\b|vol(?:ume)?\b|\d{4}\b)/i.test(p)
// trim trailing
    const trimVenue = (t) => {
      const m = t.match(/^(.+?[?!])\s+(?:In\s+|Proceedings\s|Advances\s)/i)
      if (m) return m[1].trim()
      const m2 = t.match(/^(.+?)\s+In\s+(?:Proceedings|Advances|the\s)/i)
      if (m2 && m2[1].length > 8) return m2[1].trim()
      return t
    }
// acl pattern
    const yIdx = parts.findIndex(p => /^(19|20)\d{2}[a-z]?$/.test(p))
    if (yIdx >= 0 && yIdx + 1 < parts.length) {
      const cand = trimVenue(parts[yIdx + 1])
      if (cand && cand.length > 8 && !titleLooksLikeAuthors(cand) && !isVenue(cand)) {
        out[i].title = cand
        if (!out[i].authors && yIdx > 0) {
          out[i].authors = parts.slice(0, yIdx).join(', ').slice(0, 240)
        }
        if (!out[i].year) out[i].year = parts[yIdx]
        continue
      }
    }
// otherwise take
    let best = '', bestScore = 0
    for (let p of parts) {
      if (titleLooksLikeAuthors(p)) continue
      if (isVenue(p)) continue
      const cand = trimVenue(p)
      if (titleLooksLikeAuthors(cand) || isVenue(cand)) continue
      const score = cand.length + (/^[A-Z]/.test(cand) ? 50 : 0)
      if (score > bestScore && cand.length > 8) { best = cand; bestScore = score }
    }
    if (best) out[i].title = best
  }

// self critique
// identify refs
// with focused
  const needsRetry = []
  for (let i = 0; i < out.length; i++) {
    const t = out[i].title
    if (titleLooksLikeAuthors(t) || titleLooksLikeVenue(t)) needsRetry.push(i)
  }
  if (needsRetry.length > 0) {
    onProgress?.({ done: 0, total: needsRetry.length, stage: 'retry' })
    for (let j = 0; j < needsRetry.length; j++) {
      if (signal?.aborted) break
      const i = needsRetry[j]
      try {
        const fixed = await cleanupOneTitle(out[i], { signal })
        if (fixed?.title && typeof fixed.title === 'string' && fixed.title.length > 4
            && !titleLooksLikeAuthors(fixed.title) && !titleLooksLikeVenue(fixed.title)) {
          out[i].title = fixed.title
            .replace(/(\w)-\s+(\w)/g, '$1$2')
            .replace(/^[\s.,;:]+|[\s.,;:]+$/g, '')
        }
        if (fixed?.authors) {
          out[i].authors = Array.isArray(fixed.authors) ? fixed.authors.join(', ') : String(fixed.authors)
        }
        if (fixed?.year) {
          const y = String(fixed.year).match(/\d{4}/)
          if (y) out[i].year = y[0]
        }
        if (fixed?.venue && !out[i].venue) out[i].venue = String(fixed.venue)
        if (fixed?.doi && !out[i].doi) {
          const m = String(fixed.doi).match(/(10\.\d{4,}\/[^\s,]+)/)
          if (m) out[i].doi = m[1].replace(/[.,;]$/, '')
        }
        if (fixed?.arxivId && !out[i].arxivId) {
          const m = String(fixed.arxivId).match(/(\d{4}\.\d{4,5})/)
          if (m) out[i].arxivId = m[1]
        }
      } catch (e) {  }
      onProgress?.({ done: j + 1, total: needsRetry.length, stage: 'retry' })
    }
  }
  return out
}

// llm based
export async function extractTitleLLM(firstPageText, { signal } = {}) {
  if (!firstPageText || firstPageText.trim().length < 20) return ''
  try {
    const out = await chatJSON(
      [
        { role: 'system', content: 'You extract the exact paper title from the first page of an academic PDF. Return JSON: {"title": "<the paper title verbatim>"}. Do not include authors, affiliations, or section headings.' },
        { role: 'user', content: `Below is the raw text of the first page of an academic paper. Identify ONLY the paper's title (usually the largest text near the top). Return a JSON object {"title": "<exact title>"}.

FIRST PAGE TEXT:
${firstPageText.slice(0, 2200)}` },
      ],
      { temperature: 0, maxTokens: 200, signal }
    )
    const t = typeof out.title === 'string' ? out.title.trim() : ''
    return t.slice(0, 280)
  } catch (e) {
    console.warn('LLM title extract failed', e)
    return ''
  }
}

// helpers exposed
export function summarize(results) {
  const sum = { verified: 0, suspicious: 0, not_found: 0, total: results.length }
  for (const r of results) if (r && sum[r.verdict] !== undefined) sum[r.verdict]++
  return sum
}

// second pass
// after the
// suspicious entry
// suggest corrected
// api verification
// the entry

// the agent
// the can
export async function refCheckerAgent(results, parsedRefs, { signal, onThink, onResult } = {}) {
  const out = results.map(r => r ? { ...r } : null)
  const targets = []
  for (let i = 0; i < out.length; i++) {
    const r = out[i]
    if (!r) continue
    if (r.verdict === 'verified') continue
    targets.push({ idx: i, parsed: parsedRefs[i] || r.parsed })
  }
  onThink?.(`\n<<AGENT:CheckAgent>>\n`)
  if (targets.length === 0) {
    onThink?.(`[CheckAgent] Everything verified on the first pass. Nothing to recheck.\n`)
    return out
  }

  onThink?.(`[CheckAgent] CheckAgent here. RefAgent flagged ${targets.length} entr${targets.length === 1 ? 'y' : 'ies'} as not_found or suspicious. I'll re-read each raw entry and see if the title was misread.\n`)

  for (const t of targets) {
    onThink?.(`\n<<REF:${t.idx + 1}|${((t.parsed.title || t.parsed.raw || '').slice(0, 80)).replace(/[|<>\n]/g, ' ')}|CheckAgent>>\n`)
    if (signal?.aborted) return out
    const i = t.idx
    const parsed = t.parsed
    const raw = (parsed.raw || '').slice(0, 600)
    const wrongTitle = (parsed.title || '').slice(0, 100)

    onThink?.(`[CheckAgent] Reference #${i + 1}: previous title was "${wrongTitle || '(empty)'}".\n`)

    let suggested
    try {
      const result = await chatJSON(
        [
          {
            role: 'system',
            content: 'You re-extract the paper TITLE from a messy bibliography entry. The previous extraction got it wrong. The title is the descriptive phrase about the PAPER ITSELF — not the authors, not the venue (Neural Computation, ICLR, Advances in NIPS, Proceedings of X), not a page-range fragment. Return JSON only.',
          },
          {
            role: 'user',
            content: `Below is one raw reference entry from a paper's bibliography. The earlier title extraction returned "${wrongTitle}", which looks wrong. Re-extract the true paper title.

Raw entry:
${raw}

Return: {"title": "<paper title>", "authors": "<authors comma-separated>", "year": <number>}`,
          },
        ],
        { temperature: 0, maxTokens: 400, signal }
      )
      suggested = result
    } catch (e) {
      onThink?.(`[CheckAgent] Couldn't reach the LLM for #${i + 1}, moving on. (${e.message || e})\n`)
      continue
    }

    const newTitle = suggested?.title && typeof suggested.title === 'string'
      ? suggested.title.replace(/(\w)-\s+(\w)/g, '$1$2').replace(/^[\s.,;:]+|[\s.,;:]+$/g, '')
      : ''
    if (!newTitle || newTitle.length < 6 || newTitle.toLowerCase() === (wrongTitle || '').toLowerCase()) {
      onThink?.(`[CheckAgent] Couldn't find a better title for #${i + 1}.\n`)
      continue
    }
    onThink?.(`[CheckAgent] I think the real title for #${i + 1} is "${newTitle}". Let me re-verify it.\n`)

// verify with
    const reParsed = { ...parsed, title: newTitle, authors: suggested.authors || parsed.authors, year: (suggested.year && String(suggested.year).match(/\d{4}/)?.[0]) || parsed.year }
    try {
      const reVerdict = await verifyOne(reParsed, { strictness: 'lenient', useLLM: false, signal })
      if (reVerdict.verdict === 'verified') {
        out[i] = {
          ...reVerdict,
          parsed: reParsed,
// tag the
          recheckedBy: 'refchecker',
        }
        onThink?.(`[CheckAgent] ✓ Got it. #${i + 1} now verifies as "${(reVerdict.candidate?.title || newTitle).slice(0, 80)}".\n`)
        onResult?.(i, out[i])
        continue
      }
    } catch {}
    onThink?.(`[CheckAgent] Tried the new title for #${i + 1} but the APIs still don't recognize it. Probably a real-but-uncataloged paper.\n`)
  }
  onThink?.(`[CheckAgent] Done. Handed control back.\n`)
  return out
}

// final context
// after all
// the llm
// that the
// needs human
// probably not

// adds two
// severityreason
export async function classifySeverityLLM(results, { signal, onProgress } = {}) {
  const out = results.map(r => r ? { ...r } : null)
// pick ambiguous
  const targets = []
  for (let i = 0; i < out.length; i++) {
    const r = out[i]
    if (!r) continue
    if (r.verdict === 'verified') continue
    targets.push({ idx: i, parsed: r.parsed, candidate: r.candidate, verdict: r.verdict, reason: r.reason })
  }
  if (targets.length === 0) return out
// batch
  const BATCH = 10
  for (let s = 0; s < targets.length; s += BATCH) {
    if (signal?.aborted) break
    const batch = targets.slice(s, s + BATCH)
    const items = batch.map(t => ({
      id: t.idx,
      cited_title: (t.parsed.title || t.parsed.raw || '').slice(0, 200),
      cited_year: t.parsed.year || null,
      cited_authors: (t.parsed.authors || '').slice(0, 200),
      verdict: t.verdict,
      candidate_title: t.candidate?.title || null,
      candidate_year: t.candidate?.year || null,
    }))
    onProgress?.({ done: s, total: targets.length })
    try {
      const result = await chatJSON(
        [
          {
            role: 'system',
            content: `You judge whether unverified references in an academic bibliography look REAL (just missed by metadata APIs) or FABRICATED (no such paper exists). Always return JSON: {"items": [{"id": <int>, "severity": "review" | "critical", "reason": "<one sentence>"}]}.`,
          },
          {
            role: 'user',
            content: `For each unverified reference below, decide:
- "review" — looks like a plausible real paper. Maybe the title slot has noise, or the API just doesn't index it. Human can re-verify.
- "critical" — title sounds vague, generic, made-up, or impossibly weird; year/authors don't compose into a real-looking paper.

Use ONLY the cited title, year, authors. Be lenient — if it could plausibly exist, prefer "review".

INPUT:
${JSON.stringify(items, null, 2)}

Return ONLY: {"items": [...]} `,
          },
        ],
        { temperature: 0, maxTokens: 1500, signal }
      )
      const arr = Array.isArray(result?.items) ? result.items : []
      for (const j of arr) {
        const idx = j.id
        if (typeof idx !== 'number' || !out[idx]) continue
        const sev = j.severity === 'critical' ? 'critical' : 'review'
        out[idx].severity = sev
        out[idx].severityReason = String(j.reason || '').slice(0, 200)
      }
    } catch (e) {
      console.warn('severity classify failed', e)
    }
  }
  onProgress?.({ done: targets.length, total: targets.length })
  return out
}

// context fit

// for each
// the surrounding
// sense being
// neural networks

// this catches
// real but

// never look
// result fields
// contextfit fits
// contextfitreason one
export async function contextFitCheckLLM(results, inlineHits, docText, { signal, onProgress, onThink } = {}) {
  const out = results.map(r => r ? { ...r } : null)
  if (!docText || !inlineHits || inlineHits.length === 0) return out

  const targets = []
  for (let i = 0; i < out.length; i++) {
    const r = out[i]
    if (!r || r.verdict !== 'verified') continue
    const hits = inlineHits[i] || []
    if (hits.length === 0) continue
// first citation
    const offset = hits[0]
    const start = Math.max(0, offset - 280)
    const end = Math.min(docText.length, offset + 80)
    const context = docText.slice(start, end).replace(/\s+/g, ' ').trim()
    const title = (r.candidate?.title || r.parsed?.title || '').slice(0, 200)
    if (!title || context.length < 60) continue
    targets.push({ idx: i, title, context })
  }
  if (targets.length === 0) return out

  onThink?.(`\n<<AGENT:ContextAgent>>\n`)
  onThink?.(`[ContextAgent] ContextAgent here. RefAgent verified ${targets.length} entries. Let me read the sentences around each citation and decide whether the paper actually fits.\n`)
  onProgress?.({ stage: 'context-fit', done: 0, total: targets.length })

  const BATCH = 6
  for (let s = 0; s < targets.length; s += BATCH) {
    if (signal?.aborted) break
    const batch = targets.slice(s, s + BATCH)
    const items = batch.map(t => ({ id: t.idx, title: t.title, context: t.context.slice(0, 500) }))
    try {
      const result = await chatJSON(
        [
          {
            role: 'system',
            content: 'You judge whether a cited paper TITLE makes topical sense in the SENTENCE where it is cited. You do not need to know the paper; reason from title and surrounding wording. Return JSON only.',
          },
          {
            role: 'user',
            content: `For each item, decide:
- "fits"     — the paper title is plausibly relevant to the surrounding sentence (matches topic, method, finding, or definition being discussed).
- "mismatch" — the title is clearly off-topic for the surrounding sentence (e.g. "clinical depression scale" cited in a sentence about graph convolutional networks).

Be lenient — only flag CLEAR mismatches. If the topic could plausibly relate (even tangentially), say "fits". One short sentence reason.

INPUT:
${JSON.stringify(items, null, 2)}

Return ONLY: {"items":[{"id":<int>,"fit":"fits"|"mismatch","reason":"<one short sentence>"}]}`,
          },
        ],
        { temperature: 0, maxTokens: 1200, signal }
      )
      const arr = Array.isArray(result?.items) ? result.items : []
      for (const j of arr) {
        const idx = j.id
        if (typeof idx !== 'number' || !out[idx]) continue
        out[idx].contextFit = j.fit === 'mismatch' ? 'mismatch' : 'fits'
        out[idx].contextFitReason = String(j.reason || '').slice(0, 240)
        const title = out[idx].candidate?.title?.slice(0, 60) || ''
        onThink?.(`\n<<REF:${idx + 1}|${title.replace(/[|<>\n]/g, ' ')}|ContextAgent>>\n`)
        if (out[idx].contextFit === 'mismatch') {
          onThink?.(`[ContextAgent] #${idx + 1} "${title}" — ❌ off-topic: ${out[idx].contextFitReason}\n`)
        } else {
          onThink?.(`[ContextAgent] #${idx + 1} "${title}" — ✓ fits: ${out[idx].contextFitReason}\n`)
        }
      }
    } catch (e) {
      console.warn('context-fit failed', e)
    }
    onProgress?.({ stage: 'context-fit', done: Math.min(s + BATCH, targets.length), total: targets.length })
  }
  onThink?.(`[ContextAgent] Done. ${out.filter(r => r?.contextFit === 'mismatch').length} flagged as topical mismatch.\n`)
  return out
}

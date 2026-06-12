import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import * as store from './store.js'
import { parseFile } from './parser.js'
import {
  extractReferences, offsetToPdfLocation,
  findInlineCitations, findRefsSectionStart, backfillSourceOffsets, mergeRefs,
} from './extractor.js'
import { verifyAll, summarize, extractReferencesLLM, extractTitleLLM, runAgentLoop, cleanupTitlesLLM, classifySeverityLLM, refCheckerAgent, verifyOne as agentVerifyOne } from './agent.js'
import { streamChat as llmStreamChat, chat as llmChat, chatJSON as llmChatJSON } from './llm.js'
import { checkProvider, getLastRateLimit } from './llm.js'
import {
  formatBib, formatNumbered, formatAPA, formatMLA,
  formatChicago, formatVancouver, formatIEEE, formatRIS, formatRefWorks,
} from './api.js'
import PDFViewer from './PDFViewer.jsx'
import './index.css'

const FORMATS = {
  bib: { label: 'BibTeX', fn: formatBib, ext: '.bib' },
  numbered: { label: 'Numbered', fn: formatNumbered, ext: '.txt' },
  apa: { label: 'APA', fn: formatAPA, ext: '.txt' },
  mla: { label: 'MLA', fn: formatMLA, ext: '.txt' },
  chicago: { label: 'Chicago', fn: formatChicago, ext: '.txt' },
  vancouver: { label: 'Vancouver', fn: formatVancouver, ext: '.txt' },
  ieee: { label: 'IEEE', fn: formatIEEE, ext: '.txt' },
  ris: { label: 'EndNote (RIS)', fn: formatRIS, ext: '.ris' },
  refworks: { label: 'RefWorks', fn: formatRefWorks, ext: '.txt' },
}

// atoms
const Spinner = ({ size = 12 }) => (
  <span style={{ display: 'inline-block', width: size, height: size, border: `2px solid #bfdbfe`, borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin .5s linear infinite' }} />
)

function VerdictPill({ v, small }) {
  const map = {
    verified: { bg: '#dcfce7', fg: '#15803d', label: 'Verified' },
    suspicious: { bg: '#fef3c7', fg: '#a16207', label: 'Suspicious' },
    not_found: { bg: '#fee2e2', fg: '#b91c1c', label: 'Not found' },
    pending: { bg: '#f1f5f9', fg: '#475569', label: '...' },
  }
  const c = map[v] || map.pending
  return <span style={{ fontSize: small ? 9 : 10, fontWeight: 700, padding: small ? '1px 5px' : '2px 7px', borderRadius: 4, background: c.bg, color: c.fg }}>{c.label}</span>
}

// sidebar light
function Sidebar({ projects, activeId, onSelect, onDelete, onNew, providerStatus, onSettings, rateLimit, alertItems, inlineHits, focusedIdx, onAlertClick, onAlertDownload, currentPaperTitle, currentFileName, folders, activeFolderId, onSelectFolder, onCreateFolder, onRenameFolder, onDeleteFolder }) {
  return (
    <div style={{ width: 240, minWidth: 240, height: '100vh', background: '#f8fafc', borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 14px 12px', borderBottom: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: 'linear-gradient(135deg,#3b82f6,#60a5fa)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>🔎</div>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', letterSpacing: '-0.02em' }}>RefAgent</span>
        </div>
        {currentPaperTitle ? (
          <div title={currentPaperTitle}
            style={{
              fontSize: 11, fontWeight: 600, color: '#1e293b', lineHeight: 1.35, marginTop: 6,
              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>
            {currentPaperTitle}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: '#64748b' }}>Agentic citation verifier</div>
        )}
        {currentPaperTitle && currentFileName && (
          <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentFileName}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, margin: '10px 12px' }}>
        <button onClick={onNew}
          style={{ flex: 1, padding: '8px 8px', background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: 'white', border: 'none', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 2px 8px rgba(37,99,235,0.18)' }}>
          + New verification
        </button>
        <button onClick={onCreateFolder} title="Create folder"
          style={{ padding: '8px 10px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
          📁+
        </button>
      </div>

      
      {folders.length > 0 && (
        <div style={{ padding: '0 8px 6px' }}>
          <div onClick={() => onSelectFolder(null)}
            style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: activeFolderId === null ? '#1d4ed8' : '#64748b', background: activeFolderId === null ? '#eff6ff' : 'transparent' }}>
            <span>📥</span><span style={{ flex: 1 }}>All / Inbox</span>
          </div>
          {folders.map(f => (
            <div key={f.id} onClick={() => onSelectFolder(f.id)}
              style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: activeFolderId === f.id ? '#1d4ed8' : '#475569', background: activeFolderId === f.id ? '#eff6ff' : 'transparent' }}>
              <span>📁</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <button onClick={(e) => { e.stopPropagation(); onRenameFolder(f.id, f.name) }}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 10, padding: 0 }}>✎</button>
              <button onClick={(e) => { e.stopPropagation(); onDeleteFolder(f.id) }}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 10, padding: 0 }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: '0 14px', fontSize: 9, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        {activeFolderId ? folders.find(f => f.id === activeFolderId)?.name || 'Folder' : 'History'}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px', minHeight: 0 }}>
        {(() => {
          const visible = projects.filter(p => activeFolderId == null ? !p.folderId : p.folderId === activeFolderId)
          if (visible.length === 0) return <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', padding: 20 }}>No verifications yet</div>
          return null
        })()}
        {projects.filter(p => activeFolderId == null ? !p.folderId : p.folderId === activeFolderId).map(p => {
          const isActive = p.id === activeId
          return (
            <div key={p.id} onClick={() => onSelect(p.id)}
              style={{
                padding: '8px 10px', borderRadius: 6, marginBottom: 2, cursor: 'pointer',
                background: isActive ? '#eff6ff' : 'transparent',
                border: isActive ? '1px solid #bfdbfe' : '1px solid transparent',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#f1f5f9' }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: isActive ? '#1d4ed8' : '#1e293b', lineHeight: 1.3,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                    title={p.paperTitle || p.fileName}>
                    {p.paperTitle || p.fileName || p.name}
                  </div>
                  {p.paperTitle && <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.fileName}</div>}
                </div>
                <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete this verification?')) onDelete(p.id) }}
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 11, padding: 2 }}>✕</button>
              </div>
              {p.summary && (
                <div style={{ display: 'flex', gap: 6, marginTop: 4, fontSize: 9 }}>
                  <span style={{ color: '#15803d' }}>✓ {p.summary.verified}</span>
                  {p.summary.suspicious > 0 && <span style={{ color: '#a16207' }}>⚠ {p.summary.suspicious}</span>}
                  {p.summary.not_found > 0 && <span style={{ color: '#b91c1c' }}>✗ {p.summary.not_found}</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      
      {alertItems && alertItems.length > 0 && (
        <div style={{ borderTop: '1px solid #fcd34d', background: '#fef3c7', display: 'flex', flexDirection: 'column', maxHeight: '38vh' }}>
          <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#92400e' }}>⚠ Needs review</span>
            <span className="mono" style={{ fontSize: 10, color: '#a16207' }}>{alertItems.length}</span>
            <div style={{ flex: 1 }} />
            <button onClick={onAlertDownload}
              style={{ background: 'white', color: '#a16207', border: '1px solid #fcd34d', borderRadius: 4, fontSize: 9, padding: '2px 7px', cursor: 'pointer', fontFamily: 'inherit' }}>
              ↓ Report
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #fde68a' }}>
            {alertItems.map(({ r, i }) => {
              const isCritical = r.severity === 'critical'
              const dotColor = isCritical ? '#ef4444' : '#3b82f6'
              return (
                <div key={i} onClick={() => onAlertClick(i)}
                  style={{ padding: '6px 12px', borderBottom: '1px solid #fde68a', cursor: 'pointer', display: 'flex', gap: 6, background: focusedIdx === i ? '#fde68a' : 'transparent' }}>
                  <span title={isCritical ? 'Likely fabrication — check immediately' : 'Worth a human re-check'}
                    style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: dotColor, marginTop: 4, flexShrink: 0, boxShadow: `0 0 0 2px ${dotColor}22` }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: '#451a03', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      #{i + 1} · {r.candidate?.title || r.parsed.title || r.parsed.raw.slice(0, 60)}
                    </div>
                    {r.severityReason && (
                      <div style={{ fontSize: 9, color: isCritical ? '#b91c1c' : '#1d4ed8', marginTop: 2, lineHeight: 1.3 }}>
                        {r.severityReason}
                      </div>
                    )}
                    {inlineHits?.[i]?.length > 0 && (
                      <div style={{ fontSize: 9, color: '#2563eb' }}>↗ {inlineHits[i].length} inline</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      
      <div style={{ borderTop: '1px solid #e2e8f0', padding: '10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: providerStatus?.ok ? '#15803d' : '#b91c1c' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: providerStatus?.ok ? '#22c55e' : '#ef4444' }} />
          <span style={{ flex: 1, fontWeight: 600 }}
            title={
              providerStatus?.provider === 'groq' ? 'Groq (cloud)' :
              providerStatus?.provider === 'remote_ollama' ? 'Mac Studio (tunnel)' :
              providerStatus?.provider === 'ollama' ? 'Ollama (your local)' :
              'unknown provider'
            }>
            RefAgent
            {providerStatus?.ok ? ' · online' : ` · ${providerStatus?.reason || 'offline'}`}
          </span>
          <button onClick={onSettings} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12 }}>⚙</button>
        </div>
        {providerStatus?.provider === 'groq' && rateLimit && (rateLimit.remainingRequests != null || rateLimit.remainingTokens != null) && (
          <RateLimitMini rl={rateLimit} />
        )}
      </div>
    </div>
  )
}

function RateLimitMini({ rl }) {
  const pctR = rl.limitRequests > 0 ? Math.round(100 * (rl.remainingRequests / rl.limitRequests)) : null
  const pctT = rl.limitTokens > 0 ? Math.round(100 * (rl.remainingTokens / rl.limitTokens)) : null
  return (
    <div style={{ marginTop: 6, fontSize: 9, color: '#64748b', display: 'flex', flexDirection: 'column', gap: 3 }}>
      {pctR !== null && (
        <div title={`${rl.remainingRequests}/${rl.limitRequests} requests · resets ${rl.resetRequests || '?'}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Req</span><span>{pctR}%</span></div>
          <div style={{ height: 3, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${pctR}%`, height: '100%', background: pctR < 20 ? '#ef4444' : '#22c55e' }} />
          </div>
        </div>
      )}
      {pctT !== null && (
        <div title={`${rl.remainingTokens}/${rl.limitTokens} tokens · resets ${rl.resetTokens || '?'}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Tok</span><span>{pctT}%</span></div>
          <div style={{ height: 3, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${pctT}%`, height: '100%', background: pctT < 20 ? '#ef4444' : '#22c55e' }} />
          </div>
        </div>
      )}
    </div>
  )
}

// settings dialog
function SettingsDialog({ settings, onSave, onClose, providerStatus }) {
  const [draft, setDraft] = useState(settings)
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 12, padding: 24, width: 480, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', marginBottom: 14 }}>Settings</div>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, fontSize: 12, alignItems: 'center' }}>
          <label style={{ color: '#475569' }}>Provider</label>
          <select value={draft.provider} onChange={e => setDraft({ ...draft, provider: e.target.value })} style={inp}>
            <option value="groq">Groq (cloud, free tier)</option>
            <option value="remote_ollama">Mac Studio (shared via tunnel)</option>
            <option value="ollama">Ollama (your own local)</option>
          </select>

          {draft.provider === 'groq' && (
            <>
              <label style={{ color: '#475569' }}>Groq model</label>
              <select value={draft.groqModel} onChange={e => setDraft({ ...draft, groqModel: e.target.value })} style={inp}>
                <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>
                <option value="llama-3.1-8b-instant">llama-3.1-8b-instant</option>
                <option value="mixtral-8x7b-32768">mixtral-8x7b-32768</option>
                <option value="gemma2-9b-it">gemma2-9b-it</option>
              </select>
            </>
          )}

          {draft.provider === 'remote_ollama' && (
            <>
              <label style={{ color: '#475569' }}>Shared model</label>
              <input value={draft.remoteOllamaModel || ''} onChange={e => setDraft({ ...draft, remoteOllamaModel: e.target.value })}
                list="remote-model-suggestions" style={inp} placeholder="medgemma:27b" />
              <datalist id="remote-model-suggestions">
                {(providerStatus?.models || []).map(m => <option key={m} value={m} />)}
              </datalist>
            </>
          )}

          {draft.provider === 'ollama' && (
            <>
              <label style={{ color: '#475569' }}>Ollama URL</label>
              <input value={draft.ollamaUrl} onChange={e => setDraft({ ...draft, ollamaUrl: e.target.value })} style={inp} />
              <label style={{ color: '#475569' }}>Ollama model</label>
              <input value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })}
                list="model-suggestions" style={inp} placeholder="gemma3:27b" />
              <datalist id="model-suggestions">
                {(providerStatus?.models || []).map(m => <option key={m} value={m} />)}
              </datalist>
            </>
          )}

          <label style={{ color: '#475569' }}>Extraction</label>
          <select value={draft.extractionMode} onChange={e => setDraft({ ...draft, extractionMode: e.target.value })} style={inp}>
            <option value="llm">LLM-driven (most accurate)</option>
            <option value="rule">Rule-based (fast, no LLM call)</option>
          </select>

          <label style={{ color: '#475569' }}>Strictness</label>
          <select value={draft.strictness} onChange={e => setDraft({ ...draft, strictness: e.target.value })} style={inp}>
            <option value="lenient">Lenient — pass most refs</option>
            <option value="normal">Normal</option>
            <option value="strict">Strict — flag any mismatch</option>
          </select>

          <label style={{ color: '#475569' }}>Concurrency</label>
          <input type="number" min={1} max={6} value={draft.concurrency} onChange={e => setDraft({ ...draft, concurrency: Math.max(1, Math.min(6, parseInt(e.target.value) || 2)) })} style={inp} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => onSave(draft)} style={btnPrimary}>Save</button>
        </div>
      </div>
    </div>
  )
}

const inp = { padding: '6px 9px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, fontFamily: 'inherit' }
const btnPrimary = { padding: '7px 16px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
const btnSecondary = { padding: '7px 16px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }

// chatpanel user
// split thinktext
// returns segments
// kind opener
// kind agent
// kind ref
function splitThinkByRef(thinkText) {
  if (!thinkText) return []
  const segments = []
  let currentAgent = 'RefAgent'
  let currentRef = null
  let buffer = []
  const flushBuffer = () => {
    if (currentRef) {
      currentRef.text = buffer.join('\n').trim()
      segments.push(currentRef)
      currentRef = null
    } else if (buffer.length > 0) {
      const content = buffer.join('\n').trim()
      if (content) {
// attach most
        const lastAgent = [...segments].reverse().find(s => s.kind === 'agent')
        if (lastAgent && !lastAgent.intro) lastAgent.intro = content
        else segments.push({ kind: 'opener', text: content })
      }
    }
    buffer = []
  }
  const lines = thinkText.split('\n')
  for (const line of lines) {
    const agentMatch = line.match(/^<<AGENT:([A-Za-z]+)>>$/)
    const refMatch = line.match(/^<<REF:(\d+)\|([^|>]*)(?:\|([A-Za-z]+))?>>$/)
    if (agentMatch) {
      flushBuffer()
      currentAgent = agentMatch[1]
      segments.push({ kind: 'agent', name: currentAgent, intro: '' })
    } else if (refMatch) {
      flushBuffer()
      currentRef = {
        kind: 'ref',
        num: parseInt(refMatch[1], 10),
        label: refMatch[2] || '',
        agent: refMatch[3] || currentAgent,
        text: '',
      }
    } else {
      buffer.push(line)
    }
  }
  flushBuffer()
  return segments
}

const AGENT_STYLES = {
  RefAgent:     { bg: 'linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)', border: '#cbd5e1', label: '🔍', color: '#1e40af' },
  CheckAgent:   { bg: 'linear-gradient(180deg, #faf5ff 0%, #f3e8ff 100%)', border: '#d8b4fe', label: '🔁', color: '#7e22ce' },
  ContextAgent: { bg: 'linear-gradient(180deg, #ecfdf5 0%, #d1fae5 100%)', border: '#86efac', label: '🧭', color: '#047857' },
}

function RateLimitBanner({ until, onDone }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])
  const remaining = Math.max(0, Math.ceil((until - now) / 1000))
  useEffect(() => { if (remaining === 0) onDone?.() }, [remaining])
  if (remaining === 0) return null
  return (
    <div style={{ padding: '8px 12px', background: '#fef3c7', borderBottom: '1px solid #fde68a', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#92400e' }}>
      <span style={{ fontSize: 14 }}>⏳</span>
      <span style={{ flex: 1 }}>
        <strong>Semantic Scholar rate-limited</strong> — auto-retry in <strong>{remaining}s</strong>
      </span>
    </div>
  )
}

function ChatPanel({ messages, thinkText, phase, input, onInputChange, onSend, busy, progress, counts, statusLine, rateLimitUntil, onRateLimitDone }) {
  const scrollRef = useRef(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, thinkText])
  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() } }
  const active = phase === 'parsing' || phase === 'extracting' || phase === 'verifying'
  const showProgress = active && progress && progress.total > 0
  const pct = showProgress ? (progress.done / progress.total) * 100 : 0
  const thinkSegments = splitThinkByRef(thinkText)
  return (
    <>
      
      {showProgress && (
        <div style={{ padding: '8px 12px', background: '#eff6ff', borderBottom: '1px solid #bfdbfe' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#1e40af', marginBottom: 4 }}>
            <Spinner size={10} />
            <span style={{ fontWeight: 700 }}>{progress.done}/{progress.total}</span>
            <span style={{ color: '#64748b', fontSize: 10 }}>({pct.toFixed(0)}%)</span>
            <div style={{ flex: 1 }} />
            {counts && (
              <div style={{ display: 'flex', gap: 8, fontSize: 10, fontWeight: 600 }}>
                <span style={{ color: '#15803d' }}>✓ {counts.verified || 0}</span>
                <span style={{ color: '#a16207' }}>⚠ {counts.suspicious || 0}</span>
                <span style={{ color: '#b91c1c' }}>✗ {counts.not_found || 0}</span>
              </div>
            )}
          </div>
          <div style={{ height: 6, background: '#dbeafe', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#3b82f6,#22c55e)', transition: 'width 0.3s', borderRadius: 3 }} />
          </div>
          {statusLine && <div style={{ fontSize: 10, color: '#475569', marginTop: 4, fontStyle: 'italic' }}>{statusLine}</div>}
        </div>
      )}
      {rateLimitUntil && rateLimitUntil > Date.now() && <RateLimitBanner until={rateLimitUntil} onDone={onRateLimitDone} />}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, background: 'white' }}>
        
        {thinkSegments.length === 0 && active && (
          <div style={{ background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 8, padding: '8px 10px', fontSize: 10.5, color: '#94a3b8' }}>
            <Spinner size={8} /> Agent thinking…
          </div>
        )}
        {thinkSegments.map((seg, i) => {
          const isLast = i === thinkSegments.length - 1
          if (seg.kind === 'opener') {
            return (
              <div key={i} style={{
                background: 'linear-gradient(180deg,#fef9c3 0%,#fef3c7 100%)',
                border: '1px dashed #fde68a',
                borderRadius: 8, padding: '8px 10px', fontSize: 10.5, lineHeight: 1.55,
                color: '#475569', fontFamily: "'IBM Plex Mono',ui-monospace,monospace",
              }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>📋 Plan</div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{seg.text}</div>
              </div>
            )
          }
          if (seg.kind === 'agent') {
            const st = AGENT_STYLES[seg.name] || AGENT_STYLES.RefAgent
            return (
              <div key={i} style={{
                marginTop: 8, marginBottom: 2,
                background: st.bg, border: `1px solid ${st.border}`, borderRadius: 8,
                color: st.color,
              }}>
                <div style={{ padding: '8px 12px', fontSize: 11.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14 }}>{st.label}</span>
                  <span>{seg.name}</span>
                  <span style={{ fontSize: 9.5, color: '#64748b', fontWeight: 500 }}>
                    {seg.name === 'RefAgent' && '— main verifier'}
                    {seg.name === 'CheckAgent' && '— re-reads failed entries'}
                    {seg.name === 'ContextAgent' && '— checks topical fit'}
                  </span>
                  {isLast && active && <Spinner size={8} />}
                </div>
                {seg.intro && (
                  <div style={{
                    padding: '0 12px 10px',
                    fontSize: 10.5, lineHeight: 1.55,
                    color: '#475569', fontFamily: "'IBM Plex Mono',ui-monospace,monospace",
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontWeight: 400,
                  }}>
                    {seg.intro}
                  </div>
                )}
              </div>
            )
          }
// seg kind
          const st = AGENT_STYLES[seg.agent] || AGENT_STYLES.RefAgent
          return (
            <div key={i} style={{
              background: st.bg, border: `1px dashed ${st.border}`,
              borderRadius: 8, padding: '8px 10px', fontSize: 10.5, lineHeight: 1.55,
              color: '#475569', fontFamily: "'IBM Plex Mono',ui-monospace,monospace",
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {isLast && active && <Spinner size={8} />}
                <span style={{ color: st.color }}>{st.label} {seg.agent} · Ref #{seg.num}</span>
                <span style={{ color: '#64748b', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— {seg.label}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {seg.text ? seg.text.split('\n').map((line, j) => {
                  const isCheck = line.startsWith('[CheckAgent]')
                  const isContext = line.startsWith('[ContextAgent]')
                  const lineColor = isCheck ? '#7e22ce' : isContext ? '#047857' : '#475569'
                  return <div key={j} style={{ color: lineColor }}>{line}</div>
                }) : <span style={{ color: '#94a3b8' }}>…</span>}
              </div>
            </div>
          )
        })}

        {messages.length === 0 && !active && !thinkText && (
          <div style={{ color: '#94a3b8', fontSize: 11.5, textAlign: 'center', padding: '30px 20px', lineHeight: 1.6 }}>
            Ask the agent about this paper or its references.
            <br /><br />
            <span style={{ fontSize: 10, color: '#cbd5e1' }}>
              "Which ref looks most suspicious to you?"<br />
              "Are refs 12 and 13 by the same authors?"<br />
              "Summarize what's verified vs unverified."
            </span>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '88%',
            padding: '8px 12px',
            borderRadius: 12,
            background: m.role === 'user' ? '#2563eb' : '#f1f5f9',
            color: m.role === 'user' ? 'white' : '#0f172a',
            fontSize: 12, lineHeight: 1.45,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            boxShadow: m.role === 'user' ? '0 2px 8px rgba(37,99,235,0.18)' : 'none',
          }}>
            {m.content || (busy && i === messages.length - 1 && <Spinner size={10} />)}
          </div>
        ))}
      </div>
      <div style={{ padding: '8px 12px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: 6, background: '#f8fafc' }}>
        <textarea
          rows={2} value={input} onChange={e => onInputChange(e.target.value)} onKeyDown={onKey}
          placeholder="Ask the agent…"
          style={{ flex: 1, padding: '8px 10px', fontSize: 12, fontFamily: 'inherit', border: '1px solid #cbd5e1', borderRadius: 6, resize: 'none', outline: 'none' }}
        />
        <button onClick={onSend} disabled={busy || !input.trim()}
          style={{ padding: '8px 14px', background: busy || !input.trim() ? '#cbd5e1' : '#2563eb', color: 'white', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
          {busy ? '...' : 'Send'}
        </button>
      </div>
    </>
  )
}

// logpanel chain
function LogPanel({ text, phase, progress, onCancel, statusLine }) {
  const scrollRef = useRef(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [text])
  const pct = (progress.done / Math.max(1, progress.total)) * 100
  const active = phase === 'parsing' || phase === 'extracting' || phase === 'verifying'
  return (
    <>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', fontSize: 10.5, color: '#475569', display: 'flex', alignItems: 'center', gap: 8 }}>
        {active && <Spinner size={10} />}
        <span style={{ flex: 1, fontStyle: active ? 'italic' : 'normal' }}>{statusLine || (active ? 'Working…' : 'Idle')}</span>
        {active && onCancel && (
          <button onClick={onCancel}
            style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', fontFamily: 'inherit' }}>
            stop
          </button>
        )}
      </div>
      {active && phase === 'verifying' && (
        <div style={{ height: 3, background: '#e2e8f0' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#3b82f6,#22c55e)', transition: 'width 0.3s' }} />
        </div>
      )}
      <div ref={scrollRef}
        style={{
          padding: '10px 14px', overflowY: 'auto', flex: 1,
          fontSize: 11, lineHeight: 1.55,
          color: '#334155',
          fontFamily: "'IBM Plex Mono',ui-monospace,monospace",
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: '#fafafa',
        }}>
        {text || <span style={{ color: '#94a3b8' }}>(reasoning will appear here…)</span>}
      </div>
    </>
  )
}

// reference list
// click anywhere
// use the
function RefRow({ result, parsed, idx, expanded, focused, onToggle, onJump, inlineCount, inlineCursor }) {
  if (!result) return (
    <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#94a3b8', borderBottom: '1px solid #f1f5f9' }}>
      <span className="mono" style={{ minWidth: 22, color: '#cbd5e1' }}>{idx + 1}</span>
      <Spinner /> verifying
    </div>
  )
  const { candidate, verdict, confidence, reason } = result
  return (
    <div style={{ borderBottom: '1px solid #f1f5f9', background: focused ? '#fef9c3' : 'transparent', transition: 'background 0.15s' }}>
      <div onClick={onJump} style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'flex-start' }}
        title={inlineCount > 0 ? `Click to jump to inline citation in the PDF (${inlineCount} location${inlineCount > 1 ? 's' : ''}, cycles on each click)` : 'No inline citation found in the body'}>
        <span className="mono" style={{ fontSize: 10, color: '#94a3b8', minWidth: 22, paddingTop: 2 }}>{idx + 1}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <VerdictPill v={verdict} small />
            <span className="mono" style={{ fontSize: 9, color: '#94a3b8' }}>{confidence.toFixed(2)}</span>
            {candidate?.year && <span className="mono" style={{ fontSize: 9, color: '#94a3b8' }}>{candidate.year}</span>}
            {result.contextFit === 'mismatch' && (
              <span
                title={result.contextFitReason || 'Title may not fit citation context — please re-check'}
                style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: '#dbeafe', color: '#1d4ed8', fontWeight: 600, cursor: 'help' }}
              >
                🔵 context?
              </span>
            )}
            {inlineCount > 0 && (
              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: '#dbeafe', color: '#1d4ed8', fontWeight: 600 }}>
                ↗ {Math.max(0, inlineCursor) + 1}/{inlineCount}
              </span>
            )}
            <button onClick={(e) => { e.stopPropagation(); onToggle() }}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 11, padding: '0 4px' }}
              title="Show details">{expanded ? '▾' : '▸'}</button>
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: '#0f172a', marginTop: 2, lineHeight: 1.3 }}>
            {candidate?.title || parsed.title || parsed.raw.slice(0, 140)}
          </div>
          {candidate?.authors && (
            <div style={{ fontSize: 10, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {candidate.authors}
            </div>
          )}
        </div>
      </div>
      {expanded && (
        <div style={{ padding: '4px 14px 10px 42px', fontSize: 10, color: '#475569', background: '#f8fafc' }}>
          <div style={{ marginBottom: 6 }}>
            <strong>Cited:</strong>
            <div className="mono" style={{ marginTop: 2, padding: 6, background: 'white', border: '1px solid #e2e8f0', borderRadius: 4, fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{parsed.raw.slice(0, 600)}</div>
          </div>
          {candidate && (
            <div>
              <strong>Found:</strong>
              <div style={{ marginTop: 2, padding: 6, background: 'white', border: '1px solid #e2e8f0', borderRadius: 4 }}>
                <div style={{ fontWeight: 600 }}>{candidate.title}</div>
                <div style={{ color: '#64748b' }}>{candidate.authors}</div>
                <div style={{ color: '#64748b', marginTop: 2 }}>
                  {candidate.year} · {candidate.venue || candidate.journal || '—'}
                  {candidate.doi && <> · <a href={`https://doi.org/${candidate.doi}`} target="_blank" rel="noreferrer">DOI</a></>}
                  {candidate.arxivId && <> · <a href={`https://arxiv.org/abs/${candidate.arxivId}`} target="_blank" rel="noreferrer">arXiv</a></>}
                </div>
                {candidate.url && <a href={candidate.url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: '#2563eb' }}>Open ↗</a>}
              </div>
            </div>
          )}
          <div style={{ marginTop: 6, fontStyle: 'italic', color: verdict === 'verified' ? '#15803d' : verdict === 'suspicious' ? '#a16207' : '#b91c1c' }}>
            {reason}
          </div>
        </div>
      )}
    </div>
  )
}

// main app
export default function App() {
  const [settings, setSettingsState] = useState(() => {
    const s = store.getSettings()
    return { extractionMode: 'llm', ...s }
  })
  const [providerStatus, setProviderStatus] = useState(null)
  const [rateLimit, setRateLimit] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [dropOverlay, setDropOverlay] = useState(false)

  const [activeProjectId, setActiveProjectId] = useState(null)
  const [projects, setProjects] = useState([])
  const [folders, setFolders] = useState([])
  const [activeFolderId, setActiveFolderIdState] = useState(null)

  const [fileMeta, setFileMeta] = useState(null)
  const [pdfArrayBuffer, setPdfArrayBuffer] = useState(null)
  const [pdfMeta, setPdfMeta] = useState(null)
  const [docText, setDocText] = useState('')
  const [parsedRefs, setParsedRefs] = useState([])
  const [results, setResults] = useState([])
  const [inlineHits, setInlineHits] = useState([])
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [phase, setPhase] = useState('idle')
  const [statusLine, setStatusLine] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const [focusedIdx, setFocusedIdx] = useState(null)
  const [inlineCursor, setInlineCursor] = useState({})
  const [jumpTarget, setJumpTarget] = useState(null)
  const [thinkLog, setThinkLog] = useState('')
  const [rightTab, setRightTab] = useState('refs')
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [rateLimitUntil, setRateLimitUntil] = useState(null)
// helper for
// larger window
// ref markers
  const appendThink = useCallback((chunk) => setThinkLog(prev => (prev + chunk).slice(-32000)), [])

// listen for
  useEffect(() => {
    const onLimit = (e) => {
      const ms = e.detail?.retryAfterMs || 8000
      setRateLimitUntil(Date.now() + ms)
    }
    const onRecovered = () => setRateLimitUntil(null)
    window.addEventListener('refagent-rate-limit', onLimit)
    window.addEventListener('refagent-rate-recovered', onRecovered)
    return () => {
      window.removeEventListener('refagent-rate-limit', onLimit)
      window.removeEventListener('refagent-rate-recovered', onRecovered)
    }
  }, [])
  const [expanded, setExpanded] = useState(new Set())
  const [exportMode, setExportMode] = useState('bib')
  const [copied, setCopied] = useState(false)

  const abortRef = useRef(null)
  const dragCounter = useRef(0)

  useEffect(() => { store.loadCache() }, [])
  useEffect(() => {
    setProjects(store.listProjects())
    setFolders(store.listFolders())
    setActiveFolderIdState(store.getActiveFolderId())
  }, [])

  const refreshFolders = useCallback(() => {
    setFolders(store.listFolders())
    setProjects(store.listProjects())
  }, [])
  const handleCreateFolder = useCallback(() => {
    const name = prompt('Folder name:', 'New folder')
    if (!name) return
    const id = store.createFolder(name.trim())
    store.setActiveFolderId(id)
    setActiveFolderIdState(id)
    refreshFolders()
  }, [refreshFolders])
  const handleRenameFolder = useCallback((id, currentName) => {
    const name = prompt('Rename folder:', currentName)
    if (!name) return
    store.renameFolder(id, name.trim())
    refreshFolders()
  }, [refreshFolders])
  const handleDeleteFolder = useCallback((id) => {
    if (!confirm('Delete this folder? Projects inside will become loose.')) return
    store.deleteFolder(id)
    if (activeFolderId === id) { store.setActiveFolderId(null); setActiveFolderIdState(null) }
    refreshFolders()
  }, [activeFolderId, refreshFolders])
  const handleSelectFolder = useCallback((id) => {
    store.setActiveFolderId(id)
    setActiveFolderIdState(id)
  }, [])

  const refreshProvider = useCallback(async () => {
    const s = await checkProvider()
    setProviderStatus(s)
  }, [])
  useEffect(() => { refreshProvider() }, [refreshProvider, settings.provider])

  useEffect(() => {
    const id = setInterval(() => {
      const rl = getLastRateLimit()
      if (rl) setRateLimit(rl)
    }, 1500)
    return () => clearInterval(id)
  }, [])

// window drag
  useEffect(() => {
    const onDragEnter = (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); dragCounter.current++; setDropOverlay(true) } }
    const onDragLeave = () => { dragCounter.current = Math.max(0, dragCounter.current - 1); if (dragCounter.current === 0) setDropOverlay(false) }
    const onDragOver = (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault() }
    const onDrop = (e) => { e.preventDefault(); dragCounter.current = 0; setDropOverlay(false); const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f) }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  })

// file handler
  const handleFile = useCallback(async (file) => {
    setErrorMsg(''); setExpanded(new Set()); setResults([]); setParsedRefs([])
    setPdfArrayBuffer(null); setPdfMeta(null); setDocText(''); setFocusedIdx(null); setInlineHits([]); setInlineCursor({})
    setActiveProjectId(null); setJumpTarget(null)
    setPhase('parsing'); setStatusLine('Parsing file…')
// create project
// update the
    const projectId = store.newProjectId()
    setActiveProjectId(projectId)
    try {
      const parsed = await parseFile(file)
      setFileMeta({ name: parsed.name, kind: parsed.kind, charCount: parsed.text.length, title: parsed.title || '' })
      if (parsed.pdf) { setPdfArrayBuffer(parsed.pdf.arrayBuffer); setPdfMeta({ pageOffsets: parsed.pdf.pageOffsets, items: parsed.pdf.items }) }
      setDocText(parsed.text)
// sidebar history
      let pdfBlob = null
      if (parsed.pdf?.arrayBuffer) {
        try { pdfBlob = new Blob([parsed.pdf.arrayBuffer.slice(0)], { type: 'application/pdf' }) } catch {}
      }
      await store.saveProject({
        id: projectId,
        name: (parsed.title || parsed.name).replace(/\.[^.]+$/, ''),
        fileName: parsed.name,
        fileKind: parsed.kind,
        paperTitle: parsed.title || '',
        folderId: store.getActiveFolderId(),
        createdAt: Date.now(),
        summary: { verified: 0, suspicious: 0, not_found: 0, total: 0 },
        parsedRefs: [],
        results: [],
        thinkLog: '',
        chatMessages: [],
        inlineHits: [],
        pdfBlob,
        docText: parsed.text,
        pdfPageOffsets: parsed.pdf?.pageOffsets || null,
        pdfItems: parsed.pdf?.items || null,
      })
      setProjects(store.listProjects())
// kick off
// once returns
      if (parsed.firstPageText && providerStatus?.ok !== false) {
        extractTitleLLM(parsed.firstPageText)
          .then(async t => {
            if (!t) return
            setFileMeta(prev => prev ? { ...prev, title: t } : prev)
// update the
            const proj = await store.getProject(projectId)
            if (proj) {
              await store.saveProject({ ...proj, name: t.replace(/\.[^.]+$/, ''), paperTitle: t })
              setProjects(store.listProjects())
            }
          })
          .catch(() => {})
      }
      const fullText = parsed.text
      const refsStart = findRefsSectionStart(fullText)

// extract references
      setPhase('extracting')
      const useLLM = settings.extractionMode === 'llm' && providerStatus?.ok !== false
      let refs = []
// trust rule
// llm extraction
// venue text
// separate references
// existing entries
// whatever the
      setStatusLine('Extracting references…')
      refs = extractReferences(parsed)
// pre attach
      let enriched = refs.map(r => ({
        ...r,
        location: parsed.pdf ? offsetToPdfLocation(r.sourceOffset, parsed.pdf) : null,
      }))
      setParsedRefs(enriched)
      if (enriched.length === 0) {
        setPhase('error'); setErrorMsg('No references detected.'); setStatusLine(''); return
      }

// title cleanup
// titles this
// fails surface
      const canCleanup = true
      if (canCleanup) {
        setStatusLine('Cleaning up titles via LLM…')
        appendThink(`Okay, I've parsed ${enriched.length} references from the bibliography. Some of these will have messy author lists in the title slot because PDF flat-text extraction tends to merge them. Let me clean those up first.\n\n`)
        try {
          const cleaned = await cleanupTitlesLLM(enriched, {
            onProgress: ({ done, total }) => {
              setStatusLine(`Cleaning titles ${done}/${total}…`)
              if (done && done % 5 === 0) appendThink(`  • cleaned titles for ${done}/${total} refs\n`)
            },
          })
          enriched = cleaned.map(r => ({
            ...r,
            location: parsed.pdf ? offsetToPdfLocation(r.sourceOffset, parsed.pdf) : null,
          }))
          setParsedRefs(enriched)
          refs = enriched
          appendThink(`\nGood, titles cleaned. Now I'll check each one against arXiv, CrossRef, and Semantic Scholar to confirm the citation is real.\n\n`)
        } catch (e) {
          console.warn('title cleanup failed', e)
          appendThink(`(Title cleanup hit an error: ${e.message}. Pressing on with what we have.)\n\n`)
        }
      } else {
        appendThink(`No LLM provider online — I'll do rule-based extraction only. May have noisy titles.\n\n`)
      }

// inline citations
      setStatusLine(`Locating inline citations for ${enriched.length} refs…`)
      const inline = findInlineCitations(fullText, enriched, refsStart)
      setInlineHits(inline)

// verify
      await runVerification(enriched, parsed, { inline, fullText })
    } catch (e) {
      setPhase('error'); setErrorMsg(e.message || String(e)); setStatusLine('')
    }
  }, [settings, providerStatus])

  const runVerification = useCallback(async (refs, parsedFile, extras = {}) => {
    const { inline = [], fullText = '' } = extras
    setPhase('verifying'); setStatusLine(`Verifying ${refs.length} references against arXiv / CrossRef / Semantic Scholar…`)
    setProgress({ done: 0, total: refs.length })
    const ac = new AbortController(); abortRef.current = ac
    const init = new Array(refs.length).fill(null)
    setResults(init)

    const isStreamCapable = settings.provider === 'remote_ollama' || settings.provider === 'ollama'

    try {
      let finalResults
      if (isStreamCapable && providerStatus?.ok) {
// agentic mode
        const arr = new Array(refs.length).fill(null)
        let done = 0
        await runAgentLoop(refs, {
          paperTitle: parsedFile.title || '',
          strictness: settings.strictness,
          signal: ac.signal,
          onThink: appendThink,
          onResult: (idx, result) => {
            arr[idx] = result
            done++
            setProgress({ done, total: refs.length })
            setResults(prev => { const next = prev.slice(); next[idx] = result; return next })
          },
        })
        finalResults = arr
      } else {
        finalResults = await verifyAll(refs, {
          strictness: settings.strictness,
          useLLM: providerStatus?.ok !== false,
          concurrency: settings.concurrency,
          signal: ac.signal,
          onProgress: ({ done, total, index, result }) => {
            setProgress({ done, total })
            setResults(prev => { const next = prev.slice(); next[index] = result; return next })
            const ref = refs[index]
            const label = (ref?.title || ref?.raw || '').slice(0, 70)
            const dot = result.verdict === 'verified' ? '✓' : result.verdict === 'suspicious' ? '⚠' : '✗'
            appendThink(`  ${dot} #${index + 1}: ${label}${result.candidate?.year ? ' (' + result.candidate.year + ')' : ''}\n`)
          },
        })
      }
// second agent
// and verify
      const stillUnverified = finalResults.filter(r => r && r.verdict !== 'verified').length
      if (providerStatus?.ok && stillUnverified > 0) {
        try {
          appendThink(`\n`)
          setStatusLine(`Ref-checker agent re-reading ${stillUnverified} unverified entries…`)
          const rechecked = await refCheckerAgent(finalResults, refs, {
            signal: ac.signal,
            onThink: appendThink,
            onResult: (idx, result) => {
              setResults(prev => { const next = prev.slice(); next[idx] = result; return next })
            },
          })
          finalResults = rechecked
          setResults(rechecked.slice())
        } catch (e) { console.warn('refchecker failed', e) }
      }

// final phase
      const unverified = finalResults.filter(r => r && r.verdict !== 'verified').length
      if (providerStatus?.ok && unverified > 0) {
        try {
          appendThink(`\nFinished the API lookups. ${unverified} entries didn't verify cleanly. Let me look at each title and decide which ones are probably real (just missed by the APIs) versus which look like they might be fabricated.\n\n`)
          setStatusLine('Classifying severity of unverified refs…')
          const classified = await classifySeverityLLM(finalResults, {
            signal: ac.signal,
            onProgress: ({ done, total }) => setStatusLine(`Classifying severity ${done}/${total}…`),
          })
          finalResults = classified
          setResults(classified.slice())
          const critical = classified.filter(r => r?.severity === 'critical').length
          appendThink(`Done. ${critical} entries flagged as possibly fabricated (red), the rest look like real papers the APIs simply missed (blue).\n`)
        } catch (e) { console.warn('severity classify failed', e) }
      } else if (providerStatus?.ok) {
        appendThink(`\nAll refs verified cleanly — no alerts to raise.\n`)
      }

// context fit
      const verifiedCount = finalResults.filter(r => r?.verdict === 'verified').length
      if (providerStatus?.ok && verifiedCount > 0 && fullText) {
        try {
          setStatusLine('Checking whether each verified ref fits its citation context…')
          const { contextFitCheckLLM } = await import('./agent.js')
          const fitted = await contextFitCheckLLM(finalResults, inline, fullText, {
            signal: ac.signal,
            onThink: appendThink,
            onProgress: ({ done, total }) => setStatusLine(`Context-fit check ${done}/${total}…`),
          })
          finalResults = fitted
          setResults(fitted.slice())
        } catch (e) { console.warn('context-fit failed', e) }
      }

      setPhase('done'); setStatusLine(`Done · ${finalResults.filter(Boolean).length} refs processed`)
      const summary = summarize(finalResults.filter(Boolean))
      const projectId = store.newProjectId()
// persist the
// store fresh
// have detached
      let pdfBlob = null
      if (parsedFile.pdf?.arrayBuffer) {
        try {
// make copy
          pdfBlob = new Blob([parsedFile.pdf.arrayBuffer.slice(0)], { type: 'application/pdf' })
        } catch {}
      }

// use the
// the placeholder
      const projectIdToSave = activeProjectId || store.newProjectId()
      const existing = await store.getProject(projectIdToSave)
      await store.saveProject({
        ...(existing || {}),
        id: projectIdToSave,
        name: (parsedFile.title || parsedFile.name).replace(/\.[^.]+$/, ''),
        fileName: parsedFile.name,
        fileKind: parsedFile.kind,
        paperTitle: parsedFile.title || (existing?.paperTitle || ''),
        folderId: existing?.folderId ?? store.getActiveFolderId(),
        createdAt: existing?.createdAt || Date.now(),
        summary,
        parsedRefs: refs,
        results: finalResults,
        thinkLog,
        chatMessages,
        inlineHits,
        pdfBlob: pdfBlob || existing?.pdfBlob || null,
        docText: parsed.text || existing?.docText || '',
        pdfPageOffsets: parsed.pdf?.pageOffsets || existing?.pdfPageOffsets || null,
        pdfItems: parsed.pdf?.items || existing?.pdfItems || null,
      })
      setActiveProjectId(projectIdToSave); setProjects(store.listProjects())
    } catch (e) {
      if (ac.signal.aborted) { setPhase('idle'); setStatusLine('') }
      else { setPhase('error'); setErrorMsg(e.message || String(e)) }
    }
  }, [settings, providerStatus])

  const saveSettings = useCallback((draft) => {
    const next = store.setSettings(draft)
    setSettingsState({ ...next, extractionMode: draft.extractionMode || 'llm' })
    setShowSettings(false); refreshProvider()
  }, [refreshProvider])

  const loadProject = useCallback(async (id) => {
    const proj = await store.getProject(id)
    if (!proj) return
    setActiveProjectId(id)
    setFileMeta({ name: proj.fileName, kind: proj.fileKind, charCount: 0, title: proj.paperTitle || '' })
    setParsedRefs(proj.parsedRefs || [])
    setResults(proj.results || [])
    setDocText(proj.docText || '')
    setInlineHits(proj.inlineHits || [])
    setInlineCursor({})
    setThinkLog(proj.thinkLog || '')
    setChatMessages(proj.chatMessages || [])
    setRightTab('refs')
    setPhase('done')
    setErrorMsg('')
// restore pdf
    if (proj.pdfBlob instanceof Blob) {
      try {
        const buf = await proj.pdfBlob.arrayBuffer()
        setPdfArrayBuffer(buf)
        if (proj.pdfPageOffsets && proj.pdfItems) {
          setPdfMeta({ pageOffsets: proj.pdfPageOffsets, items: proj.pdfItems })
        }
      } catch {
        setPdfArrayBuffer(null); setPdfMeta(null)
      }
    } else {
      setPdfArrayBuffer(null); setPdfMeta(null)
    }
  }, [])

  const newRun = () => {
    setActiveProjectId(null); setFileMeta(null); setParsedRefs([])
    setResults([]); setPdfArrayBuffer(null); setPdfMeta(null); setInlineHits([]); setInlineCursor({})
    setThinkLog(''); setChatMessages([])
    setPhase('idle'); setStatusLine(''); setErrorMsg('')
// immediately open
// one click
    setTimeout(() => pickFile(), 50)
  }

// auto persist
// reload history
  useEffect(() => {
    if (!activeProjectId) return
    if (phase === 'verifying' || phase === 'extracting' || phase === 'parsing') return
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return
      const proj = await store.getProject(activeProjectId)
      if (!proj) return
      await store.saveProject({ ...proj, chatMessages, thinkLog })
    }, 500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [chatMessages, thinkLog, activeProjectId, phase])
  const deleteProject = useCallback(async (id) => {
    await store.deleteProject(id); setProjects(store.listProjects())
    if (activeProjectId === id) newRun()
  }, [activeProjectId])

// inline citation
  const jumpToInline = useCallback((refIdx) => {
    const hits = inlineHits[refIdx] || []
    if (hits.length === 0) {
// inline citation
      const off = parsedRefs[refIdx]?.sourceOffset
      if (off != null) setJumpTarget({ refIdx, offset: off, nonce: Math.random() })
      setFocusedIdx(refIdx)
      return
    }
    const cur = inlineCursor[refIdx] ?? -1
    const next = (cur + 1) % hits.length
    setInlineCursor(prev => ({ ...prev, [refIdx]: next }))
    setJumpTarget({ refIdx, offset: hits[next], nonce: Math.random() })
    setFocusedIdx(refIdx)
  }, [inlineHits, inlineCursor, parsedRefs])

// filters
  const filledResults = results.filter(Boolean)
  const sum = summarize(filledResults)
  const verifiedCandidates = filledResults.filter(r => r.verdict === 'verified' && r.candidate).map(r => r.candidate)
  const alertItems = useMemo(
    () => results
      .map((r, i) => r ? ({ r, i }) : null)
      .filter(x => x && (x.r.verdict === 'suspicious' || x.r.verdict === 'not_found')),
    [results]
  )
  const showAlerts = alertItems.length > 0 && phase === 'done'
  const exportText = (FORMATS[exportMode]?.fn || formatBib)(verifiedCandidates)
  const copyExport = () => { navigator.clipboard.writeText(exportText); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  const downloadExport = () => {
    const ext = FORMATS[exportMode]?.ext || '.txt'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([exportText], { type: 'text/plain' }))
    a.download = `${(fileMeta?.name || 'refs').replace(/\.[^.]+$/, '')}-verified${ext}`
    a.click()
  }
  const downloadSuspect = () => {
    const text = alertItems.map(({ r, i }, k) =>
      `[${k + 1}] (ref ${i + 1}) ${r.verdict.toUpperCase()} conf=${r.confidence.toFixed(2)}\n` +
      `  cited: ${r.parsed.raw.replace(/\s+/g, ' ').slice(0, 240)}\n` +
      `  found: ${r.candidate ? `${r.candidate.title} (${r.candidate.year || '?'}) — ${r.candidate.venue || r.candidate.journal || ''}` : '(no candidate)'}\n` +
      `  reason: ${r.reason}\n`
    ).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text || 'No alerts.'], { type: 'text/plain' }))
    a.download = `${(fileMeta?.name || 'refs').replace(/\.[^.]+$/, '')}-alerts.txt`
    a.click()
  }
  const cancelRun = () => { abortRef.current?.abort(); setPhase('idle') }

// agent chat
  const sendChat = useCallback(async () => {
    const text = chatInput.trim()
    if (!text || chatBusy) return
    setChatInput('')
    setChatBusy(true)
    const userMsg = { role: 'user', content: text }
    setChatMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setRightTab('chat')

// detect verify
    const refMatch = text.match(/(?:ref(?:erence)?|레퍼런스|참고문헌)\s*#?\s*(\d+)/i)
    const recheckIntent = /다시|재검증|recheck|re.?check|체크|확인|찾아\s*봐|verify/i.test(text)
    if (refMatch && recheckIntent && parsedRefs.length > 0) {
      const idx = parseInt(refMatch[1], 10) - 1
      if (idx >= 0 && idx < parsedRefs.length) {
        try {
// ask llm
          const hint = await llmChatJSON(
            [
              { role: 'system', content: 'You extract a hint title from a user message that asks to re-verify a paper. Return JSON only.' },
              {
                role: 'user',
                content: `The user is talking about reference #${idx + 1}: "${(parsedRefs[idx]?.title || parsedRefs[idx]?.raw || '').slice(0, 200)}".

User message: "${text}"

If the user is giving a hint about the actual paper title (e.g., "it's recurrent neural network not RNN", "the abbreviation is for X"), return {"hintTitle": "<the actual title or expanded form to search for>"}. If unclear, return {"hintTitle": null}.`,
              },
            ],
            { maxTokens: 200, temperature: 0 }
          ).catch(() => ({ hintTitle: null }))

          const newTitle = hint?.hintTitle && typeof hint.hintTitle === 'string' ? hint.hintTitle.trim() : null
          if (newTitle && newTitle.length > 4) {
            setChatMessages(prev => {
              const next = prev.slice()
              next[next.length - 1] = { role: 'assistant', content: `🔁 Re-checking ref ${idx + 1} with hint: "${newTitle}"…` }
              return next
            })
            const newParsed = { ...parsedRefs[idx], title: newTitle }
            const reResult = await agentVerifyOne(newParsed, { strictness: settings.strictness, useLLM: true })
            setResults(prev => { const next = prev.slice(); next[idx] = reResult; return next })
            const verdictText = reResult.verdict === 'verified'
              ? `✅ Verified as "${(reResult.candidate?.title || newTitle).slice(0, 120)}"${reResult.candidate?.year ? ` (${reResult.candidate.year})` : ''}.`
              : reResult.verdict === 'suspicious'
              ? `⚠️ Found a candidate but it doesn't fully match: "${(reResult.candidate?.title || '').slice(0, 120)}". ${reResult.reason || ''}`
              : `❌ Still couldn't find it. ${reResult.reason || ''}`
            setChatMessages(prev => {
              const next = prev.slice()
              next[next.length - 1] = { role: 'assistant', content: `Re-checked ref ${idx + 1} with hint "${newTitle}".\n\n${verdictText}` }
              return next
            })
            setChatBusy(false)
            return
          }
        } catch (e) {  }
      }
    }

// build compact
    const sumLine = (() => {
      const s = summarize(results.filter(Boolean))
      return `${s.total} refs: ${s.verified} verified, ${s.suspicious} suspicious, ${s.not_found} not found.`
    })()
    const refsSnippet = results
      .map((r, i) => r ? `${i + 1}. [${r.verdict}] ${(r.candidate?.title || r.parsed.title || '').slice(0, 90)}${r.reason ? ` — ${r.reason.slice(0, 80)}` : ''}` : '')
      .filter(Boolean)
      .slice(0, 60)
      .join('\n')

    const sys = `You are RefAgent — a citation verification assistant. The user is looking at a paper${fileMeta?.title ? ` titled "${fileMeta.title}"` : ''} and wants to talk through the results. Be concise, direct, and helpful. You have access to:

${sumLine}

REFERENCE LIST:
${refsSnippet}

Answer the user's question about any of these. If they ask you to re-check a ref, suggest a plan but don't pretend to perform new lookups (your sibling pipeline does that).`

    try {
      const provider = settings.provider
      const canStream = provider === 'remote_ollama' || provider === 'ollama'
      if (canStream) {
        await llmStreamChat(
          [
            { role: 'system', content: sys },
            ...chatMessages.map(m => ({ role: m.role, content: m.content })),
            userMsg,
          ],
          {
            onToken: (chunk) => {
              setChatMessages(prev => {
                const next = prev.slice()
                const last = next[next.length - 1]
                if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + chunk }
                return next
              })
            },
            maxTokens: 800,
            temperature: 0.4,
          }
        )
      } else {
        const content = await llmChat(
          [
            { role: 'system', content: sys },
            ...chatMessages.map(m => ({ role: m.role, content: m.content })),
            userMsg,
          ],
          { maxTokens: 800, temperature: 0.4 }
        )
        setChatMessages(prev => {
          const next = prev.slice()
          next[next.length - 1] = { role: 'assistant', content }
          return next
        })
      }
    } catch (e) {
      setChatMessages(prev => {
        const next = prev.slice()
        next[next.length - 1] = { role: 'assistant', content: `(error: ${e.message || e})` }
        return next
      })
    } finally {
      setChatBusy(false)
    }
  }, [chatInput, chatBusy, chatMessages, results, fileMeta, settings.provider])

  const pickFile = () => {
    const inp = document.createElement('input')
    inp.type = 'file'; inp.accept = '.pdf,.tex,.bib,.bbl,.docx,.doc,.txt'
    inp.onchange = e => { const f = e.target.files?.[0]; if (f) handleFile(f) }
    inp.click()
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'IBM Plex Sans',-apple-system,sans-serif", background: 'linear-gradient(180deg, #f0f5ff 0%, #f8fafc 100%)' }}>
      {dropOverlay && (
        <div className="ra-drop-overlay">
          <div className="ra-drop-card">
            <div style={{ fontSize: 56, marginBottom: 12 }}>📥</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1e40af', marginBottom: 4 }}>Drop a paper anywhere</div>
            <div style={{ fontSize: 13, color: '#64748b' }}>PDF · TeX · DOCX · BibTeX</div>
          </div>
        </div>
      )}
      {showSettings && (
        <SettingsDialog settings={settings} onSave={saveSettings} onClose={() => setShowSettings(false)} providerStatus={providerStatus} />
      )}

      
      {(phase === 'parsing' || phase === 'extracting' || phase === 'verifying') && (
        <button
          onClick={() => setRightTab('log')}
          title="See agent thinking"
          style={{
            position: 'fixed', top: 12, right: 460, zIndex: 150,
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(15,23,42,0.92)', color: '#e2e8f0',
            padding: '6px 12px', borderRadius: 999,
            fontSize: 11, fontWeight: 500, cursor: 'pointer',
            border: '1px solid #334155', boxShadow: '0 4px 12px rgba(15,23,42,0.2)',
            fontFamily: 'inherit',
          }}>
          <Spinner size={10} />
          <span>{statusLine?.slice(0, 50) || 'Working…'}</span>
          {phase === 'verifying' && <span className="mono" style={{ color: '#94a3b8' }}>{progress.done}/{progress.total}</span>}
        </button>
      )}

      <Sidebar
        projects={projects}
        activeId={activeProjectId}
        onSelect={loadProject}
        onDelete={deleteProject}
        onNew={newRun}
        providerStatus={providerStatus}
        onSettings={() => setShowSettings(true)}
        rateLimit={rateLimit}
        alertItems={showAlerts ? alertItems : []}
        inlineHits={inlineHits}
        focusedIdx={focusedIdx}
        onAlertClick={jumpToInline}
        onAlertDownload={downloadSuspect}
        currentPaperTitle={fileMeta?.title || ''}
        currentFileName={fileMeta?.name || ''}
        folders={folders}
        activeFolderId={activeFolderId}
        onSelectFolder={handleSelectFolder}
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
      />

      
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {pdfArrayBuffer ? (
          <PDFViewer
            arrayBuffer={pdfArrayBuffer}
            pdfMeta={pdfMeta}
            fullText={docText}
            results={results}
            parsedRefs={parsedRefs}
            jumpTarget={jumpTarget}
            inlineHits={inlineHits}
          />
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>
            {phase === 'idle' && !fileMeta && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 60, marginBottom: 16, opacity: 0.4 }}>📄</div>
                <div style={{ fontSize: 16, color: '#475569', marginBottom: 4 }}>Drop a paper anywhere on the screen</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>or</div>
                <button onClick={pickFile} style={{ padding: '10px 18px', background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 4px 14px rgba(37,99,235,0.18)' }}>
                  Choose file
                </button>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 14 }}>PDF · .tex · .bib · .bbl · .docx</div>
              </div>
            )}
            {(phase === 'parsing' || phase === 'extracting' || phase === 'verifying') && (
              <div style={{ textAlign: 'center', color: '#475569', fontSize: 12 }}>
                <Spinner /> {statusLine}
              </div>
            )}
            {phase === 'done' && !pdfArrayBuffer && (
              <div style={{ textAlign: 'center', color: '#64748b', fontSize: 12 }}>
                {fileMeta?.name}<br />
                <span style={{ color: '#94a3b8' }}>PDF preview not available for this file type</span>
              </div>
            )}
            {phase === 'error' && (
              <div style={{ maxWidth: 400, color: '#b91c1c', fontSize: 12, textAlign: 'center', background: '#fef2f2', padding: 16, borderRadius: 8, border: '1px solid #fecaca' }}>
                {errorMsg}<br />
                <button onClick={newRun} style={{ marginTop: 12, padding: '6px 12px', background: 'white', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>Try another</button>
              </div>
            )}
          </div>
        )}
      </div>

      
      <div style={{ width: 440, minWidth: 440, borderLeft: '1px solid #e2e8f0', background: 'white', display: 'flex', flexDirection: 'column' }}>
        
        <div style={{ height: '48%', minHeight: 0, display: 'flex', flexDirection: 'column', borderBottom: '2px solid #cbd5e1' }}>
          <div style={{ padding: '8px 14px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>💬 Chat</span>
            <span style={{ fontSize: 10, color: '#94a3b8' }}>{chatMessages.length || (thinkLog ? 'agent thinking…' : '')}</span>
          </div>
          <ChatPanel
            messages={chatMessages}
            thinkText={thinkLog}
            phase={phase}
            input={chatInput}
            onInputChange={setChatInput}
            onSend={sendChat}
            busy={chatBusy}
            progress={progress}
            counts={sum}
            statusLine={statusLine}
            rateLimitUntil={rateLimitUntil}
            onRateLimitDone={() => setRateLimitUntil(null)}
          />
        </div>

        
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 8, background: '#f8fafc' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>References</span>
            <span className="mono" style={{ fontSize: 10, color: '#94a3b8' }}>{filledResults.length}/{parsedRefs.length}</span>
            <div style={{ flex: 1 }} />
            {filledResults.length > 0 && (
              <div style={{ display: 'flex', gap: 6, fontSize: 9 }}>
                <span style={{ color: '#15803d' }}>✓ {sum.verified}</span>
                {sum.suspicious > 0 && <span style={{ color: '#a16207' }}>⚠ {sum.suspicious}</span>}
                {sum.not_found > 0 && <span style={{ color: '#b91c1c' }}>✗ {sum.not_found}</span>}
              </div>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {parsedRefs.length === 0 && phase === 'idle' && (
              <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>
                References will appear here after you drop a paper.
              </div>
            )}
            {parsedRefs.map((p, i) => (
              <RefRow key={i} result={results[i]} parsed={p} idx={i}
                expanded={expanded.has(i)} focused={focusedIdx === i}
                onToggle={() => setExpanded(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })}
                onJump={() => jumpToInline(i)}
                inlineCount={inlineHits[i]?.length || 0}
                inlineCursor={inlineCursor[i] ?? -1} />
            ))}
          </div>
          {verifiedCandidates.length > 0 && (
            <div style={{ borderTop: '1px solid #e2e8f0', background: '#f8fafc' }}>
              <div style={{ padding: '6px 10px', display: 'flex', gap: 2, flexWrap: 'wrap', borderBottom: '1px solid #e2e8f0' }}>
                {Object.entries(FORMATS).map(([k, { label }]) => (
                  <button key={k} onClick={() => setExportMode(k)}
                    style={{ padding: '3px 7px', border: 'none', borderRadius: 4, fontSize: 9, fontWeight: exportMode === k ? 700 : 400, color: exportMode === k ? '#2563eb' : '#64748b', background: exportMode === k ? 'white' : 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{ padding: '6px 10px', display: 'flex', gap: 6 }}>
                <button onClick={copyExport} style={{ flex: 1, padding: 5, fontSize: 10, fontWeight: 500, cursor: 'pointer', borderRadius: 4, background: copied ? '#dcfce7' : '#eff6ff', color: copied ? '#15803d' : '#2563eb', border: `1px solid ${copied ? '#bbf7d0' : '#bfdbfe'}`, fontFamily: 'inherit' }}>
                  {copied ? '✓ Copied' : 'Copy ' + FORMATS[exportMode]?.label}
                </button>
                <button onClick={downloadExport} style={{ flex: 1, padding: 5, fontSize: 10, fontWeight: 500, cursor: 'pointer', borderRadius: 4, background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', fontFamily: 'inherit' }}>
                  ↓ {FORMATS[exportMode]?.ext}
                </button>
              </div>
            </div>
          )}
        </div>

      </div>

    </div>
  )
}

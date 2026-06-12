// refagent llm

// default provider
// ships the

// both providers
// the app

import { getSettings } from './store.js'

// module level
let _lastRateLimit = null
export function getLastRateLimit() { return _lastRateLimit }

function parseRateLimit(headers) {
// header values
// time reset
// keep parsing
  const num = (h) => {
    const v = headers.get(h); if (!v) return null
    const n = parseFloat(v); return Number.isFinite(n) ? n : null
  }
  return {
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    resetRequests: headers.get('x-ratelimit-reset-requests') || null,
    resetTokens: headers.get('x-ratelimit-reset-tokens') || null,
    retryAfter: headers.get('retry-after') || null,
    capturedAt: Date.now(),
  }
}

// provider groq
// groq enforces
// the selected
// alternative free
// gemma2 was
const GROQ_FALLBACK_CHAIN = {
  'llama-3.3-70b-versatile': ['llama-3.1-8b-instant'],
  'llama-3.1-8b-instant': ['llama-3.3-70b-versatile'],
  'mixtral-8x7b-32768': ['llama-3.1-8b-instant'],
  'gemma2-9b-it': ['llama-3.1-8b-instant'],
}

async function chatGroqOne(model, messages, { temperature, maxTokens, jsonMode, signal }) {
  const body = { model, messages, temperature, max_tokens: maxTokens }
  if (jsonMode) body.response_format = { type: 'json_object' }
  const r = await fetch('/api/groq', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  _lastRateLimit = parseRateLimit(r.headers)
  return r
}

async function chatGroq(messages, { model, temperature = 0.1, maxTokens = 400, jsonMode, signal } = {}) {
  const chain = [model, ...(GROQ_FALLBACK_CHAIN[model] || [])]
  let lastErr = null
  for (const m of chain) {
    const r = await chatGroqOne(m, messages, { temperature, maxTokens, jsonMode, signal })
    if (r.ok) {
      const data = await r.json()
      const content = data.choices?.[0]?.message?.content || ''
// tag comment
      if (m !== model) console.info(`[llm] fell back to ${m} (primary ${model} unavailable)`)
      return content
    }
    const text = await r.text()
    lastErr = new Error(`Groq ${r.status} on ${m}: ${text.slice(0, 200)}`)
// retry rate
    const isRateLimited = r.status === 429 || /rate_limit|tokens per day|tokens per minute|TPD|TPM/i.test(text)
    if (!isRateLimited) throw lastErr
    console.warn(`[llm] ${m} rate-limited, trying next in fallback chain`)
  }
  throw lastErr || new Error('Groq: all fallback models failed')
}

// provider ollama
async function chatOllama(messages, { model, temperature = 0.1, maxTokens = 400, jsonMode, signal } = {}) {
  const { ollamaUrl } = getSettings()
  const body = {
    model,
    messages,
    stream: false,
    options: { temperature, num_predict: maxTokens },
  }
  if (jsonMode) body.format = 'json'

  const r = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`)
  const data = await r.json()
  return data.message?.content || ''
}

// provider remote
// returns openai
async function chatRemoteOllama(messages, { model, temperature = 0.1, maxTokens = 800, jsonMode, signal } = {}) {
  const body = { model, messages, temperature, max_tokens: maxTokens }
  if (jsonMode) body.response_format = { type: 'json_object' }
  const r = await fetch('/api/ollama', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`Remote Ollama ${r.status}: ${text.slice(0, 240)}`)
  }
  const data = await r.json()
  return data.choices?.[0]?.message?.content || ''
}

// health check
export async function checkProvider() {
  const { provider } = getSettings()
  if (provider === 'ollama') {
    try {
      const { ollamaUrl } = getSettings()
      const r = await fetch(`${ollamaUrl}/api/tags`)
      if (!r.ok) return { ok: false, provider: 'ollama', reason: `HTTP ${r.status}` }
      const d = await r.json()
      return { ok: true, provider: 'ollama', models: (d.models || []).map(m => m.name) }
    } catch (e) { return { ok: false, provider: 'ollama', reason: e.message || 'connect failed' } }
  }
  if (provider === 'remote_ollama') {
    try {
      const r = await fetch('/api/ollama')
      const d = await r.json().catch(() => ({}))
      if (r.ok && d.ok) return { ok: true, provider: 'remote_ollama', models: d.models || [] }
      return { ok: false, provider: 'remote_ollama', reason: d.reason || `HTTP ${r.status}` }
    } catch (e) { return { ok: false, provider: 'remote_ollama', reason: e.message || 'connect failed' } }
  }
// groq via
  try {
    const r = await fetch('/api/health')
    const d = await r.json().catch(() => ({}))
    if (r.ok && d.ok) return { ok: true, provider: 'groq' }
    return { ok: false, provider: 'groq', reason: d.error || `HTTP ${r.status}` }
  } catch (e) { return { ok: false, provider: 'groq', reason: e.message || 'connect failed' } }
}

// unified chat
export async function chat(messages, opts = {}) {
  const { provider, groqModel, model: ollamaModel, remoteOllamaModel } = getSettings()
  if (provider === 'ollama') return chatOllama(messages, { model: ollamaModel, ...opts })
  if (provider === 'remote_ollama') return chatRemoteOllama(messages, { model: remoteOllamaModel, ...opts })
  return chatGroq(messages, { model: groqModel, ...opts })
}

// streaming chat
// calls api
// ontoken chunk
// the full

// only available
// groq doesn
export async function streamChat(messages, { onToken, signal, temperature = 0.4, maxTokens = 1500 } = {}) {
  const { provider, remoteOllamaModel, model: localOllamaModel, ollamaUrl } = getSettings()
  const isLocal = provider === 'ollama'
  const url = isLocal ? `${ollamaUrl}/api/chat` : '/api/ollama'
  const model = isLocal ? localOllamaModel : remoteOllamaModel
  if (provider === 'groq') throw new Error('Streaming chat requires Ollama / Mac Studio provider')

  const body = {
    model,
    messages,
    stream: true,
    temperature,
    max_tokens: maxTokens,
    options: { temperature, num_predict: maxTokens },
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!r.ok) throw new Error(`Stream ${r.status}: ${(await r.text()).slice(0, 200)}`)

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
// ollama returns
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        const chunk = obj?.message?.content || ''
        if (chunk) { full += chunk; onToken?.(chunk) }
        if (obj?.done) return full
      } catch {  }
    }
  }
  return full
}

// json helper
export async function chatJSON(messages, opts = {}) {
  const raw = await chat(messages, { ...opts, jsonMode: true })
  try { return JSON.parse(raw) }
  catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) try { return JSON.parse(m[0]) } catch {}
    throw new Error(`Bad JSON from model: ${raw.slice(0, 200)}`)
  }
}

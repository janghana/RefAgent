// ollama client

// requires user
// ollama origins

// default model

import { getSettings } from './store.js'

export async function checkOllama() {
  const { ollamaUrl } = getSettings()
  try {
    const r = await fetch(`${ollamaUrl}/api/tags`, { method: 'GET' })
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` }
    const data = await r.json()
    return { ok: true, models: (data.models || []).map(m => m.name) }
  } catch (e) {
    return { ok: false, reason: e.message || 'connect failed' }
  }
}

// pull verify
export async function ensureModel(model) {
  const { ollamaUrl } = getSettings()
  try {
    const r = await fetch(`${ollamaUrl}/api/tags`)
    if (!r.ok) return false
    const data = await r.json()
    const names = (data.models || []).map(m => m.name)
    return names.some(n => n === model || n.startsWith(model + ':') || n.split(':')[0] === model.split(':')[0])
  } catch { return false }
}

// non streaming
export async function generateJSON(prompt, { temperature = 0.1, maxTokens = 800, signal } = {}) {
  const { ollamaUrl, model } = getSettings()
  const r = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature, num_predict: maxTokens },
    }),
    signal,
  })
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`)
  const data = await r.json()
  const raw = data.response || ''
  try { return JSON.parse(raw) }
  catch {
// sometimes models
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) try { return JSON.parse(m[0]) } catch {}
    throw new Error(`Bad JSON from model: ${raw.slice(0, 200)}`)
  }
}

// plain text
export async function generateText(prompt, { temperature = 0.2, maxTokens = 600, signal } = {}) {
  const { ollamaUrl, model } = getSettings()
  const r = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature, num_predict: maxTokens },
    }),
    signal,
  })
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`)
  const data = await r.json()
  return data.response || ''
}

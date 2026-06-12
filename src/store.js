// refagent storage

// two responsibilities
// persist agent
// cache external
// repeat verifications

// storage layers
// indexeddb primary
// localstorage quick

// cache lives

const CACHE_KEY = 'refagent_cache'
const CACHE_VERSION = 'v1'
const SETTINGS_KEY = 'refagent_settings'
const IDB_NAME = 'refagent_db'
const IDB_VERSION = 1

// default agent
const DEFAULT_SETTINGS = {
  provider: 'remote_ollama',
  groqModel: 'llama-3.3-70b-versatile',
  ollamaUrl: 'http://localhost:11434',
  model: 'gemma3:27b',
  remoteOllamaModel: 'gemma3:27b',
  strictness: 'lenient',
  concurrency: 3,
  extractionMode: 'llm',
}

// settings localstorage
export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { return { ...DEFAULT_SETTINGS } }
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch {}
  return next
}

// indexeddb helpers
let _db = null
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db)
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'))
    const req = indexedDB.open(IDB_NAME, IDB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache')
    }
    req.onsuccess = () => { _db = req.result; resolve(_db) }
    req.onerror = () => reject(req.error)
  })
}
async function idbGet(key) {
  try {
    const db = await openDB()
    return new Promise(res => {
      const tx = db.transaction('cache', 'readonly')
      const r = tx.objectStore('cache').get(key)
      r.onsuccess = () => res(r.result ?? null)
      r.onerror = () => res(null)
    })
  } catch { return null }
}
async function idbPut(key, value) {
  try {
    const db = await openDB()
    return new Promise((res, rej) => {
      const tx = db.transaction('cache', 'readwrite')
      tx.objectStore('cache').put(value, key)
      tx.oncomplete = () => res(true)
      tx.onerror = () => rej(tx.error)
    })
  } catch { return false }
}
async function idbClear() {
  try {
    const db = await openDB()
    return new Promise(res => {
      const tx = db.transaction('cache', 'readwrite')
      tx.objectStore('cache').clear()
      tx.oncomplete = () => res(true)
      tx.onerror = () => res(false)
    })
  } catch { return false }
}

// memory cache
let _memCache = null

function _lsLoadCache() {
  try {
    const r = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
    if (r._v !== CACHE_VERSION) { localStorage.removeItem(CACHE_KEY); return { _v: CACHE_VERSION } }
    return r
  } catch { return { _v: CACHE_VERSION } }
}
function _ensureCache() {
  if (!_memCache) _memCache = _lsLoadCache()
  return _memCache
}
function _persistCache() {
  const c = _ensureCache()
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)) } catch {}
  idbPut('paperCache', c)
}

// boot hydrate
export async function loadCache() {
  const fromIdb = await idbGet('paperCache')
  if (fromIdb && fromIdb._v === CACHE_VERSION) { _memCache = fromIdb; return }
  _memCache = _lsLoadCache()
  if (Object.keys(_memCache).length > 1) idbPut('paperCache', _memCache)
}

// cache public
export function getCachedPaper(id) { return _ensureCache()[id] || null }

export function cachePaper(id, paper) {
  const c = _ensureCache()
  c[id] = paper
  c._v = CACHE_VERSION
  _persistCache()
}

export function getCachedByTitle(title) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const nq = norm(title); if (!nq) return null
  const c = _ensureCache()
  for (const [k, p] of Object.entries(c)) {
    if (k === '_v') continue
    if (p?.title && norm(p.title) === nq) return p
  }
  return null
}

export function clearAllCache() {
  _memCache = { _v: CACHE_VERSION }
  try { localStorage.removeItem(CACHE_KEY) } catch {}
  idbClear()
}

export function getCacheStats() {
  const c = _ensureCache()
  const entries = Object.keys(c).filter(k => k !== '_v').length
  return { entries, sizeBytes: JSON.stringify(c).length }
}

// project history

// each project
// persist enough
// the per
// pdf blobs
// the json

const PROJECTS_KEY = 'refagent_projects'
const FOLDERS_KEY = 'refagent_folders'
const ACTIVE_FOLDER_KEY = 'refagent_active_folder'

function _loadProjectsMeta() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
function _saveProjectsMeta(arr) {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(arr)) } catch {}
}

// folder management
export function listFolders() {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
function _saveFolders(arr) {
  try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(arr)) } catch {}
}
export function createFolder(name) {
  const folders = listFolders()
  const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  folders.unshift({ id, name: name || 'Untitled folder', createdAt: Date.now() })
  _saveFolders(folders)
  return id
}
export function renameFolder(id, name) {
  const folders = listFolders().map(f => f.id === id ? { ...f, name } : f)
  _saveFolders(folders)
}
export function deleteFolder(id) {
  const folders = listFolders().filter(f => f.id !== id)
  _saveFolders(folders)
// detach projects
  const projs = _loadProjectsMeta().map(p => p.folderId === id ? { ...p, folderId: null } : p)
  _saveProjectsMeta(projs)
}
export function getActiveFolderId() {
  try { return localStorage.getItem(ACTIVE_FOLDER_KEY) || null } catch { return null }
}
export function setActiveFolderId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_FOLDER_KEY, id)
    else localStorage.removeItem(ACTIVE_FOLDER_KEY)
  } catch {}
}

export function listProjects() {
  return _loadProjectsMeta().sort((a, b) => b.createdAt - a.createdAt)
}

export async function getProject(id) {
  const meta = _loadProjectsMeta().find(p => p.id === id)
  if (!meta) return null
  const fullFromIdb = await idbGet(`project:${id}`)
  return fullFromIdb || meta
}

export async function saveProject(project) {
// project name
  const meta = {
    id: project.id,
    name: project.name,
    fileName: project.fileName,
    fileKind: project.fileKind,
    paperTitle: project.paperTitle || '',
    folderId: project.folderId || null,
    createdAt: project.createdAt,
    summary: project.summary,
  }
  const list = _loadProjectsMeta().filter(p => p.id !== project.id)
  list.unshift(meta)
  _saveProjectsMeta(list.slice(0, 50))
  await idbPut(`project:${project.id}`, project)
  return project
}

export async function deleteProject(id) {
  const list = _loadProjectsMeta().filter(p => p.id !== id)
  _saveProjectsMeta(list)
  try {
    const db = await openDB()
    return new Promise(res => {
      const tx = db.transaction('cache', 'readwrite')
      tx.objectStore('cache').delete(`project:${id}`)
      tx.oncomplete = () => res(true)
      tx.onerror = () => res(false)
    })
  } catch { return false }
}

export function newProjectId() {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

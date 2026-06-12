# RefAgent 🔎

**Agentic citation verifier.** Drop a PDF, .tex, or .docx of any academic paper. RefAgent extracts every entry in the bibliography, looks each one up on **arXiv / CrossRef / Semantic Scholar**, and uses an **LLM agent** to flag references that look misattributed or fabricated. Then it lets you **chat with the agent** about the results.

---

## What it does

- Drop PDF
- Extract refs (rule + LLM)
- Lookup (arXiv, CrossRef, Semantic Scholar)
- LLM judges: verified / suspicious / not_found
- Chat with agent, export bibs

- **3-stage extraction**: rule-based + LLM-driven + LLM title cleanup (with self-critique retry)
- **3-source verification**: arXiv export API, CrossRef, Semantic Scholar (via Vercel proxy for CORS + edge cache)
- **Context-aware severity**: after lookups, the LLM judges each unverified ref as "review" (probably real, blue dot) vs "critical" (likely fabricated, red dot)
- **Streaming chain-of-thought**: Mac Studio / Ollama mode streams the agent's reasoning while it works
- **Agent chat tab**: ask follow-up questions, get focused answers grounded in the verification results
- **Inline citation jumps**: click a reference → jump to its inline citation in the rendered PDF, highlighter-marker style. Cycles through all locations on repeated clicks.
- **History + folders**: each verification run is saved (refs, results, chat, thinking log). Group runs into folders.
- **Export to**: BibTeX · Numbered · APA · MLA · Chicago · Vancouver · IEEE · EndNote (RIS) · RefWorks

---

## Use the hosted site

Just go to **YOUR_DEPLOY_URL**, drop a PDF anywhere on the page.

The cloud build runs with the **Groq free-tier proxy** by default (no setup needed). Settings → switch to your local Ollama or to the shared Mac Studio LLM if available.

---

## Run it yourself with your own Ollama

If you want to keep the LLM call private and free:

### 1. Install Ollama

```bash
# macOS
brew install ollama
# or download from https://ollama.com
ollama pull gemma3:27b   # or any other model
```

### 2. Run Ollama with CORS allowed

```bash
OLLAMA_ORIGINS='*' ollama serve
```

(this lets your browser call `http://localhost:11434` directly)

### 3. Open RefAgent

Go to YOUR_DEPLOY_URL → Settings (⚙ bottom-left) → Provider: **Ollama (your own local)** → Model: `gemma3:27b` → Save.

That's it. Drop a paper.

---

## Local development

```bash
git clone <this-repo>
cd Pjt-RefAgent
npm install
npm run dev
# → http://localhost:5173
```

For the Groq proxy (used by `/api/groq`), set a `.env.local`:

```
GROQ_API_KEY=gsk_...
OLLAMA_TUNNEL_URL=https://your-tunnel.ngrok-free.dev   # optional; only if you expose your local Ollama via ngrok
```

Deploy:

```bash
npm i -g vercel
vercel
```

---

## Architecture

```
Pjt-RefAgent/
├── src/
│   ├── App.jsx          # 3-pane UI (sidebar / PDF viewer / refs+chat+log tabs)
│   ├── PDFViewer.jsx    # pdfjs canvas + text layer + sentence highlight + zoom
│   ├── parser.js        # PDF / DOCX / TeX / BibTeX → plain text + page geometry
│   ├── extractor.js     # text → individual reference entries (rule-based)
│   ├── api.js           # arXiv / CrossRef / S2 lookups + 9 citation formatters
│   ├── llm.js           # provider-agnostic chat (Groq / Ollama / Mac Studio tunnel) + streaming
│   ├── agent.js         # extraction · cleanup · self-critique · severity · narration
│   ├── store.js         # settings · API cache (IndexedDB) · projects · folders
│   ├── main.jsx
│   └── index.css
├── api/
│   ├── groq.js          # Vercel Function — Groq proxy (key hidden server-side)
│   ├── ollama.js        # Vercel Function — remote Ollama tunnel proxy (NDJSON streaming)
│   ├── paper.js         # Vercel Function — arxiv/crossref/s2 proxy (CORS + edge cache)
│   └── health.js        # provider health check
├── vercel.json
├── index.html
└── package.json
```

### Why a proxy?

- **Groq API key never reaches the browser** — `/api/groq` lives on Vercel with the key in `GROQ_API_KEY`. Open source the entire repo, no leak.
- **Semantic Scholar rate-limits per IP** — `/api/paper` puts the Vercel edge IP between users and S2, with 24h edge cache for repeat lookups.
- **Mac Studio tunnel via ngrok** — `/api/ollama` forwards to `OLLAMA_TUNNEL_URL`, which can be a free ngrok endpoint. Browsers can't do mixed-content HTTPS → HTTP localhost from a deployed page; the proxy fixes that.

### LLM agent flow

For each reference:

1. **Extract** — rule-based + LLM, merged by arxivId/DOI/title.
2. **Cleanup** — LLM batches normalize titles/authors; a self-critique retry handles the common bug of "title slot accidentally contains author list".
3. **Lookup** — arxivId → arXiv API → S2 fallback. DOI → CrossRef. Title → S2 Match + Search + arXiv Search + CrossRef Search in parallel, scored by exact-match + citation count.
4. **Verdict** — heuristic fast-paths (exact ID, exact title, year match) auto-pass. Ambiguous cases go to the LLM with the cited entry + candidate metadata side-by-side.
5. **Severity classifier** — for unverified entries, the LLM looks at the cited title and decides "review" (plausible, probably an API miss) or "critical" (looks fabricated). Blue dot vs red dot in the sidebar.

### Free-tier guardrails

| Concern | Mitigation |
|---|---|
| Groq 12K TPM | LLM extraction chunks references-only section, throttles between chunks |
| Groq 100K TPD | Automatic fallback chain: `llama-3.3-70b` → `llama-3.1-8b-instant` → `gemma2-9b-it` |
| S2 429 per IP | All lookups go through Vercel edge with 24h cache |
| Mac Studio tunnel | Health check + auto-fallback to Groq if tunnel is offline |

---

## E2E test (Node)

Runs the full extraction pipeline against a PDF, without LLM:

```bash
curl -sL https://arxiv.org/pdf/1706.03762 -o /tmp/attention.pdf
npm run test:e2e -- /tmp/attention.pdf
# → 40 references extracted, ~26 verified via heuristic alone
```

With Ollama enabled and `node test-llm.mjs <path>` you get the same with LLM-driven extraction.

---

## License

MIT

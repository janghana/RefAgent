// vercel function

// the client
// the request
// avoids browser
// hides the
// from many

// supported sources
// semantic scholar
// s2search semantic
// s2match semantic
// arxiv arxiv
// arxiv search
// crossref doi
// crossref crossref

const S2F = 'paperId,title,abstract,authors,year,venue,externalIds,openAccessPdf,tldr,fieldsOfStudy,citationCount,url'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function GET(request) {
  const url = new URL(request.url)
  const source = url.searchParams.get('source') || ''
  const id = url.searchParams.get('id') || ''
  const q = url.searchParams.get('q') || ''

  let upstream
  let headers = {}
  try {
    if (source === 's2') {
      const u = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${S2F}`
      const opts = { headers: {} }
      if (process.env.S2_API_KEY) opts.headers['x-api-key'] = process.env.S2_API_KEY
      upstream = await fetch(u, opts)
    } else if (source === 's2search') {
      const u = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=10&fields=${S2F}`
      const opts = { headers: {} }
      if (process.env.S2_API_KEY) opts.headers['x-api-key'] = process.env.S2_API_KEY
      upstream = await fetch(u, opts)
    } else if (source === 's2match') {
      const u = `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(q)}&fields=${S2F}`
      const opts = { headers: {} }
      if (process.env.S2_API_KEY) opts.headers['x-api-key'] = process.env.S2_API_KEY
      upstream = await fetch(u, opts)
    } else if (source === 'arxiv-id') {
      const u = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`
      upstream = await fetch(u)
    } else if (source === 'arxiv-search') {
      const u = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&start=0&max_results=10&sortBy=relevance`
      upstream = await fetch(u)
    } else if (source === 'crossref-doi') {
      const u = `https://api.crossref.org/works/${encodeURIComponent(id)}`
      upstream = await fetch(u, { headers: { Accept: 'application/json' } })
    } else if (source === 'crossref-q') {
      const u = `https://api.crossref.org/works?${new URLSearchParams({ 'query.title': q, rows: '15' }).toString()}`
      upstream = await fetch(u, { headers: { Accept: 'application/json' } })
    } else {
      return Response.json({ error: `unknown source "${source}"` }, { status: 400, headers: corsHeaders })
    }
  } catch (err) {
    return Response.json({ error: 'upstream error', detail: String(err?.message || err) }, { status: 502, headers: corsHeaders })
  }

  const respHeaders = new Headers(corsHeaders)
  respHeaders.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream')
// cache successful
  if (upstream.ok) respHeaders.set('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
  const body = await upstream.text()
  return new Response(body, { status: upstream.status, headers: respHeaders })
}

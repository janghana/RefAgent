// vercel function

// keeps groq
// openai style
// api groq

// set vercel
// local dev

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

// headers forward
const FORWARD_HEADERS = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'retry-after',
]

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function POST(request) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'GROQ_API_KEY not configured on server' }, { status: 500, headers: corsHeaders })
  }

  let body
  try { body = await request.json() }
  catch { return Response.json({ error: 'Bad JSON body' }, { status: 400, headers: corsHeaders }) }

  if (!body || !body.model || !Array.isArray(body.messages)) {
    return Response.json({ error: 'Body must include { model, messages, ... }' }, { status: 400, headers: corsHeaders })
  }

  let upstream
  try {
    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return Response.json({ error: 'Upstream Groq error', detail: String(err?.message || err) }, { status: 502, headers: corsHeaders })
  }

  const headers = new Headers(corsHeaders)
  headers.set('Content-Type', upstream.headers.get('content-type') || 'application/json')
  for (const h of FORWARD_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) headers.set(h, v)
  }
// expose those
  headers.set('Access-Control-Expose-Headers', FORWARD_HEADERS.join(', '))

  const text = await upstream.text()
  return new Response(text, { status: upstream.status, headers })
}

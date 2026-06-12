// vercel function

// client posts
// ollama api
// the assistant
// llm client

// set vercel
// https abcd

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders })
}

// get list
export async function GET() {
  const base = process.env.OLLAMA_TUNNEL_URL
  if (!base) return Response.json({ ok: false, reason: 'OLLAMA_TUNNEL_URL not set' }, { status: 503, headers: corsHeaders })
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/api/tags`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
    })
    if (!r.ok) return Response.json({ ok: false, reason: `Tunnel HTTP ${r.status}` }, { status: 502, headers: corsHeaders })
    const data = await r.json()
    return Response.json({ ok: true, models: (data.models || []).map(m => m.name) }, { headers: corsHeaders })
  } catch (e) {
    return Response.json({ ok: false, reason: String(e?.message || e) }, { status: 502, headers: corsHeaders })
  }
}

export async function POST(request) {
  const base = process.env.OLLAMA_TUNNEL_URL
  if (!base) {
    return Response.json({ error: 'OLLAMA_TUNNEL_URL not configured on server' }, { status: 500, headers: corsHeaders })
  }

  let body
  try { body = await request.json() }
  catch { return Response.json({ error: 'Bad JSON body' }, { status: 400, headers: corsHeaders }) }

  if (!body?.model || !Array.isArray(body.messages)) {
    return Response.json({ error: 'Body must include { model, messages, ... }' }, { status: 400, headers: corsHeaders })
  }

  const wantStream = !!body.stream
  const ollamaBody = {
    model: body.model,
    messages: body.messages,
    stream: wantStream,
// qwen3 style
// reasoning when
// output harmless
    think: false,
    options: {
      temperature: body.temperature ?? 0.1,
      num_predict: body.max_tokens || 800,
    },
  }
  if (body.response_format?.type === 'json_object') ollamaBody.format = 'json'

  let upstream
  try {
    upstream = await fetch(`${base.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify(ollamaBody),
    })
  } catch (err) {
    return Response.json({ error: 'Tunnel unreachable', detail: String(err?.message || err) }, { status: 502, headers: corsHeaders })
  }

  if (!upstream.ok) {
    const text = await upstream.text()
    return Response.json({ error: `Ollama ${upstream.status}`, detail: text.slice(0, 600) }, { status: upstream.status, headers: corsHeaders })
  }

// streaming forward
  if (wantStream) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
      },
    })
  }

// non streaming
  const data = await upstream.json()
  const content = data?.message?.content || ''
  const synthetic = {
    id: `ollama-${Date.now()}`,
    object: 'chat.completion',
    model: data?.model || body.model,
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: data?.prompt_eval_count || 0,
      completion_tokens: data?.eval_count || 0,
      total_tokens: (data?.prompt_eval_count || 0) + (data?.eval_count || 0),
    },
  }
  return new Response(JSON.stringify(synthetic), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

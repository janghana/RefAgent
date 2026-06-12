// lightweight health
// and that

export async function GET() {
  const hasKey = !!process.env.GROQ_API_KEY
  return Response.json(
    { ok: hasKey, provider: 'groq' },
    {
      status: hasKey ? 200 : 503,
      headers: { 'Access-Control-Allow-Origin': '*' },
    }
  )
}

// Test actual candidate models with a realistic prompt.
import { config } from 'dotenv';
config({ path: '.env.local' });

const TEST_PROMPT = 'Return a single JSON object: {"status":"ok","number":42}. No markdown, no explanation.';

async function testGemini(model) {
  const key = process.env.GEMINI_API_KEY;
  const start = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
          generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
        }),
      },
    );
    const ms = Date.now() - start;
    if (!res.ok) {
      const t = await res.text();
      return { model, ok: false, error: `${res.status} ${t.slice(0, 200)}`, ms };
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const finish = data.candidates?.[0]?.finishReason;
    return { model, ok: !!text, text: text?.slice(0, 100), finishReason: finish, ms };
  } catch (e) {
    return { model, ok: false, error: e.message, ms: Date.now() - start };
  }
}

async function testOpenRouter(model) {
  const key = process.env.OPENROUTER_API_KEY;
  const start = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'DFS Calculator',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        max_tokens: 100,
        temperature: 0.1,
      }),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      const t = await res.text();
      return { model, ok: false, error: `${res.status} ${t.slice(0, 200)}`, ms };
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    return { model, ok: !!text, text: text?.slice(0, 100), ms };
  } catch (e) {
    return { model, ok: false, error: e.message, ms: Date.now() - start };
  }
}

async function main() {
  console.log('=== Testing Gemini models ===');
  const geminiModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
  for (const m of geminiModels) {
    const r = await testGemini(m);
    const status = r.ok ? 'OK  ' : 'FAIL';
    console.log(`  ${status} ${m} (${r.ms}ms) — ${r.text || r.error || r.finishReason}`);
  }

  console.log('\n=== Testing OpenRouter free models ===');
  const orModels = [
    'openai/gpt-oss-120b:free',
    'openai/gpt-oss-20b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
    'z-ai/glm-4.5-air:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'minimax/minimax-m2.5:free',
  ];
  for (const m of orModels) {
    const r = await testOpenRouter(m);
    const status = r.ok ? 'OK  ' : 'FAIL';
    console.log(`  ${status} ${m} (${r.ms}ms) — ${r.text?.replace(/\s+/g, ' ') || r.error}`);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

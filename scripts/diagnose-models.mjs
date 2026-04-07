// Diagnose which Gemini + OpenRouter models are available on our keys.
// Run: node scripts/diagnose-models.mjs

import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  console.log('=== Gemini ListModels ===');
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) { console.error('No GEMINI_API_KEY'); return; }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
    if (!res.ok) { console.error('Gemini list failed:', res.status, await res.text()); return; }
    const data = await res.json();
    const models = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    console.log(`Found ${models.length} models supporting generateContent:`);
    // Only print the interesting stable ones
    const filtered = models.filter((m) => !m.includes('embedding') && !m.includes('aqa') && !m.includes('imagen'));
    filtered.forEach((m) => console.log(`  - ${m}`));
  } catch (e) { console.error('Gemini error:', e.message); }

  console.log('\n=== OpenRouter free models (DeepSeek, Llama) ===');
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) { console.error('No OPENROUTER_API_KEY'); return; }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${orKey}` },
    });
    if (!res.ok) { console.error('OpenRouter list failed:', res.status, await res.text()); return; }
    const data = await res.json();
    const models = data.data || [];
    console.log(`Total models on OpenRouter: ${models.length}`);

    // Find free models (pricing.prompt === "0")
    const freeModels = models.filter((m) => {
      const promptPrice = parseFloat(m.pricing?.prompt || '0');
      const completionPrice = parseFloat(m.pricing?.completion || '0');
      return promptPrice === 0 && completionPrice === 0;
    });
    console.log(`\nFree models (${freeModels.length}):`);
    freeModels.slice(0, 30).forEach((m) => {
      const ctx = m.context_length ? ` [${(m.context_length / 1000).toFixed(0)}k ctx]` : '';
      console.log(`  - ${m.id}${ctx}`);
    });
    if (freeModels.length > 30) console.log(`  ... and ${freeModels.length - 30} more`);

    // Verify deepseek-r1 specifically
    const r1 = models.find((m) => m.id === 'deepseek/deepseek-r1:free');
    console.log(`\ndeepseek/deepseek-r1:free available: ${r1 ? 'YES' : 'NO'}`);
    if (r1) console.log(`  context: ${r1.context_length}, pricing: ${JSON.stringify(r1.pricing)}`);
  } catch (e) { console.error('OpenRouter error:', e.message); }

  console.log('\n=== Quick Gemini generateContent test ===');
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with just: OK' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      },
    );
    if (res.ok) {
      const data = await res.json();
      console.log('gemini-2.5-pro: WORKS —', data.candidates?.[0]?.content?.parts?.[0]?.text?.trim());
    } else {
      console.log('gemini-2.5-pro: FAIL —', res.status);
    }
  } catch (e) { console.error(e.message); }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with just: OK' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      },
    );
    if (res.ok) {
      const data = await res.json();
      console.log('gemini-2.5-flash: WORKS —', data.candidates?.[0]?.content?.parts?.[0]?.text?.trim());
    } else {
      console.log('gemini-2.5-flash: FAIL —', res.status);
    }
  } catch (e) { console.error(e.message); }

  console.log('\n=== Quick OpenRouter deepseek-r1:free test ===');
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${orKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-r1:free',
        messages: [{ role: 'user', content: 'Reply with just: OK' }],
        max_tokens: 20,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      console.log('deepseek-r1:free: WORKS —', data.choices?.[0]?.message?.content?.slice(0, 50));
    } else {
      console.log('deepseek-r1:free: FAIL —', res.status, await res.text());
    }
  } catch (e) { console.error(e.message); }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

// Works with LibreTranslate (self-hosted or hosted). Swap this one function to use another provider.
export async function translateParagraphs(paras) {
  const url = process.env.TRANSLATE_URL;
  if (!url) throw new Error('TRANSLATE_URL is not set');
  const out = [];
  for (let i = 0; i < paras.length; i += 10) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: paras.slice(i, i + 10), source: 'en', target: 'hi', format: 'text', api_key: process.env.TRANSLATE_KEY || undefined })
    });
    if (!r.ok) throw new Error('translate ' + r.status);
    out.push(...(await r.json()).translatedText);
  }
  return out;
}

// Pulls philosophers from Wikidata in two cheap steps, saving after every batch so a failure never loses progress:
//   1) one light query: ids + popularity (no labels, no paging)
//   2) details for 100 ids at a time (anchored on the ids, so it stays fast)
// Safe to re-run: philosophers already in the database are skipped.
import 'dotenv/config';
import mongoose from 'mongoose';
import { Philosopher } from '../models.js';

const MIN = +process.env.MIN_SITELINKS || 8;
const BATCH = 100;
const UA = { 'User-Agent': 'AgoraLibrary/1.0 (learning project)', Accept: 'application/sparql-results+json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const v = (row, k) => row[k]?.value;
const last = u => u.split('/').pop();
// Wikidata sometimes returns a placeholder link (unknown date) instead of a date, so never assume a match.
const year = s => {
  const m = typeof s === 'string' && s.match(/^[+-]?\d{1,6}(?=-\d\d-\d\d)/);
  return m ? parseInt(m[0], 10) : undefined;
};
const wikiTitle = u => (u ? decodeURIComponent(u.split('/wiki/')[1] || '') : '');

async function sparql(query, tries = 4) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query, format: 'json' })
      });
      if (r.ok) return (await r.json()).results.bindings;
      console.log(`Wikidata returned ${r.status}. Attempt ${a}/${tries}`);
    } catch (e) { console.log(`Network error (${e.message}). Attempt ${a}/${tries}`); }
    await sleep(4000 * a);
  }
  throw new Error('Wikidata request failed after retries. Try again in a minute, or raise MIN_SITELINKS in .env (for example 15).');
}

async function summary(lang, title) {
  if (!title) return undefined;
  try {
    const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { headers: UA });
    return r.ok ? (await r.json()).extract : undefined;
  } catch { return undefined; }
}

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agora');

  console.log(`Step 1: listing philosophers with at least ${MIN} Wikipedia editions...`);
  const rows = await sparql(`SELECT ?p ?s WHERE { ?p wdt:P106 wd:Q4964182; wikibase:sitelinks ?s. FILTER(?s >= ${MIN}) }`);
  const seen = new Map();
  rows.forEach(r => seen.set(last(v(r, 'p')), +v(r, 's')));
  const have = new Set((await Philosopher.find({}, '_id').lean()).map(p => p._id));
  const todo = [...seen].sort((a, b) => b[1] - a[1]).filter(([id]) => !have.has(id));
  console.log(`Found ${seen.size} philosophers, ${have.size} already saved, ${todo.length} to fetch.`);

  let saved = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH), values = chunk.map(([id]) => 'wd:' + id).join(' ');
    const details = await sparql(`
      SELECT ?p ?en ?hi ?desc ?birth ?death ?img ?enA ?hiA WHERE {
        VALUES ?p { ${values} }
        ?p rdfs:label ?en. FILTER(lang(?en) = "en")
        OPTIONAL { ?p rdfs:label ?hi. FILTER(lang(?hi) = "hi") }
        OPTIONAL { ?p schema:description ?desc. FILTER(lang(?desc) = "en") }
        OPTIONAL { ?p wdt:P569 ?birth } OPTIONAL { ?p wdt:P570 ?death } OPTIONAL { ?p wdt:P18 ?img }
        OPTIONAL { ?enA schema:about ?p; schema:isPartOf <https://en.wikipedia.org/> }
        OPTIONAL { ?hiA schema:about ?p; schema:isPartOf <https://hi.wikipedia.org/> }
      }`);
    const schools = {};
    try {
      for (const r of await sparql(`SELECT ?p ?ml WHERE { VALUES ?p { ${values} } ?p wdt:P135 ?m. ?m rdfs:label ?ml. FILTER(lang(?ml) = "en") }`))
        (schools[last(v(r, 'p'))] ||= new Set()).add(v(r, 'ml'));
    } catch { console.log('Schools lookup skipped for this batch.'); }

    const byId = new Map();
    details.forEach(r => { const id = last(v(r, 'p')); if (!byId.has(id)) byId.set(id, r); });
    const ids = [...byId.keys()];
    for (let j = 0; j < ids.length; j += 5) {
      const ops = await Promise.all(ids.slice(j, j + 5).map(async id => {
        const r = byId.get(id);
        const [bio, bioHi] = await Promise.all([summary('en', wikiTitle(v(r, 'enA'))), summary('hi', wikiTitle(v(r, 'hiA')))]);
        return { updateOne: { filter: { _id: id }, upsert: true, update: { $set: {
          name: v(r, 'en'), nameHi: v(r, 'hi'), description: v(r, 'desc'), bio: bio || v(r, 'desc'), bioHi,
          birthYear: year(v(r, 'birth')), deathYear: year(v(r, 'death')), image: v(r, 'img'),
          wikiEn: v(r, 'enA'), wikiHi: v(r, 'hiA'), schools: [...(schools[id] || [])], sitelinks: seen.get(id)
        } } } };
      }));
      await Philosopher.bulkWrite(ops);
    }
    saved += ids.length;
    console.log(`Saved ${saved} / ${todo.length}`);
    await sleep(1500);
  }
  console.log('Done. Philosophers in database:', await Philosopher.countDocuments());
  await mongoose.disconnect();
};
main().catch(e => { console.error(e.message); process.exit(1); });
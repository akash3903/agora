// For each philosopher, finds their public-domain English books on Project Gutenberg (via Gutendex),
// downloads the text, cuts it into chapters and stores it. Safe to re-run: existing books are skipped.
import 'dotenv/config';
import mongoose from 'mongoose';
import { Philosopher, Book, Chapter } from '../models.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HEAD = /^(book|chapter|part|section|canto|dialogue|meditation|essay)\s+([ivxlcdm]+|\d+|the \w+)\b.{0,60}$/i;

export function split(raw) {
  let t = raw.replace(/\r/g, '');
  const s = t.search(/\*\*\* ?START OF/i); if (s >= 0) t = t.slice(t.indexOf('\n', s) + 1);
  const e = t.search(/\*\*\* ?END OF/i); if (e >= 0) t = t.slice(0, e);
  const paras = t.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  const out = []; let cur = { heading: 'Beginning', paragraphs: [] };
  for (const p of paras) {
    if (p.length < 80 && HEAD.test(p)) {
      if (cur.paragraphs.length >= 3) out.push(cur);
      cur = { heading: p, paragraphs: cur.paragraphs.length >= 3 ? [] : cur.paragraphs };
    } else cur.paragraphs.push(p);
  }
  if (cur.paragraphs.length) out.push(cur);
  // fall back to fixed-size parts when no headings were found, and cap very long chapters
  const final = [];
  for (const c of out.length >= 3 ? out : [{ heading: 'Text', paragraphs: paras }])
    for (let i = 0; i < c.paragraphs.length; i += 60)
      final.push({ heading: c.paragraphs.length > 60 ? `${c.heading} (${i / 60 + 1})` : c.heading, paragraphs: c.paragraphs.slice(i, i + 60) });
  return final;
}

const gj = async url => { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); };

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agora');
  const list = await Philosopher.find({ birthYear: { $exists: true } }).sort({ sitelinks: -1 }).limit(+process.env.BOOK_LIMIT || 500);
  if (!list.length) { console.log('No philosophers in the database yet. Run: npm run ingest:philosophers'); await mongoose.disconnect(); return; }
  console.log(`Looking up books for ${list.length} philosophers...`);
  for (const p of list) {
    try {
      let url = `https://gutendex.com/books?search=${encodeURIComponent(p.name)}&languages=en&copyright=false`;
      for (let page = 0; url && page < 3; page++) {
        const d = await gj(url); url = d.next;
        for (const b of d.results) {
          if (!b.authors.some(a => a.birth_year === p.birthYear)) continue;   // exact author match
          const id = 'g' + b.id;
          if (await Book.exists({ _id: id })) continue;
          const txt = b.formats['text/plain; charset=utf-8'] || b.formats['text/plain; charset=us-ascii'] || b.formats['text/plain'];
          if (!txt) continue;
          const r = await fetch(txt); if (!r.ok) continue;
          const chapters = split(await r.text());
          if (!chapters.length) continue;
          await Chapter.insertMany(chapters.map((c, i) => ({ bookId: id, n: i + 1, ...c })));
          await Book.create({ _id: id, title: b.title, philosopherId: p._id, gutenbergId: b.id, subjects: b.subjects, downloads: b.download_count, chapterCount: chapters.length });
          console.log(`${p.name}: ${b.title} (${chapters.length} chapters)`);
          await sleep(400);
        }
      }
      await Philosopher.updateOne({ _id: p._id }, { bookCount: await Book.countDocuments({ philosopherId: p._id }) });
    } catch (e) { console.error('skip', p.name, e.message); }
    await sleep(400);
  }
  await mongoose.disconnect();
};
if (process.argv[1].endsWith('books.js')) main().catch(e => { console.error(e); process.exit(1); });
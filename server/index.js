import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import { Philosopher, Book, Chapter } from './models.js';
import { translateParagraphs } from './translate.js';

const app = express();
app.use(express.static('public'));
const wrap = fn => (req, res, next) => fn(req, res).catch(next);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pView = (p, hi) => ({
  id: p._id, name: (hi && p.nameHi) || p.name, description: p.description,
  bio: (hi && p.bioHi) || p.bio, image: p.image, schools: p.schools,
  years: [p.birthYear, p.deathYear].filter(v => v != null).join(' – '), bookCount: p.bookCount
});
const bView = b => ({ id: b._id, title: b.title, philosopherId: b.philosopherId, subjects: b.subjects.slice(0, 4), chapterCount: b.chapterCount });

// Philosopher cards: /api/philosophers?q=plato&page=1&all=1
app.get('/api/philosophers', wrap(async (req, res) => {
  const hi = req.query.lang === 'hi', page = Math.max(1, +req.query.page || 1), limit = 24;
  const f = {};
  if (!req.query.all) f.bookCount = { $gt: 0 };
  if (req.query.q) { const r = new RegExp(esc(req.query.q), 'i'); f.$or = [{ name: r }, { nameHi: r }]; }
  const [items, total] = await Promise.all([
    Philosopher.find(f).sort({ bookCount: -1, sitelinks: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Philosopher.countDocuments(f)
  ]);
  res.json({ total, page, hasMore: page * limit < total, items: items.map(p => pView(p, hi)) });
}));

// Loads the full Wikipedia bio (English + Hindi) the first time a philosopher is opened, then stores it.
async function fillBio(p) {
  if (p.bioDone) return p;
  const get = async u => {
    if (!u) return undefined;
    try {
      const lang = new URL(u).hostname.split('.')[0], title = decodeURIComponent(u.split('/wiki/')[1] || '');
      const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        { headers: { 'User-Agent': 'AgoraLibrary/1.0 (learning project)' }, signal: AbortSignal.timeout(8000) });
      return r.ok ? (await r.json()).extract : undefined;
    } catch { return undefined; }
  };
  const [en, hi] = await Promise.all([get(p.wikiEn), get(p.wikiHi)]);
  const bio = en || p.bio, bioHi = hi || p.bioHi;
  if (en || hi || (!p.wikiEn && !p.wikiHi))                 // if the network failed, try again next time
    await Philosopher.updateOne({ _id: p._id }, { $set: { bio, bioHi, bioDone: true } });
  return { ...p, bio, bioHi };
}

// Philosopher detail + their books
app.get('/api/philosophers/:id', wrap(async (req, res) => {
  let p = await Philosopher.findById(req.params.id).lean();
  if (!p) return res.status(404).json({ error: 'Not found' });
  p = await fillBio(p);
  const books = await Book.find({ philosopherId: p._id }).sort({ downloads: -1 }).lean();
  res.json({ ...pView(p, req.query.lang === 'hi'), books: books.map(bView) });
}));

// Book meta + table of contents (chapter number and heading, no text)
app.get('/api/books/:id', wrap(async (req, res) => {
  const b = await Book.findById(req.params.id).lean();
  if (!b) return res.status(404).json({ error: 'Not found' });
  const [p, chapters] = await Promise.all([
    Philosopher.findById(b.philosopherId).lean(),
    Chapter.find({ bookId: b._id }, 'n heading -_id').sort({ n: 1 }).lean()
  ]);
  res.json({ ...bView(b), author: p && pView(p, req.query.lang === 'hi').name, chapters });
}));

// One chapter (Hindi is translated on first request, then cached)
app.get('/api/books/:id/chapters/:n', wrap(async (req, res) => {
  const c = await Chapter.findOne({ bookId: req.params.id, n: +req.params.n });
  if (!c) return res.status(404).json({ error: 'Not found' });
  const total = await Chapter.countDocuments({ bookId: req.params.id });
  let paragraphs = c.paragraphs, lang = 'en';
  if (req.query.lang === 'hi') {
    try {
      if (!c.hi?.length) { c.hi = await translateParagraphs(c.paragraphs); await c.save(); }
      paragraphs = c.hi; lang = 'hi';
    } catch (e) { console.error('Hindi translation failed:', e.message); }   // falls back to English
  }
  res.json({ n: c.n, total, heading: c.heading, paragraphs, lang });
}));

// "Read next": scores unread books by subject, philosopher and school overlap with what the user finished
app.get('/api/recommend', wrap(async (req, res) => {
  const read = (req.query.read || '').split(',').filter(Boolean);
  const readBooks = await Book.find({ _id: { $in: read } }).lean();
  const subj = new Map(), phils = new Set();
  readBooks.forEach(b => { phils.add(b.philosopherId); b.subjects.forEach(s => subj.set(s, (subj.get(s) || 0) + 1)); });
  const schools = new Set((await Philosopher.find({ _id: { $in: [...phils] } }).lean()).flatMap(p => p.schools));
  const cands = await Book.find({ _id: { $nin: read } }).sort({ downloads: -1 }).limit(600).lean();
  const owners = Object.fromEntries((await Philosopher.find({ _id: { $in: [...new Set(cands.map(b => b.philosopherId))] } }).lean()).map(p => [p._id, p]));
  const scored = cands.map(b => {
    const o = owners[b.philosopherId];
    let s = Math.log10(b.downloads + 10);
    b.subjects.forEach(x => { s += 3 * (subj.get(x) || 0); });
    if (phils.has(b.philosopherId)) s += 2;
    (o?.schools || []).forEach(x => { if (schools.has(x)) s += 1.5; });
    return { s, b, o };
  }).sort((a, z) => z.s - a.s).slice(0, +req.query.limit || 4);
  res.json(scored.map(({ b, o }) => ({ ...bView(b), author: o && pView(o, req.query.lang === 'hi').name })));
}));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agora');
app.listen(process.env.PORT || 3000, () => console.log('Agora running on port ' + (process.env.PORT || 3000)));
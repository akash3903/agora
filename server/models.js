import mongoose from 'mongoose';
const { Schema, model } = mongoose;

export const Philosopher = model('Philosopher', new Schema({
  _id: String,                       // Wikidata id, e.g. Q859
  name: String, nameHi: String,
  description: String,
  bio: String, bioHi: String, bioDone: Boolean,   // bioDone: full Wikipedia bio already loaded
  birthYear: Number, deathYear: Number,
  image: String, wikiEn: String, wikiHi: String,
  schools: [String],
  sitelinks: { type: Number, default: 0 },   // popularity proxy
  bookCount: { type: Number, default: 0 }
}).index({ name: 'text', nameHi: 'text' }).index({ bookCount: -1, sitelinks: -1 }));

export const Book = model('Book', new Schema({
  _id: String,                       // "g" + Gutenberg id
  title: String,
  philosopherId: { type: String, index: true },
  gutenbergId: Number,
  language: { type: String, default: 'en' },
  subjects: [String],
  downloads: { type: Number, default: 0 },
  chapterCount: Number
}));

export const Chapter = model('Chapter', new Schema({
  bookId: String, n: Number, heading: String,
  paragraphs: [String],
  hi: [String]                        // cached Hindi translation
}).index({ bookId: 1, n: 1 }, { unique: true }));
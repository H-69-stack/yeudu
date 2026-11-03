import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/app.db');
const cols = db.prepare("pragma table_info(works)").all();
console.log(cols.map(c=>c.name).join(', '));

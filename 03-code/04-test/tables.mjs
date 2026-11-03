import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/app.db');
const tables = db.prepare("select name from sqlite_master where type='table' order by name").all();
console.log(tables.map(t=>t.name).join(', '));

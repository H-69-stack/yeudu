import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/app.db');
const rows = db.prepare("select no, title, local_path from works where local_path is not null limit 10").all();
console.log(JSON.stringify(rows, null, 1));

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const c = new Database('data/app.db');
const rows = c.prepare("select w.no, w.title, w.local_path from works w where w.local_path is not null limit 8").all();
console.log(JSON.stringify(rows, null, 1));

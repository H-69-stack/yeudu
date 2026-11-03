import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const db = new DatabaseSync('data/app.db');
const downloadDir = path.resolve('storage/pdfs');
const rows = db.prepare(`select w.no, w.title, a.storage_rel_path from works w join assets a on a.work_id=w.id and a.kind='pdf' limit 12`).all();
for (const r of rows) {
  const abs = r.storage_rel_path ? path.join(downloadDir, r.storage_rel_path) : null;
  const exists = abs && fs.existsSync(abs);
  const size = exists ? fs.statSync(abs).size : 0;
  console.log(JSON.stringify({ no: r.no, exists, KB: Math.round(size/1024), rel: r.storage_rel_path }));
}

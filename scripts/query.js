// Ad-hoc SQL against whichever database lib/db.js resolves to.
//   node scripts/query.js "select count(*) from fact_daily"
import { query, close } from '../lib/db.js';

const sql = process.argv.slice(2).join(' ');
if (!sql) { console.error('usage: node scripts/query.js "<sql>"'); process.exit(1); }

const res = await query(sql);
if (res.rows?.length) console.table(res.rows.slice(0, 50));
else console.log('(no rows)', res.affectedRows ?? '');
await close();

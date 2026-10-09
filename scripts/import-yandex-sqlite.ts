/**
 * Merge a recovered Yandex SQLite export into a copy of the RelaxDev PostgreSQL DB.
 *
 * DEFAULT = dry-run; actual writes require --apply. NEVER overwrites a PG row.
 * Every old row, including conflicting or otherwise unmapped records, is archived.
 * Audit and old upload logs keep their legacy_id to avoid duplicates on repeated imports.
 * Manager periods are archived only because overlapping live intervals need review.
 */
import fs from 'node:fs';
import { pgRows, pgTx } from '../src/lib/postgres';

type R = Record<string, unknown>;
type ExportData = { version: 1; manual: Record<string, R[]>; radar: Record<string, R[]> };
const filename = process.argv[2];
const apply = process.argv.includes('--apply');
if (!filename || filename.startsWith('--')) {
  console.error('Usage: RADAR_STORAGE=postgres DATABASE_URL=... npx tsx scripts/import-yandex-sqlite.ts backup.json [--apply]');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(filename, 'utf8')) as ExportData;
if (data.version !== 1 || !data.manual || !data.radar) throw new Error('Unsupported or corrupt export');
const stats: Record<string, number> = {};
let collisions = 0;
let archived = 0;

await pgTx(async c => {
  for (const source of ['manual', 'radar'] as const) {
    for (const [table, records] of Object.entries(data[source])) {
      if (!Array.isArray(records)) throw new Error('Not an array: '+source+'.'+table);
      for (let i=0;i<records.length;i++) {
        const r=records[i];
        const key = r.id != null ? String(r.id) :
          (table==='meta' ? String(r.key) :
           r.date!=null && r.shop_code!=null
             ? [r.date,r.shop_code,r.field??''].join('|')
             : r.shop_code!=null ? String(r.shop_code) : String(i));
        if (apply) {
          const result=await c.query(
            'INSERT INTO radar_pg_archive(kind,legacy_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',
            [source+'.'+table,key,JSON.stringify(r)]);
          archived += result.rowCount??0;
        } else archived++;
        stats[source+'.'+table]=(stats[source+'.'+table]??0)+1;
      }
    }
  }

  // Restore only records missing on RelaxDev. In conflicts we KEEP RelaxDev
  // as source of truth and leave old record in archive for later manual review.
  const maps: Record<string,{table:string;columns:string[];keys:string[]}> = {
    showcase_fill: {table:'radar_pg_showcase_fill',columns:['date','shop_code','fill','updated_at'],keys:['date','shop_code']},
    showcase_fill_afternoon:{table:'radar_pg_showcase_fill_afternoon',columns:['date','shop_code','fill','updated_at'],keys:['date','shop_code']},
    showcase_note:{table:'radar_pg_showcase_note',columns:['date','shop_code','note','updated_at'],keys:['date','shop_code']},
    showcase_day:{table:'radar_pg_showcase_day',columns:['date','updated_at'],keys:['date']},
    shop_norms:{table:'radar_pg_shop_norms',columns:['shop_code','driver_at','cook_shifts','updated_at'],keys:['shop_code']},
    contest_violations:{table:'radar_pg_contest_violations',columns:['id','shop_code','region','reason','created_at'],keys:['id']},
    showcase_audit:{table:'radar_pg_showcase_audit',columns:['at','date','shop_code','field','old_value','new_value','source','legacy_id'],keys:['legacy_id']},
    uploads:{table:'radar_pg_uploads',columns:['at','original_name','file_name','kind','summary','dates','rows','mode','legacy_id'],keys:['legacy_id']},
  };
  for (const [name,cfg] of Object.entries(maps)) {
    for (const raw of data.manual[name] ?? []) {
      const r={...raw};
      if(name==='showcase_audit'||name==='uploads')r.legacy_id=r.id;
      const values=cfg.columns.map(k=>r[k]??null);
      if (values.some((v,i)=>v===null&&cfg.keys.includes(cfg.columns[i])))continue;
      const found=await c.query('SELECT 1 FROM '+cfg.table+' WHERE '+cfg.keys.map((k,i)=>k+'=$'+(i+1)).join(' AND ')+' LIMIT 1',cfg.keys.map(k=>r[k]));
      if(found.rows.length){collisions++;continue;}
      if(apply){
        await c.query('INSERT INTO '+cfg.table+'('+cfg.columns.map(k=>'"'+k+'"').join(',')+') VALUES('+values.map((_,i)=>'$'+(i+1)).join(',')+') ON CONFLICT DO NOTHING',values);
      }
    }
  }
  if (!apply) await c.query('ROLLBACK'); // Safety: no persistent writes.
});
console.log(JSON.stringify({mode:apply?'applied':'dry-run',oldRows:stats,archived,conflictsKeptOnRelax:collisions},null,2));
console.log('Next: review radar_pg_archive, especially region_periods and collisions, before switching traffic.');

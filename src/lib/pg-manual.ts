import { pgRows, pgTx, type DbClient } from './postgres';
import { normalizeFill } from './status';
import { sortTimes } from './parsers/shop-norms';
import { normalizeCode } from './shops';
import { todayIso } from './time';
import type { ShowcaseStore, ShowcaseEdit, SaveShowcaseOptions } from './showcase-store';
import type { ShopNormsEdit, ShopNormsStore } from './shop-norms-store';
import type { ShopNorms, RegionPeriod } from './types';
import type { ShowcaseAuditFilter, ShowcaseAuditEntry, ShowcaseEditSource } from './showcase-audit';
import type { ContestViolation } from './contest-violations-store';
import type { UploadLogEntry } from './upload-log';

// PostgreSQL replaces only the manual SQLite store. The original SQLite code stays
// available for recovering the Yandex VM. All dates/timestamps are TEXT to preserve
// the original ISO strings and avoid timezone changes on round trips.
const TABLES = {
  fill: 'radar_pg_showcase_fill',
  fill_afternoon: 'radar_pg_showcase_fill_afternoon',
  note: 'radar_pg_showcase_note',
} as const;

type Seed = Omit<ShowcaseStore, 'source'>;

async function meta(c: DbClient, key: string): Promise<string | null> {
  const rows = await c.query('SELECT value FROM radar_pg_meta WHERE key=$1', [key]);
  return rows.rows.length ? String(rows.rows[0].value) : null;
}
async function setMeta(c: DbClient, key: string, value: string): Promise<void> {
  await c.query('INSERT INTO radar_pg_meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key,value]);
}

// Bulk seed reduces hundreds of sequential remote PostgreSQL round trips to
// three inserts. A cold RelaxDev instance must not time out while SSR renders.
let seedTask: Promise<void> | null = null;
export async function pgSeedShowcase(readSeed: () => Seed): Promise<void> {
  if (!seedTask) {
    seedTask = pgTx(async c => {
      if (await meta(c, 'showcase_seeded')) return;
      const seed = readSeed();
      const stamp = (day: string) => seed.touched[day] ?? seed.updatedAt ?? new Date().toISOString();
      const fills = (days: Seed['days']) => Object.entries(days).flatMap(([date, values]) =>
        Object.entries(values).map(([shop_code, fill]) => ({ date, shop_code, fill, updated_at: stamp(date) })));
      const notes = Object.entries(seed.notes || {}).flatMap(([date, values]) =>
        Object.entries(values).map(([shop_code, note]) => ({ date, shop_code, note, updated_at: stamp(date) })));
      const touches = Object.entries(seed.touched || {}).map(([date, updated_at]) => ({date, updated_at}));
      const dates = new Set([...Object.keys(seed.days), ...Object.keys(seed.afternoon), ...Object.keys(seed.notes || {})]);
      for(const date of dates) {
        if (!touches.some(t => t.date === date)) touches.push({date, updated_at: stamp(date)});
      }
      const sqlFill = (table: string) =>
        'INSERT INTO ' + table + ' (date,shop_code,fill,updated_at) ' +
        'SELECT date,shop_code,fill,updated_at FROM jsonb_to_recordset($1::jsonb) ' +
        'AS r(date text,shop_code text,fill double precision,updated_at text) ON CONFLICT DO NOTHING';
      for (const [table, rows] of [
        ['radar_pg_showcase_fill', fills(seed.days)],
        ['radar_pg_showcase_fill_afternoon', fills(seed.afternoon)],
      ] as const) {
        if (rows.length) await c.query(sqlFill(table), [JSON.stringify(rows)]);
      }
      if (notes.length) await c.query(
        'INSERT INTO radar_pg_showcase_note(date,shop_code,note,updated_at) ' +
        'SELECT date,shop_code,note,updated_at FROM jsonb_to_recordset($1::jsonb) ' +
        'AS r(date text,shop_code text,note text,updated_at text) ON CONFLICT DO NOTHING',
        [JSON.stringify(notes)],
      );
      if (touches.length) await c.query(
        'INSERT INTO radar_pg_showcase_day(date,updated_at) ' +
        'SELECT date,updated_at FROM jsonb_to_recordset($1::jsonb) ' +
        'AS r(date text,updated_at text) ON CONFLICT DO NOTHING', [JSON.stringify(touches)],
      );
      await setMeta(c, 'showcase_seeded', new Date().toISOString());
    }).catch((error: unknown) => {
      seedTask = null;
      throw error;
    });
  }
  await seedTask;
}

export async function pgShowcaseVersion(readSeed: () => Seed): Promise<string> {
  await pgSeedShowcase(readSeed);
  const v = await pgRows<{n: string; at: string}>(
    "SELECT COUNT(*)::text AS n,COALESCE(MAX(updated_at),'') AS at FROM (SELECT updated_at FROM radar_pg_showcase_fill UNION ALL SELECT updated_at FROM radar_pg_showcase_fill_afternoon) t");
  const a = await pgRows<{n: string}>('SELECT COUNT(*)::text AS n FROM radar_pg_showcase_audit');
  return 'pg|' + v[0].at + '|' + v[0].n + '|' + a[0].n;
}

export async function pgReadShowcase(readSeed: () => Seed): Promise<ShowcaseStore> {
  await pgSeedShowcase(readSeed);
  const [m, a, n, t] = await Promise.all([
    pgRows<{date:string;shop_code:string;fill:number}>('SELECT date,shop_code,fill FROM radar_pg_showcase_fill ORDER BY date,shop_code'),
    pgRows<{date:string;shop_code:string;fill:number}>('SELECT date,shop_code,fill FROM radar_pg_showcase_fill_afternoon ORDER BY date,shop_code'),
    pgRows<{date:string;shop_code:string;note:string}>('SELECT date,shop_code,note FROM radar_pg_showcase_note ORDER BY date,shop_code'),
    pgRows<{date:string;updated_at:string}>('SELECT date,updated_at FROM radar_pg_showcase_day'),
  ]);
  const days: Seed['days'] = {}, afternoon: Seed['afternoon'] = {}, notes: Seed['notes'] = {}, touched: Seed['touched'] = {};
  for (const x of m) (days[x.date] ??= {})[x.shop_code] = Number(x.fill);
  for (const x of a) (afternoon[x.date] ??= {})[x.shop_code] = Number(x.fill);
  for (const x of n) (notes[x.date] ??= {})[x.shop_code] = x.note;
  for (const x of t) touched[x.date] = x.updated_at;
  const updatedAt = t.map(x => x.updated_at).sort().at(-1) ?? null;
  return { days,afternoon,notes,touched,updatedAt,source:'db' };
}

export async function pgSaveShowcaseEdits(
  edits: readonly ShowcaseEdit[], options: SaveShowcaseOptions, readSeed: () => Seed,
): Promise<{changed:number}> {
  await pgSeedShowcase(readSeed);
  const now = options.now ?? new Date().toISOString();
  const source = options.source ?? 'unknown';
  return pgTx(async c => {
    let changed=0;
    const audit = async (e:ShowcaseEdit,field:string,from:string|null,to:string|null) => {
      await c.query('INSERT INTO radar_pg_showcase_audit(at,date,shop_code,field,old_value,new_value,source) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [now,e.date,e.shopCode,field,from,to,source]);
    };
    for (const e of edits) {
      let touched = false;
      for (const [field,value] of [['fill',e.fill],['fill_afternoon',e.afternoonFill]] as const) {
        if (value === undefined) continue;
        const table=TABLES[field];
        const prior=await c.query('SELECT fill FROM '+table+' WHERE date=$1 AND shop_code=$2',[e.date,e.shopCode]);
        const was=prior.rows.length?Number(prior.rows[0].fill):undefined;
        if (value === null) {
          if(was === undefined)continue;
          await c.query('DELETE FROM '+table+' WHERE date=$1 AND shop_code=$2',[e.date,e.shopCode]);
          await audit(e,field,String(was),null);
          touched=true;
        } else {
          const next=Math.round(Math.min(1,Math.max(0,normalizeFill(value)))*100)/100;
          if(was === next)continue;
          await c.query('INSERT INTO '+table+'(date,shop_code,fill,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(date,shop_code) DO UPDATE SET fill=excluded.fill,updated_at=excluded.updated_at',
            [e.date,e.shopCode,next,now]);
          await audit(e,field,was===undefined?null:String(was),String(next));
          touched=true;
        }
      }
      if(e.note !== undefined){
        const prior=await c.query('SELECT note FROM radar_pg_showcase_note WHERE date=$1 AND shop_code=$2',[e.date,e.shopCode]);
        const was=prior.rows.length?String(prior.rows[0].note):undefined;
        const next=e.note===null?'':e.note.trim();
        if(next==='' && was!==undefined){
          await c.query('DELETE FROM radar_pg_showcase_note WHERE date=$1 AND shop_code=$2',[e.date,e.shopCode]);
          await audit(e,'note',was,null);touched=true;
        } else if(next!=='' && was!==next){
          await c.query('INSERT INTO radar_pg_showcase_note(date,shop_code,note,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(date,shop_code) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at',
            [e.date,e.shopCode,next,now]);
          await audit(e,'note',was??null,next);touched=true;
        }
      }
      if(touched){
        await c.query('INSERT INTO radar_pg_showcase_day(date,updated_at) VALUES($1,$2) ON CONFLICT(date) DO UPDATE SET updated_at=excluded.updated_at',[e.date,now]);
        changed++;
      }
    }
    return {changed};
  });
}

export async function pgReadAudit(filter:ShowcaseAuditFilter={}):Promise<ShowcaseAuditEntry[]>{
  const parts:string[]=[];const args:unknown[]=[];
  if(filter.date){args.push(filter.date);parts.push('date=$'+args.length);}
  if(filter.shopCode){args.push(normalizeCode(filter.shopCode));parts.push('shop_code=$'+args.length);}
  args.push(Math.min(filter.limit??200,1000));
  const rows=await pgRows<{at:string;date:string;shop_code:string;field:string;old_value:string|null;new_value:string|null;source:string}>(
    'SELECT at,date,shop_code,field,old_value,new_value,source FROM radar_pg_showcase_audit'+
    (parts.length?' WHERE '+parts.join(' AND '):'')+' ORDER BY at DESC,id DESC LIMIT $'+args.length,args);
  return rows.map(r=>({at:r.at,date:r.date,shopCode:r.shop_code,field: r.field==='note'||r.field==='fill_afternoon'?r.field:'fill',from:r.old_value,to:r.new_value,source:r.source==='ui'||r.source==='upload'?r.source:'unknown'}));
}
export async function pgAuditCount():Promise<number>{
  const r=await pgRows<{n:number}>('SELECT COUNT(*)::int AS n FROM radar_pg_showcase_audit');
  return r[0].n;
}

export async function pgNormsOverrides():Promise<{shop_code:string;driver_at:string|null;cook_shifts:string;updated_at:string}[]>{
  return pgRows('SELECT shop_code,driver_at,cook_shifts,updated_at FROM radar_pg_shop_norms');
}
export async function pgSaveNorms(edits: readonly ShopNormsEdit[],now:string):Promise<{changed:number}>{
  return pgTx(async c=>{
    let changed=0;
    for(const e of edits){
      const plan=JSON.stringify(sortTimes(e.cookAt));
      const current=await c.query('SELECT driver_at,cook_shifts FROM radar_pg_shop_norms WHERE shop_code=$1',[e.shopCode]);
      if(current.rows.length&&current.rows[0].driver_at===e.driverAt&&current.rows[0].cook_shifts===plan)continue;
      await c.query('INSERT INTO radar_pg_shop_norms(shop_code,driver_at,cook_shifts,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(shop_code) DO UPDATE SET driver_at=excluded.driver_at,cook_shifts=excluded.cook_shifts,updated_at=excluded.updated_at',[e.shopCode,e.driverAt,plan,now]);
      changed++;
    }
    return {changed};
  });
}
export async function pgResetNorm(shopCode:string):Promise<boolean>{
  return pgTx(async c=>(await c.query('DELETE FROM radar_pg_shop_norms WHERE shop_code=$1',[shopCode])).rowCount!>0);
}
export async function pgNormsVersion():Promise<string>{
  const r=await pgRows<{n:number;at:string}>("SELECT COUNT(*)::int AS n,COALESCE(MAX(updated_at),'') AS at FROM radar_pg_shop_norms");
  return 'pg|'+r[0].at+'|'+r[0].n;
}

const EPOCH='2000-01-01';
function managerSame(a:string,b:string):boolean{return a.trim().split(/\s+/)[0].toLowerCase()===b.trim().split(/\s+/)[0].toLowerCase();}
function yesterday(date:string):string{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
export async function pgReconcileRegions(current:ReadonlyMap<string,string>,seed:readonly RegionPeriod[],today=todayIso()):Promise<RegionPeriod[]>{
  return pgTx(async c=>{
    if(!(await meta(c,'region_history_seeded'))){
      for(const p of seed){await c.query('INSERT INTO radar_pg_region_periods(shop_code,manager,from_date,to_date,source) VALUES($1,$2,$3,$4,$5)',
        [p.shopCode,p.manager,p.from,p.to,'seed']);}
      await setMeta(c,'region_history_seeded',new Date().toISOString());
    }
    for(const [code,manager] of current){
      const active=await c.query('SELECT id,manager FROM radar_pg_region_periods WHERE shop_code=$1 AND to_date IS NULL ORDER BY id DESC LIMIT 1',[code]);
      const prev=active.rows[0];
      if(!prev){
        const seen=await c.query('SELECT 1 FROM radar_pg_region_periods WHERE shop_code=$1 LIMIT 1',[code]);
        await c.query("INSERT INTO radar_pg_region_periods(shop_code,manager,from_date,to_date,source) VALUES($1,$2,$3,NULL,'roster')",[code,manager,seen.rows.length?today:EPOCH]);
      } else if(prev.manager!==manager){
        if(managerSame(String(prev.manager),manager)){
          await c.query('UPDATE radar_pg_region_periods SET manager=$1 WHERE id=$2',[manager,prev.id]);
        } else {
          await c.query('UPDATE radar_pg_region_periods SET to_date=$1 WHERE id=$2',[yesterday(today),prev.id]);
          await c.query("INSERT INTO radar_pg_region_periods(shop_code,manager,from_date,to_date,source) VALUES($1,$2,$3,NULL,'roster')",[code,manager,today]);
        }
      }
    }
    const r=await c.query('SELECT shop_code,manager,from_date,to_date FROM radar_pg_region_periods ORDER BY shop_code,from_date');
    return r.rows.map(x=>({shopCode:String(x.shop_code),manager:String(x.manager),from:String(x.from_date),to:x.to_date==null?null:String(x.to_date)}));
  });
}

export async function pgViolations():Promise<Omit<ContestViolation,'fixed'>[]>{
  const rows=await pgRows<{id:string;shop_code:string;region:string;reason:string;created_at:string}>(
    'SELECT id,shop_code,region,reason,created_at FROM radar_pg_contest_violations ORDER BY created_at DESC,id');
  return rows.map(x=>({id:x.id,shopCode:x.shop_code,region:x.region,reason:x.reason,createdAt:x.created_at}));
}
export async function pgAddViolation(entry:Pick<ContestViolation,'id'|'shopCode'|'region'|'reason'>):Promise<void>{
  await pgTx(async c=>{
    const prev=await c.query('SELECT shop_code,region,reason FROM radar_pg_contest_violations WHERE id=$1',[entry.id]);
    if(prev.rows.length){
      const v=prev.rows[0];
      if(v.shop_code!==entry.shopCode||v.region!==entry.region||v.reason!==entry.reason.trim())
        throw new Error('Этот запрос уже сохранён с другими данными. Обновите страницу.');
      return;
    }
    await c.query('INSERT INTO radar_pg_contest_violations(id,shop_code,region,reason,created_at) VALUES($1,$2,$3,$4,$5)',
      [entry.id,entry.shopCode,entry.region,entry.reason.trim(),new Date().toISOString()]);
  });
}
export async function pgRemoveViolation(id:string):Promise<void>{
  await pgTx(async c=>{await c.query('DELETE FROM radar_pg_contest_violations WHERE id=$1',[id]);});
}
export async function pgUploadHistory():Promise<UploadLogEntry[]>{
  const rows=await pgRows<{at:string;original_name:string;file_name:string;kind:string;summary:string;dates:string;rows:number;mode:string}>(
    'SELECT at,original_name,file_name,kind,summary,dates,"rows",mode FROM radar_pg_uploads ORDER BY at DESC,id DESC LIMIT 500');
  return rows.map(x=>({...x,originalName:x.original_name,fileName:x.file_name,dates:JSON.parse(x.dates) as string[],rows:x.rows}));
}
export async function pgAppendUploads(entries:readonly UploadLogEntry[]):Promise<void>{
  await pgTx(async c=>{
    for(const e of entries){
      await c.query('INSERT INTO radar_pg_uploads(at,original_name,file_name,kind,summary,dates,"rows",mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [e.at,e.originalName,e.fileName,e.kind,e.summary,JSON.stringify(e.dates),e.rows,e.mode]);
    }
  });
}

# RelaxDev / PostgreSQL rescue branch

Use this branch `relax-migration` for the **emergency RelaxDev deployment**.
Do not merge into `main` or enable automatic deployment on the old Yandex VM
until its disks and old databases have been backed up.

## Runtime

Node.js 22+, `npm ci`, `npm run build`, `npm start`. Next.js listens on
port **3000** by default. In RelaxDev set `PORT=3000` and `WEB_PORT=3000`
(or the same different port in both variables).

```dotenv
RADAR_STORAGE=postgres
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB
RADAR_MANAGE_PASSWORD=<strong-password>
RADAR_UPLOAD_TOKEN=<strong-upload-code>
RADAR_GITHUB_TOKEN=<fine-grained-token-with-contents-read-write>
RADAR_GITHUB_REPO=HR-analyze/radar_otkrytki_
RADAR_GITHUB_BRANCH=relax-migration
PORT=3000
WEB_PORT=3000
```

**Do not commit actual passwords or connection strings.** `RADAR_GITHUB_TOKEN`
must have Contents read/write access to this repository. Uploaded XLS/XLSX
files are committed to `fixtures/` on this branch, triggering a rebuild when
the host's GitHub deployment integration is enabled.

This rescue configuration uses the **committed fixture snapshot** to display
all network metrics, and **PostgreSQL** for manual showcase fills, notes,
audit, manager history, shop norm changes, contest violations, and upload log.

Limitations (intentional): automatic Google Drive/Sheets ETL cron endpoints
continue to be disabled in this hybrid `snapshot` source mode. Import new
employee/delivery exports through the file-upload UI; this builds a new
snapshot on the next deployment. Google credentials can be added later when
the SQL-based ETL migration is ready. Do not schedule cron yet.

## Before repatriating to Yandex

1. **DO NOT overwrite either live database.** Stop writes to the old site;
   take byte-consistent copies of the original SQLite databases (include WAL,
   or use SQLite backup API) and a PostgreSQL `pg_dump` on RelaxDev.
2. On a machine with read-only access to the copied SQLite databases, run:

   ```bash
   python3 scripts/export-yandex-sqlite.py \
     --manual /backup/manual.db \
     --radar /backup/radar.db \
     --output /private/yandex-export.json
   ```

3. **First restore a COPY of the RelaxDev PostgreSQL database** into a
   separate integration/test database. With this branch checked out run:

   ```bash
   RADAR_STORAGE=postgres DATABASE_URL='postgresql://...' \
      npx tsx scripts/import-yandex-sqlite.ts /private/yandex-export.json
   ```

   Dry-run performs no modifications. Inspect counts / collisions.

4. Re-run with `--apply` against the **test** integration database and
   verify views, per-shop figures, audit, old and new dates. Every original
   SQLite row is preserved in `radar_pg_archive` (including old main
   `radar.db` tables and manager periods); keyed manual records missing
   from RelaxDev are imported with `ON CONFLICT DO NOTHING`. Conflicting
   records must be reviewed manually; never silently overwrite new updates.

5. After QA, choose one primary server and one final PostgreSQL database,
   freeze writes briefly, reconcile changes since the snapshot, then switch
   DNS. Keep both original SQLite copies and all `pg_dump` files.

**Important:** automatic conflict-free merging of manager timeline histories
and old ETL `radar.db` is NOT provided. Those rows are preserved in the
archive for deliberate validation against newer history and fixture exports.

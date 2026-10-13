#!/usr/bin/env python3
"""Read-only backup/export of legacy Yandex SQLite; never modifies the old files."""
import argparse
import datetime
import json
import sqlite3
from pathlib import Path

def export_db(path):
    uri = f"file:{path.resolve()}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    try:
        names = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        result = {}
        for name in names:
            # Table names come from sqlite_master, not from outside input.
            result[name] = [dict(row) for row in con.execute('SELECT * FROM "' + name.replace('"', '""') + '"')]
        return result
    finally:
        con.close()

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--manual",required=True,type=Path,help="Old data/manual.db")
    p.add_argument("--radar",required=True,type=Path,help="Old data/radar.db")
    p.add_argument("--output",required=True,type=Path)
    a=p.parse_args()
    for file in (a.manual,a.radar):
        if not file.is_file():
            p.error(f"Missing database: {file}")
    payload={"version":1,"exportedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
             "manual":export_db(a.manual),"radar":export_db(a.radar)}
    a.output.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print("Exported",a.output,"(keep this file private: includes production data)")

if __name__=="__main__":
    main()

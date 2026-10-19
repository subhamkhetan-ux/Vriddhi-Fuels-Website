"""SQLite write-ahead journal. A cursor advances only with a durable upload."""
import json
import sqlite3
from pathlib import Path


class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode=WAL")
        self.db.execute("pragma synchronous=FULL")
        self.db.executescript("""
          create table if not exists objects(kind text, guid text, alter_id integer,
            master_id integer, data text, deleted integer default 0, primary key(kind,guid));
          create table if not exists uploads(id integer primary key, payload text not null);
          create table if not exists writes(job text primary key, phase text not null, result text);
          create table if not exists meta(key text primary key,value text not null);
        """)

    def get(self, key, default=None):
        r = self.db.execute("select value from meta where key=?", (key,)).fetchone()
        return json.loads(r[0]) if r else default

    def set(self, key, value):
        with self.db:
            self.db.execute("insert into meta values(?,?) on conflict(key) do update set value=excluded.value",
                            (key, json.dumps(value)))

    def known(self, kind):
        return {r["guid"]: dict(r) for r in self.db.execute("select * from objects where kind=?", (kind,))}

    def identities(self, kind):
        return {r["guid"]: dict(r) for r in self.db.execute(
            "select guid,alter_id,master_id,deleted from objects where kind=?", (kind,))}

    def object_payload(self, kind, guid):
        row = self.db.execute("select data from objects where kind=? and guid=?", (kind,guid)).fetchone()
        return json.loads(row[0]) if row else None

    def stage(self, objects):
        """Persist the object and its pending cloud upload in the SAME transaction."""
        with self.db:
            for obj in objects:
                self.db.execute("""insert into objects values(?,?,?,?,?,?) on conflict(kind,guid) do update set
                  alter_id=excluded.alter_id,master_id=excluded.master_id,data=excluded.data,deleted=excluded.deleted""",
                                (obj["kind"], obj["guid"], obj["alter_id"], obj["master_id"],
                                 json.dumps(obj["data"]), int(obj.get("deleted", False))))
                self.db.execute("insert into uploads(payload) values(?)", (json.dumps(obj),))

    def upload_batch(self):
        rows, size = [], 0
        for r in self.db.execute("select id,payload from uploads order by id limit 50"):
            size += len(r["payload"].encode())
            if rows and size > 2_000_000:
                break
            rows.append(r)
        return rows

    def uploaded(self, rows):
        with self.db:
            self.db.executemany("delete from uploads where id=?", [(r["id"],) for r in rows])

    def write(self, job, phase, result=None):
        with self.db:
            self.db.execute("insert into writes values(?,?,?) on conflict(job) do update set phase=excluded.phase,result=excluded.result",
                            (job, phase, json.dumps(result)))

    def written(self, job):
        r = self.db.execute("select * from writes where job=?", (job,)).fetchone()
        return dict(r) if r else None

    def close(self):
        self.db.close()

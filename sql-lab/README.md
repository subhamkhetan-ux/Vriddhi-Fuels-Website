# SQL Connectivity Lab

An interactive, in-browser teaching app for demonstrating **SQL database connectivity**
live on screen — built for a classroom projector.

## What students see

1. **Open a Connection** — enter host / port / database / driver / credentials and press
   *Connect*. The app builds the matching connection string and a live **console** narrates
   every step of the real connection lifecycle (resolve host → authenticate → session ready).
2. **Execute a Query & Fetch Results** — write real SQL and run it against a preloaded
   sample database. `SELECT`, `JOIN`, `GROUP BY`, `INSERT`, `UPDATE` all work; errors and
   "querying without a connection" are shown just like real drivers behave.
3. **The Same Steps in Real Code** — the identical `connect → statement → execute → fetch →
   close` pattern shown in **Python (psycopg2), Java (JDBC), Node.js (pg), and PHP (PDO)**.

## Sample database (`school`)

- `students(id, name, city, year)`
- `courses(id, title, credits)`
- `enrollments(id, student_id → students, course_id → courses, grade)`

Use *Reset database* to restore the sample data after edits.

## How it works

Real SQL runs entirely in the browser using **SQLite compiled to WebAssembly**
([sql.js](https://sql.js.org)). No server, no database install, no accounts.

## Running it

It's a static page. Open it over HTTP (WebAssembly needs `http://`/`https://`, not `file://`):

```bash
# from the repository root
python3 -m http.server 8000
# then visit http://localhost:8000/sql-lab/
```

Or deploy the `sql-lab/` folder to any static host (GitHub Pages, Netlify, etc.).

## Files

- `index.html` — the entire app (HTML + CSS + JS).
- `sql-wasm.js`, `sql-wasm.wasm` — the bundled SQLite engine (works fully offline).

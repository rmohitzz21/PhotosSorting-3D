import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

test("keyset paging walks every row exactly once, newest first", async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-page-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url)),
    req = createRequire(root + "/package.json"),
    pg = new PGlite({ extensions: { vector } });
  await pg.exec(await fs.readFile(root + "/schema.sql", "utf8"));
  globalThis.sql = (parts, ...args) => {
    const query = parts.reduce((s, p, i) => s + (i ? "$" + i : "") + p, "");
    const run = async (c) => (await c.query(query, args)).rows;
    return { run, then: (ok, fail) => run(pg).then(ok, fail) };
  };
  const db = 'export const db=()=>globalThis.sql;export const owner=async()=>"tester";';
  const mocks = {
    "./database": "export const localData=false;export const dataDirectory=String();",
    "./db": db,
  };
  await build({
    stdin: {
      contents: 'export {libraryPage} from "./lib/library";',
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(output, "page.cjs"),
    plugins: [
      {
        name: "mock",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => {
            if (mocks[a.path]) return { namespace: "mock", path: a.path };
          });
          b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({
            contents: mocks[a.path],
          }));
        },
      },
    ],
  });
  const { libraryPage } = req(path.join(output, "page.cjs"));

  await pg.exec("insert into users(id) values('tester')");
  await pg.query("insert into imports(id,owner,expected) values($1,'tester',250)", [
    "11111111-1111-1111-1111-111111111111",
  ]);
  // 250 rows: 200 dated an hour apart, 50 with no date at all.
  for (let i = 0; i < 250; i++) {
    const dated = i < 200;
    const taken = dated ? new Date(Date.UTC(2026, 0, 1, i)).toISOString() : null;
    await pg.query(
      `insert into media(id,owner,import_id,filename,kind,bytes,category,state,position,taken_at,sort_at,thumb)
       values($1,'tester','11111111-1111-1111-1111-111111111111',$2,'photo',1000,'Other photos','ready',$3,$4,coalesce($4::timestamptz,'-infinity'),'t')`,
      [
        "22222222-0000-4000-8000-" + String(i).padStart(12, "0"),
        "photo" + i + ".jpg",
        i,
        taken,
      ],
    );
  }

  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard++) {
    const page = await libraryPage({ user: "tester", cursor, limit: 40 });
    seen.push(...page.items.map((i) => i.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 250, "expected every row once, got " + seen.length);
  assert.equal(new Set(seen).size, 250, "pages overlapped");

  // Dated rows come first, newest first; undated rows land last.
  const first = await libraryPage({ user: "tester", limit: 3 });
  assert.deepEqual(
    first.items.map((i) => i.filename),
    ["photo199.jpg", "photo198.jpg", "photo197.jpg"],
  );

  // Filters narrow the page without breaking the walk.
  await pg.query("update media set category='Receipts' where position < 5");
  const receipts = await libraryPage({ user: "tester", category: "Receipts", limit: 100 });
  assert.equal(receipts.items.length, 5);
  assert.equal(receipts.nextCursor, null);

  const matched = await libraryPage({ user: "tester", q: "photo17.jpg", limit: 100 });
  assert.deepEqual(
    matched.items.map((i) => i.filename),
    ["photo17.jpg"],
  );

  // Display queries must not ship fingerprint columns to the client.
  for (const key of ["pixels", "phash", "hash"])
    assert.ok(!(key in first.items[0]), key + " must not be returned");

  assert.equal(first.total, 250);
  // Only the first page pays for count(*); later pages report no total.
  const second = await libraryPage({
    user: "tester",
    cursor: first.nextCursor,
    limit: 3,
  });
  assert.equal(second.total, null);
  assert.equal(second.items.length, 3);
  await pg.close();
});

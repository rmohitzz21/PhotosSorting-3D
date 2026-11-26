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

test("groups persist, total bytes, and survive a keeper change", async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-dupes-"));
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
      contents:
        'export {rebuildGroups,readGroups,setKeeper} from "./lib/dupe-store";',
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(output, "dupes.cjs"),
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
  const { rebuildGroups, readGroups, setKeeper } = req(path.join(output, "dupes.cjs"));

  await pg.exec("insert into users(id) values('tester')");
  await pg.query("insert into imports(id,owner,expected) values($1,'tester',4)", [
    "11111111-1111-1111-1111-111111111111",
  ]);
  const id = (n) => "33333333-0000-4000-8000-" + String(n).padStart(12, "0");
  const add = (n, bytes, hash, kind = "photo", thumb = "t") =>
    pg.query(
      `insert into media(id,owner,import_id,filename,kind,bytes,hash,category,state,position,sort_at,thumb)
       values($1,'tester','11111111-1111-1111-1111-111111111111',$2,$3,$4,$5,'Other photos','ready',$6,'-infinity',$7)`,
      [id(n), "p" + n + ".jpg", kind, bytes, hash, n, thumb],
    );
  await add(0, 900, "same");
  await add(1, 500, "same");
  await add(2, 100, "unique");
  // A video placeholder pair must never become a group.
  await add(3, 400, null, "video", null);

  assert.equal(await rebuildGroups("tester"), 1);
  let groups = await readGroups("tester");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keeperId, id(0), "largest bytes should be keeper");
  assert.deepEqual(groups[0].memberIds.slice().sort(), [id(0), id(1)].sort());
  assert.equal(Number(groups[0].bytesReclaimable), 500);
  assert.equal(groups[0].kind, "exact");

  // Rebuilding is idempotent: no duplicate rows, and the id is derived from
  // membership so it does not change.
  const firstId = groups[0].id;
  assert.equal(await rebuildGroups("tester"), 1);
  const rebuilt = await readGroups("tester");
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].id, firstId, "group ids must be stable across rebuilds");

  // Promoting the other member recomputes the reclaimable figure.
  await setKeeper("tester", firstId, id(1));
  groups = await readGroups("tester");
  assert.equal(groups[0].keeperId, id(1));
  assert.equal(Number(groups[0].bytesReclaimable), 900);

  // A rebuild must not discard the user's keeper choice.
  await rebuildGroups("tester");
  groups = await readGroups("tester");
  assert.equal(groups[0].keeperId, id(1), "a user's keeper must survive a rebuild");
  assert.equal(Number(groups[0].bytesReclaimable), 900);

  // A keeper that is not a member of the group is refused.
  await assert.rejects(() => setKeeper("tester", groups[0].id, id(2)), /member/);
  // Another user cannot touch this group.
  await assert.rejects(() => setKeeper("other", groups[0].id, id(0)), /not found/);

  await pg.close();
});

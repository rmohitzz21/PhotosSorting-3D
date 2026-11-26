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
test("Picker imports persist, resume, respect budget and erase only the signed-in library", async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-test-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url)),
    req = createRequire(root + "/package.json"),
    pg = new PGlite({ extensions: { vector } });
  const schema = await fs.readFile(root + "/schema.sql", "utf8");
  await pg.exec(schema);
  await pg.exec(schema);
  globalThis.blobs = new Map();
  globalThis.sql = (parts, ...args) => {
    const query = parts.reduce((s, p, i) => s + (i ? "$" + i : "") + p, "");
    const run = async (c) => (await c.query(query, args)).rows;
    return { run, then: (ok, fail) => run(pg).then(ok, fail) };
  };
  sql.transaction = (qs) =>
    pg.transaction(async (tx) => {
      for (const q of qs) await q.run(tx);
    });
  const db =
    'export const db=()=>globalThis.sql;export const owner=async()=>"tester";';
  const mocks = {
    "./database": "export const localData=false;export const dataDirectory=String();",
    "./db": db,
    "../../../lib/db": db,
    "./photo-tokens": 'export const accessToken=async()=>"test";',
    "@vercel/blob":
      "export const put=async(p,b)=>{blobs.set(p,b);return {pathname:p}};export const get=async p=>({stream:new Response(blobs.get(p)).body});export const list=async()=>({blobs:[...blobs.keys()].map(url=>({url}))});export const del=async paths=>paths.forEach(k=>blobs.delete(k));",
    ai: 'export const generateText=async()=>({text:JSON.stringify({"1":{category:"Receipts",caption:"Hotel Iris receipt",tags:[]}})});',
  };
  await build({
    stdin: {
      contents:
        'export {stepPhotos} from "./lib/photo-picker";export {runBatch} from "./lib/jobs";export {libraryPage} from "./lib/library";export {GET as csv} from "./app/api/export/route";export {DELETE as erase} from "./app/api/library/route";',
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(output, "app.cjs"),
    plugins: [
      {
        name: "mock",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => {
            if (mocks[a.path]) return { namespace: "mock", path: a.path };
            if (["sharp", "zod"].includes(a.path))
              return { external: true, path: req.resolve(a.path) };
          });
          b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({
            contents: mocks[a.path],
          }));
        },
      },
    ],
  });
  const { stepPhotos, runBatch, libraryPage, csv, erase } = req(
    path.join(output, "app.cjs"),
  );
  const preview = await req("sharp")({
    create: { width: 128, height: 128, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname.endsWith("googleusercontent.com"))
      return new Response(preview);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/sessions"))
      return Response.json({
        id: "remote",
        pickerUri: "https://photos.google.com/picker/test",
        pollingConfig: { pollInterval: "0s" },
      });
    if (url.pathname.endsWith("/sessions/remote"))
      return Response.json({ mediaItemsSet: true });
    return Response.json({
      mediaItems: Array.from({ length: 10 }, (_, n) => ({
        id: "img" + n,
        type: "PHOTO",
        mediaFile: {
          filename: "photo" + n + ".jpg",
          mimeType: "image/jpeg",
          baseUrl: "https://lh3.googleusercontent.com/" + n,
        },
      })),
    });
  };
  Object.assign(process.env, {
    AI_GATEWAY_API_KEY: "test",
    BATCH_MAX_USD: ".01",
    MONTHLY_LIMIT_USD: "0",
  });
  await pg.exec("insert into users(id) values('tester'),('other')");
  let s = await stepPhotos("tester", "start");
  assert.equal(s.state, "picking");
  const next = () => stepPhotos("tester", "advance", s.id);
  s = await next();
  assert.equal(s.state, "listing");
  s = await next();
  assert.equal(s.count, 10);
  await assert.rejects(
    stepPhotos("tester", "confirm", s.id, s.estimate),
    /budget/,
  );
  process.env.MONTHLY_LIMIT_USD = "1";
  s = await stepPhotos("tester", "confirm", s.id, s.estimate);
  s = await next();
  assert.equal(s.completed, 8);
  s = await next();
  assert.equal(s.state, "done");
  assert.equal(blobs.size, 20);
  assert.equal(await runBatch("tester"), true);
  assert.equal(await runBatch("tester"), false);
  assert.ok(
    (await libraryPage({ user: "tester", limit: 500 })).items.some((i) =>
      i.caption.includes("Hotel Iris"),
    ),
  );
  assert.match(await (await csv()).text(), /Hotel Iris/);
  await erase();
  assert.equal(blobs.size, 0);
  for (const t of [
    "imports",
    "jobs",
    "photo_sessions",
    "budgets",
    "media",
    "audit_log",
    "analysis",
    "dupe_groups",
    "categories",
  ])
    assert.equal(
      (await pg.query("select count(*)::int n from " + t)).rows[0].n,
      0,
    );
  assert.deepEqual((await pg.query("select id from users")).rows, [
    { id: "other" },
  ]);
  await pg.close();
});


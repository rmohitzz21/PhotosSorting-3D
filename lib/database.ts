import { neon } from "@neondatabase/serverless";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export const localData =
  process.env.SHOEBOX_LOCAL_STORAGE === "1" && !process.env.VERCEL;
export const dataDirectory = path.resolve(".shoebox");
const shared = globalThis as typeof globalThis & {
  shoeboxDatabase?: Promise<PGlite>;
};
function localDatabase() {
  return (shared.shoeboxDatabase ??= (async () => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const pg = new PGlite(path.join(dataDirectory, "postgres"), {
      extensions: { vector },
    });
    await pg.exec(await readFile(path.resolve("schema.sql"), "utf8"));
    return pg;
  })());
}
type Rows = Record<string, any>[];
type Query = PromiseLike<Rows> & {
  run: (client: PGlite | Transaction) => Promise<Rows>;
};
function query(parts: TemplateStringsArray, ...args: unknown[]): Query {
  const statement = parts.reduce(
    (sql, part, i) => sql + (i ? "$" + i : "") + part,
    "",
  );
  const run = async (client: PGlite | Transaction) =>
    (await client.query(statement, args)).rows as Rows;
  return { run, then: (ok, fail) => localDatabase().then(run).then(ok, fail) };
}
const localSql = Object.assign(query, {
  transaction: async (queries: Query[]) => {
    const pg = await localDatabase();
    return pg.transaction(async (tx) => {
      for (const q of queries) await q.run(tx);
    });
  },
});
interface Database {
  (parts: TemplateStringsArray, ...args: unknown[]): PromiseLike<Rows>;
  transaction(queries: PromiseLike<Rows>[]): PromiseLike<unknown>;
}
export function db(): Database {
  return (localData ? localSql : neon(process.env.DATABASE_URL!)) as Database;
}

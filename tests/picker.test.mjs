import test from "node:test";
import assert from "node:assert/strict";
import {
  expiry,
  duration,
  fetchPreview,
  listPicked,
  PickerExpired,
  GoogleUnavailable,
} from "../lib/picker-protocol.ts";
const base = "https://lh3.googleusercontent.com/picture";
test("expired download requires a re-pick before any network call", async () => {
  const issued = Date.now() - 3600000;
  const deadline = expiry(
    issued,
    new Date(Date.now() + 86400000).toISOString(),
  );
  let calls = 0;
  await assert.rejects(
    fetchPreview(base, deadline, "key", async () => {
      calls++;
    }),
    PickerExpired,
  );
  assert.equal(calls, 0);
});
test("fetches a bounded derivative with bearer authorization and handles early expiry", async () => {
  let calls = 0;
  await assert.rejects(
    fetchPreview(base, Date.now() + 10000, "test", async (url, init) => {
      assert.equal(url, base + "=w1600-h1600");
      assert.equal(init.headers.Authorization, "Bearer test");
      assert.equal(init.redirect, "error");
      calls++;
      return new Response(null, { status: 403 });
    }),
    PickerExpired,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchPreview(
      "https://untrusted.invalid/x",
      Date.now() + 10000,
      "test",
      () => assert.fail(),
    ),
    /Invalid media address/,
  );
  await assert.rejects(
    fetchPreview(
      base,
      Date.now() + 10000,
      "test",
      async () => new Response(null, { status: 429 }),
    ),
    GoogleUnavailable,
  );
});
test("pages through one selection and preserves stable ids across overlapping pages", async () => {
  const paths = [];
  const items = await listPicked("a/b", async (path) => {
    paths.push(path);
    return Response.json(
      paths.length === 1
        ? { mediaItems: [{ id: "a" }], nextPageToken: "x+y" }
        : { mediaItems: [{ id: "a" }, { id: "b" }] },
    );
  });
  assert.deepEqual(
    items.map((x) => x.id),
    ["a", "b"],
  );
  assert.match(paths[1], /sessionId=a%2Fb/);
  assert.match(paths[1], /pageToken=x%2By/);
});
test("uses the earlier session expiry and Google's fractional poll interval", () => {
  assert.equal(expiry(100, new Date(500).toISOString()), 500);
  assert.equal(duration("3.5s", 5000), 3500);
  assert.equal(duration("0s", 5000), 0);
});

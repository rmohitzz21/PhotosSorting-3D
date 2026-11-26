import test from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor } from "../lib/cursor.ts";

test("a cursor round-trips through encode and decode", () => {
  const row = { sort_at: new Date("2026-03-04T05:06:07.000Z"), id: "a3f1" };
  const decoded = decodeCursor(encodeCursor(row));
  assert.equal(decoded.sortAt, "2026-03-04T05:06:07.000Z");
  assert.equal(decoded.id, "a3f1");
});

test("a string sort_at is accepted unchanged", () => {
  const encoded = encodeCursor({ sort_at: "-infinity", id: "b2" });
  assert.deepEqual(decodeCursor(encoded), { sortAt: "-infinity", id: "b2" });
});

test("absent, empty and malformed cursors decode to null", () => {
  for (const bad of [null, undefined, "", "not-base64!!", "eyJub3BlIjoxfQ=="])
    assert.equal(decodeCursor(bad), null, "should reject " + JSON.stringify(bad));
});

test("a cursor containing a quote or separator survives encoding", () => {
  const encoded = encodeCursor({ sort_at: "-infinity", id: 'x"|y' });
  assert.equal(decodeCursor(encoded).id, 'x"|y');
});

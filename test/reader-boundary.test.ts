/**
 * Purpose: exercise host token construction through synchronous reader doors.
 * Owns resources: each runtime and token registration are released on every exit.
 * Guarantees: parse pumps constructors and propagates their failures
 *   [tested: npm test; commit=9d6b109740b1744b734b53b563a3be8642d24c0e].
 * Open Obligations: None.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { metta, G, S } from "../src/index.ts";
import { registerToken, unregisterToken } from "../src/tokens.ts";

test("parse and forms pump host token constructors without admitting facts", async () => {
  using m = await metta();
  const pattern = /#[0-9a-f]{6}/;
  registerToken(m.engine, pattern, lexeme => G(parseInt(lexeme.slice(1), 16)));
  try {
    const size = m.self.size;
    assert.equal(m.parse("#ff8800"), G(0xff8800));
    assert.equal(String(m.parse("(colour #0000ff $name)")), "(colour 255 $name)");
    assert.equal(String(m.forms("(colour #0000ff)")[0]!.atom), "(colour 255)");
    assert.equal(m.self.size, size);
  } finally {
    assert.equal(unregisterToken(m.engine, pattern), true);
  }
  assert.equal(m.parse("#ff8800"), S("#ff8800").atom);
});

test("parse propagates a token constructor failure and leaves the reader usable", async () => {
  using m = await metta();
  registerToken(m.engine, /@[0-9]+/, () => { throw new Error("token constructor refused"); });
  try {
    assert.throws(() => m.parse("@1"), /token constructor refused/);
  } finally {
    unregisterToken(m.engine, /@[0-9]+/);
  }
  assert.equal(m.parse("42"), G(42));
});

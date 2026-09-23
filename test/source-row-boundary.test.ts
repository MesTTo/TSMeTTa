/**
 * Purpose: compare typed source columns with the engine reader.
 * Guarantees: literal query columns exclude strings, comments and anonymous variables
 *   [tested: npm run typecheck and npm test; commit=d8bcc2de2cc2024b78637e8862a165cf14627da9].
 * Owns resources: the runtime is disposed after the test.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { metta, S, type Atom, type SourceVars, type SourceRow } from "../src/index.ts";
import * as ambient from "../src/ambient.ts";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function exact<T extends true>(): void {}

test("typed source columns follow token boundaries", async () => {
  exact<Equal<SourceVars<'(f "$fake" $real) ; $comment'>, "real">>();
  exact<Equal<SourceVars<'(f "a\\\"$fake" $real)'>, "real">>();
  exact<Equal<SourceVars<'(f prefix$dollar $real)'>, "real">>();
  exact<Equal<SourceRow<string>, Record<string, Atom>>>();
  using m = await metta();
  m.add(S.f("$fake", 42));
  const rows: SourceRow<'(f "$fake" $real)'>[] = await m.q('(f "$fake" $real)');
  assert.deepEqual(Object.keys(rows[0]!), ["real"]);
  assert.equal(String(rows[0]!.real), "42");
  // @ts-expect-error a dollar inside a string creates no column.
  void rows[0]!.fake;
});

test("ambient source columns preserve the literal query", async () => {
  try {
    await ambient.add(S.f("$fake", 42));
    const rows: SourceRow<'(f "$fake" $real)'>[] = await ambient.q('(f "$fake" $real)');
    assert.deepEqual(Object.keys(rows[0]!), ["real"]);
    assert.equal(String(rows[0]!.real), "42");
    // @ts-expect-error quoted dollars are not result columns.
    void rows[0]!.fake;
  } finally {
    await ambient.reset();
  }
});

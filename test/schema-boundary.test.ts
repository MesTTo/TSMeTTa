/**
 * Purpose: check polymorphic schema atoms and the declared factory arity.
 * Guarantees: runtime variables and TypeScript argument counts follow the declaration
 *   [tested: npm run typecheck and npm test; commit=f43f0466e4ed256f599e6aa56eaa7ed92a9249d9].
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Schema, S, V, parseType, termVars, matchTerms, type Atom } from "../src/index.ts";

test("schema variables unify as variables, including nested arrow arguments", () => {
  const type = parseType("(-> (-> $x $y) $x $y)", "apply");
  assert.deepEqual(termVars(type).map(v => v.name), ["x", "y"]);
  const row = matchTerms(type, parseType("(-> (-> Number Bool) Number Bool)", "apply"));
  assert.equal(String(row?.x), "Number");
  assert.equal(String(row?.y), "Bool");
});

test("schema factories enforce declared arity and retain open vocabulary", () => {
  const stored: Atom[] = [];
  const schema = new Schema({ add: (...atoms) => stored.push(...atoms as Atom[]) }, {
    parent: "(-> Symbol Symbol %Undefined%)", value: "Number", thunk: "(-> Number)",
  } as const);
  assert.equal(String(schema.S.parent(S.ada, V.child)), "(parent ada $child)");
  assert.equal(String(schema.S.thunk()), "(thunk)");
  assert.equal(String(schema.S.value), "value");
  assert.equal(String(schema.S.anything!(1, 2, 3)), "(anything 1 2 3)");
  // The compiler must reject each malformed application; building a term does not evaluate it.
  // @ts-expect-error parent takes two arguments.
  schema.S.parent(S.ada);
  // @ts-expect-error parent takes two arguments.
  schema.S.parent(S.ada, S.bob, S.cy);
  // @ts-expect-error thunk takes no arguments.
  schema.S.thunk(1);
  assert.equal(stored.length, 3);
});

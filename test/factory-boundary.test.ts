/**
 * Purpose: check host prototype names as typed vocabulary entries.
 * Guarantees: named property calls construct atoms [tested: npm run typecheck and npm test; commit=WORKTREE].
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { S, V, fn, type Atom, type Var } from "../src/index.ts";

test("host method names construct vocabulary with checked return types", () => {
  const terms: Atom[] = [S.apply(V.f, 21), S.call(1), S.bind(2), S.toString(3),
    S.hasOwnProperty(4), S.constructor(5), fn.apply(V.f, 21)];
  assert.deepEqual(terms.map(String), ["(apply $f 21)", "(call 1)", "(bind 2)",
    "(to-string 3)", "(has-own-property 4)", "(constructor 5)", "(apply $f 21)"]);
  const vars: Var[] = [V.apply, V.call, V.bind, V.toString, V.constructor];
  assert.deepEqual(vars.map(String), ["$apply", "$call", "$bind", "$toString", "$constructor"]);
});

/**
 * Purpose: assert the TYPE layer's own claims, so a change that moves one
 *   realm without the other is caught by the same gate as a runtime defect.
 * Assumes:
 *   - the checks below fail at COMPILE time, in `npm run typecheck`, which is
 *     where a type claim belongs; the runtime cases beside them check the
 *     parts that have a runtime half
 * Guarantees:
 *   - the type-level reader and the runtime reader agree about a pattern's
 *     variables, which is the isomorphism law ArkType's `attest` exists for
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type {
  Arity,
  ArrowArgs,
  ArrowArity,
  ArrowResult,
  CheckArity,
  Head,
  SourceRow,
  SourceVars,
  SymbolsOf,
  Tag,
  Tokens,
} from "../src/index.ts";
import {
  type Atom,
  type Name,
  S,
  type Var,
  type VarsOf,
  e,
  expr,
  internedCount,
  list,
  nil,
  parseType,
  sym,
  termVars,
  variable,
} from "../src/index.ts";

/** A compile-time equality assertion. A mismatch is a type error, not a value. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

/** Asserting the assertion: this line is the whole check. */
function expectType<Claim extends true>(_claim?: Claim): void {
  void _claim;
}

describe("the type-level reader", () => {
  it("finds a pattern's variables, and the runtime reader agrees", () => {
    expectType<Exact<SourceVars<"(likes ada $drink)">, "drink">>();
    expectType<Exact<SourceVars<"(parent $x $y)">, "x" | "y">>();
    expectType<Exact<SourceVars<"(parent tom bob)">, never>>();
    expectType<Exact<SourceVars<"(f $x $x)">, "x">>();

    // The same question, asked of the runtime reader.
    assert.deepEqual(
      termVars(expr(sym("likes"), sym("ada"), variable("drink"))).map((v) => v.name),
      ["drink"],
    );
    assert.deepEqual(
      termVars(expr(sym("parent"), variable("x"), variable("y"))).map((v) => v.name),
      ["x", "y"],
    );
    assert.deepEqual(termVars(expr(sym("parent"), sym("tom"))).map((v) => v.name), []);
  });

  it("types a row by the pattern's own names, with atoms as the values", () => {
    expectType<Exact<SourceRow<"(likes ada $drink)">, { drink: Atom }>>();
    expectType<Exact<SourceRow<"(parent $x $y)">, { x: Atom; y: Atom }>>();
    // The anonymous variable names nothing, so it contributes no column.
    expectType<Exact<SourceRow<"(f $_ $x)">, { x: Atom }>>();
  });

  it("splits a term into its top-level tokens, keeping a nested group whole", () => {
    expectType<Exact<Tokens<"(likes ada $drink)">, ["likes", "ada", "$drink"]>>();
    expectType<Exact<Tokens<"(f (g 1) 2)">, ["f", "(g 1)", "2"]>>();
    expectType<Exact<Tokens<'(f "a b" c)'>, ["f", '"a b"', "c"]>>();
    expectType<Exact<Head<"(likes ada $drink)">, "likes">>();
    expectType<Exact<Arity<"(likes ada $drink)">, 2>>();
  });

  it("reads an arrow declaration the way the engine holds it", () => {
    expectType<Exact<ArrowArgs<"(-> Symbol Number)">, ["Symbol"]>>();
    expectType<Exact<ArrowResult<"(-> Symbol Number)">, "Number">>();
    expectType<Exact<ArrowArity<"(-> Symbol Symbol %Undefined%)">, 2>>();
    expectType<Exact<ArrowResult<"(-> Symbol Symbol %Undefined%)">, "%Undefined%">>();

    // And the runtime reader builds the same shape.
    assert.equal(String(parseType("(-> Symbol Number)", "ageOf")), "(-> Symbol Number)");
  });

  it("refuses an application whose arity disagrees with its declaration", () => {
    expectType<Exact<CheckArity<"parent", [1, 2], "(-> Symbol Symbol %Undefined%)">, unknown>>();
    // One argument where the arrow presents two: the check answers an error
    // type carrying the message, which is what puts it at the call site.
    type Wrong = CheckArity<"parent", [1], "(-> Symbol Symbol %Undefined%)">;
    expectType<
      Exact<Wrong["__mettaArityError"], "parent takes 2 argument(s), this gives 1">
    >();
  });

  it("narrows a schema-backed factory to its declared names, and still spells any other", () => {
    expectType<Exact<SymbolsOf<"parent" | "ageOf">["parent"], Name<"parent">>>();
    expectType<Exact<SymbolsOf<"parent" | "ageOf">["anythingElse"], Name>>();
    expectType<Exact<VarsOf<"x">["x"], Var<"x">>>();
  });

  it("names the tags this binding speaks", () => {
    expectType<Exact<Tag, "s" | "v" | "n" | "g" | "b" | "e" | "p" | "o">>();
  });
});

describe("the small builders", () => {
  it("build the terms they name", () => {
    assert.equal(String(nil()), "()");
    assert.equal(String(e(S.a, 1, "t")), '(a 1 "t")');
    assert.equal(String(list([S.a, S.b])), "(:: a (:: b ()))");
    assert.equal(String(list([], { cons: "cons" })), "()");
    assert.equal(String(list([S.a], { cons: "cons" })), "(cons a ())");
  });
});

describe("the intern table", () => {
  it("holds one entry per structurally distinct atom", () => {
    const before = internedCount();
    sym("a-name-nothing-else-here-uses");
    const after = internedCount();
    assert.ok(after > before, "interning a fresh name added no entry");
    sym("a-name-nothing-else-here-uses");
    assert.equal(internedCount(), after, "interning the same name added a second entry");
  });
});

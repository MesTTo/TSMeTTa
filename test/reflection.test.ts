/**
 * Purpose: the verbs that ask the engine about ITSELF — documentation, proofs,
 *   forms, traces, disassembly, statuses, counters — and the scopes that bound
 *   what a reduction may spend.
 * Guarantees:
 *   - a strict scope runs its source ONCE, so a write inside a refused
 *     directive does not happen twice
 *   - a proof is a discriminated union, so a `switch` over its nodes is
 *     exhaustive
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  CastError,
  Derivation,
  InferenceLimitError,
  type MeTTa,
  type ProofNode,
  S,
  StrictError,
  V,
  metta,
  sub,
} from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
  m.run(`
    (= (dbl $x) (* 2 $x))
    (= (quad $x) (dbl (dbl $x)))
    (: Ann Person)
    (@doc dbl (@desc "double a number"))
  `);
});

after(() => {
  m.dispose();
});

describe("asking the engine about itself", () => {
  it("answers a subject's own documentation", async () => {
    const found = await m.doc(S.dbl).one();
    assert.match(found.text, /double a number/);
    assert.equal(await m.doc(S.nobodyDocumentedThis).find(), undefined);
  });

  it("solves a relation backwards, keyed by its own variables", async () => {
    assert.deepEqual(String((await m.solve(4, sub(V.x, 1)).one())["x"]), "5");
    assert.throws(() => m.solve(4, 5));
  });

  it("narrows a value the type discipline admits, and names the types when it does not", () => {
    assert.equal(String(m.cast(S.Ann, S.Person)), "Ann");
    assert.equal(m.cast(3, S.Number), 3);
    // `Atom` is unchecked by the translator, so a cast to it mirrors that.
    assert.equal(String(m.cast(S.Ann, S.Atom)), "Ann");
    assert.throws(
      () => m.cast(S.Ann, S.Dog),
      (error: unknown) => {
        assert.ok(error instanceof CastError);
        assert.match(error.message, /its types are Person/);
        return true;
      },
    );
  });

  it("reads a proof tree as a discriminated union", async () => {
    const proof = await m.why(S.quad(3));
    assert.ok(proof instanceof Derivation);
    assert.equal(proof.answer.text, "12");
    assert.ok(proof.complete);
    assert.equal(proof.truncations.length, 0);
    // Two `dbl` firings and one `quad`, and the rules are deduplicated.
    assert.equal(proof.rules.length, 2);
    assert.match(String(proof), /by \(= \(quad \$a\) \(dbl \(dbl \$a\)\)\)/);

    // Every node narrows on `kind`, which is what a union buys over a class
    // hierarchy: the switch below is exhaustive and TypeScript proves it.
    const kinds = new Set<string>();
    const walk = (nodes: readonly ProofNode[]): void => {
      for (const node of nodes) {
        kinds.add(node.kind);
        switch (node.kind) {
          case "step":
            walk(node.children);
            break;
          case "fact":
            assert.ok(node.space.length > 0);
            break;
          case "builtin":
          case "truncated":
            assert.ok(node.text.length > 0);
            break;
        }
      }
    };
    walk(proof.children);
    assert.ok(kinds.has("step"));
    assert.ok(kinds.has("builtin"));
  });

  it("truncates a proof at a finite depth rather than claiming none", async () => {
    const shallow = await m.derivation(S.quad(3), { depth: 1 }).find();
    assert.ok(shallow !== undefined);
    assert.ok(!shallow.complete);
    assert.ok(shallow.truncations.length > 0);
  });

  it("answers no proof for something that has none", async () => {
    assert.equal(await m.why(S.neverDefined(1)), undefined);
  });

  it("reads every top-level form without evaluating any of them", () => {
    const forms = m.forms("(= (f $x) $x)\n!(f 1)");
    assert.deepEqual(forms.map((form) => form.kind), ["function", "runnable"]);
    assert.equal(forms[0]?.text, "(= (f $x) $x)");
    assert.equal(forms[1]?.atom.text, "(f 1)");
    // Reading is not running: `f` is still undefined here.
    assert.equal(m.run("!(f 1)")[0]?.texts[0], "(f 1)");
  });

  it("traces a reduction as call and exit events", () => {
    const events = m.trace("!(quad 3)", { maxEvents: 200 });
    assert.ok(events.length >= 6);
    assert.equal(events[0]?.kind, "call");
    assert.equal(events[0]?.term.text, "(quad 3)");
    const last = events[events.length - 1];
    assert.equal(last?.kind, "exit");
    assert.equal(last?.kind === "exit" ? last.answer.text : "", "12");
  });

  it("disassembles a name into the clauses it compiled to", () => {
    const listing = m.disassemble("dbl");
    assert.match(listing, /dbl\(/);
    assert.throws(() => m.disassemble("nothingCompiledThis"));
  });

  it("reports what the engine did with each directive", () => {
    const groups = m.runStatus("!(+ 1 2)\n!(typoo 1)\n!(empty)");
    assert.deepEqual(
      groups.map((group) => group.map((row) => row.status)),
      [["value"], ["not-reducible"], ["empty"]],
    );
    assert.equal(groups[0]?.[0]?.text, "3");
  });

  it("refuses an unreduced directive inside a strict scope, running the source once", () => {
    const counted = m.space("&strict-writes");
    counted.clear();
    {
      using _scope = m.strict();
      assert.ok(m.isStrict);
      assert.deepEqual(m.run("!(+ 1 2)")[0]?.texts, ["3"]);
      assert.throws(
        () => m.run(`!(add-atom &strict-writes (wrote))\n!(typoo 1)`),
        (error: unknown) => {
          assert.ok(error instanceof StrictError);
          return true;
        },
      );
    }
    assert.ok(!m.isStrict);
    // ONE write, not two: the source is executed once and judged from what it
    // did, rather than executed to judge it and executed again to keep it.
    assert.equal(counted.size, 1);
    // Outside the scope the same directive is ordinary data again.
    assert.deepEqual(m.run("!(typoo 1)")[0]?.texts, ["(typoo 1)"]);
  });

  it("bounds what a reduction may spend in inferences", () => {
    m.run("(= (spin $n) (spin (+ $n 1)))");
    assert.throws(
      () => {
        using _bound = m.limits({ inferences: 2_000 });
        m.run("!(spin 0)");
      },
      (error: unknown) => {
        assert.ok(error instanceof InferenceLimitError);
        assert.equal(error.limit, 2_000);
        return true;
      },
    );
  });

  it("reads the engine's own counters, from outside a job", () => {
    const before = m.engine.engineCounters;
    m.run("!(quad 9)");
    const after = m.engine.engineCounters;
    // The process's own work, not one suspended engine's handful: a fresh SWI
    // engine has retired a couple of dozen inferences, and this is far past it.
    assert.ok(before.inferences > 1_000, `${String(before.inferences)} inferences`);
    assert.ok(after.inferences > before.inferences);
    assert.ok(after.cpuSeconds >= before.cpuSeconds);
  });
});

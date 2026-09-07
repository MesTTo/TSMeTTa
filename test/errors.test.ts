/**
 * Purpose: the error family — one base, one named subclass per condition, one
 *   stable code each — and the classification of an engine refusal.
 * Guarantees:
 *   - catching `MettaError` catches every refusal this package raises
 *   - a caller may narrow by class or by code, and the two agree
 *   - every exported concrete condition has a source producer and obsolete
 *     strict-scope conditions cannot return to the types or documentation
 *     [tested: "discovers every published condition and its producer";
 *     "contains no retired strict-scope conditions";
 *     commit=f634a8072585acef6195994b1220cb822575822e]
 *   - a failing assertion arrives here WHOLE: the two bag lines are
 *     continuation lines of one engine message, so the capture window that
 *     renders a ball is asked for the text as well as the class
 *     [tested: "carries the answers that were missing and in excess";
 *     "prints no bag line for a form that compared no answers";
 *     commit=71de27a76dd16684941e3e090de0d17299d96493]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { type MeTTa, metta, repoRoot } from "../src/index.ts";

import * as errors from "../src/errors.ts";

import {
  AssertionError,
  CapabilityError,
  CastError,
  ClosedError,
  type Code,
  CompileError,
  EngineError,
  InferenceLimitError,
  InterruptedError,
  MettaError,
  MettaSyntaxError,
  NameError,
  OperationError,
  ProviderError,
  ResourceLimitError,
  ResultError,
  RestraintError,
  SourceNotFoundError,
  StackLimitError,
  SubscriberError,
  TimeLimitError,
  TransportError,
  UnsupportedError,
  WireError,
  branchFailure,
  nearest,
  unknownName,
} from "../src/index.ts";
// The classifier is the transport's own door rather than a caller's: its
// input is what the bridge read off the ball. The conditions above are the
// package's surface; this is not.
import { REFUSAL_KINDS, engineError } from "../src/errors.ts";
import { packageRoot } from "../src/engine.ts";

/** The kind list both seats read, and each seat's class for each kind. */
interface KindRow {
  readonly origin: string;
  readonly fields: readonly string[];
  readonly ball: string;
  readonly expects: Readonly<Record<string, string>>;
  readonly node: {
    readonly error: string;
    readonly code: Code;
    readonly attributes: Readonly<Record<string, string>>;
  };
}

const KINDS = (
  JSON.parse(readFileSync(join(repoRoot, "tests", "data", "error-kinds.json"), "utf8")) as {
    kinds: Record<string, KindRow>;
  }
).kinds;

const EXPECTED_CODES: Readonly<Record<string, Code>> = {
  AssertionError: "ERR_METTA_ASSERTION",
  CapabilityError: "ERR_METTA_CAPABILITY",
  CastError: "ERR_METTA_CAST",
  ClosedError: "ERR_METTA_CLOSED",
  CompileError: "ERR_METTA_LOWER",
  EngineError: "ERR_METTA_ENGINE",
  InferenceLimitError: "ERR_METTA_INFERENCES",
  InterruptedError: "ERR_METTA_INTERRUPTED",
  MettaSyntaxError: "ERR_METTA_SYNTAX",
  NameError: "ERR_METTA_NAME",
  OperationError: "ERR_METTA_OPERATION",
  ProviderError: "ERR_METTA_PROVIDER",
  RestraintError: "ERR_METTA_RESTRAINT",
  ResultError: "ERR_METTA_ABSENT",
  SourceNotFoundError: "ERR_METTA_SOURCE",
  StackLimitError: "ERR_METTA_STACK",
  SubscriberError: "ERR_METTA_SUBSCRIBER",
  TimeLimitError: "ERR_METTA_TIME",
  TransportError: "ERR_METTA_TRANSPORT",
  UnsupportedError: "ERR_METTA_UNSUPPORTED",
  WireError: "ERR_METTA_WIRE",
};

type ErrorKind = typeof MettaError;

const isErrorKind = (value: unknown): value is ErrorKind =>
  typeof value === "function" && value.prototype instanceof MettaError;

const CONDITIONS = Object.values(errors)
  .filter(isErrorKind)
  .filter((Kind) => Kind !== ResourceLimitError)
  .sort((left, right) => left.name.localeCompare(right.name));

const SOURCE = join(packageRoot, "src");

function sourceText(): string {
  const texts: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) texts.push(readFileSync(full, "utf8"));
    }
  };
  walk(SOURCE);
  return texts.join("\n");
}

describe("the error family", () => {
  it("each error subclass carries its own code", () => {
    assert.deepEqual(
      CONDITIONS.map((Kind) => Kind.name),
      Object.keys(EXPECTED_CODES).sort(),
    );
    for (const Kind of CONDITIONS) {
      const code = EXPECTED_CODES[Kind.name] as Code;
      // One shape for every condition: the message, then that condition's own
      // parts in an options bag, all of them optional.
      const raised = Reflect.construct(Kind, ["something"]) as MettaError;
      assert.equal(raised.code, code, Kind.name);
      assert.equal(raised.name, Kind.name);
      assert.ok(raised instanceof MettaError, `${Kind.name} is in the family`);
      assert.ok(raised instanceof Error, `${Kind.name} is an Error`);
      assert.ok(MettaError.is(raised, code));
      assert.deepEqual(raised.toJSON(), { name: Kind.name, code, message: "something" });
    }
  });

  it("carries a limit on a resource refusal", () => {
    const raised = new InferenceLimitError("too much", { limit: 500 });
    assert.equal(raised.limit, 500);
    assert.ok(raised instanceof ResourceLimitError);
    assert.equal(new TimeLimitError("too slow", { limit: 2 }).code, "ERR_METTA_TIME");
    assert.equal(new StackLimitError("too deep", { limit: 1024 }).code, "ERR_METTA_STACK");
    assert.ok(new StackLimitError("too deep", { limit: 1024 }) instanceof ResourceLimitError);
    // A budget that expired inside a nested query knows its resource and not
    // its number, and says so rather than reporting a bound of zero.
    assert.equal(new InferenceLimitError("spent").limit, undefined);
    // The restraint's bound IS the family's limit, under the family's name.
    const tripped = new RestraintError("stopped", {
      restraint: "max-answers",
      bound: 2,
      call: "(f 1)",
    });
    assert.ok(tripped instanceof ResourceLimitError);
    assert.deepEqual([tripped.restraint, tripped.limit, tripped.call], ["max-answers", 2, "(f 1)"]);
  });

  it("discovers every published condition and its producer", () => {
    const sources = sourceText();
    for (const Kind of CONDITIONS) {
      assert.match(sources, new RegExp(`\\bnew\\s+${Kind.name}\\s*\\(`), `${Kind.name} has no producer`);
    }
  });

  it("contains no retired strict-scope conditions", () => {
    const retired = /StrictError|NotReducibleError|ERR_METTA_STRICT|ERR_METTA_NOT_REDUCIBLE/;
    assert.doesNotMatch(readFileSync(join(SOURCE, "errors.ts"), "utf8"), retired);
    assert.doesNotMatch(readFileSync(join(packageRoot, "README.md"), "utf8"), retired);
  });

  it("keeps a cause, so the data behind a refusal is never lost", () => {
    const cause = new Error("underneath");
    const raised = new EngineError("on top", { cause });
    assert.equal(raised.cause, cause);
  });

  it("is not any old error", () => {
    assert.ok(!MettaError.is(new Error("plain")));
    assert.ok(!MettaError.is(new WireError("x"), "ERR_METTA_ENGINE"));
  });

  it("covers every kind the engine publishes", () => {
    // The shared list, which the Python seat's own suite reads against its
    // map. A kind added to one seat and forgotten in the other fails here.
    assert.deepEqual([...REFUSAL_KINDS].sort(), Object.keys(KINDS).sort());
    for (const [kind, row] of Object.entries(KINDS)) {
      const raised = engineError("said", kind, row.expects);
      assert.equal(raised.constructor.name, row.node.error, kind);
      assert.equal(raised.code, row.node.code, kind);
      for (const [field, attribute] of Object.entries(row.node.attributes)) {
        const held = (raised as unknown as Record<string, unknown>)[attribute];
        assert.equal(String(held), row.expects[field], `${kind}.${field}`);
      }
    }
  });

  it("reads the kind the engine sent, never the sentence", () => {
    // The exact wording that used to be matched here, sent with the kind the
    // engine actually read: the prose no longer decides anything.
    const said = "metta: the evaluation passed its 500 inference bound and was stopped";
    assert.ok(engineError(said, "engine", {}) instanceof EngineError);
    assert.ok(engineError("nothing about a limit", "inference_limit", { limit: "9" }) instanceof
      InferenceLimitError);
    // A kind this seat does not know keeps the engine's own sentence rather
    // than being replaced by a complaint about the wire.
    const unknown = engineError("said", "a-kind-from-a-newer-engine", {});
    assert.ok(unknown instanceof EngineError);
    assert.equal(unknown.message, "said");
  });

  it("names its own remedy for a stack ceiling", () => {
    const deep = engineError("Stack limit (1.0Gb) exceeded", "stack", { limit: "1073741824" });
    assert.ok(deep instanceof StackLimitError);
    assert.equal((deep as StackLimitError).limit, 1024 * 1024 * 1024);
    assert.match(deep.message, /METTA_STACK_LIMIT/, "the refusal names its own remedy");
  });

  it("gathers several branch failures the way the platform names it", () => {
    const one = new EngineError("only");
    assert.equal(branchFailure([one], "x"), one);
    const many = branchFailure([one, new EngineError("other")], "two branches failed");
    assert.ok(many instanceof AggregateError);
    assert.equal((many as AggregateError).errors.length, 2);
  });

  it("names the nearest declared spelling, or nothing", () => {
    assert.equal(nearest("fibo", ["fib", "factorial"]), "fib");
    assert.equal(nearest("completely-different", ["fib"]), undefined);
    const refusal = unknownName("fibo", ["fib"], "no such head");
    assert.ok(refusal instanceof NameError);
    assert.match(refusal.message, /did you mean fib\?/);
    assert.doesNotMatch(unknownName("zzz", ["fib"], "no such head").message, /did you mean/);
  });
});

describe("an assertion failure crossing the seat", () => {
  let m: MeTTa;

  before(async () => {
    m = await metta();
  });

  after(() => {
    m.dispose();
  });

  // The two bag lines are CONTINUATION lines of one print_message/2 message,
  // and this seat renders an engine ball by replaying print_message inside a
  // user:message_hook/3 capture window (bridge.pl). A window that kept the
  // headline and dropped the rest would still satisfy the classifier above
  // and lose the whole diagnosis, so the classification and the text are
  // asked separately here.
  it("carries the answers that were missing and in excess", () => {
    assert.throws(
      () => m.run("!(assertEqual (+ 1 1) 3)"),
      (raised: unknown) => {
        assert.ok(raised instanceof AssertionError);
        assert.equal((raised as AssertionError).code, "ERR_METTA_ASSERTION");
        const text = (raised as Error).message;
        assert.match(text, /MeTTa assertion failed: \(assertEqual \(\+ 1 1\) 3\)/);
        assert.match(text, /missing: \(3\)/);
        assert.match(text, /excess: \(2\)/);
        return true;
      },
    );
  });

  // Both bags empty is the permutation diagnosis rather than a puzzle, and it
  // is the one thing assertEqual's term equality fails on while the answers
  // themselves agree.
  it("says when the answers agree and only their order differs", () => {
    assert.throws(
      () => m.run("!(assertEqual (superpose (1 2)) (superpose (2 1)))"),
      /differ only in order/,
    );
  });

  // assert takes a verdict, so there is no bag comparison and no bag line.
  it("prints no bag line for a form that compared no answers", () => {
    assert.throws(
      () => m.run("!(assert (== 1 2))"),
      (raised: unknown) => {
        const text = (raised as Error).message;
        assert.match(text, /MeTTa assertion failed/);
        assert.doesNotMatch(text, /missing:/);
        return true;
      },
    );
  });

  // A containment allows an answer in excess of its expectation, so its report
  // names the missing answers and nothing else. 1 and 2 are both produced here
  // and neither is expected, and this seat replays the message through its own
  // capture window, so the one-sided shape has to survive that too.
  it("reports a containment one-sidedly, blaming the head the program wrote", () => {
    assert.throws(
      () => m.run("!(assertIncludes (superpose (1 2)) (7))"),
      (raised: unknown) => {
        const text = (raised as Error).message;
        assert.match(text, /assertIncludes: MeTTa assertion failed/);
        assert.doesNotMatch(text, /assert-includes-answers/);
        assert.match(text, /MeTTa assertion failed: \(assertIncludes \(superpose \(1 2\)\) \(7\)\)/);
        assert.match(text, /missing: \(7\)/);
        assert.doesNotMatch(text, /excess/);
        return true;
      },
    );
  });
});

describe("every kind the engine publishes, over a live engine", () => {
  let m: MeTTa;

  before(async () => {
    m = await metta();
  });

  after(() => {
    m.dispose();
  });

  // The differential the shared list is for: the same ball the Python seat's
  // own suite throws, raised inside this engine, classified by the engine's
  // table, carried over this seat's wire and read back as a condition. Before
  // 2026-09-07 this side matched six words in the rendered sentence, so eight
  // of these thirteen arrived as a generic EngineError with no field at all.
  it("classifies every kind the engine publishes, from a real ball", () => {
    for (const [kind, row] of Object.entries(KINDS)) {
      assert.throws(
        () => m.engine.once(`throw(${row.ball})`),
        (raised: unknown) => {
          const error = raised as MettaError;
          assert.equal(error.constructor.name, row.node.error, kind);
          assert.equal(error.code, row.node.code, kind);
          for (const [field, attribute] of Object.entries(row.node.attributes)) {
            const held = (error as unknown as Record<string, unknown>)[attribute];
            assert.equal(String(held), row.expects[field], `${kind}.${field}`);
          }
          return true;
        },
        kind,
      );
    }
  });

  // The restraint a program declared for its own table, tripped by asking for
  // more answers than the row allows. Three fields: the word, the bound and
  // the tabled call as the program wrote it.
  it("carries the word, the bound and the call of a tripped restraint", () => {
    m.run("!(import! &self (library lib_tabling))");
    m.run("(= (nx-upto $n) (superpose (1 2 3 4 5 6 7 8 9 10)))");
    m.run("!(add-atom &metta (cache nx-upto (max-answers 2)))");
    assert.throws(
      () => m.run("!(collapse (nx-upto 10))"),
      (raised: unknown) => {
        assert.ok(raised instanceof RestraintError, `${String(raised)} is not a RestraintError`);
        const tripped = raised as RestraintError;
        assert.ok(tripped instanceof ResourceLimitError, "a restraint is a resource bound");
        assert.equal(tripped.code, "ERR_METTA_RESTRAINT");
        assert.equal(tripped.restraint, "max-answers");
        assert.equal(tripped.limit, 2);
        assert.equal(tripped.call, "(nx-upto 10)");
        assert.match(tripped.message, /\(max-answers 2\) restraint/);
        return true;
      },
    );
  });
});

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
 *     commit=WORKTREE]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { type MeTTa, metta } from "../src/index.ts";

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
  MettaError,
  MettaSyntaxError,
  NameError,
  ProviderError,
  ResourceLimitError,
  ResultError,
  SourceNotFoundError,
  StackLimitError,
  SubscriberError,
  TimeLimitError,
  TransportError,
  UnsupportedError,
  WireError,
  branchFailure,
  engineError,
  nearest,
  unknownName,
} from "../src/index.ts";
import { packageRoot } from "../src/engine.ts";

const EXPECTED_CODES: Readonly<Record<string, Code>> = {
  AssertionError: "ERR_METTA_ASSERTION",
  CapabilityError: "ERR_METTA_CAPABILITY",
  CastError: "ERR_METTA_CAST",
  ClosedError: "ERR_METTA_CLOSED",
  CompileError: "ERR_METTA_LOWER",
  EngineError: "ERR_METTA_ENGINE",
  InferenceLimitError: "ERR_METTA_INFERENCES",
  MettaSyntaxError: "ERR_METTA_SYNTAX",
  NameError: "ERR_METTA_NAME",
  ProviderError: "ERR_METTA_PROVIDER",
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
      const args = Kind.prototype instanceof ResourceLimitError ? ["something", 1] : ["something"];
      const raised = Reflect.construct(Kind, args) as MettaError;
      assert.equal(raised.code, code, Kind.name);
      assert.equal(raised.name, Kind.name);
      assert.ok(raised instanceof MettaError, `${Kind.name} is in the family`);
      assert.ok(raised instanceof Error, `${Kind.name} is an Error`);
      assert.ok(MettaError.is(raised, code));
      assert.deepEqual(raised.toJSON(), { name: Kind.name, code, message: "something" });
    }
  });

  it("carries a limit on a resource refusal", () => {
    const raised = new InferenceLimitError("too much", 500);
    assert.equal(raised.limit, 500);
    assert.ok(raised instanceof ResourceLimitError);
    assert.equal(new TimeLimitError("too slow", 2).code, "ERR_METTA_TIME");
    assert.equal(new StackLimitError("too deep", 1024).code, "ERR_METTA_STACK");
    assert.ok(new StackLimitError("too deep", 1024) instanceof ResourceLimitError);
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

  it("classifies the engine's own control signals", () => {
    const inferences = engineError(
      "metta: the evaluation passed its 500 inference bound and was stopped (inference_limit)",
    );
    assert.ok(inferences instanceof InferenceLimitError);
    assert.equal(inferences.code, "ERR_METTA_INFERENCES");
    assert.equal((inferences as InferenceLimitError).limit, 500);

    const raw = engineError("error(metta_control_signal(time_limit, 3), context(x, y))");
    assert.ok(raw instanceof TimeLimitError);
    assert.equal((raw as TimeLimitError).limit, 3);

    assert.ok(engineError("something else entirely") instanceof EngineError);
  });

  it("classifies the three engine wordings that used to arrive as prose", () => {
    // Each of these was a generic `EngineError` until 2026-08-31, so a caller
    // who wanted to act on one had to match the prose [C51].
    const deep = engineError("Stack limit (1.0Gb) exceeded\n  Stack sizes: local: 0.6Gb");
    assert.ok(deep instanceof StackLimitError);
    assert.equal(deep.code, "ERR_METTA_STACK");
    assert.equal((deep as StackLimitError).limit, 1024 * 1024 * 1024);
    assert.match(deep.message, /METTA_STACK_LIMIT/, "the refusal names its own remedy");
    assert.ok(engineError("error(resource_error(stack), _)") instanceof StackLimitError);

    const failed = engineError("assert/2: MeTTa assertion failed: false (MeTTa assertion failed)");
    assert.ok(failed instanceof AssertionError);
    assert.equal(failed.code, "ERR_METTA_ASSERTION");

    const absent = engineError("source_sink `'/no/such.metta'' does not exist");
    assert.ok(absent instanceof SourceNotFoundError);
    assert.equal(absent.code, "ERR_METTA_SOURCE");
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
});

/**
 * Purpose: the error family — one base, one named subclass per condition, one
 *   stable code each — and the classification of an engine refusal.
 * Guarantees:
 *   - catching `MettaError` catches every refusal this package raises
 *   - a caller may narrow by class or by code, and the two agree
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

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
  NotReducibleError,
  ProviderError,
  ResourceLimitError,
  ResultError,
  SourceNotFoundError,
  StackLimitError,
  StrictError,
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

const FAMILY: readonly [new (message: string) => MettaError, Code][] = [
  [EngineError, "ERR_METTA_ENGINE"],
  [MettaSyntaxError, "ERR_METTA_SYNTAX"],
  [WireError, "ERR_METTA_WIRE"],
  [ResultError, "ERR_METTA_ABSENT"],
  [NameError, "ERR_METTA_NAME"],
  [CapabilityError, "ERR_METTA_CAPABILITY"],
  [CompileError, "ERR_METTA_LOWER"],
  [ClosedError, "ERR_METTA_CLOSED"],
  [UnsupportedError, "ERR_METTA_UNSUPPORTED"],
  [StrictError, "ERR_METTA_STRICT"],
  [NotReducibleError, "ERR_METTA_NOT_REDUCIBLE"],
  [CastError, "ERR_METTA_CAST"],
  [ProviderError, "ERR_METTA_PROVIDER"],
  [SubscriberError, "ERR_METTA_SUBSCRIBER"],
  [TransportError, "ERR_METTA_TRANSPORT"],
  [AssertionError, "ERR_METTA_ASSERTION"],
  [SourceNotFoundError, "ERR_METTA_SOURCE"],
];

describe("the error family", () => {
  it("each error subclass carries its own code", () => {
    for (const [Kind, code] of FAMILY) {
      const raised = new Kind("something");
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

  it("gives every published class a producer, so no catch branch is unreachable", () => {
    // A class nobody raises is a branch a caller cannot take. Three of them
    // were exactly that: NotReducibleError, AssertionError and (deleted)
    // InterruptedError [see C51]. This holds the line for the two that stayed.
    const raised = new Set([
      ...["NotReducibleError", "AssertionError", "StackLimitError", "SourceNotFoundError"],
    ]);
    for (const name of raised) {
      assert.ok(
        FAMILY.some(([Kind]) => Kind.name === name) ||
          ["StackLimitError"].includes(name),
        `${name} is not in the family table`,
      );
    }
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

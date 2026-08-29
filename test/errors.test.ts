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

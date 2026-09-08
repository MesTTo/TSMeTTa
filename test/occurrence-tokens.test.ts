/**
 * Purpose: verify occurrence identity through native and provider spaces.
 * Guarantees: blame orders stable tokens and closes failed provider streams
 *   [tested: occurrence-tokens.test.ts; commit=WORKTREE].
 * Owns resources: the fixture disposes its engine; each provider is detached.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import {
  type Atom, CapabilityError, type MeTTa, S, type SpaceProvider,
  capabilitiesOf, metta, toAtom,
} from "../src/index.ts";

let m: MeTTa;
before(async () => { m = await metta({ actor: "t0-node", generation: 100_000 }); });
after(() => { m.dispose(); });

describe("stored occurrence tokens", () => {
  it("keeps duplicate identities distinct and the digest content-only", () => {
    const space = m.space("&native-tokens");
    space.add(S.row(1), S.row(1));
    const before = space.blame(S.row(1)).map(String);
    assert.equal(new Set(before).size, 2);
    for (const token of before) assert.match(token, /^\(t t0-node 1\d{5}\)$/);
    const digest = space.digest();
    space.clear();
    assert.deepEqual(space.blame(S.row(1)), []);
    space.add(S.row(1), S.row(1));
    const after = space.blame(S.row(1)).map(String);
    assert.equal(new Set([...before, ...after]).size, 4);
    assert.equal(space.digest(), digest);
    assert.ok(space.delete(S.row(1)));
    assert.deepEqual(space.blame(S.row(1)).map(String), after.slice(1));
    assert.ok(space.delete(S.row(1)));
    assert.deepEqual(space.blame(S.row(1)), []);
  });

  it("orders provider tokens by generation and actor without losing duplicates", () => {
    const atom = toAtom(S.row(1));
    const pairs: readonly (readonly [Atom, Atom])[] = [
      [toAtom(S.t(S.z, 7)), atom], [toAtom(S.t(S.a, 6)), atom],
      [toAtom(S.t(S.z, 3)), toAtom(S.row(2))], [toAtom(S.t(S.a, 7)), atom],
    ];
    let closed = 0;
    const provider: SpaceProvider = {
      *atoms() { yield* pairs.map((pair) => pair[1]); },
      *tokens() { try { yield* pairs; } finally { closed += 1; } },
    };
    assert.ok(capabilitiesOf(provider).includes("tokens"));
    const space = m.attach("&provider-tokens", provider);
    try {
      assert.deepEqual(space.blame(atom).map(String), ["(t a 6)", "(t a 7)", "(t z 7)"]);
      assert.equal(closed, 1);
      assert.deepEqual(space.blame(S.absent), []);
      assert.equal(closed, 2);
    } finally { m.detach("&provider-tokens"); }
  });

  it("drives asynchronous token streams through blamed", async () => {
    let closed = 0;
    const space = m.attach("&async-tokens", {
      async *tokens() {
        try {
          await Promise.resolve();
          yield [toAtom(S.t(S.remote, 8)), toAtom(S.row(1))] as const;
          yield [toAtom(S.t(S.remote, 6)), toAtom(S.row(1))] as const;
        } finally { closed += 1; }
      },
    });
    try {
      assert.deepEqual((await space.blamed(S.row(1))).map(String), ["(t remote 6)", "(t remote 8)"]);
      assert.equal(closed, 1);
    } finally { m.detach("&async-tokens"); }
  });

  it("closes invalid, duplicated and failed token streams", () => {
    for (const mode of ["invalid", "duplicate", "late"] as const) {
      let closed = 0;
      const pair = [toAtom(S.t(S.remote, 1)), toAtom(S.row(1))] as const;
      const space = m.attach("&failed-tokens", {
        *tokens() {
          try {
            if (mode === "invalid") yield [S.wrong.atom, pair[1]] as const;
            else {
              yield pair;
              if (mode === "duplicate") yield pair;
              else throw new Error("late token failure");
            }
          } finally { closed += 1; }
        },
      });
      try {
        assert.throws(() => space.blame(S.row(1)),
          mode === "duplicate" ? /distinct_occurrence_tokens/ :
            mode === "late" ? /late token failure/ : /occurrence_pair/);
        assert.equal(closed, 1, mode);
      } finally { m.detach("&failed-tokens"); }
    }
  });

  it("reports a provider failure before iteration starts", () => {
    const space = m.attach("&eager-token-failure", {
      tokens() { throw new Error("eager token failure"); },
    });
    try { assert.throws(() => space.blame(S.row(1)), /eager token failure/); }
    finally { m.detach("&eager-token-failure"); }
  });

  it("names the remedy when a provider has no identities", async () => {
    const space = m.attach("&anonymous-rows", { *atoms() { yield S.row(1); } });
    try {
      assert.deepEqual((await space.atoms()).map(String), ["(row 1)"]);
      assert.throws(() => space.blame(S.row(1)), (error: unknown) => {
        assert.ok(error instanceof CapabilityError);
        assert.match(String(error), /native overlay/);
        assert.match(String(error), /stable provider identities/);
        return true;
      });
    } finally { m.detach("&anonymous-rows"); }
  });
});

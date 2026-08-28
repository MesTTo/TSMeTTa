/**
 * Purpose: the workloads this seat is measured on, and which counter decides
 *   each of them.
 * Assumes:
 *   - a case that names `inferences` runs its whole ask to EXHAUSTION.
 *     bridge.pl's metta_node_guarded/2 emits its `spent` event only after the
 *     command has no more answers, so a job the host abandons contributes
 *     nothing to the engine counter [measured 2026-08-28: draining 2000 rows
 *     reports 282622 inferences and breaking out of the same ask at 20 reports
 *     0, in one process]
 *   - a case that names `instructions` is run under `perf stat -e
 *     instructions:u` by the Python driver, with setup and teardown outside
 *     perf's control-fd window
 * Guarantees:
 *   - every case's declared counters match what it produces: an inference
 *     case holds an engine and an engine-free case does not [tested: "every
 *     case that pins inferences holds an engine, and every engine-free case
 *     does not"]
 *   - the lazy case abandons its ask rather than draining it, which is what
 *     makes its inference pin of zero a statement about laziness rather than
 *     an absence of work [tested: "the lazy case abandons the ask instead of
 *     draining it"]
 *   - a case's `operations` is what its run returns, so a workload that
 *     silently shrank is a failure and not a smaller number [tested: "each
 *     case completes exactly the operations it declares"]
 * Decides: the sizes below. Each is the smallest that puts the deciding
 *   counter far above its own noise while keeping one sample under a second,
 *   so three samples of the whole suite fit inside the gate's budget.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Collapse,
  type MeTTa,
  S,
  V,
  atomFromWire,
  fromTransport,
  metta,
  sym,
  toTransport,
  wireFromAtom,
} from "../src/index.ts";

/** Which counter decides a case. A case may name both when it straddles the boundary. */
export type Counter = "inferences" | "instructions";

/** One prepared workload: the engine behind it, the measured work, and its release. */
export interface Bench {
  /** The engine whose inference counter the driver reads, or null for host-side work. */
  readonly engine: MeTTa | null;
  /** The measured work. Answers how many operations it completed. */
  readonly run: () => Promise<number>;
  /** Released after every sample, inside setup's own untimed window. */
  readonly close: () => void;
}

/** One benchmark case. */
export interface Case {
  readonly name: string;
  readonly unit: string;
  readonly operations: number;
  readonly counters: readonly Counter[];
  /** Why those counters and not the others, printed by `--list`. */
  readonly decidedBecause: string;
  readonly setup: () => Promise<Bench>;
  /**
   * The most host-to-engine round trips the measured window may take.
   *
   * For a case whose guarantee is that it does NOT drain its source. The
   * engine's own counter cannot state that guarantee, because an abandoned
   * job reports nothing at all; this transport counter can, and the driver
   * checks it against the same window the counters are read from.
   */
  readonly crossingBound?: number;
}

const nothing = (): void => {};

// ---------------------------------------------------------------- host side

const ATOMS = 20_000;

/**
 * Interning, both of its paths.
 *
 * Each iteration MISSES the table on a fresh key and then HITS it on the same
 * key, and the `===` is the interning guarantee itself: a miss that failed to
 * publish, or a hit that rebuilt, drops the completed count and fails the run
 * before any counter is read.
 *
 * Instructions decide. Nothing here reaches the engine, so its inference
 * counter cannot move and would pin a constant zero that no change to this
 * code could ever disturb.
 */
const atomIntern: Case = {
  name: "atom-intern",
  unit: "atoms",
  operations: ATOMS,
  counters: ["instructions"],
  decidedBecause: "host-side only: the engine is never asked, so inferences cannot move",
  setup: async () => ({
    engine: null,
    run: async () => {
      let held = 0;
      for (let index = 0; index < ATOMS; index += 1) {
        const built = S.edge(sym(`n${index}`), S.depth(S.n(index % 97)));
        if (built === S.edge(sym(`n${index}`), S.depth(S.n(index % 97)))) held += 1;
      }
      return held;
    },
    close: nothing,
  }),
};

const WIRE_TRIPS = 50_000;

/**
 * The codec, out and back.
 *
 * Out is wireFromAtom then toTransport, which is what crosses into the engine;
 * back is fromTransport then atomFromWire, which is what comes out of it. The
 * `===` at the end is the property a codec exists to keep, and it holds only
 * because both halves agree and the atom re-interns to the same object.
 *
 * Instructions decide, for the same reason atom-intern's do: this is the pure
 * host half of the transport and the engine is not running.
 */
const wireRoundTrip: Case = {
  name: "wire-roundtrip",
  unit: "atom round-trips",
  operations: WIRE_TRIPS,
  counters: ["instructions"],
  decidedBecause: "host-side only: the codec runs without the engine, so inferences cannot move",
  setup: async () => {
    const term = S.edge(
      S.n(7),
      S.tag("x"),
      S.deep(S.a, S.b, S.nested(S.n(-1), S.n(1024))),
      V.rest,
    );
    return {
      engine: null,
      run: async () => {
        let kept = 0;
        for (let trip = 0; trip < WIRE_TRIPS; trip += 1) {
          if (atomFromWire(fromTransport(toTransport(wireFromAtom(term)))) === term) kept += 1;
        }
        return kept;
      },
      close: nothing,
    };
  },
};

// -------------------------------------------------------------- engine side

const FACTS = 2_000;
const TAKEN = 20;
// How many times answers-lazy asks and abandons. One abandonment is two
// milliseconds of work, and a window that small spreads 0.28 percent across
// nine samples against a one percent band; fifty of them spread 0.03 percent
// [measured 2026-08-28, three runs of three samples each way]. Repetition also
// strengthens what the case says, since fifty abandoned jobs reporting zero
// inferences is a stronger statement than one doing so.
const ABANDONS = 50;

async function facts(): Promise<MeTTa> {
  const m = await metta();
  for (let index = 0; index < FACTS; index += 1) m.self.add(S.fact(S.n(index), S.n(index * 2)));
  return m;
}

/**
 * A query returning many rows, drained through the thenable.
 *
 * `await ans` is the eager door: Answers.then hands off to toArray, which
 * walks the same async iterator `for await` walks, so this measures the whole
 * ask and the transport that carries every row of it.
 *
 * Inferences decide, because the engine does the work and its counter is
 * deterministic under load where wall clock is not. Instructions are pinned
 * beside them because the engine counter is blind to this seat's own half of
 * each answer: a change that added a round trip per row would leave the
 * inference count untouched.
 *
 * This is also the EAGER half of the pair answers-lazy completes.
 */
const queryRows: Case = {
  name: "query-rows",
  unit: "rows",
  operations: FACTS,
  counters: ["inferences", "instructions"],
  decidedBecause:
    "engine work, so inferences decide; instructions price the transport the engine counter cannot see",
  setup: async () => {
    const m = await facts();
    return {
      engine: m,
      run: async () => (await m.match(S.fact(V.a, V.b))).length,
      close: () => m.dispose(),
    };
  },
};

/**
 * The same ask, abandoned after twenty of its two thousand rows, fifty times.
 *
 * The pin that matters here is `inferences: 0`, and it is a statement rather
 * than an absence. bridge.pl reports what a job spent as that job's LAST
 * event, reached only once the command has no more answers, so an abandoned
 * job contributes nothing. A lazy path that quietly began draining would
 * report the eager case's count and fail this row by four orders of magnitude.
 *
 * Instructions therefore decide the SIZE of the lazy path, since the engine
 * counter is definitionally zero here and cannot say whether twenty rows cost
 * twenty rows' work or two thousand. What they price includes the teardown:
 * leaving the loop early closes the cursor and destroys the engine behind it,
 * which happens inside the window and is most of what a short take costs.
 */
const answersLazy: Case = {
  name: "answers-lazy",
  unit: "rows",
  operations: TAKEN * ABANDONS,
  counters: ["inferences", "instructions"],
  decidedBecause:
    "an abandoned job reports zero inferences by construction, so that zero gates the laziness and instructions gate its size",
  // The transport's own N+1 counter says what the inference counter cannot: a
  // drain costs one crossing per row of the WHOLE source, 2003 an ask against
  // the 22 a take of twenty costs. The bound is structural rather than exact,
  // so an implementation detail worth a crossing an ask does not fail the run
  // while a drain fails it by two orders of magnitude.
  crossingBound: ABANDONS * (TAKEN + 12),
  setup: async () => {
    const m = await facts();
    return {
      engine: m,
      run: async () => {
        let seen = 0;
        for (let round = 0; round < ABANDONS; round += 1) {
          let taken = 0;
          for await (const _row of m.match(S.fact(V.a, V.b))) {
            taken += 1;
            if (taken === TAKEN) break;
          }
          seen += taken;
        }
        return seen;
      },
      close: () => m.dispose(),
    };
  },
};

const CALLS = 500;

/**
 * A defined function, called from the host.
 *
 * The body is LOWERED, so the whole of it lives in the engine and a call costs
 * no host crossing per step. What this prices is therefore the per-call path a
 * user pays: the ask out, the reduction, and the one answer back.
 *
 * Inferences decide. The work is the engine's and the host's share is one ask
 * per call, which is already the smallest this door can be.
 */
const defineCall: Case = {
  name: "define-call",
  unit: "calls",
  operations: CALLS,
  counters: ["inferences"],
  decidedBecause: "a lowered body runs entirely in the engine, so its own counter is the whole cost",
  setup: async () => {
    const m = await metta();
    const countdown = m.define(function countdown(n: number): number {
      return n === 0 ? 0 : countdown(n - 1);
    });
    return {
      engine: m,
      run: async () => {
        let answered = 0;
        for (let call = 0; call < CALLS; call += 1) {
          if (String(await countdown(4).one()) === "0") answered += 1;
        }
        return answered;
      },
      close: () => m.dispose(),
    };
  },
};

const YIELDS = 2_000;

/**
 * A host operation the engine calls back into, once per yield.
 *
 * A generator body is nondeterminism from JavaScript, pulled one answer at a
 * time, so a collapse over it is exactly YIELDS crossings back into this
 * process. That is the one workload here whose cost is genuinely SPLIT: the
 * engine's half retires inferences and the host's half retires none, because
 * the engine counter cannot see across the boundary.
 *
 * Both counters therefore decide, and they decide different halves. A change
 * that moved work from the engine into the host would improve the inference
 * row while leaving the instruction row flat, which is the shape this pair
 * exists to make visible rather than to hide.
 */
const hostOp: Case = {
  name: "host-op",
  unit: "yields",
  operations: YIELDS,
  counters: ["inferences", "instructions"],
  decidedBecause:
    "the crossing is split: inferences see the engine half and retire none for the host half, which instructions carry",
  setup: async () => {
    const m = await metta();
    m.op(
      function* countTo(n: number) {
        for (let index = 0; index < n; index += 1) yield index;
      },
      { effect: "pureStructural" },
    );
    return {
      engine: m,
      run: async () => {
        const collapsed = await m.eval(Collapse(S["count-to"](YIELDS))).one();
        return String(collapsed).split(" ").length;
      },
      close: () => m.dispose(),
    };
  },
};

/** Every case, by name. */
export const CASES: Readonly<Record<string, Case>> = Object.freeze({
  [atomIntern.name]: atomIntern,
  [wireRoundTrip.name]: wireRoundTrip,
  [queryRows.name]: queryRows,
  [answersLazy.name]: answersLazy,
  [defineCall.name]: defineCall,
  [hostOp.name]: hostOp,
});

/** Case names in the order the driver runs and reports them. */
export const NAMES: readonly string[] = Object.freeze(Object.keys(CASES));

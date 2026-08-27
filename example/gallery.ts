/**
 * Purpose: the gallery. Four programs that use the whole surface, each one
 *   runnable, so the README's claims are executable rather than asserted.
 * Assumes:
 *   - it is run from this checkout, so `metta()` finds the engine tree beside
 *     the package
 * Guarantees:
 *   - every line here runs; `test/gallery.test.ts` runs this file and checks
 *     what it printed
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Collapse,
  S,
  type Term,
  V,
  caseOf,
  hostValue,
  metta,
} from "../src/index.ts";

/** Everything the gallery printed, in order, so a test can read it back. */
export const printed: string[] = [];

const say = (label: string, value: unknown): void => {
  const line = `${label}: ${String(value)}`;
  printed.push(line);
  console.log(line);
};

const m = await metta();

// ---------------------------------------------------------------------------
// Program I: a knowledge base, end to end.
//
// A schema, facts, a generator define with the yield/yield* duality, the
// thenable collapse, and at-most-one.

m.schema({ parent: "(-> Symbol Symbol %Undefined%)" });

m.add(S.parent(S.tom, S.bob), S.parent(S.bob, S.ann), S.parent(S.ann, S.eve));

const descendants = m.define(function* descendants(x: Term) {
  const { c } = yield* m.match(S.parent(x, V.c));
  yield c;
  yield S.descendants(c);
});

say("descendants of tom", (await descendants(S.tom)).map(String).join(" "));
say("heir of eve", (await descendants(S.eve).find()) ?? S.none);
say("the equations it installed", descendants.equations.map(String).join("  "));

// ---------------------------------------------------------------------------
// Program II: the performance twin.
//
// Two lowered bodies, whose arithmetic and recursion are the engine's own, so
// a call costs no host crossing. The bodies are ordinary TypeScript and still
// run in TypeScript.

function findDivisor(n: number, d: number): number {
  if (d * d > n) return n;
  if (n % d === 0) return d;
  return findDivisor(n, d + 1);
}

const divisor = m.define(findDivisor);
say("find-divisor, as one equation", divisor.equations[0]);
say("the same body, run in TypeScript", findDivisor(91, 2));

const isPrime = m.define(function isPrime(n: number): boolean {
  return n === findDivisor(n, 2);
}, { name: "prime?" });

{
  using _limits = m.limits({ stack: 1_000_000_000 });
  using counted = m.stats();
  const four = await Promise.all(
    [53537257, 53781811, 54218443, 54734431].map((n) => isPrime(n).one()),
  );
  say("four primes", four.map(String).join(" "));
  say("what it cost", counted);
}

// ---------------------------------------------------------------------------
// Program III: host code the engine calls, in all three shapes.

m.op(function* upto(n: number) {
  for (let i = 1; i <= n; i += 1) yield i;
}, { effect: "pureStructural" });
say("a generator op is nondeterminism", await m.eval(Collapse(S.upto(4))).one());

const shout = m.op(function shout(text: string): string {
  return text.toUpperCase();
}, { effect: "pureStructural" });
say("a plain op", hostValue(await shout("hello").one()));

const later = m.op(async function later(n: number): Promise<number> {
  await new Promise((resume) => setTimeout(resume, 1));
  return n * 10;
}, { effect: "oracleIO" });
say("an async op, awaited mid-reduction", await later(4).one());
say("its declared effect", m.effectOf(later));

// ---------------------------------------------------------------------------
// Program IV: a world, a watch and a case tower.

const todos = m.space(S.todos);
todos.add(S.todo(1, "write the guide", S.active));

const seen: string[] = [];
const watching = (async (): Promise<void> => {
  for await (const admission of todos.watch(S.todo(V.id, V.text, V.state), { pollMs: 1 })) {
    seen.push(admission.text);
    break;
  }
})();

const world = m.world(todos);
world.remove(S.todo(1, "write the guide", S.active));
world.add(S.todo(1, "write the guide", S.done));
say("the draft's view", (await world.match(S.todo(V.id, V.text, S.active))).length);
say("the parent, untouched", todos.size);
world.commit();
say("after the commit", (await todos.atoms()).map(String).join(" "));

await watching;
say("what the watch saw", seen.join(" "));

const label = caseOf(S.done)
  .with(S.active, () => "still going")
  .with(S.done, () => "finished")
  .otherwise(() => "unknown");
say("a case tower", await m.eval(label).one());

m.dispose();

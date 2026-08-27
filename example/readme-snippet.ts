/**
 * Purpose: the repository README's TypeScript snippet, kept runnable, so the
 *   page cannot drift away from the surface it shows.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { metta, S, type Term, V } from "../src/index.ts";

const m = await metta();
m.add(S.parent(S.tom, S.bob), S.parent(S.bob, S.ann));

// Rows are keyed by the pattern's own variable names.
for await (const { child } of m.match(S.parent(S.tom, V.child))) {
  console.log(String(child));                  // bob
}

// An ordinary TypeScript function becomes ONE equation the engine holds, so a
// call costs no host crossing at all.
const twice = m.define(function twice(n: number): number {
  return n * 2;
});
console.log(String(await twice(21).one())); // 42

// A generator body is traced into clauses; `yield*` asks, `yield` emits.
const grandparent = m.define(function* grandparent(x: Term) {
  const { y } = yield* m.match(S.parent(x, V.y));
  const { z } = yield* m.match(S.parent(y, V.z));
  return z;
});
console.log(String(await grandparent(S.tom).one())); // ann

// And a TypeScript function the engine calls back into, from the middle of a
// reduction, awaited if it answers with a promise.
m.op(async function fetchJson(url: string): Promise<unknown> {
  return (await fetch(url)).json();
});
console.log(m.effectOf("fetch-json")); // oracleIO

m.dispose();

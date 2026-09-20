# MeTTa in TypeScript

The engine runs inside your Node process on a WebAssembly SWI-Prolog. No system
SWI, no Python, no server, no compiler.

Semantics are PeTTa's. This is a surface onto that engine, not a second
implementation of the language.

```sh
npm ci
```

```ts
import { metta, S, V, fn } from "./src/index.ts";

const m = await metta();
await m.eval(fn.add(1, 2)).one();        // 3
```

## Build terms, don't concatenate strings

```ts
S.parent(S.alice, S.bob)     // (parent alice bob)
V.p                          // $p
fn.add(1, 2)                 // (+ 1 2)
fn.carAtom(S.x)              // (car-atom x)
```

TypeScript's casing reaches MeTTa's hyphens: `fn.carAtom` is `car-atom`, and a
defined `function balanceOf` installs `balance-of`. For a head outside
identifier grammar, index it: `fn["prime?"]`.

## Ask

```ts
await m.run("(= (parent bob alice)) (= (parent alice zoe))");

await m.eval(fn.match(S["&self"], S["="](S.parent(V.p, S.alice)), V.p)).toArray();
// [ bob ]
```

## Answers are a stream, not an array

```ts
await m.eval(fn.superpose([1, 2, 3])).count();        // 3

for await (const a of m.eval(fn.superpose([1, 2, 3]))) { /* 1, 2, 3 */ }

await m.eval(q).take(2).toArray();   // stop the generator after two
```

- `one` `toArray` `count` `last` `at` — collect
- `take` `drop` `until` `chunk` `unique` `filter` — narrow, lazily
- `some` `every` `find` `exists` `forEach` — decide
- `column` `rows` `toTable` — read answers as a table
- `stream` `timeout` `tap` `orThrow` — control and observe

## What is here

- **Runs anywhere Node does** — and in a browser, over the same WebAssembly
  build; `npm run build:browser` emits the bundle.
- **Spaces** — `match`, add, remove, state cells, new spaces, and foreign
  providers that answer `match` and become spaces.
- **Definition doors** — three ways to give a head meaning, including a
  TypeScript function as a MeTTa function.
- **Nondeterminism as async iteration** — an answer set is an
  `AsyncIterable`, so a generator is consumed lazily and a `take` stops it.
- **Types** — the engine's declarations, checked through the same lanes.
- **Scopes and the extension tier** — the seam other packages register
  against.
- **Typed throughout** — `npm run typecheck`, and the atom algebra is typed
  rather than `any`.

## Verify

```sh
npm test          # the suite
npm run typecheck
npm run kit       # the conformance corpus, compared against the Python seat
```

`llms.txt` beside this file is the full cheat sheet, and the repository root's
covers the language and every other surface.

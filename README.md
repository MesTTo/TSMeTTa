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

## Theories

Equations group as a class, which is the grouping form and is required
nowhere:

```ts
class Arithmetic {
  twiceOver(n: number): number { return n * 2; }
  thriceOver(n: number): number { return n * 3; }
}
m.theory(Arithmetic);          // installs `twice-over` and `thrice-over`
```

A class with no marks installs every own prototype method. `@equation`,
`@grounded` and `@named("exact-head")` narrow that to the marked ones, for a
class that also carries helpers, and the marks compose on one method. They need
a BUILD, though: TypeScript compiles Stage-3 method decorators and V8 has not
shipped them, so a decorated class does not run under Node's own type stripping.
The unmarked form runs everywhere.

## Coordination

```ts
const row = await jobs.take(S.job(V.n), { signal: AbortSignal.timeout(50) });
```

`peek` waits until a matching atom is there and leaves it; `take` removes one.
There is no engine-side blocking wait (`take-atom` needs `library(thread)`,
which a WebAssembly SWI does not have), so these poll, bounded by the signal.
The take is still a take rather than a race. Each waiter reads a candidate and
then asks the engine to delete that exact atom. JavaScript may interleave other
waiters between those calls; the delete result is the arbiter, so a waiter that
lost the candidate retries instead of returning it.

`m.race([a, b])` answers the first branch and cancels the rest through their
signals; `Promise.any` is the platform's word for it, with the cancellation
wired.

The rest of the family is the platform's own concurrency, because the engine's
is absent from this build:

```ts
import { Channel, every, merge, parMap, spawn } from "tsmetta";

await parMap(ids, (id) => m.eval(S.fetch(id)).one(), { concurrency: 8 });
const both = merge(m.match(a), m.match(b));       // interleaved as they arrive
const jobs = new Channel<Atom>({ max: 100 });     // a mailbox with backpressure
const task = spawn(m.eval(expensive));            // started now; await or cancel
for await (const rows of every(1_000, () => m.match(p).toArray(), { signal })) {}
```

`parMap` bounds how many run at once and preserves INPUT order, which is what
makes it a map rather than a gather; an unbounded `Promise.all` over ten
thousand items opens ten thousand host operations at once. A `Channel` bounded
by `max` makes a sender WAIT rather than dropping, which is `queue.Queue`'s
policy and not a ring buffer's. Every one of them takes an `AbortSignal`.

Concurrency here is real wherever the work AWAITS (every host operation that
touches a network, a file or a timer), and is interleaving rather than
parallelism for pure reduction, which is what one engine can honestly offer.

### Python package counterparts


The platform refusals above are separate from the Python package comparison.
The Python capabilities once described here as missing are present under these
public Node subpaths:

| Python capability | Node package surface | public counterpart |
|---|---|---|
| annotated and weighted evaluation | `tsmetta/algebra` | `counting`, `tropical`, `prob`, `prov`, `ranked`, and `TaggedAnswer.under` |
| numeric-array interop | `tsmetta/arrays` | typed arrays, `Tensor`, `EmbeddingStore`, and `installArrays` |
| a space over a network | `tsmetta/remote` | `connect`, `serve`, `RemoteSpace`, and `Gateway` |
| static analysis of definitions | `tsmetta/lint` | `RULES`, `Finding`, `lint`, and `lintFile` |
| assembling an app from a manifest | `tsmetta/manifest` | `boot`, `Boot`, and `VOCABULARY` |
| spaces over rows | `tsmetta/tables` | `tableSpace`, `arrayTables`, and `bridge` |
| host-value conversion | `tsmetta/convert` | `registerType`, `project`, `build`, and `autoImage` |
| library discovery and installation | `tsmetta/integrate` | `integrate`, `discover`, `entryPoints`, and reflection helpers |
| a tabled computed map | `tsmetta/structures` | `TabledMap`; tables are query-local because swipl-wasm has threads disabled, so forms within one `run()` reuse and later jobs recompute |
| a lazy path into a host value | `tsmetta/paths` | `Path`, `path`, `reach`, and `installPaths`; the engine calls a registered operation instead of lifting a marker from a pattern |

## Verify

```sh
npm test          # the suite
npm run typecheck
npm run kit       # the conformance corpus, compared against the Python seat
```

`llms.txt` beside this file is the full cheat sheet, and the repository root's
covers the language and every other surface.

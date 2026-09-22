# MeTTa in TypeScript

The engine runs inside your Node process on a WebAssembly SWI-Prolog. No system
SWI, no Python, no server, no compiler.

Semantics are PeTTa's. This is a surface onto that engine, not a second
implementation of the language.

<!-- shared:what-is-metta -->
## What MeTTa is

MeTTa is a language for rewriting metagraphs. A program and its data are the
same thing: atoms in a space, where an atom is a symbol, a number, a variable
or an expression built from other atoms, and a space is the metagraph they
form together.

You write equations rather than statements, and the engine matches a pattern
against the whole space at once. Every match is an answer, so a rule that fits
three ways yields three results, and whether you take one of them, the first,
or all is the caller's choice rather than the language's. Search is something
you write down instead of something you implement.

One space holds symbolic rules and grounded values side by side: a number, a
matrix, a handle to a trained model. A rule can match on what a model produced
and a model can be called from inside a rule, so the neurosymbolic case is
ordinary here rather than an integration between two systems. Both halves are
atoms in the same metagraph, read by the same matcher.
<!-- /shared:what-is-metta -->

## Why TypeScript

TypeScript is where LLM tooling is written: MCP servers, agent loops, and the
services around them. The engine runs inside your Node process on a
WebAssembly build, so there is no system install, no sidecar process and no
compiler in the way of shipping one -- which is what lets a tool server carry
a reasoner instead of calling one.

The type system earns its place: terms are typed as you build them, so a
malformed query is a compile error rather than a runtime answer of no results,
and the same bundle runs in a browser.

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

- `one` `toArray` `count` `last` `at`: collect
- `take` `drop` `until` `chunk` `unique` `filter`: narrow, lazily
- `some` `every` `find` `exists` `forEach`: decide
- `column` `rows` `toTable`: read answers as a table
- `stream` `timeout` `tap` `orThrow`: control and observe

## What is here

### Node and browsers

The package selects its WebAssembly build for the host.

```ts
import { metta as open, fn as terms } from "tsmetta";

// Node resolves dist/index.js; browser bundlers select browser/index.js.
// npm run build:browser emits the browser bundle.
const runtime = await open();
String(await runtime.eval(terms.add(1, 2)).one()); // "3"
runtime.dispose();
```

### Spaces

Store atoms, update a state cell, or query a TypeScript provider.

```ts
const kb = m.space("&people");
kb.add(S.parent(S.alice, S.bob));
String((await kb.match(S.parent(S.alice, V.child)).one())["child"]); // "bob"
kb.delete(S.parent(S.alice, S.bob)); // true

const cell = m.state(S.rest);
String(cell.set(S.active).value);   // "active"

const scores = m.attach("&scores", {
  *match() { yield S.score(S.ada, 3); }, // candidates; the engine unifies
});
String((await scores.match(S.score(S.ada, V.n)).one())["n"]); // "3"
```

### Definition doors

Lower a function, trace a generator, or call host code from MeTTa.

```ts
const twice = m.define(function twice(n: number): number { return n * 2; });
String(await twice(21).one()); // "42", an engine equation

const colour = m.define(function* colour() { yield S.red; yield S.blue; });
(await colour().toArray()).map(String); // ["red", "blue"], traced clauses

const shout = m.op(function shout(text: string): string {
  return text.toUpperCase();
}, { effect: "pureStructural" });
String(await shout("hello").one()); // '"HELLO"', a host callback
```

### Nondeterminism as async iteration

Taking two answers closes the generator after two emissions.

```ts
const naturals = m.op(function* naturals() {
  for (let n = 0; ; n += 1) yield n;
}, { effect: "pureStructural" });

for await (const answer of naturals().take(2)) {
  console.log(String(answer)); // "0", then "1"; the loop ends
}
```

### Types

A schema publishes declarations that the engine can match.

```ts
const vocabulary = m.schema({ ageOf: "(-> Symbol Number)" });
String(vocabulary.typeOf("ageOf")); // "(-> Symbol Number)"
String((await m.match(S[":"](S.ageOf, V.type)).one())["type"]);
// "(-> Symbol Number)"
```

### Scopes and extensions

Bound a block's evaluation and install a library through the public extension door.

```ts
m.use({ name: "greetings", source: "(= (greet $who) (Hello $who))" });
{
  using budget = m.limits({ inferences: 100_000 });
  String(await m.eval(S.greet(S.world)).one()); // "(Hello world)"
} // the inference bound ends here
```

### Typed atoms

The atom classes expose their fields after TypeScript narrows the value.

```ts
import { type Atom, Expression, type Term, toAtom } from "tsmetta";

const input: Term = S.job(7);
const atom: Atom = toAtom(input);
if (atom instanceof Expression) {
  const children: readonly Atom[] = atom.items;
  children.map(String); // ["job", "7"]
}
// npm run typecheck checks the atom types and their compile-time tests.
```

### Structure without an engine

Unification, one-way matching and alpha-canonical keys are plain functions over
atoms; nothing boots.

```ts
import { alphaEqual, alphaKey, matchTerms, unifies } from "tsmetta/matching";

unifies(S.parent(V.a, S.bob), S.parent(S.tom, V.b));          // true
String(matchTerms(S.parent(V.child, S.bob), S.parent(S.tom, S.bob))?.["child"]);
// "tom", keyed by the pattern's own variable name

alphaEqual(S.f(V.x), S.f(V.y));                               // true
alphaKey(S.f(V.x)) === alphaKey(S.f(V.y));                    // true, one key per shape
```

### Closed sets a typo cannot pass

The engine's own value sets are TypeScript unions, so naming one wrongly is a
compile error rather than a refusal at run time. The members carry the
camelCase-to-hyphen map with them.

```ts
import { Atomicity, EffectClass } from "tsmetta/vocabularies";

Atomicity.atomicSingle;      // "atomic-single", the host spelling mapping to the meaning's
EffectClass.pureStructural;  // "pureStructural"
```

### Errors carry a code, not prose

One base class, one named subclass per condition a caller can act on, and a
stable `code` to match on so the wording stays free to change.

```ts
import { CastError, CompileError } from "tsmetta/errors";

new CastError("planted").code;   // "ERR_METTA_CAST"
CompileError.defaultCode;        // "ERR_METTA_LOWER"
```

Every value above is printed by `examples/subpaths-snippet.ts` and asserted in
`test/gallery.test.ts`, so the page cannot show a call the package does not
have or an answer it does not give.

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

Two waiters can see one candidate; these are the read, delete, and retry steps inside `take`.

```ts
const jobs = m.space("&jobs");
jobs.add(S.job(1));
const options = { signal: AbortSignal.timeout(1_000) };

const waiterA = await jobs.peek(S.job(V.n), options);
String(waiterA["n"]); // "1"; peek leaves (job 1) in the space
const waiterB = await jobs.peek(S.job(V.n), options);
String(waiterB["n"]); // "1"; B sees the same candidate

jobs.delete(S.job(waiterA["n"]!)); // true: A wins (job 1)
jobs.delete(S.job(waiterB["n"]!)); // false: B lost; take must retry

const retryB = jobs.take(S.job(V.n), options);
// No candidate: poll until one arrives or the signal aborts.
// WebAssembly SWI has no library(thread) for an engine-side blocking wait.
jobs.add(S.job(2));
String((await retryB)["n"]); // "2"; B removes (job 2), never returns (job 1)
jobs.size;                  // 0
```

```ts
import { Channel, every, merge, parMap, spawn } from "tsmetta";

// First answer wins; the other branches are cancelled through their signals.
String(await m.race([m.eval(1), m.eval(2)])); // "1" or "2"

// Bound host operations in flight and preserve input order.
(await parMap([1, 2], (n) => m.eval(fn.add(n, 10)).one(), { concurrency: 2 }))
  .map(String); // ["11", "12"]
const both = merge(m.eval(1), m.eval(2));
(await both.toArray()).map(String); // both answers, in arrival order

const mailbox = new Channel<number>({ max: 1 });
await mailbox.send(1);
const pending = mailbox.send(2); // waits while the mailbox is full
await mailbox.receive();        // 1; the waiting sender can proceed
await pending;
await mailbox.receive();        // 2
mailbox.close();

const task = spawn(m.eval(fn.add(1, 2))); // starts now; task.cancel() stops it
(await task).map(String);               // ["3"]
const controller = new AbortController();
for await (const count of every(1_000, () => jobs.size, { signal: controller.signal })) {
  console.log(count); // 0
  controller.abort(); // stops the next repetition
}
// Awaited host I/O can overlap.
// Pure reductions interleave on one engine.
```

### Public subpaths

Every code-module entry point the package exports, which is what
`package.json`'s own exports map says rather than a list kept here.

| Subpath | What it is |
|---|---|
| `tsmetta/algebra` | Weighted answers: `counting`, `tropical`, `prob`, `prov`, `ranked`, and `TaggedAnswer.under` |
| `tsmetta/ambient` | One lazily booted engine behind free functions, so a first program needs no setup line: `add`, `define`, `evaluate`, `engine`, `catalog`, `loadFile` |
| `tsmetta/arrays` | Typed arrays, `Tensor`, `EmbeddingStore`, and `installArrays` |
| `tsmetta/atom` | The atom algebra: one interned immutable value per MeTTa atom, narrowing by `instanceof`, printing as MeTTa text. `Expression`, `Grounded`, `FloatAtom`, `Sym`, `SpaceHandle`, `ATOM_OF` |
| `tsmetta/browser` | Fetch, validate and compile a browser runtime once per root: `prepareRuntime`, `mountInto`, `runtimeVersion`, `forgetRuntime` |
| `tsmetta/config` | The process-wide settings the engine and the presentation layer read, and the one place an operator sets them: `config`, `Setting`, `Settings` |
| `tsmetta/convert` | `registerType`, `project`, `build`, and `autoImage` |
| `tsmetta/derivation` | One proof of one answer, as data: the equations that fired, the stored atoms they rested on, and the goals the walk could not see inside. `derivationOf`, `ProofNode`, `Step`, `Fact`, `Truncated`, `readable` |
| `tsmetta/errors` | The error family: one base class carrying a stable machine-readable `code`, one named subclass per condition a caller can act on. `EngineError`, `CompileError`, `CastError`, `CapabilityError`, `ClosedError`, `Code` |
| `tsmetta/events` | A fold over a space's writes: a standing query that carries state, steps once per matching write, and is itself readable. `fold`, `EventStream`, `publish`, `stream`, `STATELESS` |
| `tsmetta/integrate` | `integrate`, `discover`, `entryPoints`, and reflection helpers |
| `tsmetta/lint` | `RULES`, `Finding`, `lint`, and `lintFile` |
| `tsmetta/manifest` | `boot`, `Boot`, and `VOCABULARY` |
| `tsmetta/matching` | The structural operations over atoms that need no engine at all: `unifies`, `matchTerms`, `alphaEqual`, `alphaKey`, `alphaCanonical`, `isGround`, `renameVariables` |
| `tsmetta/parallel` | The coordination verbs, spelled with the platform's own concurrency rather than the engine's: `race`, `merge`, `parMap`, `spawn`, `every`, `Channel`, `Task` |
| `tsmetta/paths` | `Path`, `path`, `reach`, and `installPaths`; the engine calls a registered operation instead of lifting a marker from a pattern |
| `tsmetta/provider` | A space whose atoms live in TypeScript, answering match, add, remove and enumeration for a named space: `CAPABILITIES`, `CUSTOM_MATCH`, `Adder`, `BulkAdder`, `Enumerable`, `BoundedMatcher` |
| `tsmetta/random` | One deterministic pseudo-random source, shared by everything here that draws: `Random` |
| `tsmetta/remote` | `connect`, `serve`, `RemoteSpace`, and `Gateway` |
| `tsmetta/saga` | Record what a sequence of effectful steps committed, and undo it in reverse by the compensations the program declared: `saga`, `Saga`, `compensates`, `compensations` |
| `tsmetta/seam` | This seat's one extension seam, the seat-level twin of `engine/ext_points.pl` and of `metta.seam` on the Python seat: `GROUP`, `KINDS`, `Point`, `Declaration`, `Claim` |
| `tsmetta/spaces` | Space views and combinators, every one an ordinary `SpaceProvider`: a live `Map` becomes queryable and two spaces read as one. `view`, `union`, `overlay`, `diff`, `mapped`, `objectView`, `readOnly` |
| `tsmetta/strategies` | The rewriting strategies the engine's strategy library reifies, so a plan is built in TypeScript and then stored, queried, serialised and applied: `Id`, `Fail`, `Seq`, `Choice`, `All`, `One`, `Repeat`, `BottomUp`, `Innermost` |
| `tsmetta/structures` | `TabledMap`; tables are query-local because swipl-wasm has threads disabled, so forms within one `run()` reuse and later jobs recompute |
| `tsmetta/subscribe` | Standing queries: a pattern, a space, and something that happens every time an atom matching it arrives or leaves. `subscribe`, `Subscription`, `LiveView`, `Event` |
| `tsmetta/tables` | `tableSpace`, `arrayTables`, and `bridge` |
| `tsmetta/testing` | Generate atoms, check properties over them, and hold a space implemented in TypeScript to the contract the engine expects of one: `atoms`, `forAll`, `booleans`, `Arbitrary` |
| `tsmetta/tokens` | Reader classes of the host's own: a full-token regex and the JavaScript function that turns a matching lexeme into an atom. `registerToken`, `unregisterToken`, `tokens`, `construct` |
| `tsmetta/version` | The version this package declares, read from its own manifest: `version` |
| `tsmetta/vocabularies` | The engine's own closed value sets as TypeScript unions, so a program that names one names it exactly and a typo is a compile error: `VOCABULARIES`, `EffectClass`, `OpKind`, `SpaceCapability`, `isValueOf`, `effectRank` |
| `tsmetta/wire` | The codec between MeTTa atoms and the tagged wire terms the engine reads and writes, in both directions and at both strictnesses: `Wire`, `Tag`, `Transport`, `atomFromWire`, `decodeEngine` |

## Verify

```sh
npm test          # the suite
npm run typecheck
npm run kit       # the conformance corpus, compared against the Python seat
```

`llms.txt` beside this file is the full cheat sheet, and the repository root's
covers the language and every other surface.

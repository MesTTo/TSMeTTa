# MeTTa in TypeScript, on the MeTTa Kernel engine

The MeTTa Kernel engine runs inside a Node process here, in that process rather than
behind a socket, over [swipl-wasm](https://github.com/SWI-Prolog/npm-swipl-wasm)
8.0.6, which is the SWI-Prolog organisation's own WebAssembly build of SWI
10.1.13. There is nothing to install besides npm packages: no SWI on the
machine, no compiler, no shared library.

TypeScript is the notation and MeTTa is the meaning. Every door here either
builds a term or asks the engine one, and nothing on this side re-implements
matching, rewriting or nondeterminism.

```sh
cd extensions/node
npm ci        # fetches swipl-wasm and builds the TypeScript
npm test
```

```ts
import { metta, S, V } from "./extensions/node/src/index.ts";

const m = await metta();

m.add(S.parent(S.tom, S.bob), S.parent(S.bob, S.ann));

for await (const { child } of m.match(S.parent(S.tom, V.child))) {
  console.log(String(child));            // bob
}
```

## Atoms

An atom is an interned, frozen value, so `===` is structural and `Set`, `Map`
and `includes` are structural with it, without any of them being
reimplemented:

```ts
S.parent(S.tom, S.bob) === S.parent(S.tom, S.bob);   // true
new Set([S.a, S.a]).size;                            // 1
```

`S` mints symbols, `V` variables, `G` lifts a host value, `_` is the anonymous
variable, and `fn` is the operation vocabulary. Applying a name builds an
expression; a bare name is the symbol:

```ts
S.parent            // the symbol `parent`
S.parent(S.tom)     // the expression `(parent tom)`
V.x                 // `$x`
G(new Date())       // a live host value, by reference
[S.parent, S.tom]   // an array in term position IS an expression
```

`instanceof` narrows: `Sym`, `Var`, `Grounded`, `Expression`, `SpaceHandle`.
`String(atom)` renders MeTTa text and so does a template literal, while
`atom + 1` and `atom == "f"` REFUSE, because there is no answer to those that
is not a wrong one.

### Names, and the one map

A TypeScript identifier reaches the meaning layer through TypeScript's own
casing, so `S.carAtom` is `car-atom` and `function balanceOf` installs
`balance-of`. The map fires only on a plain lowerCamelCase identifier, so
`S.Number`, `S.StateMonad`, `S["%Undefined%"]`, `S["prime?"]` and
`S["car-atom"]` are every one of them exactly themselves. `V` is exact,
because a variable's name is the key you destructure an answer by.

An operator's head is punctuation, which no casing map reaches, so `fn`
consults an operator table first: `fn.add` is `+`, `fn.gte` is `>=`. Those are
the same words the free functions export, so `fn.gte(a, b)` and `gte(a, b)`
name one head by construction.

## Answers

An ask is a lazy description. Nothing runs until something consumes it.

```ts
const ans = m.match(S.parent(V.x, S.bob));   // nothing has run
for await (const { x } of ans) { ... }        // one answer at a time
const rows  = await ans;                      // the whole answer set
const who   = await ans.one();                // exactly one, or a refusal
const maybe = (await ans.find()) ?? S.none;   // at most one, so ?? composes
ans.take(5).map(({ x }) => S.seen(x));        // lazily, and nothing has run yet
```

`await` executes and collapses, which is where Drizzle and Kysely put
execution; it is the platform's own promise protocol rather than an invented
`.all()`. One fence: returning an `Answers` from an `async function` awaits it
implicitly, so the lazy handle does not survive an async return.

Leaving a `for await` early closes the cursor and destroys the engine behind
it, so an unbounded generator is safe to walk:

```ts
m.run("(= (from $n) (superpose ($n (from (+ $n 1)))))");
for await (const answer of m.eval(S.from(1))) {
  if (Number(hostValue(answer)) === 5) break;   // the sixth is never computed
}
```

A deadline goes in the options position and is the platform's own:

```ts
await m.eval(term).until(AbortSignal.timeout(50));
```

Cancellation is checkpoint-granular: the engine is asked to stop between
answers, so a single very long reduction runs to its next answer before it
notices. That is `fetch`'s own contract, said plainly.

## Spaces

A space is a collection, and it means by `add`, `delete`, `has`, `size` and
`clear` what `Set` means by them:

```ts
const kb = m.space(S.kb);
kb.add(S.parent(S.tom, S.bob));      // answers the space, as Set.add does
kb.has(S.parent(V.x, S.bob));        // true; a pattern asks the same question
kb.delete(S.parent(S.tom, S.bob));   // answers whether anything went
kb.size;
for await (const atom of kb) { ... } // its stored atoms, unevaluated
```

`kb.match(pattern)` answers ROWS keyed by the pattern's own variable names, in
first-seen order; `kb.match(pattern, template)` answers the template's
instances, evaluated, which is MeTTa's own reading of the third argument of
`match`.

`kb.eval(term)` reduces a term IN this space, which is the engine's own
`evalc`: the space's equations are the ones in force and its model is the one
that applies.

A space is named by an ATOM, so a parametric space is a handle like any other:
`m.space(S.cache(primary, 100))` names one space per parameter set, and a
program reads its own parameters back by matching the name. A name and creation
OPTIONS compose freely, which the Python side records as a gap it wanted
closed:

```ts
const locked = m.space(S.locked, { grants: [] });
locked.add(m.parse("(= (double $x) (* $x 2))"));
await locked.eval(S.double(21)).one();          // 42: ordinary computation stays
await locked.eval(S.exists_file("x")).toArray();
//  &locked cannot run exists_file because its restricted base does not publish
//  the file capability; grant it explicitly when the space is created

const reader = m.space(S.reader, { grants: ["file"] });   // and now it runs
```

`kb.readsThrough(parent)` declares that a space reads its parent's atoms and
writes its own, which is what a world rides on.

## The three doors

### define, from a plain body

A plain function's own source is LOWERED into one equation. The whole body
lives in the engine afterwards, so a call costs no host crossing at all:

```ts
function findDivisor(n: number, d: number): number {
  if (d * d > n) return n;
  if (n % d === 0) return d;
  return findDivisor(n, d + 1);
}
const divisor = m.define(findDivisor);
// (= (find-divisor $n $d)
//    (if (> (* $d $d) $n) $n (if (== (% $n $d) 0) $d (find-divisor $n (+ $d 1)))))
```

The body is real TypeScript, so `findDivisor(91, 2)` still answers `7` in
TypeScript, its types check, and a second definition names it as an ordinary
identifier:

```ts
const isPrime = m.define(function isPrime(n: number): boolean {
  return n === findDivisor(n, 2);
}, { name: "prime?" });

await isPrime(53537257).one();       // True
```

`===` becomes the engine's `==`, `%` becomes `%`, and the recursion becomes a
call. A construct with no MeTTa meaning refuses at DEFINITION time, naming
both the construct and the remedy; a free name nothing defines refuses the
same way, which is what makes a minified build say so instead of building a
term out of `t` and `n`.

The parser is [acorn](https://github.com/acornjs/acorn), never the `typescript`
package: TypeScript 7 ships no Strada API, so `ts.createSourceFile` is absent
there. Types are erased before `Function.prototype.toString()` ever runs, so
what is parsed is always plain ECMAScript.

### define, from a generator body

A generator body is TRACED once with symbolic arguments. `yield*` ASKS a goal
and `yield` EMITS an answer, and each spelling has exactly one meaning
wherever it appears:

```ts
const grandparent = m.define(function* grandparent(x: Term) {
  const { y } = yield* m.match(S.parent(x, V.y));
  const { z } = yield* m.match(S.parent(y, V.z));
  return z;
});
// (= (grandparent $x) (match &self (parent $x $y) (match &self (parent $y $z) $z)))
```

A conjunction of goals IS a nest of matches in MeTTa, because each one's
template is the rest of the body. Several emissions are several clauses, each
under the goals asked above it:

```ts
const descendants = m.define(function* descendants(x: Term) {
  const { c } = yield* m.match(S.parent(x, V.c));
  yield c;                    // a child is a descendant
  yield S.descendants(c);     // and so is every deeper one
});
// (= (descendants $x) (match &self (parent $x $c) $c))
// (= (descendants $x) (match &self (parent $x $c) (descendants $c)))
```

Recursion inside a traced body is a MENTION, `S.descendants(c)`, not a call: a
named function expression binds its own name to the generator function, and
the const being defined is still in its temporal dead zone. That is the
mention law said twice: `S.f()` builds the term, `f(...)` asks. A LOWERED body
needs no such care, because its own source is read.

A body that branches on a symbolic binding refuses at definition time, naming
both remedies: write the comparison as a term (`If(gt(x, 0), ...)`), or define
the body as a plain function so its own source is lowered, where a real `if`
works.

### op, for host code the engine calls

```ts
const nowMs = m.op(function nowMs(): number { return Date.now(); },
                   { effect: "oracleIO" });
```

A plain body answers once. A GENERATOR body is nondeterminism from JavaScript,
pulled one answer at a time, so an unbounded generator is usable. An ASYNC
body, or an async generator, is awaited between the engine's ask and its
answer:

```ts
m.op(function* upto(n: number) { for (let i = 1; i <= n; i += 1) yield i; },
     { effect: "pureStructural" });
m.op(async function fetchJson(url: string) { return (await fetch(url)).json(); });
```

An operation declares the WEAKEST effect class that is honestly true of it,
out of `pureStructural`, `readOnlyLookup`, `nondeterministicReadOnly`,
`writesState` and `oracleIO`. An unstated one is `oracleIO`, which is the
fail-closed reading. `{ raw: true }` hands the body ATOMS instead of values,
for a body that looks at structure.

`G(x)` crossing into the engine and back answers `x` ITSELF (`===`).

## Scopes

Resource-shaped constructs take `using`:

```ts
{
  using _ = m.limits({ stack: 1_000_000 });
  using s = m.stats();
  await m.eval(term);
  console.log(s.inferences, s.crossings, s.replays);
}
```

Inferences are the engine's own counter: deterministic, transport independent.
Crossings are this transport's N+1 counter, one per host-to-engine round trip,
so a lowered body costs none per call and a live operation costs its yields.

`using` is a Node 24 syntax (Node 22's V8 rejects it, though it does carry
`Symbol.dispose`). On Node 22, compile, or call `.release()` and
`[Symbol.dispose]()` directly; the objects themselves work either way.

### Worlds

A world is a DRAFT: claim, try, then commit or restore.

```ts
const w = m.world(todos);
w.add(S.todo(id, text));
try { await api.save(todo); w.commit(); } catch { w.restore(); }
```

Adds land in a child space the engine makes read through the parent, so a
query inside the world sees the parent's atoms and the draft's together.
Removals are journalled on this side, because a child cannot un-see its
parent's atom, and applied when the world commits, inside ONE engine
transaction. `restore()` is free, because the parent was never touched.

**The one thing to know:** between `w.remove(a)` and `w.commit()`, a query made
OUTSIDE the world still sees `a`. The world's own `match`, `has` and `atoms`
honour the journal.

A world cannot be an SWI transaction held open across host calls, because
`engine_yield/1` cannot unwind through the nested query frame `transaction/1`
opens; `m.speculate(term)` is the door for the engine's own discarded
execution scope, for a plan the engine runs by itself.

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
`@grounded` and `@tabled` narrow that to the marked ones, for a class that also
carries helpers, and they compose. They need a BUILD, though: TypeScript
compiles Stage-3 method decorators and V8 has not shipped them, so a decorated
class does not run under Node's own type stripping. The unmarked form runs
everywhere.

## Coordination

```ts
const row = await jobs.take(S.job(V.n), { signal: AbortSignal.timeout(50) });
```

`peek` waits until a matching atom is there and leaves it; `take` removes one.
There is no engine-side blocking wait (`take-atom` needs `library(thread)`,
which a WebAssembly SWI does not have), so these poll, bounded by the signal.
The take is still a take rather than a race: the read and the removal are two
synchronous engine calls with nothing between them, and this host is
single-threaded.

`m.race([a, b])` answers the first branch and cancels the rest through their
signals; `Promise.any` is the platform's word for it, with the cancellation
wired.

## Live queries

```ts
for await (const { edge, atom } of kb.watch(S.todo(V.id, V.state))) { ... }
```

Admissions are the engine's own atom events, queued and drained. There is no
engine-side blocking wait, because a WebAssembly SWI has no `library(thread)`,
so this polls the queue; `{ pollMs }` sets the interval and an `AbortSignal`
ends it.

## Vocabulary

```ts
const kb = m.schema({
  parent: "(-> Symbol Symbol %Undefined%)",
  ageOf:  "(-> Symbol Number)",
});
```

One writing, three realms: the TypeScript type, the runtime term, and the
engine-side declaration all come from the same object literal. A declared name
takes the same casing map as every other vocabulary door, so `ageOf` installs
`age-of`.

The `decodeWith` door speaks [Standard Schema](https://standardschema.dev), so
Zod, Valibot, ArkType, TypeBox, Yup and Joi all validate an answer with no
runtime dependency added here.

## Libraries

A library installs in BOTH realms through one call, and is DATA once it is
here:

```ts
m.use({ name: "greetings", source: "(= (greet $who) (Hello $who))",
        grants: ["network"], vocabulary: ["greet"] });

await m.catalog.match(S.library(V.name, V.version));   // what is loaded
```

A library declares the capabilities it needs, so a restricted space refuses it
by grant, and one that cannot find its own artifact refuses loudly rather than
failing later somewhere else.

## Numbers

JavaScript has ONE number type and MeTTa has two, so the crossing has to
choose, and the choice is stated rather than left to chance.

The distinction lives in the ATOM CLASS. `G(42)` is the integer `42` and
`float(42)` is the float `42.0`; they are different atoms and both hold the
JavaScript number `42`. `G(1.5)` and `float(1.5)` are the SAME atom, because a
number with a fraction is already a float. A `bigint` is always an integer,
however large, and an integer past the exactly-representable range stays one.

`(== 2 2.0)` answers **True**: numeric equality is by VALUE across the
integer/float constructors, following LeaTTa's `Ground.equiv`. What tells them
apart is IDENTITY, which is what a codec has to preserve:

```
!(=alpha 2 2.0)                      False
!(case 2 ((2.0 float) ($_ other)))   other
!(subtraction-atom (2 2.0) (2))      (2.0)
```

The one thing this host has no type for is a rational, and it says so:

```
the number 1r3 has no JavaScript type; a rational crosses as its Prolog
spelling and this host has nothing to hold it in
```

## Errors are data, and interruption is opt-in

MeTTa answers an ERROR ATOM per failing branch and keeps the successful
branches beside them, which is what makes an error data: a program may match
on one, count them, or ignore them.

```ts
const answers = await m.eval(Superpose([S.bad(1), S["+"](1, 1)]));
answers.filter(isError);       // one (Error (car-atom ()) "...")
answers.filter((a) => !isError(a));   // the 2
```

`orThrow()` is the door for a caller who would rather be interrupted. One
failing branch raises its own error; several raise the platform's own
`AggregateError`, with one entry per branch, each carrying its error atom as
`cause`, so reporting a failure never loses the data:

```ts
try {
  await m.eval(term).orThrow();
} catch (e) {
  if (e instanceof AggregateError) console.log(e.errors);
}
```

## Nothing reaches your console

An embedded engine that prints is printing over whatever the host was saying,
so this one does not. A program's own `println!` is buffered and
`m.drainOutput()` hands it over; an engine error is raised as a `MettaError`
carrying the engine's own message, never written out. Pass
`metta({ verbose: true })` when you want the engine's trace.

That took work rather than being free: swipl-wasm writes every Prolog
exception to the console before handing it back, and offers no switch, so
`bridge.pl` catches inside the engine and the outcome crosses as data.

Every refusal carries a stable `code`, so a test or a tool matches the code
and the prose stays free to improve: `ERR_METTA_ENGINE`, `ERR_METTA_WIRE`,
`ERR_METTA_ABSENT`, `ERR_METTA_AMBIGUOUS`, `ERR_METTA_NAME`,
`ERR_METTA_CAPABILITY`, `ERR_METTA_TRACE`, `ERR_METTA_LOWER`,
`ERR_METTA_CLOSED`, `ERR_METTA_UNSUPPORTED`.

## How a host operation reaches JavaScript

Through SWI's own engine coroutine, not through `library(wasm)`'s `:=`.

A goal running inside an SWI engine `engine_yield/1`s a host-call request to
`engine_next/2`; this side computes the answer, `engine_post/2`s it back, and
the goal resumes. That is the shape Lua takes for a host call and the shape
Emscripten's Asyncify takes for a suspension. It needs no globals, no `eval`
(so it is CSP-clean, which the browser target requires), and it lets the host
`await` between the ask and the answer, which is what makes an async operation
ordinary here.

`library(wasm)`'s `:=/2` is present in this build and unusable from Node: its
JavaScript half starts every chain with `obj = obj || window`, a bare
identifier, so every call raises `ReferenceError: window is not defined`.
Defining `globalThis.window` after boot does work, and would make every
browser-detecting package in the host process believe it is in a browser, so
it is refused here.

## What this build does not carry

Four platform libraries are absent from a WebAssembly SWI and there is no
substitute for any of them, so the capabilities that rest on them are absent
too. `metta()` reports them on `m.refusals`, each with what it costs, and
**raises on any refusal it does not name**, so an absence cannot creep in
quietly:

| missing | in | costs |
|---|---|---|
| `library(thread)` | `engine/metta.pl` | `concurrent_maplist`, so `jobs/2`. The build is single-threaded. |
| `library(time)` | `engine/metta.pl` | `alarm/4`, so `metta_timeout/2`. An `AbortSignal` bounds the pull from this side instead. |
| `library(process)` | `engine/metta.pl` | subprocess operations; a WebAssembly instance has none to start. |
| `library(process)` | `lib/lib_gitimport/lib_gitimport.pl` | `import!` from git, which shells out. |

Everything else loads. Tabling is present, `library(sha)` is present, and the
engine parses, translates and evaluates end to end.

## What the binding calls

Only published surface. `bridge.pl` is this binding's Prolog half and every
engine predicate it calls carries an `seam:kind/2` in `engine/ext_points.pl`
as a `service` or a `host_service`, or is a MeTTa builtin that `builtin_fun/1`
enumerates. That is checked rather than promised:
`tests/prolog/static_checks.pl`'s
`a_host_binding_calls_only_published_surface` walks every host transport with
SWI's own `prolog_walk_code/1`, so a call that reaches an internal fails the
gate naming the pair.

## The conformance kit

The binding is held to the codec twice, and the two answer different
questions.

`kit/driver.ts` exposes it as one `CodecDriver` for the golden corpus at
`tests/codec/corpus.json`, which is the grammar's authority. A whole binding
runs every leg the kit has: it reads MeTTa source, prints through the engine's
own writer, round trips an atom, and runs programs.

`kit/corpus.json` and `kit/run.ts` answer the other question. They record cases
and never answers, because
`extensions/python/tests/ch21_another_language_at_the_seam/test_node_binding.py`
runs the same programs through the shipped Python host in the same moment and
compares the two. A codec can satisfy a written-down grammar and still disagree
with the engine beside it, and that is what this half would catch.

```sh
npm run kit | head -40
```

## Running the suite

| command | what it runs | needs |
|---|---|---|
| `sh build.sh` | `npm run build` | npm |
| `sh test.sh` | typecheck, then the whole suite | npm |
| `sh bench.sh` | every benchmark case against its pins | npm, a Python with `metta.testing`, perf |
| `npm test` | compiles, then `node --test build/test/*.test.js` | any Node 22.18+ |
| `npm run test:source` | `node --test test/*.test.ts` | a Node with type stripping, and Node 24 for `using` |
| `npm run typecheck` | both tsconfigs | |
| `npm run kit` | the live-host comparison report | |

The first three are the ones the gate runs, so a developer and `check.sh` call
one thing rather than two that can drift. None of them fetches or builds what a
step above them makes: each says which command is missing and exits 0, because
a gate that reaches the network fails for a reason that is not the tree.

`npm test` compiles rather than type-stripping because a distro Node is often
built without TypeScript support (`node -p
process.config.variables.node_use_amaro` answers false on Debian and Ubuntu),
and a gate that only ran on the official build would not run on the machine
that most needs it.

## What the surface costs

`sh bench.sh` measures six workloads and holds each to a committed pin in
`benchmarks/baseline.json`. The comparison, the bands and the re-pin belong to
the shared harness in `extensions/python/metta/benchmarking.py`, so one
baseline format and one regression protocol cover every component.

Which counter decides is a property of the case, not a policy:

| case | what it does | decided by |
|---|---|---|
| `atom-intern` | 20,000 interned expressions, each minted twice | `instructions:u` |
| `wire-roundtrip` | 50,000 atoms out through the codec and back | `instructions:u` |
| `query-rows` | 2,000 rows asked and drained through `await` | inferences |
| `answers-lazy` | 20 of those 2,000 rows, abandoned, fifty times | inferences, pinned at 0 |
| `define-call` | 500 calls of a lowered `define`d body | inferences |
| `host-op` | 2,000 yields of a generator `op` the engine pulls | inferences |

Inferences decide wherever the engine does the work, because they are
deterministic where wall clock is not: the four inference rows read the same
number in all nine samples of three consecutive runs, on a box under load,
while wall clock moved several percent over the same runs. Where the work is on
this side of the wire the engine's counter cannot move at all, so retired
instructions decide instead, and the three rows that straddle the boundary pin
both because each counter sees one half.

`answers-lazy` is the interesting one. bridge.pl reports what a job spent as
that job's LAST event, reached only once the command has no more answers, so an
abandoned job reports nothing: its inference pin of zero is a statement that
the ask really was abandoned, and a lazy path that quietly began draining would
report `query-rows`' 282,622 and fail by four orders of magnitude. Its size is
`instructions:u`, since a counter fixed at zero cannot say whether twenty rows
cost twenty rows' work or two thousand.

A Node process is not deterministic enough to gate on retired instructions
without help, so the instruction rows run under `--predictable
--predictable-gc-schedule --liftoff-only` and the baseline's configuration
stamp records them. Bare, one engine workload spreads 29% across four rounds;
`--liftoff-only` alone takes it to 2.6%, which names the mechanism as TurboFan
tiering swipl-wasm up on background threads part way through the window, and
the full set reaches 0.03%. Those rows therefore measure Liftoff-compiled
WebAssembly rather than the tier a long-lived process settles into, which is
the right trade for a gate that reads the change rather than the absolute.

```sh
sh bench.sh                       # every case against its pins
sh bench.sh query-rows host-op    # two of them
sh bench.sh --update              # re-pin, after reviewing the workload
```

## Layout

| file | what it is |
|---|---|
| `src/atom.ts` | the interned atom algebra, its printing and its order |
| `src/wire.ts` | the tagged codec, at both strictnesses |
| `src/engine.ts` | boot, the job pump, and host-operation dispatch |
| `src/answers.ts` | the lazy, thenable, async-iterable ask |
| `src/space.ts` | a space as a collection, and its query doors |
| `src/metta.ts` | the surface: the doors, the scopes, the reflection verbs |
| `src/define/lower.ts` | a plain body, lowered from its own source |
| `src/define/trace.ts` | a generator body, traced into clauses |
| `src/define/define.ts` | the three definition doors |
| `src/words.ts` | the word door, the control forms, the case tower |
| `src/scopes.ts` | limits, stats and worlds, through `using` |
| `src/schema.ts` | the vocabulary door and Standard Schema interop |
| `src/library.ts` | the extension tier |
| `src/state.ts` | a state cell |
| `src/types/sexpr.ts` | MeTTa text, read at the type level |
| `bridge.pl` | the Prolog half: the codec, the job pump, the host-op trampoline |
| `test/*.test.ts` | `node --test` |
| `kit/` | the conformance kit, both halves |
| `example/` | the programs the README and the tests run |
| `benchmarks/cases.ts` | the six workloads, and which counter decides each |
| `benchmarks/sampler.ts` | one sample, with setup outside perf's window |
| `benchmarks/run.ts` | the command line the Python driver and a reader use |
| `benchmarks/bench.py` | the driver over the shared `BenchmarkBaseline` |
| `benchmarks/configuration.py` | the stamp a pin refuses to compare across |
| `benchmarks/baseline.json` | the committed pins |
| `build.sh`, `check.sh`, `test.sh`, `bench.sh` | the component contract |

## A note on TypeScript versions

The package is built with TypeScript 6. Under 5.9, `for await` over an ask
sometimes resolves to the yieldable protocol's synchronous iterator rather
than the async one, and reports that a bound name does not exist on
`GoalRequest`. TypeScript 6.0.3 resolves it correctly, and the design this
follows targets TS 6/7 semantics anyway. The runtime is unaffected: `for await`
prefers `Symbol.asyncIterator` in every engine.

A consumer with `noUncheckedIndexedAccess` on will see `S.parent` typed as
`Name | undefined`, because the ambient factories spell any name through an
index signature. Declaring vocabulary with `m.schema(...)`, or using the call
door `S("parent")`, is exact under either setting.

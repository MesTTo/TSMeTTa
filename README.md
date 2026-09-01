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

The package carries `"private": true`, and a `prepublishOnly` hook that reads
it and exits nonzero. That is a pre-release guard and not a decision about the
registry: this repository is private until it is made public, and everything
goes public together on that day, at which point the line comes out and
`npm install metta-node` is the whole install.

The hook exists because npm's own guard cannot be demonstrated. npm is
documented to refuse a private package, but measured 2026-08-29,
`npm publish --dry-run` on one prints `Publishing to
https://registry.npmjs.org/` and lists the tarball, because the dry run
simulates the pack and skips the preflight. `node tools/refuse-early-publish.mjs`
is the same refusal in a form that can be run on demand, and it keys off the
same flag, so removing that one line lifts both.

Until then the package installs from a tarball, which is a supported path and
the one this seat's tutorial documents:

```sh
cd extensions/node && npm pack      # writes metta-node-<version>.tgz
npm install /path/to/metta-node-<version>.tgz
```

`npm pack` runs `tools/bundle-runtime.mjs` first, which copies the engine into
the tarball, and removes it again afterwards. Without that a published package
would carry the bridge and not the engine it drives.

`dist/` is a build product, not a checked-in one: `npm run build:dist` writes
it and npm's `prepare` hook runs that on install. Import `src/` as below while
working in this checkout, or build first: a `dist/` older than the `src/`
beside it is a copy of an older codec, and the seat's own suites never load it
because they compile source into `build/`. `sh check.sh node-dist` builds it
and runs a consumer through the result.

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
new Set([S.a.atom, S.a.atom]).size;                  // 1
```

A BARE name is the exception, and it is worth knowing once. `S.a` answers a
fresh callable proxy on every access, because the same name has to work both
as a symbol and as the head of an expression, so `S.a === S.a` is `false`. The
atom under it is interned like any other, which is what `.atom` reaches and
why the line above says `S.a.atom`. Anywhere an atom is what you mean, ask for
it.

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

The language-level `remove-atom` drains every unifying occurrence and answers
`true` even when none existed. `delete` is deliberately the host collection
door instead: it removes one occurrence and reports whether one was present,
which keeps its `Set.prototype.delete` contract distinct from MeTTa's coarser
operation.

`kb.match(pattern)` answers ROWS keyed by the pattern's own variable names, in
first-seen order; `kb.match(pattern, template)` answers the template's
instances, evaluated, which is MeTTa's own reading of the third argument of
`match`.

A variable the SOURCE did not name gets one minted for it, and that name is an
identity: one cell spends one name however often it occurs, two cells never
share one, and two separate answers never reuse a name, so putting them in one
expression cannot silently share a variable. It used to be the cell's address
in the engine's stack, which moves under a collection and is handed on
afterwards [C54].

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

await isPrime(53537257).one();       // true
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

The rest of the family is the platform's own concurrency, because the engine's
is absent from this build:

```ts
import { Channel, every, merge, parMap, spawn } from "metta-node";

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

## Live queries

```ts
for await (const { edge, atom } of kb.watch(S.todo(V.id, V.state))) { ... }
```

Admissions are the engine's own atom events, queued and drained. There is no
engine-side blocking wait, because a WebAssembly SWI has no `library(thread)`,
so this polls the queue; `{ pollMs }` sets the interval and an `AbortSignal`
ends it.

## Standing queries

```ts
using watch = subscribe(kb, S.alarm(V.what), {
  onEvent: ({ edge, atom }) => console.log(edge, String(atom)),
});
```

A subscription is a resource: leaving its block ends it, and so does
`unsubscribe()`. Without a handler the events queue and `drain()` empties the
queue; a queue nobody drains REFUSES past `queueMax` rather than discarding the
oldest, because a dropped event is a wrong answer nobody is told about.

`LiveView` is the same machinery kept as a count:

```ts
await using alarms = await LiveView.open(kb, S.alarm(V.what));
alarms.size;                    // seeded once, then kept current
alarms.count(S.alarm(S.fire));  // multiplicity, because a space is a multiset
```

## Spaces implemented in TypeScript

A space's atoms can live wherever you keep them: a `Map`, an array, a SQL
table, an HTTP service. The engine queries it like any other space.

```ts
const rows = new Map([["ada", 3]]);
const scores = m.attach("&scores", rows);          // a live view, one line
rows.set("bob", 5);                                // no publication step
await scores.match(S.kv(V.who, V.n));              // both rows
```

For anything with a shape of its own, implement only what the backend has:

```ts
const table: SpaceProvider = {
  *match(pattern) { /* yield CANDIDATES; the engine unifies */ },
  add(atom) { ... },
};
m.attach("&table", table);
```

Capabilities are DERIVED from the methods present, so a provider that cannot
remove is refused a removal by name rather than failing silently, and its own
`refusal(capability)` sentence reaches the caller. Subscribability is the one
thing not derived: a provider says what its change events promise through
`delivers()`, because whether a store can emit them is a fact about the store
and not about its method list.

Yielding every atom is always correct; yielding fewer than match is never
allowed to be. Pushing the bound parts of a pattern into the backend is the
performance lever, never a correctness requirement.

`metta-node/testing` carries the conformance suite for one:

```ts
const results = await checkSpaceProvider(space, provider, [S.kv(S.ada, 3)]);
```

## The space algebra

Every combinator is an ordinary provider, so each composes with the last and
attaches like any other.

```ts
import { diff, mapped, objectView, overlay, readOnly, union, view } from "metta-node/spaces";

m.attach("&all", union(kb, rules));            // read as one; writes refused
m.attach("&safe", readOnly(kb));               // reads only
m.attach("&draft", overlay(front, kb));        // ChainMap's rule: writes hit front
m.attach("&edges", mapped(kb, bridge));        // one declaration, both directions
await diff(a, b);                              // how they differ, as multisets
```

`union` and `readOnly` implement no write method at all, so the refusal a write
meets is the ENGINE's own capability error rather than a check written in
TypeScript.

## Proofs

```ts
const proof = await m.why(S.quad(3));
console.log(String(proof));
//  (quad 3) = 12
//    (quad 3) = 12
//      by (= (quad $a) (dbl (dbl $a)))
//      (dbl 3) = 6
//        by (= (dbl $a) (* 2 $a))
//        builtin *(2,3,6)
```

`m.derivation(target)` answers every proof and `m.why(target)` the first. Each
node is a discriminated union on `kind` (`step`, `fact`, `builtin`,
`truncated`), so a `switch` over one is exhaustive and TypeScript proves it.
`proof.rules` and `proof.facts` are what a reader usually wants first, and
`complete` is false exactly when a depth budget cut the walk short, so an empty
answer set and a truncated proof never read alike.

## Asking the engine about itself

```ts
m.doc(S.area);                   // the (@doc ...) atom it holds
m.solve(4, sub(V.x, 1));         // { x: 5 }: the relation, backwards
m.cast(S.Ann, S.Person);         // narrowed, or CastError naming its real types
m.forms(source);                 // every top-level form, read and not run
m.trace("!(quad 3)");            // the engine's own call and exit events
m.disassemble("dbl");            // the Prolog clauses the name compiled to
m.runStatus(source);             // per directive: value, not-reducible, empty
m.evalStatus(S.Point(1, 2));     // the same three words, for a TERM
m.reducible(S.Point(1, 2));      // false: nothing applies to that head
m.engine.engineCounters;         // inferences, CPU, GC, table bytes
```

An unreduced term is DATA, which is MeTTa's own law: `!(hello world)` answers
`(hello world)` and that is the whole of hello world in this language. There is
no scope that refuses one, and there was; it is gone (user, 2026-08-31),
because refusing an unreduced term refuses the language.

Deciding what to do about one is the caller's, and `m.reducible` is the
question, asked of the engine's own `metta_reducible_head/2` without reducing
anything:

```ts
m.reducible(S.double(4));      // true
m.reducible(S.Point(1, 2));    // false
```

`runStatus` and `evalStatus` are the same question over a whole source or a
term, answering `value`, `not-reducible` or `empty` beside each answer.

`m.limits({ inferences })` bounds what a reduction may spend. There is no
`timeout` beside it and the surface says so rather than pretending: a
WebAssembly SWI has no `library(time)`, so a deadline is the host's
`AbortSignal` and is checkpoint-granular.

## The module tier

For a program that wants no setup line at all:

```ts
import { add, evaluate, match, q } from "metta-node/ambient";

await add(S.parent(S.tom, S.bob));
for await (const { x } of match(S.parent(V.x, S.bob))) { ... }
```

One engine, created by the first verb that needs it. Importing boots nothing,
and an ask from here is as lazy as the method it stands for: the boot happens
on the first pull. `reset()` disposes it and forgets it.

The reduction door is `evaluate` here and `m.eval` on the surface: `eval`
cannot be a module-level binding at all, because ECMAScript refuses it as a
declaration name in strict mode and every module is one.

## The satellites

The root exports what a program reaches for; everything else is a subpath, so
an unimported one costs nothing at all. This is the TypeScript image of the
Python package's lazily loaded satellites.

| subpath | what it carries |
|---|---|
| `metta-node/algebra` | value algebras, tagged derivations, `evaluate`, `why`, `under` |
| `metta-node/ambient` | the module tier: one lazily booted engine |
| `metta-node/arrays` | typed arrays as atoms, `Tensor`, `EmbeddingStore` |
| `metta-node/config` | the settings a process runs under |
| `metta-node/convert` | the two-way projection, the four images, `registerType` |
| `metta-node/derivation` | the proof tree |
| `metta-node/events` | the fold over a space's writes |
| `metta-node/integrate` | the library interface, discovery, wrapping, reflection |
| `metta-node/lint` | five rules over MeTTa source, with suppression |
| `metta-node/manifest` | a whole setup as one declarative record |
| `metta-node/matching` | unification, one-way matching, alpha keys, renaming |
| `metta-node/parallel` | the coordination verbs |
| `metta-node/paths` | lazy structural paths into a live host value |
| `metta-node/provider` | the space-provider seam, and host-owned matching |
| `metta-node/random` | the seeded source everything that draws draws from |
| `metta-node/remote` | a space over HTTP, both ends |
| `metta-node/spaces` | `view`, `union`, `readOnly`, `overlay`, `mapped`, `diff`, `objectView` |
| `metta-node/strategies` | the rewriting strategies, as reified atoms |
| `metta-node/structures` | `AlphaSet`, `PatternMap`, `MatchIndex`, `ClosureView`, `TabledMap` |
| `metta-node/subscribe` | standing queries and the live view |
| `metta-node/tables` | a space over rows, and the bridge back |
| `metta-node/saga` | the compensating-transaction journal |
| `metta-node/tokens` | reader classes of the host's own |
| `metta-node/testing` | atom generators, a property runner, the conformance checks |
| `metta-node/version` | the version this build declares |
| `metta-node/vocabularies` | all 32 of the engine's closed value sets, as unions |
| `metta-node/wire` | the codec, for a conformance kit |

## How a host type crosses

A value crosses by REFERENCE unless something says how it should cross by
SHAPE. `G(person)` is the reference; `registerType` is the other door.

```ts
import { IMAGES, project, registerType } from "metta-node/convert";

registerType(Person, {
  name: "Person",
  toAtom: (person) => [person.name, person.age],
  fromAtom: (name: string, age: number) => new Person(name, age),
});
project(new Person("Ada", 36));      // (Person "Ada" 36)
```

A registration picks one of four images, and the four are the engine's own:
`registry-image` is one of the vocabularies generated from a booted engine, so
`IMAGES` cannot drift from what the engine knows.

| image | how the value crosses |
|---|---|
| `expression` | `(Name child...)`, the default and the shaped form |
| `symbol` | the bare name its first child renders to, which is how an enum reads |
| `handle` | by reference, though the registration still describes it |
| `operations` | by reference, and its methods are meant to become operations |

The `symbol` image runs backwards too. A bare symbol carries no constructor to
look up, so every symbol registration is offered the name in turn and the first
whose `fromAtom` answers something other than `undefined` claims it.

`autoImage(value)` is the rung beneath a declared image: `"transparent"` or
`"opaque"`, decided in constant time. A scalar and a small sized container
cross transparent; an ITERATOR stays opaque however short it is, because
measuring or converting one drains it, and draining is a side effect no image
choice is allowed to have.

## Integrating a library

`integrate` is what a TypeScript library implements to work with MeTTa, and it
installs atomically: a failure part way undoes what it did.

```ts
import { discover, integrate, wrapObject } from "metta-node/integrate";

wrapObject(m, "db", connection, { execute: "db-query!", close: "db-close!" });
await m.eval(S["db-query!"]("select 1")).one();
```

A package advertises itself in its own `package.json`, under one of three
groups. Nothing is scanned and nothing is guessed.

```json
{
  "metta": {
    "integrations": "./dist/metta.js",
    "requires": ["base-lib"],
    "spaces": { "duck": "./dist/duck.js#createDuck" },
    "libraries": { "nars": "./metta" }
  }
}
```

`entryPoints(group)` answers the advertised names UNLOADED, so discovery
imports nothing and the app keeps deciding what loads; `loadEntryPoint(name)`
loads exactly one. `discover()` returns integrations in INSTALL order, so a
library built on another does not have to tell its users the right order by
hand, and a cycle refuses rather than picking one.

`installReflectionOps(m)` turns calling a host object into reasoning about one:

```metta
!(match (context-space) (config $c) (js-field $c $name))
; (depth 3), (name "deep") -- one answer per field
```

`(js-field $object $name)` answers a `(name value)` pair in both modes. With
the name bound it is a getter; unbound it enumerates. That second mode is what
a function cannot offer and a relation can.

## Vectors by key

```ts
import { EmbeddingStore } from "metta-node/arrays";

using store = new EmbeddingStore(m, { name: "emb" });
store.add(S.dog, new Float64Array([1, 0]));
store.add(S.cat, new Float64Array([0.9, 0.1]));
await m.eval(S["emb-knn"](G(new Float64Array([1, 0])), 1)).toArray();   // dog
```

`add` has MAP semantics: adding a key that is already there replaces its vector
in its first-seen position. The vectors are copied into one contiguous
row-major buffer, rebuilt lazily after a write, with each row's norm beside it,
so a query is one pass of `n * width` multiply-adds with no per-vector
indirection. A zero or non-finite vector is refused at the door, because cosine
similarity has no answer for either and a silently empty ranking is worse.

## What a space declares about itself

A space's own facts live in the catalog, and the engine acts on them.

```ts
kb.handles(S.user(V.id, V.name), "Exact");   // routing: bounds may reach you
kb.handles(S.scan(V.x), "Refuse");           // a scan-only source, in three words
kb.covers("writesState");                    // what a world reified from here may do
kb.writes("transactional");                  // what a write promises in a transaction
kb.emits("best-first");                      // what (top k ...) needs before it bounds
kb.capacity(1000);                           // an add beyond this is refused loudly
```

`handles` is keyed by SHAPE as well as by space, so a second declaration adds a
row and queries route by the most specific one that matches. `Exact` licenses
pushing the caller's bound to the provider; `Partial` and `Sound` stay
candidates the engine re-unifies; `Refuse` makes the query a loud error instead
of a silent partial answer. The other three are keyed by space alone, so
redeclaring REPLACES: two rows saying different things about one space is not a
stronger claim, it is an unanswerable one.

`kb.digest()` is a sha256 of everything the space holds. The engine
canonicalizes each atom, multiset-sorts the lines and hashes the whole, so two
spaces agree exactly when they hold the same atoms up to alpha, in any
insertion order and in any process. A space holding a live host reference is
refused rather than hashed, because a reference prints by address.

`kb.capacity(n)` bounds the space through the engine's own admission gate, so
it holds for every write path in. The row is DATA and claiming the gate is
separate sugar, which is deliberate: the pre-add hook takes ONE claimant, and a
program that writes its own admission judge has to be able to claim it.

`m.libraryPath(directory, alias)` registers a directory of MeTTa sources under
a name `(import! &self (library <alias> <file>))` can reach. The directory is
MOUNTED before it is registered, because the engine runs in a WebAssembly
filesystem of its own and cannot see this process's.

`kb.transaction(term)` runs one term atomically: every engine write commits or
rolls back together, and an EMPTY answer set is the rollback. The body is a
TERM rather than a callable, and the reason is architectural: this seat
reaches JavaScript by suspending the engine, and the engine says exactly why
that cannot happen inside a transaction: `engine_yield/1 cannot unwind through
either`. Build the work as a term and this door runs it atomically.

## Reactions, and which one fires first

A reaction is a rule the ENGINE runs when a matching atom lands, under the
match's own bindings.

```ts
alarms.reacts(S.alert(V.what), S.insert(S["&log"], S.all(V.what)));
alarms.add(S.alert(S.fire));                 // (all fire) lands in &log
```

The managed heads are `(insert <ctx> <atom>)`, `(retract <ctx> <atom>)` and
`(revise <ctx> <old> <new>)`, and they route through the same write paths a
direct write does, so a provider's capabilities and declared atomicity govern a
bridged write exactly as a direct one. A cascade is bounded at depth 32 and
throws naming the chain.

`subscribe` is the neighbour of this, not a special case: a reaction's
operation runs ENGINE-side, so it reaches registered spaces, while a
subscription delivers host-side to anything with `add` and `remove`.

When several reactions match one write, `agenda` says which goes first.

```ts
alarms.reacts(S.alert(V.w), S.insert(S["&log"], S.low()), { priority: 1 });
alarms.reacts(S.alert(V.w), S.insert(S["&log"], S.high()), { priority: 9 });
alarms.agenda("priority");                   // (high) before (low)
```

`declaration` is the default and the order they were declared; `recency` is the
most recently declared first; `specificity` is the most tests in the pattern
first; `priority` reads each reaction's own number, highest first; and `user`
names a MeTTa function that scores a reaction. Every policy breaks ties on
declaration order. Those five are a production system's conflict-resolution
strategies under their usual names, which is where the engine took them from:
OPS5 and CLIPS resolve a conflict set the same way.

## Undoing what cannot be rolled back

A saga is the answer to work that has already committed: instead of a
transaction that unwinds, each step declares what UNDOES it, and recovery runs
those in reverse. That is the classical formulation, and it exists precisely
because atomicity is not available across the boundary in question [source:
Garcia-Molina and Salem, "Sagas", SIGMOD 1987].

```ts
import { compensates, saga } from "metta-node/saga";

m.op(function charge(amount: number) { ... }, { effect: "writesState" });
m.op(function refund(amount: number) { ... }, { effect: "writesState" });
compensates(m, "charge", "refund");

using book = saga(m, m.space("&receipts"));
await book.run(S.charge(10));
await book.run(S.charge(20));
await book.rollback();                       // refund 20, then refund 10
```

A receipt is DATA: `(did charge (10) 10)` is an ordinary atom in an ordinary
space, so a program queries its own journal with `match`. Only operations whose
DECLARED effect is `writesState` or stronger earn one, because a read has
nothing to undo.

Three behaviours matter and only show when something goes wrong. A step that
throws commits NO receipt, so the journal never records an obligation for work
that did not happen. `rollback` PREFLIGHTS every receipt against a declared
compensation before undoing anything, because discovering a missing one half
way through leaves the world in neither state. And a compensation that throws
keeps its receipt and every receipt before it, so a retry resumes rather than
restarts. A compensator must therefore be idempotent.

The step is not itself atomic here, and that is the one place this seat differs
from the Python one. Python runs each step inside an engine transaction; this
seat cannot, because it reaches JavaScript by SUSPENDING the engine and
`engine_yield/1` cannot unwind through a transaction. What is left is the
classical saga, which is the mechanism people reach for sagas to get.

## A notation of your own

The reader is extensible from the host: give it a full-token regex and the
function that turns a matching lexeme into an atom.

```ts
import { registerToken } from "metta-node/tokens";

registerToken(m.engine, /#[0-9a-f]{6}/, (lexeme) => G(parseInt(lexeme.slice(1), 16)));
m.run("!(colour #ff8800)");        // (colour 16746496)
```

The constructor receives the COMPLETE matched lexeme, quotes included for a
string token, and the callable never leaves this side: the engine keeps the
pattern and a key, and hands the key back when the reader meets a match.
Registering the same pattern again replaces the constructor, and only future
parses read the new mapping, because an atom already returned is a value.

This needs `library(pcre)`, which `m.engine.capabilities()` reports for the
build you are on. It is present in the shipped one.

## A provider that claims the whole conjunction

Without this, every conjunction is split one pattern at a time and
re-dispatched per outer row. That is a nested-loop plan, and a nested-loop plan
cannot reach the AGM bound however fast the backend is: for the triangle
`R(x,y), S(y,z), T(z,x)` with each relation of size N the bound is N^1.5, and no
join plan achieves it. So this is not a tuning knob.

```ts
const provider: SpaceProvider = {
  *atoms() { for (const [from, to] of edges) yield S.edge(from, to); },
  plan(patterns) {
    if (patterns.length < 2) return undefined;          // decline
    return { claimed: [0, 1], rows: myOwnJoin(patterns) };
  },
};
```

`claimed` names the patterns BY POSITION, and the engine derives the rest, so a
claim cannot drop a conjunct or name a pattern nobody offered and two
occurrences of a repeated pattern stay apart. A partial claim is legal: take
the two patterns you own and leave the third. Answering nothing declines, and
the engine plans it exactly as it always did.

The claim is EXACT, and this is the one place the seam differs from the rest of
it. Elsewhere you may over-approximate because the engine re-unifies each
candidate, which is cheap; there is no cheap re-check for a join, because the
only way to verify a row is to run it. `checkSpaceProvider` holds a claim to
the join it replaced:

```ts
await checkSpaceProvider(kb, provider, [], {
  conjunctions: [[S.edge(V.x, V.y), S.edge(V.y, V.z)]],
});
```

`plan` and `pushdown` are different capabilities: `pushdown` classifies how
exactly you filter ONE pattern, which is what licenses a bound reaching you,
and `plan` is this. `rules` is a third, declared rather than derived: it says
this space's atoms include EQUATIONS, which in MeTTa is the difference between
a data source and a place a program lives, and no method list can derive a
promise about content.

## A value that owns its matching

A host value can decide for itself what it unifies with, which is Hyperon's
`CustomMatch` in this runtime's vocabulary.

```ts
import { G, type Atom, type Term, hostValue } from "metta-node";
import { CUSTOM_MATCH, registerCustomMatch } from "metta-node/provider";

class Range {
  readonly low: number;
  readonly high: number;
  constructor(low: number, high: number) {
    this.low = low;
    this.high = high;
  }
  *[CUSTOM_MATCH](other: Atom): Iterable<Term> {
    const held = hostValue(other);
    if (typeof held === "number" && held >= this.low && held <= this.high) yield other;
  }
}
registerCustomMatch(m.engine, Range);
await m.eval(S.unify(G(new Range(1, 10)), G(5), S.yes, S.no)).one();   // yes
```

Either operand order consults the same logic, and a variable still binds the
value WHOLE without consulting it. Registration is per class and per engine,
and it is what turns the seam on: until the first call the matcher carries no
clause for host-owned matching at all, so a program that does not use this pays
nothing for it. That is the difference from the Python seat, which can afford
an always-present probe because its crossing is a function call; here it is a
coroutine yield, and the matcher's ground-comparison path is the hottest there
is.

## What a definition says about itself

```ts
import { definitionFacts } from "metta-node";

definitionFacts(m, function outer(n: number): number {
  return helper(n) + addAtom(n);
});
// { freeVariables: ["addAtom", "helper"], effect: "writesState",
//   unresolved: ["helper"], pure: false, span: {...}, doc: undefined }
```

Nothing is installed and nothing is written: the body is lowered to find out
what it reaches and the term is thrown away. `lower` is the authority on which
names a body could not bind itself, because it must decide that to compile at
all, so this is the same answer the equations were built from.

`effect` is the join over the heads whose effect the ENGINE declares, and
`unresolved` is what keeps it honest: the engine declares an effect for a
registered operation and a builtin, and none for a head defined by equations,
whose effect is its own body's. `pure` is a claim rather than a measurement, so
it is conservative: a body reaching an unresolved head is never called pure
however pure the rest of it reads.

## Collections over atoms, before there is an engine

```ts
import { AlphaSet, MatchIndex, PatternMap } from "metta-node/structures";

new AlphaSet([S.f(V.x)]).has(S.f(V.y));            // true: one pattern, two spellings
routes.matching(S.route(S.home));                  // which entries APPLY here
inbox.matches(S.order(7, S.express));              // sublinear over many patterns
```

`MatchIndex` is an imperfect discrimination tree, the term-indexing structure
automated theorem provers use at millions-of-terms scale: the tree answers
candidates and a one-way match confirms, which is what keeps a nonlinear
pattern such as `(f $x $x)` exact. `PatternMap` keeps the `Map` protocol EXACT
(`get(k)` answers what was stored under that very key) and puts the dispatch
question on its own door.

`metta-node/matching` is what they are built on, and it is useful by itself:
`unifyTerms`, `matchTerms`, `unifies`, `alphaKey`, `alphaEqual`, `isGround`,
`renameVariables`. `unify(a, b)` at arity two on the root IS the host matcher,
so asking whether two terms fit costs no crossing at all.

## Property testing

```ts
import { atoms, forAll, fromPattern } from "metta-node/testing";

const outcome = forAll(atoms(), (atom) => m.roundTrip(atom) === atom);
assert.ok(outcome.ok, `seed ${outcome.seed}: ${String(outcome.counterexample)}`);
```

Seeded, so a failing run is reproducible; shrunk, so the counterexample is the
smallest the shrinker could reach; and it answers a RESULT rather than calling
an assertion, so it works under `node:test`, under a runner this package has
never heard of, and inside an ordinary program.

## The command line

```sh
npx metta-node run program.metta      # every ! answer group
npx metta-node eval "(+ 1 2)"         # one term
npx metta-node why "(quad 3)"         # the first proof
npx metta-node repl                   # a read-eval-print loop
```

`--version` and `--help` boot nothing, and every command exits nonzero when it
fails.

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

`==` and `!=` are pure term equality. The integer `2` and float `2.0` have
different constructors, so `(== 2 2.0)` answers `false`. A written error is an
ordinary operand here too: `(== (Error bad none) 0)` answers `false` rather
than executing or raising the error term. The codec preserves the constructor
distinction that both equality and identity observe:

```
!(== 2 2.0)                          false
!(=alpha 2 2.0)                      false
!(case 2 ((2.0 float) ($_ other)))   other
!(subtraction-atom (2 2.0) (2))      (2.0)
```

The one thing this host has no type for is a rational, and it says so:

```
the number 1r3 has no JavaScript type; a rational crosses as its Prolog
spelling and this host has nothing to hold it in
```

## How deep a term may be

As deep as the ENGINE can hold one. Nothing on this side recurses per nesting
level: the wire is a flat preorder token list rather than a nested term, and
every walk over a term (the codec, `String(atom)`, `mapTerm`, `toAtom`, the
standard order, the renamers) carries its depth on a worklist. Measured on
this build, `m.parse` of `(f (f ... 1 ...))` answers at 200,000 deep in 1.2
seconds and at 500,000 in 2.7, and the term it answers renders, round trips and
sorts.

Past that the engine's own stack is the bound, and it says so:

```ts
try { m.parse(veryDeep); }
catch (error) {
  if (error instanceof StackLimitError) console.log(error.limit);  // 1073741824
}
```

`StackLimitError` carries the ceiling in bytes and names its remedy, which is
`METTA_STACK_LIMIT` (or `config.configure({ stackLimit })` before the first
boot) and which a 32-bit WebAssembly build must still fit in its address space.
The session is usable afterwards.

The one walk that does NOT do this is `project`, the host-value-to-atom
direction, which gives out around 2,700 levels of nested JavaScript objects.
That is a caller's own object graph rather than an engine answer, and the
platform is no better on the same data: `structuredClone` gives out at 3,127
and `JSON.stringify` at 4,161.

## A surface has a lifetime

`m.dispose()` releases what the surface holds, and every door refuses
afterwards with `ClosedError` rather than answering. That includes an ask that
was in flight: its next pull refuses, while closing the abandoned stream is
still allowed, because cleanup must not raise.

```ts
{
  using m = await metta();
  m.run("!(+ 1 2)");
}
```

`Symbol.dispose` is the same call, so a `using` block is the shortest form of
it on Node 24; on Node 22 the build downlevels it.

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

A refusal this binding raises is a `MettaError`, and each condition has its own
subclass and its own stable `code`, so a caller narrows by class or switches on
the code and the two agree:

```ts
catch (error) {
  if (error instanceof ResultError) ...            // not exactly one answer
  else if (error instanceof CapabilityError) ...   // this build, or this space, lacks it
  else if (MettaError.is(error, "ERR_METTA_STRICT")) ...
  else throw error;
}
```

`EngineError`, `MettaSyntaxError`, `WireError`, `ResultError`, `NameError`,
`CapabilityError`, `CompileError`, `ClosedError`, `UnsupportedError`,
`StrictError`, `NotReducibleError`, `CastError`, `AssertionError`,
`SourceNotFoundError`, `InferenceLimitError`, `TimeLimitError`,
`StackLimitError`, `ProviderError`, `SubscriberError`, `TransportError`. All
sit under `MettaError` with `cause` and `toJSON`, and every one of them is
raised by something: a class nobody produces is a `catch` branch a caller
cannot take, so there is no such class here.

A deadline is NOT one of them: `AbortSignal.timeout` aborts with the platform's
own `TimeoutError`, which is what every other async API raises, and inventing a
second one to catch instead would be the wrong kindness. `InferenceLimitError`
is a different thing: the engine stopping ITSELF inside a reduction.

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
`ERR_METTA_CLOSED`, `ERR_METTA_UNSUPPORTED`, `ERR_METTA_NOT_REDUCIBLE`,
`ERR_METTA_ASSERTION`, `ERR_METTA_SOURCE`, `ERR_METTA_STACK`.

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

### Python package counterparts

The platform refusals above are separate from the Python package comparison.
The Python capabilities once described here as missing are present under these
public Node subpaths:

| Python capability | Node package surface | public counterpart |
|---|---|---|
| annotated and weighted evaluation | `metta-node/algebra` | `counting`, `tropical`, `prob`, `prov`, `ranked`, and `TaggedAnswer.under` |
| numeric-array interop | `metta-node/arrays` | typed arrays, `Tensor`, `EmbeddingStore`, and `installArrays` |
| a space over a network | `metta-node/remote` | `connect`, `serve`, `RemoteSpace`, and `Gateway` |
| static analysis of definitions | `metta-node/lint` | `RULES`, `Finding`, `lint`, and `lintFile` |
| assembling an app from a manifest | `metta-node/manifest` | `boot`, `Boot`, and `VOCABULARY` |
| spaces over rows | `metta-node/tables` | `tableSpace`, `arrayTables`, and `bridge` |
| host-value conversion | `metta-node/convert` | `registerType`, `project`, `build`, and `autoImage` |
| library discovery and installation | `metta-node/integrate` | `integrate`, `discover`, `entryPoints`, and reflection helpers |
| a tabled computed map | `metta-node/structures` | `TabledMap`, including the engine's table counters through `stats` |
| a lazy path into a host value | `metta-node/paths` | `Path`, `path`, `reach`, and `installPaths`; the engine calls a registered operation instead of lifting a marker from a pattern |

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
| `src/errors.ts` | the error family, one subclass per condition |
| `src/matching.ts` | unification, one-way matching, alpha keys, renaming |
| `src/structures.ts` | `AlphaSet`, `PatternMap`, the discrimination tree |
| `src/provider.ts` | a space implemented in TypeScript |
| `src/spaces.ts` | the space algebra, every combinator a provider |
| `src/derivation.ts` | a proof, as a discriminated union |
| `src/parallel.ts` | the coordination verbs on the platform's concurrency |
| `src/subscribe.ts` | standing queries and the live view |
| `src/testing.ts` | generators, the property runner, the conformance checks |
| `src/vocabularies.ts` | the engine's closed value sets, checked against `&metta` |
| `src/strategies.ts` | the rewriting strategies, as reified atoms |
| `src/paths.ts` | lazy structural paths into a live host value |
| `src/ambient.ts` | the module tier |
| `src/cli.ts` | the command line |
| `src/present.ts` | the presentation hook every handle prints through |
| `src/types/sexpr.ts` | MeTTa text, read at the type level |
| `bridge.pl` | the Prolog half: the codec, the job pump, the host-op trampoline |
| `test/*.test.ts` | `node --test` |
| `kit/` | the conformance kit, both halves |
| `examples/` | the programs the README and the tests run |
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

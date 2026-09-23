<!-- Purpose: demonstrate the public TypeScript surface with executable examples.
Open Obligations: None. -->
# MeTTa in TypeScript

```ts
import { metta, S, V } from "tsmetta";

const m = await metta();
m.add(S.parent(S.tom, S.bob), S.parent(S.bob, S.ann));

// Rows are keyed by the pattern's own variable names.
for await (const { child } of m.match(S.parent(S.tom, V.child))) {
  console.log(String(child));                    // bob
}

// An ordinary TypeScript function becomes ONE equation the engine holds, so
// the call costs no host crossing.
const twice = m.define(function twice(n: number): number { return n * 2; });
console.log(String(await twice(21).one()));      // 42
```

The engine is a WebAssembly SWI-Prolog that boots inside the Node process, and
the same bundle runs in a browser. PeTTa defines what the language means.

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

A tool server can carry a reasoner instead of calling one: MCP servers, agent
loops and the services around them are written in TypeScript, and the engine
ships with the package rather than beside it.

## Installation

```sh
npm install tsmetta
```

The engine is SWI-Prolog compiled to WebAssembly and ships inside the package,
so nothing is installed beside it and no native build runs. The surfaces below
are subpath imports of the same package.

That SWI-Prolog is a patched build, in `_host/`. SWI-Prolog's own WebAssembly
release, npm's `swipl-wasm`, carries fourteen defects that crash the engine or
change its answers, so this package carries SWI-Prolog 10.1.14 with every
patch the engine requires, compiled by SWI-Prolog's own WebAssembly recipe.
The engine checks its host at every boot, and `metta()` refuses any other
SWI-Prolog with an `EngineError` that names each patch it lacks.

```ts
import { metta, S, V } from "tsmetta";
import { matchUnder } from "tsmetta/algebra";
import { tableSpace } from "tsmetta/tables";
```

From a checkout of this repository instead:

```sh
npm ci
npm run typecheck
```

## Build terms, don't concatenate strings

```ts
S.parent(S.alice, S.bob)     // (parent alice bob)
V.p                          // $p
fn.add(1, 2)                 // (+ 1 2)
fn.carAtom(S.x)              // (car-atom x)
seg(V.rest)                  // (:seg $rest), a gap standing for a run of children
seg()                        // ..., the anonymous gap
```

TypeScript's casing reaches MeTTa's hyphens: `fn.carAtom` is `car-atom`, and a
defined `function balanceOf` installs `balance-of`. For a head outside
identifier grammar, index it: `fn["prime?"]`.

The 267 heads the engine publishes are ordinary PROPERTIES on `fn`, generated
from its own catalog, so `fn.carAtom` is checked, autocompleted, and needs no
`!` even under `noUncheckedIndexedAccess`. Any other head still resolves
through the index signature, where `Name | undefined` is honest because that
head may not be there.

A head is a property only if its host spelling images back onto the engine's.
`assertEqual` is not one: the catalog already spells it that way, and the map
sends both `fn.assertEqual` and `fn["assertEqual"]` to `assert-equal`, a
different head. The CALL form is the exact door, because it mints the name
given rather than mapping it:

```ts
fn("assertEqual");        // assertEqual, the catalog's own spelling
fn["assertEqual"];        // assert-equal -- mapped, like the property
fn["prime?"];             // prime?, because the map leaves this one alone
```

The operators and control forms are also ordinary functions:

```ts
import { add, gte, If } from "tsmetta";

add(1, 2);                            // (+ 1 2), as (a: Term, b: Term) => Atom
If(gte(V.age, 18), S.adult, S.minor); // (if (>= $age 18) adult minor)
```

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

An answer set is a whole `Promise` of its answers, `catch` and `finally`
included, that starts no work until something awaits it. So
`await assert.rejects(m.eval(term), OperationError)` states a refusal, and
`Promise.all([m.eval(a), m.eval(b)])` gathers two asks, with no wrapper.

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

Lower a function, trace a generator, admit a generator's equations as data,
or call host code from MeTTa.

```ts
const twice = m.define(function twice(n: number): number { return n * 2; });
String(await twice(21).one()); // "42", an engine equation

const colour = m.define(function* colour() { yield S.red; yield S.blue; });
(await colour().toArray()).map(String); // ["red", "blue"], traced clauses

m.rules(function* depth(inner: Term) {
  yield rewrite(S.depth(S.leaf), 0);
  yield rewrite(S.depth(S.wrap(inner)), add(1, S.depth(inner)));
}); // two equations whose heads are patterns, stored as written

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
String(vocabulary.S.ageOf(S.ada)); // "(age-of ada)"; the callable takes one argument
String(vocabulary.typeOf("ageOf")); // "(-> Symbol Number)"
String((await m.match(S[":"](S.ageOf, V.type)).one())["type"]);
// "(-> Symbol Number)"
```

A type position takes this host's own types. `arrow`, `typed` and the `type`
option of `define` and `state` read each one through `typeAtom`: a term is
itself and an array is an expression type; a JavaScript constructor names the
type the engine admits all its values at, `Boolean` being `Bool` and `BigInt`
being `Number`, since the engine types a bigint inside signed i64 `Number`;
an atom class names its metatype, `Sym` being `Symbol`; and any other class
names what `registerType` taught it, else its own name. A function that is no
class, such as `Math.max`, raises `NameError`.

```ts
String(arrow(Number, BigInt, Boolean)); // "(-> Number Number Bool)"
String(typeAtom([S.List, String]));     // "(List String)"
class Dog {}
String(typed(S.rex, Dog));              // "(: rex Dog)"
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

A number crosses as the kind the engine gives it. An integer is a `number`
while it is safe and a `bigint` past that; a float is a `number` in a
`FloatAtom`, so `float(2)` stays apart from the integer 2; and a rational is
the exact `Rational` it is, a bigint numerator over a bigint denominator in a
`RationalAtom`, printed as the engine writes it. The portable wire refuses a
rational, since CODEC.md has no tag for one; the engine's own transport
carries it both ways.

```ts
import { G, Rational, RationalAtom } from "tsmetta";

m.import(lib.math);
const third = await m.fn.mathRational(1, 3).one();
third instanceof RationalAtom;                // true: third.value is 1n over 3n
String(await m.eval(S["+"](third, 1)).one()); // "4r3"
G(new Rational(2n, 6n)) === third;            // true: one number, one atom
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

```ts
import { Atomicity, EffectClass } from "tsmetta/vocabularies";

Atomicity.atomicSingle;      // "atomic-single": the host's casing, the meaning's hyphens
EffectClass.pureStructural;  // "pureStructural"
```

The sets are TypeScript unions, so the compiler carries the correction
instead of the engine refusing at run time. These two do not compile, which
is the point:

<!-- Deliberate type errors, self-contained, and not part of any runnable
     snippet; each line carries tsc's own text. -->
```ts
import { EffectClass } from "tsmetta/vocabularies";

EffectClass.pureStrucural;
// TS2551: Property 'pureStrucural' does not exist. Did you mean 'pureStructural'?

const effect: EffectClass = "purestructural";
// TS2820: Type '"purestructural"' is not assignable to type 'EffectClass'.
//         Did you mean '"pureStructural"'?
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

## Queries, joins and guards

Shared variables join patterns. A guard is a MeTTa term evaluated under those
bindings, and `limit` bounds admitted answers inside the engine.

```ts
using people = m.space();
people.add(S.person(S.ada), S.age(S.ada, 36), S.person(S.grace), S.age(S.grace, 17));
const adults = people.prepare(
  S[","](S.person(V.name), S.age(V.name, V.age)),
  { where: fn.gte(V.age, 18), limit: 1 },
);
(await adults.solve()).map(row => String(row.name)); // ["ada"]
```

`match(pattern, { where, limit })` is the immediate form. Its longhand is
`(take limit (match space pattern (let true guard (quote (columns...)))))`;
omitting an option omits its wrapper. A template replaces the quoted columns
and is evaluated: `people.match(S.age(V.name, V.age), fn.add(V.age, 1))`.
Guards and bounds also survive `yield*` in a traced definition. The bracket
head `S[","]` stays exact, as do `fn["prime?"]` and `fn["change-state!"]`.

## Prepared queries and temporary facts

Preparation retains the term, wire encoding and columns. It holds no cursor
and caches no answers; each solve reads the current space.

```ts
using routes = m.space();
routes.add(S.route(S.direct));
const query = routes.prepare(S.route(V.path));
query.columns; // ["path"]
String(query.term); // the native match term, available as data
await query.solve({ given: [S.route(S.detour)] }).count(); // 2
await query.solve().count();                            // 1
```

`solve({ given })` is `space.withFacts(given, query.term)`: the engine runs
`(progn (add-atom space fact)... term)` in a snapshot and discards every
evaluation write on **every** exit, the temporary facts included. Success, an
empty result, cancellation and a thrown error are one case, not four, and
that is the guarantee: no exit keeps a write. Occurrences the space already
held, and their tokens, survive.

The snapshot is a closed native computation, so a host callback cannot
suspend inside it; a query that awaits host code wants an ordinary solve.
Cancellation is per execution, so `query.solve({ signal })` leaves the
prepared query reusable.

There is no assumption scope spanning arbitrary JavaScript. One would need a
shared engine service that removes the exact occurrence it admitted, and
deleting an equal value instead would remove someone else's.

## Transactions and speculation

```ts
using inventory = m.space();
inventory.transaction(fn.progn(
  fn.addAtom(inventory, S.stock(3)),
  fn.addAtom(inventory, S.reserved(1)),
)); // both writes commit together

await inventory.speculate(fn.progn(
  fn.addAtom(inventory, S.trial()),
  fn.match(inventory, S.trial(), S.yes),
)); // [yes]
inventory.has(S.trial()); // false
```

`transaction(term)` names `(transaction term)` and returns every answer;
engine failure rolls the transaction back. `speculate(term)` names the
engine's snapshot scope and always discards its writes. `m.transaction` and
`m.speculate` use `m.self`.

`using policy = m.atomic()` makes **each call** a transaction.
`using policy = m.speculative()` makes each call a separate snapshot. These
policies apply to the engine until disposal; a JavaScript block containing
several calls is not one transaction. Build one term when the whole operation
must be atomic. A callback body is refused with the transport's remedy:
WebAssembly SWI cannot yield to JavaScript through a transaction or snapshot.

Native table and exact-memo counters belong to the query that creates their
tables. Read those counters inside the same evaluation, such as a `progn`
containing the call and its statistics read. Closing the answers closes that
native query; a later statistics query sees no retained table.

## Reified worlds and compensation

A reified world is a language value with evaluation, successor, diff and
conflict-checked commit operations. Those operations currently live in the
Python binding, not in a shared engine service. TSMeTTa therefore has no
`reify` door. Adding one requires moving that semantic owner into the engine;
a TypeScript implementation would create a second world model.

The existing `m.world(space)` is a mutable draft with `add`, `remove`,
`match`, `commit` and `restore`. Its commit applies a native atomic delta.
It is not a reified-world value.

Compensation handles effects that have already committed:

```ts
import { compensates, saga } from "tsmetta";

let reserved = 0;
m.op(function reserve(n: number) { reserved += n; return reserved; }, { effect: "writesState" });
m.op(function release(n: number) { reserved -= n; return reserved; }, { effect: "writesState" });
compensates(m, "reserve", "release"); // an ordinary catalog declaration
using receipts = m.space();
using book = saga(m, receipts);
await book.run(S.reserve(2));
receipts.size; // 1: (did reserve (2) 2)
await book.rollback();
reserved; // 0
```

Rollback preflights the compensation declarations and then walks receipts in
reverse. A failed compensation keeps its receipt for retry, so compensators
must be idempotent. A saga does not make external effects atomic.

## Events and standing queries

Admissions are events in the same space queries read. Subscribe to them as
callbacks or async iterables; `using` and leaving an iteration release the
watch. A caller's `AbortSignal` also cancels it.

```ts
import { fold, subscribe } from "tsmetta";

using alarms = m.space();
using watch = subscribe(alarms, S.alarm(V.what));
using counter = fold(alarms, S.alarm(V.what), count => count + 1, { initial: 0 });
alarms.add(S.alarm(S.fire));
await watch.settled();
watch.drain().map(event => event.edge); // ["add"]
await counter.settled();
counter.state; // 1
```

`space.reacts(pattern, operation)` publishes an engine reaction;
`space.agenda(policy)` declares its ordering. `fold` accumulates host state.
A finite `queueMax` makes an undrained queue fail loudly instead of losing
events. `settled()` observes delivery of writes already made.

## Materialized answers

```ts
using facts = m.space();
facts.add(S.person(S.ada), S.person(S.ada));
using joined = facts.live(S.person(V.name), S.age(V.name, V.age));
facts.add(S.age(S.ada, 36));
joined.columns;                         // ["name", "age"]
joined.size;                            // 2 occurrences
joined.count({ name: S.ada, age: 36 });  // 2
facts.delete(S.person(S.ada));
joined.size;                            // 1
```

The engine seeds and registers the view together, then recomputes it at
committed segment boundaries. Rollback and speculation publish no changes.
`joined.changes({ signal, queueMax })` is an async iterable of `add`, `remove`
and `progress` records with generation numbers. Each consumer owns its queue;
`progress` marks a complete generation. The final snapshot survives `close()`.
`LiveView.open(space, pattern)` projects this same committed bag as atoms.

`space.liveEval(call)` maintains a private incremental tabled call. Declare
`(cache head (incremental private))` in the catalog first. Shared tables and
queries needing a yielding host callback are refused: an observation snapshot
cannot suspend. Unchanged reads transfer no rows; updates currently recompute
the native query rather than maintaining a second TypeScript join engine.

## Foreign spaces, composed spaces and live objects

```ts
import { objectView, readOnly, union } from "tsmetta/spaces";

const scores = new Map([["ada", 3]]);
const source = m.attach("&scores", scores);
String((await source.match(S.kv(S.ada, V.score)).one()).score); // "3"
scores.set("ada", 4); // the next query sees 4

const settings = { threshold: 3 };
const combined = m.attach("&combined", readOnly(union(source, objectView(settings))));
String((await combined.match(S.field(V.object, S.threshold, V.value)).one()).value); // "3"
m.detach(combined.name);
m.detach(source.name);
```

A `SpaceProvider` supplies only the operations its backend supports. It yields
candidate atoms; the engine unifies them. `overlay`, `mapped` and `diff` use
the same provider contract. Direct host mutations are visible to new queries;
they do not manufacture native admission events. Unsupported writes are
refused by capability. `handles`, `writes` and `emits` publish the provider's
promises as catalog rows.

## Native engine values

A value only the engine can hold, a compiled regex or a store's engine,
crosses as a `NativeHandle`: the engine keeps it in a registry and this side
holds the id, so handing the handle back reaches the very same value, and the
same value crossing again is the same atom. `release()`, or leaving a `using`
block, lets the engine drop it, and so does collecting the last atom that
names it; either travels with the engine's next crossing, and a released
handle is refused wherever it is sent. The portable transport refuses a handle
as it refuses a live host value, since only this engine can name it.

```ts
import { NativeHandle, lib } from "tsmetta";

const regex = m.space().import(lib.regex);
using pattern = await regex.fn.reCompile("\\d+").one();
pattern instanceof NativeHandle;                          // true
(await regex.fn.reFind(pattern, "n7 n8").toArray()).map(String); // ['"7"', '"8"']
```

## Mutable cells

```ts
const balance = m.state(10, { type: S.Number });
balance.set(12).held;                        // 12
String(await m.eval(fn.getState(balance)).one()); // "12"
```

The cell carries its engine atom, so passing `balance` and passing
`balance.handle` mean the same thing. Spaces carry their atoms too. The
engine's `StateMonad` declaration checks writes; TypeScript's generic checks
calls to `set`.

## Arrays and shape types

```ts
import { G } from "tsmetta";
import { Tensor, installArrays } from "tsmetta/arrays";

const matrix = new Tensor(new Float64Array([1, 2, 3, 4, 5, 6]), [2, 3]);
matrix.at(1, 2);          // 6
String(matrix.type);     // "(Tensor float64 2 3)"
matrix.reshape(6).data === matrix.data; // true
installArrays(m);
String(await m.eval(S.arrayMax(G(matrix.data))).one()); // "6"
```

JavaScript's `TypedArray` family supplies numeric storage. A tensor adds shape
and a MeTTa type; reshaping shares storage and incompatible sizes are refused.
Dimensions and coordinates must be safe integers; dimensions may be zero.
`EmbeddingStore` presents vector neighbours as a provider. Numeric libraries
already producing typed arrays need no library-specific door in core.

## Algebras and semirings

```ts
import { Algebra, AlgebraDeclarationError, matchUnder, taggedFact, taggedRule } from "tsmetta/algebra";

using weighted = m.space();
weighted.add(taggedFact(0.5, S.a()), taggedFact(0.2, S.b()),
  taggedRule(1, S.c(), S.a(), S.b()));
String((await matchUnder(weighted, S.c(), "prob").one()).tag); // "0.1"
String((await matchUnder(weighted, S.c(), "counting").one()).tag); // "1" proof

// Carriers are terms, so they compose: one that counts the proofs underneath
// the probability is the product of the two.
const overlapping = S.product(S.prob, S.counting);

// The carrier names an ENGINE declaration. A host object is not one.
const host = new Algebra("host", { combine: "+", extend: "*", zero: 0, one: 1 });
try {
  matchUnder(weighted, S.c(), host);
  throw new Error("a host algebra was accepted as an engine declaration");
} catch (error) {
  if (!(error instanceof AlgebraDeclarationError)) throw error;
  error.code; // "ERR_METTA_CAPABILITY"
}
```

`matchUnder(space, pattern, carrier)` is `(match-under space carrier pattern)`,
and it answers `{ value, tag }` atoms. The engine owns fixpoints, carrier laws,
guards and cyclic evaluation, and `m.catalog` holds the declarations.

## Tables and SQL

```ts
import { arrayTables, bridge, tableSpace } from "tsmetta/tables";

const rows = { people: [{ name: "Ada", age: 36 }] };
const table = m.attach("&table", tableSpace(arrayTables(rows), [
  bridge(S.person(V.name, V.age), "people", { name: V.name, age: V.age }),
]));
String((await table.match(S.person("Ada", V.age)).one()).age); // "36"
m.detach(table.name);
```

Record arrays and async row sources are the TypeScript shapes here.
`TableSource.rows(table, constraints)` lets a database package parameterize its
own SQL driver; the core names no driver and translates no SQL dialect. A
`bridge` is a data declaration mapping columns to a relation. No pandas or
Python dataframe adapter is ported.

## Remote serving, authorization, HTTP and GraphQL

`serve({ spaces, port, token })` from `tsmetta/remote` serves an explicit space
allow-list over HTTP. It defaults to loopback. `connect(url, { space, token })`
returns a provider you attach locally; `await using gateway = await serve(...)`
owns the server and its cursors. A configured bearer token is required on
every request. The protocol preserves lazy pulls, structured refusals and
portable atoms; live JavaScript references cannot cross it.

Application HTTP routes and GraphQL resolvers can await a query and project
its rows. They belong in the application or an integration package that owns
the schema and authorization policy. The core has no GraphQL schema generator
or framework registry.

## Integrations and entry points

`tsmetta/integrate` turns a module's functions into host operations. Packages
advertise `metta.integrations`, `metta.spaces`, `metta.libraries` or
`metta.extensions` in their own `package.json`. `entryPoints(group)` inspects
names without importing packages; discovery is explicit and asynchronous.

`tsmetta/seam` declares extension points and registers rows against them.
`seam.declared()` and `seam.rows()` inspect the machinery, and
`seam.publish(m)` makes it queryable in the catalog. An integration registers
from its own package; core carries no third-party library roster. Filesystem
discovery is Node-only. Browser applications import their integrations
explicitly.

The query and observation examples are exercised by `test/depth-parity.test.ts`
and `test/live-parity.test.ts`; the existing satellite, provider, saga and remote
suites cover those doors.

## What a lowered body says

A plain function handed to `define` is read from its own source and becomes
one equation, so its body is TypeScript whose meaning is MeTTa. Arithmetic,
comparisons, `if`, `const`, ternaries and recursion are the engine's own, and
so are `&`, `|`, `^`, `~`, `<<` and `>>`, which become the `bit-` family over
MeTTa's unbounded integers, as a `bigint`'s are rather than a number's 32.
`&&` and `||` short-circuit, as they do in TypeScript, which is MeTTa's
`and-then` and `or-else`; the relational `and` and `or`, which evaluate both
sides and can solve for an unbound one, are the word door's `and(a, b)` and
`or(a, b)`. An
atom is mentioned the way it is built: `S.name` is a symbol, `S.pair(a, b)`
an expression, `V.x` a variable, `fn.carAtom(x)` an engine call and
`G("text")` a grounded literal. The word door's functions and constants
(`If`, `Collapse`, `Superpose`, `carAtom`, `neg`, `e`, `TRUE`, `UNIT`) are
read by the names this package exports them under, after the engine's own
heads, so a definition of your own called `add` wins over the word.

```ts
import { Superpose, type Term } from "tsmetta";

const classify = m.define(function classify(n: number): Term {
  switch (n) {
    case 0:
      return S.zero;
    default:
      return n > 0 ? S.positive : S.negative;
  }
});
(await classify(-3).one()).text; // "negative"

const swap = m.define(function swap(pair: Term): Term {
  const [left, right] = pair as [Term, Term]; // (let ($left $right) $pair ...)
  return S.swapped(right, left);
});
String(await swap([1, 2]).one()); // "(swapped 2 1)"

const signs = m.define(function signs(x: number): Term {
  return Superpose([x, -x]);
});
(await signs(4).toArray()).map(String); // ["4", "-4"]
```

Array destructuring is MeTTa's pattern `let`, a run of `const`s is its
`let*`, and a `switch` is its `case`: labels without statements share the next
arm, a clause ending in `break` continues after the switch, and `default` is
tried last whatever its position, as TypeScript tries it. Because the source is
all the lowering reads, the factories and words are recognised by NAME: a local
binding of the same name shadows them, and a renamed import
(`import { S as Sym }`) is not one of them.

An array's own walks are the engine's walks over an expression:
`xs.map((x) => x + 1)` is `(map-atom $xs $x (+ $x 1))`, `xs.filter(isBig)` is
`(filter-atom $xs is-big)`, and `xs.reduce((acc, x) => acc + x, 0)` is
`(foldl-atom $xs 0 $acc $x (+ $acc $x))`, an arrow being the template and any
other argument the function applied.

An arrow function is MeTTa's lambda: `(v: number) => v < limit` in a body is
`(|-> ($v) (< $v $limit))`, closing over the body's own names, and a binder
that shadows one of them gets a fresh variable as JavaScript gives it a new
binding. `m.lambda` lowers an arrow the same way from host code, answering the
term to pass, apply or store:

```ts
const twice = m.lambda((x: number) => x * 2);
String(twice); // "(|-> ($x) (* $x 2))"
String(await m.eval([twice, 21]).one()); // "42"
String(await m.eval(fn.forall(fn.superpose([1, 3]), m.lambda((v: number) => v < 2))).one()); // "false"
```

`Math`'s functions keep their JavaScript meaning on the engine's own math
heads. `Math.abs(a - b) < 2` is `(< (abs-math (- $a $b)) 2)`, and so for the
twelve others with a head of the same name, `acos` to `trunc`. `Math.log(x)`
is the natural logarithm, `(log-math e x)`. `Math.round` rounds a tie up, as
JavaScript does, where the engine's `round-math` rounds it away from zero, so
it lowers to the floor unless the fraction reaches a half: `Math.round(-2.5)`
is -2 in both. `Math.max` and `Math.min` fold `max` and `min` over their
arguments, and `Math.PI`, `Infinity` and `NaN` are their numbers. A Math
function passed as a value is its head, or its lambda where the call is more
than a head. The answers are TypeScript's: exact where the result is
determined, and within one ulp where the language leaves the function
implementation-approximated, as it does `sin` and `log`. MeTTa's integers have
one zero, so `Math.round(-0.5)` answers 0 where TypeScript answers -0.

```ts
const near = m.define(function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 2;
});
String(near.equations[0]); // "(= (near $a $b) (< (abs-math (- $a $b)) 2))"
```

A Math function the engine has no head for, such as `Math.sign`, refuses and
names the ones that lower. So does one handed to `map`, `filter` or `reduce`
whose arity is not what the walk passes, since JavaScript would hand it the
index as well: `xs.map(Math.pow)` computes `x ** index`.

A body reaches another definition by the name its function was written with.
A head TypeScript cannot spell, such as `in`, a keyword there, is installed
with `{ name }`, and a later body calling the function's own name lowers to
that head: the engine recorded which head the name installed, the one fact
the source alone cannot carry. A name two definitions were written with
refuses rather than guess. What `define` returns is its head wherever a term
goes, so a definition passes as a value, and `G(isIn)` is the spelling for the
live object:

```ts
import { Let, TRUE, type Term } from "tsmetta";

const isIn = m.define(function isIn(x: Term, xs: Term): Term {
  return Let(TRUE, fn.isMember(x, xs), x);
}, { name: "in" });
const digit = m.define(function digit(x: Term): Term {
  return isIn(x, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
String(digit.equations[0]); // "(= (digit $x) (in $x (0 1 2 3 4 5 6 7 8 9)))"
(await digit(7).toArray()).map(String); // ["7"]
String(S.tested(isIn, 7)); // "(tested in 7)"
```

A structural case is the word door's `caseOf` chain, which a body writes the
way host code builds it: each handler destructures the variables its pattern
binds, and `.otherwise` is the catch-all where `.end()` leaves none. A body
typed in terms rather than numbers uses the word door's arithmetic, `add`, so
the TypeScript checks what the engine will compute:

```ts
import { _, add, caseOf } from "tsmetta";

const len = m.define(function len(list: Term): Term {
  return caseOf(list)
    .with([], () => 0)
    .with(S.cons(_, V.tail), ({ tail }) => add(len(tail), 1))
    .end();
});
String(await len([1, 2, 3]).one()); // "3"
```

`this` is the space the definition lives in, and a body says to it what host
code says: `this.match(pattern, template)` queries and `this.atoms()` lists,
the two host doors one MeTTa head performs exactly. A write names the engine's
own operation, `fn.addAtom(this, atom)`, because the host `add` and `delete`
doors are wider than any one head. The same two methods read back on a
parameter or const the program declares as a `Space`, and a space the body
reaches by closure is named in `{ scope }`, since the source is all the
lowering reads. A statement
run for its effect is MeTTa's `chain`, and running off the end answers the
unit, `()`, as a TypeScript function without a return answers `undefined`:

```ts
import { type Space, type Term } from "tsmetta";

const notes = m.space(S.notes);
const note = m.define(function note(this: Space, text: string): Term {
  fn.addAtom(this, S.noted(text)); // (chain (add-atom &notes (noted $text)) $_ ...)
  return this.match(S.noted(V.said), V.said);
}, { space: notes });
(await note("hello").toArray()).map(String); // ['"hello"']
```

A definition's head is always its function's parameters, so a family of
equations whose heads are PATTERNS, one clause for `leaf` and one for
`(wrap $inner)`, is written as the equations it is. `m.rules` takes the
generator shape a traced `define` reads, runs it once with its parameters as
the rule set's variables, and stores every equation it yields exactly as
written, after checking them all:

```ts
import { add, rewrite, type Term } from "tsmetta";

const depth = m.rules(function* depth(inner: Term) {
  yield rewrite(S.depth(S.leaf), 0);
  yield rewrite(S.depth(S.wrap(inner)), add(1, S.depth(inner)));
});
String(depth[1]); // "(= (depth (wrap $inner)) (+ 1 (depth $inner)))"
String(await m.eval(S.depth(S.wrap(S.wrap(S.leaf)))).one()); // "2"
```

## The engine's functions, and its libraries

`fn` BUILDS a term and `m.fn` ASKS it: `m.fn.carAtom(x)` is
`m.eval(fn.carAtom(x))`, lazily, spelled by the same map, and every space has
its own, asking in that space. `lib` names the shipped libraries and `import`
loads one, or a MeTTa file by its host path, whose own relative imports then
resolve beside it:

```ts
import { lib } from "tsmetta";

m.import(lib.spaces); // (import! &self (library lib_spaces))
m.add(S.friend(S.ada, S.bob));
(await m.fn.find(m.self, S.friend(V.a, V.b))).map(String); // ["true"]
(await m.fn.carAtom([1, 2]).one()).text; // "1"
```

`lib.spaces` is `lib_spaces`, since a library's name is a file name and takes
no casing map; `lib("name")` names a library outside the `lib_` family and
`lib("alias", "file")` a file inside a registered library path.

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

### Async, concurrency and ownership

Each `MeTTa` owns an engine. Dispose it after its spaces, views and queries;
`using space = m.space()` allocates an anonymous native space and releases it
at block exit. Released handles refuse later operations, including a prepared
query first consumed after release. A prepared query owns no running cursor.

Promises and async iterators let host I/O overlap. Pure reductions share one
WebAssembly engine; they do not become parallel CPU work. Run independent
engines in workers for that. Exchange portable terms rather than engine handles.
Abort signals are checked at answer boundaries, so cancellation does not
preempt one long synchronous reduction; use the engine's inference budget for
that case. Per-call policies are engine-wide and should not span unrelated
concurrent tasks.

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
| `tsmetta/algebra` | Native `matchUnder`, `TaggedValue`, tagged facts and rules; host carrier and retained-derivation utilities |
| `tsmetta/ambient` | One lazily booted engine behind free functions, so a first program needs no setup line: `add`, `define`, `evaluate`, `engine`, `catalog`, `loadFile` |
| `tsmetta/arrays` | Typed arrays, `Tensor`, `EmbeddingStore`, and `installArrays` |
| `tsmetta/atom` | The atom algebra: one interned immutable value per MeTTa atom, narrowing by `instanceof`, printing as MeTTa text. `Expression`, `Grounded`, `FloatAtom`, `RationalAtom`, `Rational`, `Sym`, `SpaceHandle`, `ATOM_OF`, `typeAtom` |
| `tsmetta/browser` | The browser build of the root surface: `metta`, `MeTTa`, `S`, `V`, `fn`, and `forgetRuntime` |
| `tsmetta/config` | The process-wide settings the engine and the presentation layer read, and the one place an operator sets them: `config`, `Setting`, `Settings` |
| `tsmetta/convert` | `registerType`, `project`, `build`, and `autoImage` |
| `tsmetta/derivation` | One proof of one answer, as data: the equations that fired, the stored atoms they rested on, and the goals the walk could not see inside. `derivationOf`, `ProofNode`, `Step`, `Fact`, `Truncated`, `readable` |
| `tsmetta/errors` | The error family: one base class carrying a stable machine-readable `code`, one named subclass per condition a caller can act on. `EngineError`, `CompileError`, `CastError`, `CapabilityError`, `ClosedError`, `Code` |
| `tsmetta/events` | A fold over a space's writes: a standing query that carries state, steps once per matching write, and is itself readable. `fold`, `EventStream`, `publish`, `stream`, `STATELESS` |
| `tsmetta/integrate` | `integrate`, `discover`, `entryPoints`, and reflection helpers |
| `tsmetta/lint` | `RULES`, `Finding`, `lint`, and `lintFile` |
| `tsmetta/live` | Committed materialized query bags and independent change streams: `LiveQuery`, `LiveDelta`, `ChangesOptions` |
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
| `tsmetta/structures` | `TabledMap`; tables are query-local because the WebAssembly SWI-Prolog has threads disabled, so forms within one `run()` reuse and later jobs recompute |
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

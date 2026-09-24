<!-- Purpose: record shipped surface changes and caller migration requirements.
Open Obligations: None. -->
# Changelog

## Unreleased

- A free word is the head it names wherever a term goes, as its `fn`
  spelling is: `typed(S.plus, add)` is `(: plus +)` and `m.fn.getType(add)`
  asks about `+`. Every word of `OPERATOR_HEADS` and `WORD_HEADS` used to
  cross in term position as an opaque host value, `(js Function)`.
- A pending value where a term or a datum goes raises `NameError`: an ask,
  such as what a defined `f(x)` answers, or a promise nobody awaited. It used
  to cross as a live JavaScript object, so `m.fn.getType(f(x))` answered
  `%Undefined%` for the object with nothing said. `S.f(x)` builds the call
  to mention it, awaiting the ask gives its answers, and `G(value)` still
  grounds a thenable when that is what the program means.
- A value only the engine can hold crosses into TypeScript as a
  `NativeHandle` and back as the very same value: `re-compile`'s pattern, a
  store from `database-open!`, any C blob the engine answers. It used to raise
  `metta_node_untaggable` at the boundary. The bridge keeps each value in one
  registry under a fresh id, interned by its key, so the same value crossing
  again is the same atom, and it holds any engine term, so a provider door can
  later carry a term the wire grammar would hand back changed under the same
  tag. `release()` or a `using` block lets the engine drop the value, and so
  does collecting the last atom naming it; either travels with the engine's
  next crossing, and a released or never-issued id is
  `existence_error(metta_native_handle, Id)` in the engine and refused here
  before it is sent. The portable transport refuses `h` as it refuses `o`.
- A type position reads this host's types. `arrow(Number, BigInt, Boolean)`
  is `(-> Number Number Bool)`, `typed(S.rex, Dog)` is `(: rex Dog)` for a
  class `Dog`, and `{ type: String }` on `define` or `state` declares
  `String`. All of them go through `typeAtom`: a term is itself, an array an
  expression type, a JavaScript constructor the type the engine admits all
  its values at, an atom class its metatype, `Space` `SpaceType`, and any
  other class what `registerType` taught it or its base, else its own name,
  the nominal type PyMeTTa gives a user class. `BigInt` names `Number`, as
  Python's `int` does there, because the engine types a bigint inside signed
  i64 `Number` and admits the engine's `BigInt` wherever `Number` is asked
  for. A function that is no class raises `NameError`; a constructor used to
  cross into the type as an opaque host value, so `arrow(Number, Number)`
  built `(-> (js Function) (js Function))`.
- The WebAssembly host is rebuilt. Text holding U+0000 crosses from the
  engine whole, where it was cut at the first NUL; the shipped libraries'
  native halves and SWI's archive, utf8proc, yaml and OSSP UUID packages are
  linked in, utf8proc with the engine's two patches, so `nfkc-casefold`
  drops default-ignorable code points and `unicode_map/3` no longer aborts on
  an empty result;
  and `m.engine.capabilities()` answers what a load would, each
  row decided the first time anything reads it. This build names nine
  capabilities absent: concurrency, crypto, deadlines, environment-listing,
  http, https, redis, socket and subprocess. A row nothing had loaded used to
  read present, so http, https, socket and environment-listing did.
- Loading or importing a file copes with a directory that changes while it is
  read. The mount copied every entry of the file's directory after a `stat`,
  so an entry removed between the listing and the read, such as another
  process's scratch file, or a symbolic link whose target is gone raised
  ENOENT and the load failed. The mount now lists entries with their types,
  never opens a file its filter refuses, stats only a link to follow it, and
  skips an entry that is gone by the time it is read; the directory asked for
  still has to exist.
- An answer that is the symbol `Empty` crosses as that symbol at the term
  door and through the reader: `m.eval(S.noeval(S.Empty))` answers
  `[Empty]`, `m.evalStatus` reports it as a `value`, and
  `(atom-replace a ((a Empty)))` answers the `Empty` the rewrite produced. Both doors evaluated through the engine's `eval/2`, whose
  last goal prunes an `Empty` answer as a program does, so they answered
  nothing where PyMeTTa's doors answer `[Empty]`. Only an absent answer
  declines now. Inside a program `Empty` still prunes a branch, so
  `(superpose (a Empty b))` answers `a` and `b`, and a `!` directive in
  `m.run` keeps the engine's pruning. A body run by `speculate` or
  `withFacts` that ends in `Empty` answers it too; `(empty)` is the body that
  answers nothing.
- A failed assertion hands a harness its parts as atoms: `AssertionError`
  now carries `.actual`, `.expected`, `.missing` and `.excess` beside
  `.operation`, read off the refusal by the engine's own
  `metta_assertion_failure/6`, the classifier the Python seat's
  `AssertionFailure` reads. `.actual` is what a `test` produced or an
  `assert`'s goal; `.missing` and `.excess` are the answers a bag comparison
  found absent and extra, `undefined` where the form compared no bags and
  empty where the answers agree and differ only in order. They were in the
  message only, which a harness had to parse. The bridge's refusal frame grows
  a seventh element carrying the four parts as encoded terms.
- The engine transport reads a whole rational, `6r2`, as the integer it is,
  as the Python seat does.
- A MeTTa rational crosses into TypeScript as the exact number it is: a
  `RationalAtom` holding a `Rational`, a bigint numerator over a bigint
  denominator in lowest terms, printed as the engine writes it (`1r3`) and
  sent back in that spelling, which the engine's reader takes as the same
  number. Every answer holding one used to raise a WireError naming a number
  JavaScript had no type for, so `(stats-mean (1 2))` could not be asked from
  TypeScript; PyMeTTa carries the same answer as a `Fraction`. `G(rational)`
  interns by value, so two equal rationals are one atom, and `byStandardOrder`
  orders a rational exactly among the integers and floats, the double nearest
  a third below it and a float first where the values tie. The `Rational`
  class is the one the algebra's `Amplitude` already used, moved beside the
  other numbers and still exported from `tsmetta/algebra`. The portable
  transport refuses a rational by name, since CODEC.md gives it no tag, as it
  refuses a live host value.
- `seg()` with no name is MeTTa's anonymous gap `...`, each occurrence its own
  variable as `_` is for one child, so `S.order(seg())` matches an `order` of
  any arity; `seg` took a name only, and the gap had no spelling but the
  bracket door's `S["..."]`. PyMeTTa writes it with Python's `...`, which
  TypeScript has no literal for. A space's rows now have a test reading a run
  through a named gap and every arity through an anonymous one.
- `Math`'s functions in a lowered body keep their JavaScript meaning on the
  engine's own math heads, where every Math call refused as a call to
  something that is not a plain name. `Math.abs(a - b) < 2` lowers to
  `(< (abs-math (- $a $b)) 2)`, and so for `acos`, `asin`, `atan`, `ceil`,
  `cos`, `exp`, `floor`, `pow`, `sin`, `sqrt`, `tan` and `trunc`. `Math.log`
  is `log-math` with Euler's number as its base, and `Math.round` rounds a tie
  up as JavaScript does, where `round-math` rounds it away from zero:
  `Math.round(-2.5)` is -2 and `(round-math -2.5)` is -3. `Math.max` and
  `Math.min` fold the binary `max` and `min` over any number of arguments.
  `Math.PI`, `Infinity` and `NaN` lower to their numbers, and a sign over any
  of them stays one literal, so `-Infinity` is `-inf`. A Math function passed
  as a value is its head, or its lambda where the call is more than a head;
  one handed to `map`, `filter` or `reduce` whose arity is not what the walk
  passes refuses, since JavaScript would pass the index too, and `Math.max`
  and `Math.min` refuse as values. A property test runs one body in
  TypeScript and in the engine over 414 draws: exact for `abs`, `ceil`,
  `floor`, `round`, `sqrt`, `trunc`, `max` and `min`, and within one ulp for
  the functions ECMA-262 leaves implementation-approximated, where V8's libm
  and the engine's differ in the last place. PyMeTTa's table of math mentions
  is the same door for Python.

- A lowered body mentions atoms the way a program builds them: `S.name`,
  `S.f(a, b)`, `S["x"]`, `S("exact")`, `V.x`, `fn.carAtom(x)`, `G(literal)` and
  `float(literal)` lower to the atoms those spellings build, and the word
  door's functions and constants (`If`, `Collapse`, `Superpose`, `carAtom`,
  `neg`, `e`, `nil`, `TRUE`, `UNIT` and the rest) lower to their heads after
  the engine's own. `const [a, b] = v` is MeTTa's pattern `let` and `switch`
  is its `case`; a run of `const`s is `let*`, a statement run for its effect
  is `chain`, and a bare `return;` or running off the end answers the unit.
  `this` is the space the definition installs into, and a space's own `match`
  and `atoms` on `this` or on a space in `{ scope }` lower to `match` and
  `get-atoms`; `add` and `delete` refuse there, naming the head to call,
  because their host doors are wider than any one head. Until now each of these
  refused at definition time with
  "reads a property" or "calls something that is not a plain name". The word
  door's heads live in one table, `WORD_HEADS`, that the builders and the
  lowering both read.
- A lowered body reads the word door's `caseOf(x).with(pattern, handler)`
  chain as MeTTa's `case`, each handler's destructured names being its
  pattern's variables, `.otherwise` the catch-all arm and `.end()` none; `_`
  is the anonymous variable; and `match` and `atoms` read back on a parameter
  or const declared as a `Space`.
- A lowered body reaches a definition by the name its function was written
  with, even when `{ name }` installed it under a head the casing map cannot
  produce: `isIn(x, xs)` lowers to `(in $x $xs)` after
  `m.define(function isIn(...), { name: "in" })`, where it used to refuse as a
  name nothing defines. The engine records which heads each defining name
  installed, a name two definitions share refuses naming both, and
  `effectOf` and `disassemble` read a name string by the same rule. A name
  nothing defines yet refuses naming the mention door, `S.g(...)`, beside the
  ways to supply it.
- An array's own `map`, `filter` and `reduce` in a lowered body are the
  engine's `map-atom`, `filter-atom` and `foldl-atom`: `[1, 2, 3].map((x) => x
  + 1)` lowers to `(map-atom (1 2 3) $x (+ $x 1))`, an arrow callback being the
  template and a named function the function form, `xs.reduce(sum, 0)` to
  `(foldl-atom $xs 0 sum)`. They refused as property reads. A `reduce` with no
  initial value refuses, since MeTTa's fold needs one.
- An arrow function in a lowered body is MeTTa's lambda: `(v) => v < limit`
  lowers to `(|-> ($v) (< $v $limit))`, closing over the body's own names,
  where it used to refuse as an ArrowFunctionExpression. A binder that shadows
  a name of the body around it gets a fresh variable, since the enclosing
  equation's own variable would be bound by the call first. `m.lambda(arrow)`
  lowers an arrow from host code into the same term. An async function now
  refuses at definition time, naming op, where one without an `await` used to
  lower as if it were synchronous.
- An answer set and a spawned `Task` are whole Promises, `catch` and `finally`
  included, through one abstract face, `PromiseFace`, whose `then` each
  implements; they were `PromiseLike`, so `assert.rejects(m.eval(term), ...)`
  threw ERR_INVALID_ARG_TYPE and a test had to wrap the ask in a function.
  Nothing runs until something awaits, as before. Drizzle's QueryPromise is the
  prior art.
- A lowered body's `&&` and `||` lower to `and-then` and `or-else`, where they
  lowered to `and` and `or`. TypeScript's operators short-circuit, and so do
  those two special forms, while `and` and `or` are relations that evaluate
  both sides first: `x !== 0 && 10 / x > 1` used to divide by zero at `x = 0`.
  A body that means the relation, to solve for an unbound operand, says it
  with the word door's `and(a, b)` and `or(a, b)`. Stored equations using `&&`
  or `||` change accordingly; answers over ground booleans do not.
- `If(condition, then)` builds the two-argument `(if condition then)`, which
  answers nothing where the condition is false; `If` took exactly three.
- A lowered body's `&`, `|`, `^`, `~`, `<<` and `>>` become the engine's
  `bit-and`, `bit-or`, `bit-xor`, `bit-not`, `bit-shift-left` and
  `bit-shift-right`, which work over unbounded integers as a `bigint`'s
  operators do; they used to refuse as operators the engine has no head for.
  `>>>` refuses naming why: an unsigned shift has no meaning without a top bit.
- `m.rules(function* name(x, xs) { yield rewrite(lhs, rhs); ... })` stores the
  equations a generator yields exactly as written, with the generator's
  parameters as their variables: the door for heads that are patterns, such
  as `(= (depth leaf) 0)` beside `(= (depth (wrap $x)) ...)`, which `define`
  cannot say because its head is always its function's parameters. Every
  yield is checked before any lands, and a goal, a non-equation or an empty
  set refuses with `ERR_METTA_TRACE`. PyMeTTa's `@m.rules` is the same door.
- What `define` and `op` return is its head wherever a term goes: `h(twice,
  2)` asks `(h twice 2)`, where it used to ground the JavaScript function, and
  `G(twice)` is the spelling for the live object.
- `space.fn` and `m.fn` ASK the engine's functions: `m.fn.carAtom(x)` is
  `m.eval(fn.carAtom(x))`, spelled by the map `fn` uses, which is now one
  exported function, `fnHead`.
- `lib` names the shipped libraries, `lib.spaces` being `(library
  lib_spaces)`, and `space.import(module)` / `m.import(module)` loads one, or
  a MeTTa file by its host path with its directory mounted first, as
  `(import! space module)`. Importing a library no longer needs source text.
- `rewrite(head, body)` builds `(= head body)`, an equation as a value, for a
  program that stores, removes or matches equations as data.

## 0.0.1-alpha.1 - 2026-09-24

- Boot the engine on a patched WebAssembly SWI-Prolog this package carries in
  `_host/`, in place of npm's `swipl-wasm`, which carries fourteen of the
  defects the engine's host-workaround patches fix. The host is SWI-Prolog
  10.1.14 with every patch applied, built by npm-swipl-wasm's own recipe with
  the declaration of its patches packed into its home, and it is the one host
  for Node and the browser build alike. Every boot now runs the engine's host
  check before the engine loads; a host that does not declare every required
  patch is refused with `EngineError` carrying the engine's own sentence, with
  nothing written to the console. The loader is required once per process,
  because running its factory reassigns its module's exports to the LZ4 codec
  emscripten embeds in it. `benchmarks/baseline.json` is re-stamped for the
  new host with every pin kept: against npm's host on one box the inference
  rows are unchanged except `query-rows`, which the boot check's first-call
  warm-up moves by one, and every instruction row moves inside its band.

- Run synchronous parsing inside a job so registered host token constructors
  can answer; preserve named variables and propagate constructor failures.

- Preserve literal source-query columns through the ambient free-function
  wrapper as well as the runtime method; verified by compile-time and runtime
  checks using a quoted dollar and one actual variable.

- Repair corpus-discovered boundary defects: reject invalid tensor dimensions
  and fractional coordinates; preserve polymorphic schema variables and declared
  arities; type callable vocabulary names inherited from Function and Object.
- Infer query columns from variable tokens, excluding quoted text and comments.
- Await asynchronous provider finalizers when a query is truncated. Match table
  columns together so repeated variables agree, including nested terms, and
  preserve literal dollar constraints.
- Join generator effects with nondeterministic delivery. Preserve repeated
  pattern variables and valid shrinks in `fromPattern`.
- Copy linked runtime roots into packed artifacts. Isolate the packed consumer
  check from enclosing package self-reference; correct executable carrier and
  browser-export documentation.

### Migration

`swipl-wasm` is no longer a dependency of this package: the SWI-Prolog it runs
is `_host/`, and `swipl-wasm` stays only as a devDependency, the stock host the
suite proves is refused. `metta()` refuses a host without the engine's patches,
so an application that swapped in its own SWI-Prolog build needs one declared
by MesTTo/MeTTa's `tools/pymetta-host/declare-host.sh`.

Tensor dimensions and coordinates now reject invalid numeric indices. Schema
callables check their declared arity at compile time. A generator declared pure
reports `nondeterministicReadOnly`; awaiting a truncated query waits for its
provider's finalizer. Repeated table columns must hold equal terms.

## 0.0.1-alpha.0 - 2026-09-22

- Add prepared queries with native joins, guards and limits. The query exposes
  its term and columns, reuses its encoding, and reads fresh answers on each solve.
- Add temporary facts through `Space.withFacts` and `PreparedQuery.solve({given})`.
  Both run a closed native snapshot and discard every evaluation write.
- Add disposable per-call transaction and speculation policies. Let exceptions
  unwind native scopes before converting them to transport errors.
- Add anonymous disposable spaces and atom projection for spaces and state cells.
  Releasing a space evicts its host ownership and rejects deferred queries.
- Add committed `LiveQuery` multisets, joined patterns, private tabled queries,
  independent bounded change streams and native effect-plan inspection.
  Use the same committed snapshot in `LiveView`; repair opening races and
  variable-pattern removal counts. Honor caller cancellation and close sources.
- Add `matchUnder` for native weighted fixpoints and composed carriers.
- Decode callback replies before unifying a bound result, so a rejected guard
  fails logically instead of becoming a malformed-wire error. Update browser
  bootstrap validation for the engine's `pkg.metta` library entry point.
- Expand README.md and llms.txt with executable examples and explicit engine
  boundaries. Reified worlds require a shared engine service; mutable drafts
  remain distinct. Host-spanning temporary-fact disposal needs exact occurrence
  removal. GraphQL frameworks and SQL drivers remain extension-package concerns.

### Migration

Existing unguarded matches keep their behavior. A template that is an ordinary
host object must be wrapped in `G`; atom-bearing handles are templates directly.
`atomic()` and `speculative()` apply separately to each engine call, not to a
JavaScript block. `given` discards all query writes, not only its added facts.
Use an ordinary solve for yielding host callbacks. Use `matchUnder` with a
declared carrier name or term for engine semantics; the older retained-proof
`evaluate` API continues to exist.

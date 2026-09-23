<!-- Purpose: record shipped surface changes and caller migration requirements.
Open Obligations: None. -->
# Changelog

## Unreleased

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

Tensor dimensions and coordinates now reject invalid numeric indices. Schema
callables check their declared arity at compile time. A generator declared pure
reports `nondeterministicReadOnly`; awaiting a truncated query waits for its
provider's finalizer. Repeated table columns must hold equal terms.

Existing unguarded matches keep their behavior. A template that is an ordinary
host object must be wrapped in `G`; atom-bearing handles are templates directly.
`atomic()` and `speculative()` apply separately to each engine call, not to a
JavaScript block. `given` discards all query writes, not only its added facts.
Use an ordinary solve for yielding host callbacks. Use `matchUnder` with a
declared carrier name or term for engine semantics; the older retained-proof
`evaluate` API continues to exist.

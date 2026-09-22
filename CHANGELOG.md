# Changelog

## Unreleased

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

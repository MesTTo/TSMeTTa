# TypeScript language surface depth

The Node surface now exposes native prepared queries, guards, temporary facts,
per-call transaction policies, disposable spaces, committed query multisets and
weighted fixpoints. The full suite grew from **655 to 689 passing tests**, with
no failures or skips. README.md and llms.txt describe these APIs and the shared
engine boundaries below. No dependency was added.

The implementation is committed as `484e554d80d0db7ed620d4ea609849fb0b81aadf`;
the header-only provenance commit is
`dd0707a42eb721523e9c08454649650053ffb972`. Final completion is blocked by the
superproject evidence checker's commit lookup: it cannot resolve a real commit
in the independent Node repository. That checker is outside the Node-only edit
boundary. The separate browser classifier failure also needs an engine repair.

## Implemented and documented

| Capability | TypeScript notation and meaning | Evidence |
|---|---|---|
| Joins and guards | `space.match(S[","](...), {where, limit})` builds native `match`, `let true` and `take` terms. Templates remain positional; host objects use `G`. | `test/depth-parity.test.ts` checks rows, templates, rejected limits, async guards and traced generator lowering. |
| Prepared queries | `space.prepare(pattern, options)` retains the native term, wire and columns. Each `solve()` opens a fresh execution. | Fresh reads, cancellation, callable values, empty rows, special variable names and released-space refusal. |
| Temporary facts | `space.withFacts(facts, term)` and `query.solve({given})` add facts and evaluate one closed term in a native snapshot. All writes are discarded. | Equal occurrences retain their original tokens; empty answers, exceptions and early close leave the store unchanged. |
| Transactions and speculation | `m.transaction(term)` delegates to the existing native transaction. `m.atomic()` / `m.speculative()` and their Space forms return disposable, engine-wide policies applied separately to each call. | Committed prior calls survive a later failed call; the failing call rolls back; out-of-order disposal removes only its own policy. |
| Space and cell ownership | `using space = m.space()` allocates an anonymous native space. Space and State carry `ATOM_OF`; release evicts the host handle and rejects deferred queries. | Native term projection, cache eviction, repeated release and prepared-query lifetime checks. |
| Events and standing queries | Existing subscriptions now honor caller cancellation and iteration cleanup. `LiveView` reads a committed native query snapshot. | Opening races, variable-pattern removal, source failure, cancellation and queue overflow. |
| Materialized answers | `space.live(...patterns)` and `space.liveEval(call)` expose occurrence rows, multiplicity and independent bounded change streams. A native commit hook recomputes queries and produces sorted bag deltas. | Atomic batches, rollback/speculation exclusion, private incremental tables, 150 generated mutations checked against fresh engine joins, independent consumers and failed recomputation. |
| Queryable machinery | `space.effectPlan(term)` reads native transitive operation/effect analysis without executing its subject. | Pure and effectful definitions are inspected before execution. |
| Native algebras | `matchUnder(space, pattern, carrier)` names `match-under`; the engine owns recursion, fixpoints, carrier laws and composed carriers. | Weighted paths, cyclic idempotent evaluation, product/formula carriers and 27 weight combinations checked against exhaustive event probabilities. |

The callback decoder now parses a valid reply before unifying it with a bound
result. An incompatible boolean, number or expression is ordinary logical
failure. Tests cover deterministic, asynchronous, generator and async-generator
callbacks. The bridge's exception catcher now surrounds transaction/snapshot
execution, allowing rollback before the error crosses to JavaScript.

The browser manifest check now requires the engine's current
`lib/lib_builtin_types/pkg.metta` entry point. A new Chromium case exercises
prepared queries, temporary facts, live rows and state handles from the emitted
browser package.

README.md gained worked sections for the transferable language capabilities and
the existing host doors: foreign/composed spaces, live objects, cells, arrays,
tables, remote authorization, compensation, async ownership and integrations.
`test/readme.test.ts` executes the new TypeScript fences. Its existing export
comparison covers all 32 named code subpaths, including the new `tsmetta/live`.
The manifest has 35 entries including the root and two non-code assets.

## Deliberate adaptations and engine boundaries

- **Reified worlds require an engine service.** Python's reification, successor
  evaluation, diff and conflict-checked commit currently live in its binding,
  including `_history/world.py` and `_binding/worlds.pl`. The shared engine has
  no complete host service for this model. No second implementation or dummy
  `reify` method was added. Existing `m.world()` remains a mutable draft, clearly
  distinguished in both documents. Existing `tsmetta/saga` supplies declared
  host compensations and is covered by its suite.
- **Temporary facts are closed computations.** The native snapshot provides
  exact rollback. An assumption scope spanning arbitrary JavaScript would need
  a published exact-occurrence-removal service. The internal
  `spaces:metta_remove_occurrence/3` was not bypassed, and removal by value was
  rejected because it can consume a pre-existing equal occurrence.
- **WebAssembly cannot suspend a native transaction or snapshot through a
  yielding callback.** Ordinary solves support async host guards; closed
  transactions, temporary facts and observation snapshots refuse that crossing.
  Native thread concurrency requires a different engine build; host promises,
  async iterators and independently owned worker engines are the existing
  TypeScript equivalents.
- **No pandas door or Python table wrapper was ported.** JavaScript records,
  `TableSource.rows(table, constraints)` and typed arrays already provide the
  relevant host shapes. Database packages own parameterized SQL and drivers.
- **No GraphQL framework or third-party integration roster was added.** HTTP
  routes and GraphQL resolvers project query rows in their owning applications.
  Packages register against the existing declared extension points and
  advertise their entry points in their own manifests.
- **The older host algebra utilities remain distinct.** `evaluate` retains host
  derivation trees. New language queries use native `matchUnder`; passing a
  host `Algebra` object there is refused with a declaration remedy.
- **Platform refusal classification needs an engine repair.** The shared
  `metta_host_error_kind/3` currently recognizes space capability errors but
  falls through for `error(metta_platform_required(...), _)`. The existing
  browser test correctly expects a capability error for `hyperpose`; no local
  classifier or weakened assertion was introduced. The engine owner was asked
  to repair this outside the Node edit boundary.
- **The evidence checker needs component-aware Git lookup.**
  `tests/checks/check_evidence_tags.py:commit_problems` invokes `git cat-file`
  only in the superproject. It therefore rejects the valid Node implementation
  commit in all 15 pinned citations. `git -C extensions/node rev-parse --verify
  '484e554d80d0db7ed620d4ea609849fb0b81aadf^{commit}'` succeeds. The checker owner
  was asked to resolve pins in the source file's repository, retaining root
  history for inherited citations. The headers keep their genuine provenance.

## Verification

All package gates ran in the detached Node battery at
`ai-battery-1/extensions/node`, with the enclosing engine and library sources
frozen under `ai-battery-1`. Shared fixture paths were linked for reads. The
superproject evidence lane was run from its required root against stable Node
sources, as explicitly requested. No other superproject lane was run.

| Command | Result | Log |
|---|---|---|
| `npm ci` | Passed; 0 vulnerabilities | `ai-tmp/ai-depth-npm-ci.log` |
| Baseline `npm test` at `ec3a0dd` | 655 passed, 0 failed, 0 skipped | Battery `ai-tmp/ai-baseline-fixed.log` |
| Final `npm test` at commit `484e554d80d0db7ed620d4ea609849fb0b81aadf` | 689 passed, 0 failed, 0 skipped | Battery `ai-tmp/ai-depth-commit-test.log` |
| `npm run typecheck` | Passed | Battery `ai-tmp/ai-depth-types2.log` |
| `npm run build:dist` | Passed | Battery `ai-tmp/ai-depth-dist2.log` |
| Imports through actual `tsmetta`, `tsmetta/live`, `tsmetta/algebra` exports | Passed: prepared/given/live/native weighted query smoke | Battery `ai-tmp/ai-depth-package.log` |
| `npm run test:browser` | 23 passed, 1 failed, 0 skipped; shared platform refusal classification above | Battery `ai-tmp/ai-depth-browser2.log` |
| `sh tools/check.sh evidence` before final pins | Passed globally; 0 findings | `ai-tmp/ai-depth-evidence3.log` |
| `sh tools/check.sh evidence` with final pins | Failed: 15 Node commit-resolution findings caused by the root-only Git lookup | `ai-tmp/ai-depth-evidence-final.log` |
| `jscpd --reporters ai --noTips src` | Passed; two existing clones, 0.1%; reviewed and unrelated | `ai-tmp/ai-depth-clones.log` |
| `git diff --check` | Passed | Git exit status 0 |

The 34 additional Node cases comprise 17 depth cases, 16 live cases and one
executed README case. Existing suites continue to exercise providers, composed
spaces, typed atoms, arrays, tables, compensation, remote serving and discovery.

## Diagnostic failures and resolutions

- The first battery layout lacked shared fixtures: `ENOENT` for the examples
  and tests directories and `MODULE_NOT_FOUND` in the CLI fixture. Correcting
  the enclosing layout restored the unchanged 655-test baseline.
- Initial overload compilation reported `TS2322: Type 'Answers<Atom>' is not
  assignable to type 'Answers<Row>'` and `TS2339: Property 'n' does not exist on
  type 'Atom'`. Restricting positional templates to atom-carrying forms removed
  the options-object ambiguity; arbitrary host templates use `G`.
- The documentation guard reported `space.ts:113: export class PreparedQuery {`
  as an undocumented export. Its native API contract is now documented.
- An initial `if guard template Empty` lowering let `take` consume a rejected
  result. Native `(let true guard template)` provides the required logical
  failure and passes the guarded-limit tests.
- A cyclic set-carrier fixture using a boolean coefficient reached
  `'$tbl_wkl_add_answer'/4: Not enough resources: private_table_space`. Native
  set coefficients are numeric; the corrected fixture uses `1`. Other test
  assumptions were corrected to the native contracts: `counting` counts proofs,
  `change-state!` returns `true`, and namespace factories must be converted to
  atoms before inspecting their text.
- Async guards exposed `metta_node_decode/2: Unknown error term:
  metta_node_undecodable([b,false]) (not a wire atom the Node binding writes)`.
  Decoding before bound-result unification fixed the cause and all callback
  result modes now pass.
- The executed README reported `no answer to match(&scores, (kv "ada" $score)),
  where exactly one was required`. The Map adapter uses symbol keys, so the
  example now queries `S.ada`.
- Browser startup reported `EngineError: browser runtime manifest is missing
  lib/lib_builtin_types/lib_builtin_types.metta`. The package-entry correction
  removed this and its cascading `page.waitForSelector: Timeout 120000ms
  exceeded.` / `page.waitForFunction: Timeout 120000ms exceeded.` failures.
- The remaining browser assertion is `actual 'ERR_METTA_ENGINE'`,
  `expected 'ERR_METTA_CAPABILITY'`. Its message is `(hyperpose ...) is refused:
  this build does not have the concurrency capability, because library(thread)
  is absent. What that costs: (hyperpose ...), and lib_thread's par-map, spawn,
  await, channels, pools and blocking take-atom; this build evaluates on one
  thread.` The shared classifier is the source of the mismatch.
- The first evidence run reported `GATE FAILED: evidence` for 16 C citations.
  Those were repaired by the C owner. A later run resolved unquoted Node test
  names as unrelated file words: `tested: names answer in
  tests/prolog/reduced_platform_boot.pl, which no runner executes` and
  `tested: names uses in
  examples/ch20-extending-the-engine/20-04-modules-and-the-catalog/_fixtures/imports/import_order/uses.metta,
  which cannot report a failure: it holds no (test ...) or (assert ...) form`.
  Quoting the complete executed case names removed that ambiguity and the next
  run had zero findings globally. Pinning to the actual implementation commit
  exposed the checker defect above: `commit=484e554d80d0db7ed620d4ea609849fb0b81aadf
  does not resolve to a commit`. All 15 final findings have this same cause;
  none disputes the existence or execution of the cited case.

Local tooling also rejected unsupported record edits with `unknown node
fields: parent`, `'native-notation is not a proposition'`, and
`'boolean-callback' is a proposition, not an approach`. Recording claims and
an explicit completed repair approach used the supported interface. The detail
command also reported `the following arguments are required: --because` and
`is not readable as a record: Expecting value, at line 1 column 1` when given
`--file` instead of a positional document reference; the corrected reference
was accepted. An initial
llms.txt patch failed context verification and was reapplied against the read
file; no partial edit survived. Literal lookup typos produced `No such file or
directory (os error 2)` and `regex parse error: ... unclosed group`; source paths
and patterns were corrected before relying on their results.

The implementation reused the existing Node notation and shared engine seam.
Earlier local Node commits `db5a6f893647526481a04626e34bcb4a4a7fa023` and
`1218ffdd7530dff335b8a41b7772fba3ba4e2c2a` supplied live-query and scope-catcher
prior art. Their claims were rechecked against this checkout and the gates above.
The source and rationale record is the ignored `agenticmind.json` under the
`node-depth` goal. All edited and staged files belong to `extensions/node`.

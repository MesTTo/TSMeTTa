/**
 * Purpose: the package's whole public surface, as named exports.
 * Assumes:
 *   - named exports only, which is what lets the free word functions be
 *     re-exports and still tree-shake, and what the distribution law of
 *     `ai-typescript-design.md` requires
 * Guarantees:
 *   - nothing here has a side effect at import time: booting is a call, so
 *     `"sideEffects": false` is true of this package
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

// The atom algebra.
export {
  Atom,
  Expression,
  FloatAtom,
  G,
  Grounded,
  type Kind,
  SpaceHandle,
  Sym,
  type Term,
  type TermList,
  Var,
  byStandardOrder,
  expr,
  exprOf,
  float,
  fresh,
  internedCount,
  lift,
  mapTerm,
  registerRepr,
  unregisterRepr,
  space,
  substitute,
  sym,
  termVars,
  toAtom,
  variable,
} from "./atom.ts";

// The name doors.
export {
  type Applied,
  type Name,
  S,
  type SymFactory,
  type SymbolsOf,
  V,
  type VarFactory,
  type VarsOf,
  _,
  e,
  fn,
  list,
  nil,
  seg,
} from "./factories.ts";

// The word door and the case tower.
export {
  Accept,
  type Bound,
  CaseBuilder,
  Collapse,
  Drop,
  Empty,
  If,
  Let,
  LetStar,
  Match,
  ATOM_TYPE,
  FALSE,
  In,
  Quote,
  Refuse,
  Superpose,
  TRUE,
  UNDEFINED,
  UNIT,
  abs,
  add,
  and,
  arrow,
  carAtom,
  caseOf,
  cdrAtom,
  ceil,
  consAtom,
  div,
  eq,
  floor,
  getType,
  gt,
  gte,
  lt,
  lte,
  maxAtom,
  minAtom,
  mod,
  mul,
  ne,
  neg,
  not,
  or,
  pow,
  sqrt,
  sub,
  typed,
  unify,
  xor,
} from "./words.ts";

// Asks.
export {
  Answers,
  type AskOptions,
  Rows,
  type GoalRequest,
  type Plan,
  type Row,
  answersOf,
  errorOf,
  isError,
  isGoalRequest,
} from "./answers.ts";

// Spaces.
export {
  type Admission,
  type DerivationOptions,
  Space,
  type WaitOptions,
  type SpaceOptions,
  type WatchOptions,
  hostValue,
} from "./space.ts";

// Scopes.
export { type Limits, ScopeHandle, Stats, World } from "./scopes.ts";

// The definition doors.
export {
  type Defined,
  type DefineOptions,
  type Installer,
  type OpOptions,
  isTracing,
} from "./define/define.ts";
export { type Body, type Clause, type TracedGoal } from "./define/trace.ts";
export { type Lowered, type LowerScope, lower } from "./define/lower.ts";
export {
  type DefinitionFacts,
  type EffectSource,
  type FactsOptions,
  type SourceOrigin,
  type SourceSpan,
  definitionFacts,
  docOf,
  spanOf,
} from "./define/facts.ts";

// The surface.
export {
  type AnswerGroup,
  type BootOptions,
  type DirectiveStatus,
  type Form,
  MeTTa,
  type ReconcileReport,
  type StatusGroup,
  type StatusRow,
  type TraceEvent,
  type TraceOptions,
  mention,
  metta,
} from "./metta.ts";

// State.
export { State, type StateOptions, type Widen } from "./state.ts";

// Theories: equations grouped as a class.
export {
  type Door,
  type Marked,
  type TheoryClass,
  type TheoryMethod,
  equation,
  grounded,
  methodsOf,
  named,
  tabled,
} from "./theory.ts";

// The extension tier.
export { type Library, type LibraryHost, useLibrary } from "./library.ts";

// Schemas and validation.
export {
  Schema,
  type SchemaDeclarations,
  SchemaError,
  type StandardResult,
  type StandardSchemaV1,
  decodeWith,
  decodeWithAsync,
  parseType,
} from "./schema.ts";

// The naming map, so a program can ask what a name images to.
export { mapsExactly, mettaName, tsName } from "./naming.ts";

// The engine's own closed value sets that the core surface itself names. The
// other twenty-eight are the `metta-node/vocabularies` satellite, because a
// program that never mentions `agenda-policy` should not carry its table.
// Each name below is a frozen table AND the union of its values, because a
// `const` object carries both meanings: `EffectClass.oracleIO` is the word and
// `EffectClass` is the type of the five.
export {
  Delivery,
  EffectClass,
  EventOrder,
  Semiring,
  SpaceCapability,
  SubscriptionEdge,
  type VocabularyName,
  effectRank,
  joinEffects,
} from "./vocabularies.ts";

// Errors: one family, one base, one `code` per condition.
export {
  CapabilityError,
  CastError,
  AssertionError,
  ClosedError,
  type Code,
  CompileError,
  EngineError,
  InferenceLimitError,
  type MettaErrorOptions,
  MettaError,
  MettaSyntaxError,
  NameError,
  ProviderError,
  ResourceLimitError,
  ResultError,
  SourceNotFoundError,
  StackLimitError,
  SubscriberError,
  TimeLimitError,
  TransportError,
  UnsupportedError,
  WireError,
  branchFailure,
  engineError,
  isTransportError,
  nearest,
  unknownName,
} from "./errors.ts";

// The structural operations that need no engine: unification, one-way
// matching, alpha-canonical keys, renaming.
export {
  type Bindings,
  alphaCanonical,
  alphaEqual,
  alphaKey,
  isGround,
  matchTerms,
  nameAnonymous,
  renameVariables,
  unifies,
  unifyTerms,
} from "./matching.ts";

// Spaces implemented in TypeScript.
export {
  type Adder,
  CAPABILITIES,
  CUSTOM_MATCH,
  type Clearer,
  type CustomMatch,
  type DeliveryPromise,
  type Enumerable,
  type Matcher,
  type ProviderCapability,
  type Remover,
  type SpaceProvider,
  type Subscribable,
  capabilitiesOf,
  customMatchers,
  hasProvider,
  providerOf,
  providers,
  registerCustomMatch,
  registerProvider,
  requireCapability,
  unregisterCustomMatch,
  unregisterProvider,
} from "./provider.ts";

// The live view of a host collection, which is the shortest useful provider.
// The rest of the space algebra is the `metta-node/spaces` satellite.
export { view } from "./spaces.ts";

// Proofs.
export {
  type Builtin,
  Derivation,
  type Fact,
  type ProofNode,
  type Step,
  derivationOf,
  readable,
} from "./derivation.ts";

// Coordination, on the platform's own concurrency.
export {
  Channel,
  type ConcurrencyOptions,
  Task,
  every,
  merge,
  parMap,
  race,
  spawn,
} from "./parallel.ts";

// Standing queries, and the fold that carries state across them.
export { type EventStream, Fold, STATELESS, fold, publish, stream } from "./events.ts";
export {
  type Event,
  LiveView,
  SUBSCRIPTION_QUEUE_MAX,
  type SubscribeOptions,
  Subscription,
  subscribe,
} from "./subscribe.ts";

// The compensating-transaction journal.
export {
  Saga,
  compensates,
  compensations,
  saga,
} from "./saga.ts";

// Reader classes of the host's own, for a notation this engine should parse.
export {
  type TokenConstructor,
  construct,
  registerToken,
  tokens,
  unregisterToken,
} from "./tokens.ts";

// The presentation hook, for a caller extending this surface with handles of
// its own that should print as what they are.
export { showsAs } from "./present.ts";

// The seeded source everything here that draws draws from.
export { Random } from "./random.ts";

// The settings a process runs under, and the version it declares.
export { Config, type Setting, type Settings, config } from "./config.ts";
export { version } from "./version.ts";

// The two-way projection between a host value and an atom.
export {
  AUTO_TRANSPARENT_LIMIT,
  FROM_ATOM,
  IMAGES,
  type Image,
  type Projected,
  type Projection,
  type Registration,
  type SelfProjecting,
  TO_ATOM,
  type Transparency,
  autoImage,
  build,
  declarations,
  ensureRegistered,
  imageOf,
  isProjectable,
  project,
  projected,
  registerType,
  unregisterType,
} from "./convert.ts";

// The value carriers a program reads answers under. The declaration door, the
// law checks and the tagged-program evaluator are `metta-node/algebra`.
export {
  Algebra,
  Amplitude,
  type Carrier,
  Rational,
  type TaggedAnswer,
  counting,
  prob,
  prov,
  ranked,
  tropical,
} from "./algebra.ts";

// The engine layer, for a conformance kit and for a host that needs the floor.
export {
  type AdmissionEvent,
  type AnswerEvent,
  type Command,
  type Counters,
  type Capability,
  Engine,
  type EngineCounters,
  type GroupsEvent,
  Job,
  type JobEvent,
  type OpKind,
  packageRoot,
  repoRoot,
  type Scope,
  type ValueEvent,
  boot,
} from "./engine.ts";

// The codec.
export {
  HostValues,
  type Tag,
  type WireTokens,
  type Transport,
  type Wire,
  atomFromWire,
  decodeEngine,
  encodeEngine,
  fromRoundTrip,
  fromTransport,
  hostText,
  numberFromText,
  numberToText,
  toTransport,
  wireFromAtom,
} from "./wire.ts";

// Type-level readers, for a caller typing its own vocabulary.
export type {
  ArityError,
  Arity,
  ArrowArgs,
  ArrowArity,
  ArrowResult,
  CheckArity,
  Head,
  SchemaVars,
  SourceRow,
  SourceVars,
  Tokens,
} from "./types/sexpr.ts";

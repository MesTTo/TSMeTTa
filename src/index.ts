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
  mapTerm,
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
  type Bound,
  CaseBuilder,
  Collapse,
  Empty,
  If,
  Let,
  LetStar,
  Match,
  Quote,
  Superpose,
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
  type Grant,
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

// The surface.
export {
  type AnswerGroup,
  type BootOptions,
  MeTTa,
  type ReconcileReport,
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

// Errors.
export { type Code, PettaError, branchFailure, nearest } from "./errors.ts";

// The engine layer, for a conformance kit and for a host that needs the floor.
export {
  type AdmissionEvent,
  type AnswerEvent,
  type Command,
  type Counters,
  type EffectClass,
  Engine,
  type GroupsEvent,
  Job,
  type JobEvent,
  type OpKind,
  REFUSALS,
  type Refusal,
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
  type Transport,
  type Wire,
  atomFromWire,
  decodeEngine,
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

/**
 * Purpose: the engine's own closed value sets, as TypeScript unions, so a
 *   program that names one of these names it exactly and a typo is a compile
 *   error rather than an answer that never comes.
 * Assumes:
 *   - each block below is one `(vocabulary ...)` row in the `&metta` catalog,
 *     whose presets live in `engine/spaces/catalog.pl`
 * Guarantees:
 *   - every table here matches its catalog row exactly, values in the
 *     catalog's own order, and the test that checks it BOOTS the engine and
 *     reads `&metta` rather than reading a copy of this file, so the two
 *     cannot drift [tested: "every vocabulary here matches the engine's own"]
 *   - a value's KEY is this package's own casing map applied to the word, so
 *     `AnswerPolicy.bestFirst` is `"best-first"`, exactly as `S.bestFirst` is
 *     the symbol `best-first`. A word the map leaves alone keeps its exact
 *     spelling, which is why `OpKind.raw_det` carries an underscore the style
 *     guide would otherwise refuse: it is the engine's word, not an identifier
 *     this package chose
 * Decides: a frozen object plus a derived union type, not an `enum`. The
 *   package compiles under `erasableSyntaxOnly`, which refuses `enum` because
 *   an enum emits runtime code that type stripping cannot erase; the const
 *   object is the shape TypeScript's own documentation recommends in its
 *   place, and it has the property an enum lacks — the VALUES are the engine's
 *   own words, so a bare string still passes every door.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

/** The `ClauseFailedEnum` vocabulary, in the catalog's own order. */
export const ClauseFailedEnum = {
  ClauseFailNonDet: "ClauseFailNonDet",
  ClauseFailDet: "ClauseFailDet",
} as const;

/** One value of the `ClauseFailedEnum` vocabulary. */
export type ClauseFailedEnum = (typeof ClauseFailedEnum)[keyof typeof ClauseFailedEnum];

/** The `EvaluationOrderEnum` vocabulary, in the catalog's own order. */
export const EvaluationOrderEnum = {
  OrderClause: "OrderClause",
  OrderFittest: "OrderFittest",
} as const;

/** One value of the `EvaluationOrderEnum` vocabulary. */
export type EvaluationOrderEnum = (typeof EvaluationOrderEnum)[keyof typeof EvaluationOrderEnum];

/** The `FunctionResultEnum` vocabulary, in the catalog's own order. */
export const FunctionResultEnum = {
  Nondeterministic: "Nondeterministic",
  Deterministic: "Deterministic",
} as const;

/** One value of the `FunctionResultEnum` vocabulary. */
export type FunctionResultEnum = (typeof FunctionResultEnum)[keyof typeof FunctionResultEnum];

/** The `MismatchEnum` vocabulary, in the catalog's own order. */
export const MismatchEnum = {
  MismatchOriginal: "MismatchOriginal",
  MismatchError: "MismatchError",
  MismatchFail: "MismatchFail",
} as const;

/** One value of the `MismatchEnum` vocabulary. */
export type MismatchEnum = (typeof MismatchEnum)[keyof typeof MismatchEnum];

/** The `NoMatchEnum` vocabulary, in the catalog's own order. */
export const NoMatchEnum = {
  NoMatchOriginal: "NoMatchOriginal",
  NoMatchFail: "NoMatchFail",
  NoMatchError: "NoMatchError",
} as const;

/** One value of the `NoMatchEnum` vocabulary. */
export type NoMatchEnum = (typeof NoMatchEnum)[keyof typeof NoMatchEnum];

/** The `OutOfClausesEnum` vocabulary, in the catalog's own order. */
export const OutOfClausesEnum = {
  FailureOriginal: "FailureOriginal",
  FailureEmpty: "FailureEmpty",
  FailureError: "FailureError",
} as const;

/** One value of the `OutOfClausesEnum` vocabulary. */
export type OutOfClausesEnum = (typeof OutOfClausesEnum)[keyof typeof OutOfClausesEnum];

/** The `agenda-policy` vocabulary, in the catalog's own order. */
export const AgendaPolicy = {
  declaration: "declaration",
  recency: "recency",
  specificity: "specificity",
  priority: "priority",
  user: "user",
} as const;

/** One value of the `agenda-policy` vocabulary. */
export type AgendaPolicy = (typeof AgendaPolicy)[keyof typeof AgendaPolicy];

/** The `answer-policy` vocabulary, in the catalog's own order. */
export const AnswerPolicy = {
  depth: "depth",
  fair: "fair",
  bestFirst: "best-first",
} as const;

/** One value of the `answer-policy` vocabulary. */
export type AnswerPolicy = (typeof AnswerPolicy)[keyof typeof AnswerPolicy];

/** The `atomicity` vocabulary, in the catalog's own order. */
export const Atomicity = {
  transactional: "transactional",
  atomicSingle: "atomic-single",
  bestEffort: "best-effort",
} as const;

/** One value of the `atomicity` vocabulary. */
export type Atomicity = (typeof Atomicity)[keyof typeof Atomicity];

/** The `cache-mode` vocabulary, in the catalog's own order. */
export const CacheMode = {
  unchecked: "unchecked",
  force: "force",
  refuse: "refuse",
} as const;

/** One value of the `cache-mode` vocabulary. */
export type CacheMode = (typeof CacheMode)[keyof typeof CacheMode];

/** The `delivery` vocabulary, in the catalog's own order. */
export const Delivery = {
  atMostOnce: "at-most-once",
  atLeastOnce: "at-least-once",
  perWriteExactly: "per-write-exactly",
} as const;

/** One value of the `delivery` vocabulary. */
export type Delivery = (typeof Delivery)[keyof typeof Delivery];

/** The `determinism` vocabulary, in the catalog's own order. */
export const Determinism = {
  det: "det",
  semidet: "semidet",
  nondet: "nondet",
} as const;

/** One value of the `determinism` vocabulary. */
export type Determinism = (typeof Determinism)[keyof typeof Determinism];

/** The `effect-class` vocabulary, in the catalog's own order. */
export const EffectClass = {
  pureStructural: "pureStructural",
  readOnlyLookup: "readOnlyLookup",
  nondeterministicReadOnly: "nondeterministicReadOnly",
  writesState: "writesState",
  oracleIO: "oracleIO",
} as const;

/** One value of the `effect-class` vocabulary. */
export type EffectClass = (typeof EffectClass)[keyof typeof EffectClass];

/** The `event-order` vocabulary, in the catalog's own order. */
export const EventOrder = {
  ordered: "ordered",
  unordered: "unordered",
} as const;

/** One value of the `event-order` vocabulary. */
export type EventOrder = (typeof EventOrder)[keyof typeof EventOrder];

/** The `fidelity` vocabulary, in the catalog's own order. */
export const Fidelity = {
  Exact: "Exact",
  Partial: "Partial",
  Sound: "Sound",
  Refuse: "Refuse",
} as const;

/** One value of the `fidelity` vocabulary. */
export type Fidelity = (typeof Fidelity)[keyof typeof Fidelity];

/** The `image-mode` vocabulary, in the catalog's own order. */
export const ImageMode = {
  opaque: "opaque",
  transparent: "transparent",
  auto: "auto",
} as const;

/** One value of the `image-mode` vocabulary. */
export type ImageMode = (typeof ImageMode)[keyof typeof ImageMode];

/** The `memo-aggregate` vocabulary, in the catalog's own order. */
export const MemoAggregate = {
  none: "none",
  min: "min",
  max: "max",
  sum: "sum",
  count: "count",
} as const;

/** One value of the `memo-aggregate` vocabulary. */
export type MemoAggregate = (typeof MemoAggregate)[keyof typeof MemoAggregate];

/** The `memo-strategy` vocabulary, in the catalog's own order. */
export const MemoStrategy = {
  wtinylfu: "wtinylfu",
  lru: "lru",
} as const;

/** One value of the `memo-strategy` vocabulary. */
export type MemoStrategy = (typeof MemoStrategy)[keyof typeof MemoStrategy];

/** The `numeric-type` vocabulary, in the catalog's own order. */
export const NumericType = {
  Number: "Number",
  BigInt: "BigInt",
} as const;

/** One value of the `numeric-type` vocabulary. */
export type NumericType = (typeof NumericType)[keyof typeof NumericType];

/** The `on-error-mode` vocabulary, in the catalog's own order. */
export const OnErrorMode = {
  keep: "keep",
  empty: "empty",
  abort: "abort",
} as const;

/** One value of the `on-error-mode` vocabulary. */
export type OnErrorMode = (typeof OnErrorMode)[keyof typeof OnErrorMode];

/** The `op-kind` vocabulary, in the catalog's own order. */
export const OpKind = {
  det: "det",
  many: "many",
  async: "async",
  raw_det: "raw_det",
  raw_many: "raw_many",
} as const;

/** One value of the `op-kind` vocabulary. */
export type OpKind = (typeof OpKind)[keyof typeof OpKind];

/** The `registry-image` vocabulary, in the catalog's own order. */
export const RegistryImage = {
  expression: "expression",
  symbol: "symbol",
  handle: "handle",
  operations: "operations",
} as const;

/** One value of the `registry-image` vocabulary. */
export type RegistryImage = (typeof RegistryImage)[keyof typeof RegistryImage];

/** The `route-key` vocabulary, in the catalog's own order. */
export const RouteKey = {
  context: "context",
  global: "global",
} as const;

/** One value of the `route-key` vocabulary. */
export type RouteKey = (typeof RouteKey)[keyof typeof RouteKey];

/** The `save-format` vocabulary, in the catalog's own order. */
export const SaveFormat = {
  metta: "metta",
  fast: "fast",
} as const;

/** One value of the `save-format` vocabulary. */
export type SaveFormat = (typeof SaveFormat)[keyof typeof SaveFormat];

/** The `semiring` vocabulary, in the catalog's own order. */
export const Semiring = {
  bool: "bool",
  bag: "bag",
  counting: "counting",
  set: "set",
  ranked: "ranked",
  tropical: "tropical",
  prob: "prob",
  prov: "prov",
} as const;

/** One value of the `semiring` vocabulary. */
export type Semiring = (typeof Semiring)[keyof typeof Semiring];

/** The `semiring-order` vocabulary, in the catalog's own order. */
export const SemiringOrder = {
  ascending: "ascending",
  descending: "descending",
} as const;

/** One value of the `semiring-order` vocabulary. */
export type SemiringOrder = (typeof SemiringOrder)[keyof typeof SemiringOrder];

/** The `source-kind` vocabulary, in the catalog's own order. */
export const SourceKind = {
  linear: "linear",
  repeated: "repeated",
  peek: "peek",
} as const;

/** One value of the `source-kind` vocabulary. */
export type SourceKind = (typeof SourceKind)[keyof typeof SourceKind];

/** The `space-capability` vocabulary, in the catalog's own order. */
export const SpaceCapability = {
  file: "file",
  process: "process",
  network: "network",
} as const;

/** One value of the `space-capability` vocabulary. */
export type SpaceCapability = (typeof SpaceCapability)[keyof typeof SpaceCapability];

/** The `subscription-edge` vocabulary, in the catalog's own order. */
export const SubscriptionEdge = {
  add: "add",
  remove: "remove",
  both: "both",
} as const;

/** One value of the `subscription-edge` vocabulary. */
export type SubscriptionEdge = (typeof SubscriptionEdge)[keyof typeof SubscriptionEdge];

/** The `visibility` vocabulary, in the catalog's own order. */
export const Visibility = {
  PUBLIC: "PUBLIC",
  INTERNAL: "INTERNAL",
} as const;

/** One value of the `visibility` vocabulary. */
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

/** The `volatility` vocabulary, in the catalog's own order. */
export const Volatility = {
  volatile: "volatile",
  stable: "stable",
  immutable: "immutable",
} as const;

/** One value of the `volatility` vocabulary. */
export type Volatility = (typeof Volatility)[keyof typeof Volatility];

/** The `world` vocabulary, in the catalog's own order. */
export const World = {
  closedWorld: "closed-world",
  openWorld: "open-world",
} as const;

/** One value of the `world` vocabulary. */
export type World = (typeof World)[keyof typeof World];

/**
 * Every vocabulary, by the engine's own name for it.
 *
 * The reflection door: a tool that must enumerate the closed sets reads this
 * rather than a list it keeps itself, and the sync test walks it against
 * `&metta`.
 */
export interface Vocabularies {
  readonly "ClauseFailedEnum": typeof ClauseFailedEnum;
  readonly "EvaluationOrderEnum": typeof EvaluationOrderEnum;
  readonly "FunctionResultEnum": typeof FunctionResultEnum;
  readonly "MismatchEnum": typeof MismatchEnum;
  readonly "NoMatchEnum": typeof NoMatchEnum;
  readonly "OutOfClausesEnum": typeof OutOfClausesEnum;
  readonly "agenda-policy": typeof AgendaPolicy;
  readonly "answer-policy": typeof AnswerPolicy;
  readonly "atomicity": typeof Atomicity;
  readonly "cache-mode": typeof CacheMode;
  readonly "delivery": typeof Delivery;
  readonly "determinism": typeof Determinism;
  readonly "effect-class": typeof EffectClass;
  readonly "event-order": typeof EventOrder;
  readonly "fidelity": typeof Fidelity;
  readonly "image-mode": typeof ImageMode;
  readonly "memo-aggregate": typeof MemoAggregate;
  readonly "memo-strategy": typeof MemoStrategy;
  readonly "numeric-type": typeof NumericType;
  readonly "on-error-mode": typeof OnErrorMode;
  readonly "op-kind": typeof OpKind;
  readonly "registry-image": typeof RegistryImage;
  readonly "route-key": typeof RouteKey;
  readonly "save-format": typeof SaveFormat;
  readonly "semiring": typeof Semiring;
  readonly "semiring-order": typeof SemiringOrder;
  readonly "source-kind": typeof SourceKind;
  readonly "space-capability": typeof SpaceCapability;
  readonly "subscription-edge": typeof SubscriptionEdge;
  readonly "visibility": typeof Visibility;
  readonly "volatility": typeof Volatility;
  readonly "world": typeof World;
}

/** Every vocabulary, by the engine's own name for it. */
export const VOCABULARIES: Vocabularies = {
  "ClauseFailedEnum": ClauseFailedEnum,
  "EvaluationOrderEnum": EvaluationOrderEnum,
  "FunctionResultEnum": FunctionResultEnum,
  "MismatchEnum": MismatchEnum,
  "NoMatchEnum": NoMatchEnum,
  "OutOfClausesEnum": OutOfClausesEnum,
  "agenda-policy": AgendaPolicy,
  "answer-policy": AnswerPolicy,
  "atomicity": Atomicity,
  "cache-mode": CacheMode,
  "delivery": Delivery,
  "determinism": Determinism,
  "effect-class": EffectClass,
  "event-order": EventOrder,
  "fidelity": Fidelity,
  "image-mode": ImageMode,
  "memo-aggregate": MemoAggregate,
  "memo-strategy": MemoStrategy,
  "numeric-type": NumericType,
  "on-error-mode": OnErrorMode,
  "op-kind": OpKind,
  "registry-image": RegistryImage,
  "route-key": RouteKey,
  "save-format": SaveFormat,
  "semiring": Semiring,
  "semiring-order": SemiringOrder,
  "source-kind": SourceKind,
  "space-capability": SpaceCapability,
  "subscription-edge": SubscriptionEdge,
  "visibility": Visibility,
  "volatility": Volatility,
  "world": World,
};

/** One vocabulary's engine name. */
export type VocabularyName = keyof Vocabularies;

/** Every value of one vocabulary, in the catalog's own order. */
export function valuesOf(vocabulary: VocabularyName): readonly string[] {
  return Object.values(VOCABULARIES[vocabulary]);
}

/** Whether a word is a value of one vocabulary. */
export function isValueOf(vocabulary: VocabularyName, word: string): boolean {
  return valuesOf(vocabulary).includes(word);
}

/**
 * How strong an effect class is, from structural purity to host I/O.
 *
 * The catalog declares the five in RANK ORDER, so the position in the row is
 * the rank and nothing here restates it.
 */
export function effectRank(effect: EffectClass): number {
  return valuesOf("effect-class").indexOf(effect);
}

/**
 * The strongest of several effect classes: the lattice join.
 *
 * A plan's effect is the strongest effect any step of it has, which is what
 * makes this a join rather than a sum. With no arguments the answer is the
 * bottom of the lattice, `pureStructural`, because a plan that does nothing
 * has no effect.
 */
export function joinEffects(...effects: readonly EffectClass[]): EffectClass {
  let strongest: EffectClass = EffectClass.pureStructural;
  for (const effect of effects) {
    if (effectRank(effect) > effectRank(strongest)) strongest = effect;
  }
  return strongest;
}

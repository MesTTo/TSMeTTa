/**
 * Purpose: numeric arrays as atoms. A typed array crosses by REFERENCE with
 *   its identity intact, carries a type the engine can dispatch on, and prints
 *   as its shape and element type rather than as a wall of numbers.
 * Assumes:
 *   - the platform's own `TypedArray` family is the recognition boundary here,
 *     the way DLPack is on the Python side: it is what every numeric library
 *     in this runtime already produces, and it needs no protocol negotiation
 * Guarantees:
 *   - an array crosses and comes back as the VERY SAME object, so a reduction
 *     that passes one through has not copied a megabyte
 *     [tested: "crosses by reference, with identity"]
 *   - the operations are pure with respect to their input: none of them writes
 *     into an array it was given, so an array in a space is not changed by
 *     being queried [tested: "never writes into an array it was given"]
 *   - `shape`, `dtype` and `size` answer without touching the elements, so
 *     asking about a large array costs nothing
 *   - `topIndices` retains only k candidates in a stable bounded heap, then
 *     sorts that prefix once: O(n log k + k log k) time and O(k) space
 *     [tested: "matches a full stable top-k order across bounds and non-finite scores",
 *     "sorts only the retained top-k prefix after one streaming pass"; commit=6b5caa45cc0abc8b2d396c0614e22f427678be4b]
 *   - `EmbeddingStore.remove` does not move or rewrite survivors; key order,
 *     equal-score result order and survivor identity stay intact
 *     [tested: "removes from the ordered index without rewriting every later
 *     key", "resets its width after the last removal";
 *     commit=4a81aa55810a9a40bb501e77f3304d21b658279b]
 *   - front-removal cost stays flat from 10,000 to 200,000 entries
 *     [measured: old median 0.137769 ms then 4.140005 ms; ordered Map median
 *     0.000330 ms then 0.000290 ms; command=node
 *     ai-tmp/state-crash-embedding-remove-bench.mjs baseline 10000 && node
 *     ai-tmp/state-crash-embedding-remove-bench.mjs current 10000 && node
 *     ai-tmp/state-crash-embedding-remove-bench.mjs baseline 200000 && node
 *     ai-tmp/state-crash-embedding-remove-bench.mjs current 200000;
 *     fixture=101 front removals per size on Node 22.22.1;
 *     commit=4a81aa55810a9a40bb501e77f3304d21b658279b]
 * Decides: a MATRIX is a typed array plus a shape, held beside it rather than
 *   inside it, because a `Float64Array` has one dimension and inventing a
 *   subclass to carry another would make every library's array the wrong kind.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { Atom, G, type Term, expr, registerRepr, sym, toAtom } from "./atom.ts";
import { MettaError } from "./errors.ts";
import type { Defined } from "./define/define.ts";
import type { MeTTa } from "./metta.ts";
import { showsAs } from "./present.ts";
import { type Space, hostValue } from "./space.ts";

/** Every typed array the platform has. */
export type NumericArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

/** The element type, in the name its constructor carries. */
export type Dtype =
  | "int8"
  | "uint8"
  | "uint8clamped"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "float32"
  | "float64"
  | "int64"
  | "uint64";

const DTYPES = new Map<Function, Dtype>([
  [Int8Array, "int8"],
  [Uint8Array, "uint8"],
  [Uint8ClampedArray, "uint8clamped"],
  [Int16Array, "int16"],
  [Uint16Array, "uint16"],
  [Int32Array, "int32"],
  [Uint32Array, "uint32"],
  [Float32Array, "float32"],
  [Float64Array, "float64"],
  [BigInt64Array, "int64"],
  [BigUint64Array, "uint64"],
]);

/** Whether a value is one of the platform's typed arrays. */
export function isArray(value: unknown): value is NumericArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/** The element type of an array, or a refusal naming what it got. */
export function dtypeOf(array: NumericArray): Dtype {
  const found = DTYPES.get(array.constructor);
  if (found === undefined) throw new MettaError(`${String(array.constructor.name)} is not a typed array`);
  return found;
}

/** How many elements an array holds. Reads no element. */
export function sizeOf(array: NumericArray): number {
  return array.length;
}

/**
 * An array with a shape, for the dimensions a typed array does not have.
 *
 * The array itself is untouched and shared: a tensor is a READING of one, so
 * two tensors may share elements and neither owns them.
 */
export class Tensor {
  /** The elements, in row-major order. */
  readonly data: NumericArray;
  /** The extent of each dimension, outermost first. */
  readonly shape: readonly number[];

  constructor(data: NumericArray, shape: readonly number[] = [data.length]) {
    const total = shape.reduce((product, each) => product * each, 1);
    if (total !== data.length) {
      throw new MettaError(
        `a shape of [${shape.join(", ")}] wants ${String(total)} elements and this array ` +
          `has ${String(data.length)}`,
      );
    }
    this.data = data;
    this.shape = Object.freeze([...shape]);
    Object.freeze(this);
  }

  /** The element type. */
  get dtype(): Dtype {
    return dtypeOf(this.data);
  }

  /** How many elements there are. */
  get size(): number {
    return this.data.length;
  }

  /** How many dimensions there are. */
  get rank(): number {
    return this.shape.length;
  }

  /** One element, by its index in each dimension. */
  at(...index: readonly number[]): number | bigint {
    if (index.length !== this.shape.length) {
      throw new MettaError(
        `this tensor has ${String(this.shape.length)} dimensions and ${String(index.length)} ` +
          `indices were given`,
      );
    }
    let at = 0;
    for (let dimension = 0; dimension < index.length; dimension += 1) {
      const extent = this.shape[dimension] as number;
      const position = index[dimension] as number;
      if (position < 0 || position >= extent) {
        throw new MettaError(
          `index ${String(position)} is outside dimension ${String(dimension)} of ` +
            `extent ${String(extent)}`,
        );
      }
      at = at * extent + position;
    }
    return this.data[at] as number | bigint;
  }

  /**
   * The same elements, read under another shape.
   *
   * A VIEW: it shares the array, so reshaping a hundred megabytes costs
   * nothing and neither reading owns the elements.
   */
  reshape(...shape: readonly number[]): Tensor {
    return new Tensor(this.data, shape);
  }

  /** Every element as an ordinary array, which COPIES. */
  toArray(): (number | bigint)[] {
    return [...this.data];
  }

  /** The type atom the engine dispatches on: `(Tensor <dtype> <extent>...)`. */
  get type(): Atom {
    return expr(sym("Tensor"), sym(this.dtype), ...this.shape.map((extent) => G(extent)));
  }

  toString(): string {
    return `Tensor(${this.dtype}[${this.shape.join(" x ")}])`;
  }
}

showsAs(Tensor.prototype, (tensor: Tensor) => tensor.toString());

// An array prints as what it IS rather than as `(js Float64Array)`, which
// tells a reader nothing about the thing they are looking at.
for (const [constructor, dtype] of DTYPES) {
  registerRepr(constructor as abstract new (...args: never[]) => NumericArray, (array) =>
    `(array ${dtype} ${String(array.length)})`,
  );
}
registerRepr(Tensor, (tensor) => `(tensor ${tensor.dtype} ${tensor.shape.join(" ")})`);

/** The operations a program reaches for, each pure in its input. */
export const ARRAY_OPS = {
  /** How many elements. */
  arraySize: (array: NumericArray): number => array.length,
  /** The element type, as a symbol. */
  arrayDtype: (array: NumericArray): string => dtypeOf(array),
  /** One element, by index. */
  arrayAt: (array: NumericArray, at: number): number | bigint => {
    const held = array[at];
    if (held === undefined) throw new MettaError(`index ${String(at)} is outside this array`);
    return held;
  },
  /** A COPY of one contiguous run, so the original is never aliased by accident. */
  arraySlice: (array: NumericArray, from: number, to: number): NumericArray =>
    array.slice(from, to) as NumericArray,
  /** The sum, in the platform's own arithmetic. */
  arraySum: (array: NumericArray): number => {
    let total = 0;
    for (const each of array) total += Number(each);
    return total;
  },
  /** The largest element. */
  arrayMax: (array: NumericArray): number => {
    if (array.length === 0) throw new MettaError("an empty array has no largest element");
    let best = Number(array[0]);
    for (const each of array) best = Math.max(best, Number(each));
    return best;
  },
  /** The smallest element. */
  arrayMin: (array: NumericArray): number => {
    if (array.length === 0) throw new MettaError("an empty array has no smallest element");
    let best = Number(array[0]);
    for (const each of array) best = Math.min(best, Number(each));
    return best;
  },
} as const;

/**
 * Install the array operations, so a MeTTa program reaches into an array.
 *
 * ```ts
 * installArrays(m);
 * const scores = new Float64Array([3, 1, 4]);
 * await m.eval(S["array-max"](G(scores))).one();     // 4
 * ```
 *
 * The array itself never crosses: the engine holds a reference and every
 * operation runs here, which is what keeps a hundred megabytes on this side of
 * the wire.
 */
export function installArrays(surface: MeTTa): Defined[] {
  return Object.entries(ARRAY_OPS).map(([name, body]) =>
    surface.op(body as unknown as (...args: never[]) => unknown, {
      name: name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
      effect: "pureStructural",
    }),
  );
}

/**
 * The k largest elements' indices, best first, ties by position.
 *
 * A WORST-at-root bounded heap: each finite score takes at most log k work,
 * and only the retained prefix is sorted best-first at the end. Ties keep the
 * earlier position, so the result is stable without sorting all n scores.
 */
export function topIndices(array: NumericArray, k: number): number[] {
  if (k <= 0) return [];
  const best: RankedIndex[] = [];
  for (let at = 0; at < array.length; at += 1) {
    const value = Number(array[at]);
    if (!Number.isFinite(value)) continue;
    const candidate = { at, value };
    if (best.length < k) {
      pushWorstHeap(best, candidate);
      continue;
    }
    const worst = best[0] as RankedIndex;
    if (bestFirst(candidate, worst) >= 0) continue;
    replaceWorst(best, candidate);
  }
  return best.sort(bestFirst).map((each) => each.at);
}

interface RankedIndex {
  readonly at: number;
  readonly value: number;
}

/** Best score first, preserving the earlier input position on a tie. */
function bestFirst(left: RankedIndex, right: RankedIndex): number {
  return right.value - left.value || left.at - right.at;
}

/** Add one candidate while keeping the heap's worst candidate at its root. */
function pushWorstHeap(heap: RankedIndex[], candidate: RankedIndex): void {
  let at = heap.length;
  heap.push(candidate);
  while (at > 0) {
    const parent = Math.floor((at - 1) / 2);
    const held = heap[parent] as RankedIndex;
    if (bestFirst(candidate, held) <= 0) break;
    heap[at] = held;
    at = parent;
  }
  heap[at] = candidate;
}

/** Replace the root with a better candidate and restore the worst-root invariant. */
function replaceWorst(heap: RankedIndex[], candidate: RankedIndex): void {
  let at = 0;
  for (;;) {
    const left = at * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const worse =
      right < heap.length && bestFirst(heap[right] as RankedIndex, heap[left] as RankedIndex) > 0
        ? right
        : left;
    const child = heap[worse] as RankedIndex;
    if (bestFirst(child, candidate) <= 0) break;
    heap[at] = child;
    at = worse;
  }
  heap[at] = candidate;
}

/** One hit of a nearest-neighbour search. */
export interface Neighbour {
  /** The key the vector was stored under. */
  readonly key: Atom;
  /** Cosine similarity with the query, in [-1, 1]. */
  readonly score: number;
}

/** What an {@link EmbeddingStore} accepts. */
export interface EmbeddingStoreOptions {
  /** The prefix its two operations take. `emb` by default. */
  readonly name?: string;
  /** Whether each vector also lands in the space as `(embedding key vector)`. */
  readonly mirror?: boolean;
  /** Where a mirrored fact goes. The engine's own self space, by default. */
  readonly space?: Space;
}

/**
 * Vectors by key, searchable from MeTTa.
 *
 * ```ts
 * using store = new EmbeddingStore(m, { name: "emb" });
 * store.add(S.dog, new Float64Array([1, 0]));
 * store.add(S.cat, new Float64Array([0.9, 0.1]));
 * await m.eval(S["emb-knn"](G(new Float64Array([1, 0])), 1)).toArray();  // (dog)
 * ```
 *
 * `add` has MAP semantics: adding a key that is already there replaces its
 * vector in its first-seen position, so the store never grows two entries for
 * one thing. `(<name>-knn $query $k)` is nondeterministic retrieval, best
 * first; `(<name>-embed $key)` answers the stored vector or nothing.
 *
 * An insertion-ordered map owns the vectors. They are copied into one
 * contiguous row-major buffer, rebuilt lazily after a write, and each row's
 * norm is kept beside it. A query is then one pass of `n * width`
 * multiply-adds over that buffer with no per-vector indirection, and the norms
 * are not recomputed per query.
 */
export class EmbeddingStore implements Disposable {
  // Map replacement preserves an entry's position; delete followed by set
  // appends it. Node implements the specified order with an ordered hash table
  // whose delete finds one bucket entry and marks that entry as a hole.
  // https://tc39.es/ecma262/2026/multipage/keyed-collections.html#sec-map.prototype.set
  // https://github.com/v8/v8/blob/f2f944440cd96ec11dd85e2dd2f79326fd750835/src/objects/ordered-hash-table.cc
  readonly #entries = new Map<Atom, Float64Array>();
  readonly #installed: Defined[];
  readonly #mirror: boolean;
  readonly #space: Space;
  #keyOrder: readonly Atom[] | undefined;
  #matrix: Float64Array | undefined;
  #norms: Float64Array | undefined;
  #width: number | undefined;

  constructor(surface: MeTTa, options: EmbeddingStoreOptions = {}) {
    const name = options.name ?? "emb";
    this.#mirror = options.mirror ?? true;
    this.#space = options.space ?? surface.self;
    const store = this;
    this.#installed = [
      surface.op(
        function* knn(query: unknown, k: unknown): Generator<Atom> {
          for (const found of store.search(asVector(query), Number(k))) yield found.key;
        } as (...args: never[]) => unknown,
        { name: `${name}-knn`, effect: "nondeterministicReadOnly" },
      ),
      surface.op(
        function embed(key: Atom): unknown {
          return store.get(key) ?? null;
        } as (...args: never[]) => unknown,
        { name: `${name}-embed`, effect: "readOnlyLookup", raw: true },
      ),
    ];
  }

  /** How many keys are stored. */
  get size(): number {
    return this.#entries.size;
  }

  /** The width every vector has, or undefined while the store is empty. */
  get width(): number | undefined {
    return this.#width;
  }

  /** Every key, in first-seen order. */
  get keys(): readonly Atom[] {
    return this.#orderedKeys();
  }

  /** Store one vector, replacing whatever that key held. */
  add(key: Term, vector: NumericArray | readonly number[]): void {
    const atom = toAtom(key);
    const held = asVector(vector);
    if (this.#width === undefined) this.#width = held.length;
    else if (held.length !== this.#width) {
      throw new MettaError(
        `this store holds vectors of width ${String(this.#width)} and this one has ` +
          `${String(held.length)}`,
      );
    }
    const previous = this.#entries.get(atom);
    if (previous === undefined) {
      this.#entries.set(atom, held);
      this.#keyOrder = undefined;
    } else {
      if (this.#mirror) {
        this.#space.delete(expr(sym("embedding"), atom, G(previous)));
      }
      this.#entries.set(atom, held);
    }
    this.#matrix = undefined;
    this.#norms = undefined;
    if (this.#mirror) this.#space.add(expr(sym("embedding"), atom, G(held)));
  }

  /** The vector one key holds, or undefined. */
  get(key: Term): Float64Array | undefined {
    return this.#entries.get(toAtom(key));
  }

  /** Forget one key. Answers whether it was there. */
  remove(key: Term): boolean {
    const atom = toAtom(key);
    const held = this.#entries.get(atom);
    if (held === undefined) return false;
    if (this.#mirror) {
      this.#space.delete(expr(sym("embedding"), atom, G(held)));
    }
    this.#entries.delete(atom);
    this.#keyOrder = undefined;
    this.#matrix = undefined;
    this.#norms = undefined;
    if (this.#entries.size === 0) this.#width = undefined;
    return true;
  }

  /** The k nearest keys to a query, best first, by cosine similarity. */
  search(query: NumericArray | readonly number[], k = 1): Neighbour[] {
    if (!Number.isInteger(k) || k <= 0) {
      throw new MettaError(`k is a positive whole number of neighbours, not ${String(k)}`);
    }
    const asked = asVector(query);
    if (this.#entries.size === 0) return [];
    if (this.#width !== undefined && asked.length !== this.#width) {
      throw new MettaError(
        `this store holds vectors of width ${String(this.#width)} and the query has ` +
          `${String(asked.length)}`,
      );
    }
    const { keys, matrix, norms } = this.#packed();
    const width = this.#width ?? 0;
    let queryNorm = 0;
    for (let at = 0; at < asked.length; at += 1) queryNorm += (asked[at] as number) ** 2;
    queryNorm = Math.sqrt(queryNorm);
    const scores = new Float64Array(keys.length);
    for (let row = 0; row < keys.length; row += 1) {
      let dot = 0;
      const base = row * width;
      for (let at = 0; at < width; at += 1) {
        dot += (matrix[base + at] as number) * (asked[at] as number);
      }
      // Neither norm can be zero: `checked` refuses a zero vector at the door,
      // which is what makes this division safe rather than guarded.
      scores[row] = dot / (queryNorm * (norms[row] as number));
    }
    return topIndices(scores, k).map((at) => ({
      key: keys[at] as Atom,
      score: scores[at] as number,
    }));
  }

  /** Forget everything, mirrored facts included. */
  clear(): void {
    if (this.#mirror) {
      for (const [key, vector] of this.#entries) {
        this.#space.delete(expr(sym("embedding"), key, G(vector)));
      }
    }
    this.#entries.clear();
    this.#keyOrder = undefined;
    this.#matrix = undefined;
    this.#norms = undefined;
    this.#width = undefined;
  }

  /** Remove the two operations this installed. */
  close(): void {
    for (const each of this.#installed) each.forget();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #orderedKeys(): readonly Atom[] {
    const held = this.#keyOrder;
    if (held !== undefined) return held;
    const built = Object.freeze([...this.#entries.keys()]);
    this.#keyOrder = built;
    return built;
  }

  #packed(): { keys: readonly Atom[]; matrix: Float64Array; norms: Float64Array } {
    const keys = this.#orderedKeys();
    const held = this.#matrix;
    const norms = this.#norms;
    if (held !== undefined && norms !== undefined) return { keys, matrix: held, norms };
    const width = this.#width ?? 0;
    const built = new Float64Array(keys.length * width);
    const lengths = new Float64Array(keys.length);
    let row = 0;
    for (const vector of this.#entries.values()) {
      built.set(vector, row * width);
      let total = 0;
      for (let at = 0; at < width; at += 1) total += (vector[at] as number) ** 2;
      lengths[row] = Math.sqrt(total);
      row += 1;
    }
    this.#matrix = built;
    this.#norms = lengths;
    return { keys, matrix: built, norms: lengths };
  }

  toString(): string {
    return `EmbeddingStore(${String(this.#entries.size)} x ${String(this.#width ?? 0)})`;
  }
}

showsAs(EmbeddingStore.prototype, (held: EmbeddingStore) => held.toString());

/**
 * One vector as the store holds them: a COPY, so a caller that reuses its own
 * buffer for the next vector does not change the one already stored.
 */
function asVector(value: unknown): Float64Array {
  if (isArray(value)) return checked(Float64Array.from(value as ArrayLike<number>));
  if (Array.isArray(value)) return checked(Float64Array.from(value as readonly number[]));
  if (value instanceof Tensor) {
    if (value.rank !== 1) {
      throw new MettaError(
        `embedding vectors are one-dimensional and this tensor has shape [${value.shape.join(", ")}]`,
      );
    }
    return asVector(value.data);
  }
  const held = value instanceof Atom ? hostValue(value) : value;
  if (held !== value) return asVector(held);
  throw new MettaError(`expected a numeric array, got ${String(value)}`);
}

/**
 * A vector this store can actually search with.
 *
 * A non-finite element makes every score it touches NaN, and a zero vector has
 * no direction, so cosine similarity is undefined for both. Refusing at the
 * door names the vector; allowing it would produce a silently empty ranking.
 */
function checked(vector: Float64Array): Float64Array {
  let total = 0;
  for (let at = 0; at < vector.length; at += 1) {
    const held = vector[at] as number;
    if (!Number.isFinite(held)) {
      throw new MettaError(`embedding vectors are finite and element ${String(at)} is ${String(held)}`);
    }
    total += held * held;
  }
  if (vector.length === 0 || total === 0) {
    throw new MettaError("an embedding vector has a direction, and a zero vector has none");
  }
  return vector;
}

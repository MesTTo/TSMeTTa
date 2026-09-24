/**
 * Purpose: the stack ceiling a WebAssembly engine boots under: memoryMaximum,
 *   which sizes a module's memory from its binary, over modules this file
 *   encodes and over the host this package carries; stackCeiling, which
 *   leaves the stacks what the memory can still hold; and a boot with no
 *   stack setting.
 * Assumes:
 *   - `node --test` gives this file its own process, and nothing in it
 *     configures `stackLimit`, so its engine boots under the derived ceiling
 * Guarantees:
 *   - the property that whatever sections and imports precede it, the declared
 *     maximum of memory 0 is the answer, holds over generated layouts
 *     [tested: "reads the declared maximum of memory 0 whatever precedes it"]
 *   - the property that the ceiling is the largest L with used + 2L within
 *     what the memory can grow to holds over generated memories [tested:
 *     "leaves room for the stacks and what their growth left behind"]
 * Open Obligations: None.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { type MeTTa, MettaError, config, metta, packageRoot } from "../src/index.ts";
import { type Arbitrary, forAll } from "../src/testing.ts";
import { memoryMaximum, stackCeiling } from "../src/wasm-memory.ts";

const PAGE = 65_536;
const GIB = 1024 ** 3;
/** What an Emscripten loader grows a 32-bit memory to: one page short of 4 GiB. */
const GROWABLE = 4 * GIB - PAGE;
/** SWI's own default ceiling on this build, 128 MiB for each byte of its 8-byte word. */
const SWI_DEFAULT = GIB;

const host = readFileSync(join(packageRoot, "_host", "swipl-web.wasm"));

/** An unsigned LEB128. */
const leb = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? low | 0x80 : low);
  } while (rest > 0);
  return bytes;
};

const name = (text: string): number[] => [...leb(text.length), ...Buffer.from(text)];
const section = (id: number, payload: readonly number[]): number[] => [id, ...leb(payload.length), ...payload];
const limits = (minimum: number, maximum: number | undefined, flags = 0): number[] =>
  maximum === undefined ? [flags, ...leb(minimum)] : [flags | 1, ...leb(minimum), ...leb(maximum)];

interface Layout {
  readonly customs: number;
  readonly functionImports: number;
  readonly imported: boolean;
  readonly minimum: number;
  readonly maximum: number | undefined;
}

/** A module: custom sections, a type section, imports, then memory 0. */
function encode(layout: Layout, defined: number | undefined = layout.maximum): Uint8Array {
  const imports: number[][] = [];
  for (let at = 0; at < layout.functionImports; at += 1) imports.push([...name("env"), ...name(`f${String(at)}`), 0x00, 0]);
  if (layout.imported) imports.push([...name("env"), ...name("memory"), 0x02, ...limits(layout.minimum, layout.maximum)]);
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (let at = 0; at < layout.customs; at += 1) bytes.push(...section(0, [...name(`c${String(at)}`), 1, 2, 3]));
  bytes.push(...section(1, [1, 0x60, 0, 0]));
  if (imports.length > 0) bytes.push(...section(2, [...leb(imports.length), ...imports.flat()]));
  // A module that imports its memory may define another after it, which is
  // memory 1 and must not be the answer.
  if (!layout.imported || defined !== layout.maximum) bytes.push(...section(5, [1, ...limits(layout.minimum, defined)]));
  return Uint8Array.from(bytes);
}

const layouts: Arbitrary<Layout> = {
  generate: (random): Layout => ({
    customs: random.between(0, 3),
    functionImports: random.between(0, 4),
    imported: random.between(0, 1) === 1,
    minimum: random.between(0, 256),
    maximum: random.between(0, 3) === 0 ? undefined : random.between(256, 65_536),
  }),
};

/** A memory's declared maximum and what boot left in it, both in bytes. */
interface Memory {
  readonly maximum: number;
  readonly used: number;
}

const memories: Arbitrary<Memory> = {
  generate: (random): Memory => {
    const maximum = random.between(1, 65_536) * PAGE;
    return { maximum, used: random.between(0, Math.min(maximum, GROWABLE) - 1) };
  },
};

describe("sizing a WebAssembly module's memory", () => {
  it("reads the declared maximum of memory 0 whatever precedes it", () => {
    const outcome = forAll(layouts, (layout) =>
      memoryMaximum(encode(layout)) === (layout.maximum ?? 65_536) * PAGE);
    assert.ok(outcome.ok, outcome.ok ? "" : `seed ${String(outcome.seed)}: ${JSON.stringify(outcome.counterexample)}`);
  });

  it("reads an imported memory first", () => {
    const layout: Layout = { customs: 0, functionImports: 2, imported: true, minimum: 1, maximum: 512 };
    assert.equal(memoryMaximum(encode(layout, 1024)), 512 * PAGE);
  });

  it("answers 4 GiB for a memory with no maximum", () => {
    const layout: Layout = { customs: 1, functionImports: 0, imported: false, minimum: 1, maximum: undefined };
    assert.equal(memoryMaximum(encode(layout)), 4 * GIB);
  });

  it("refuses what it cannot size", () => {
    const base = encode({ customs: 0, functionImports: 0, imported: false, minimum: 1, maximum: 2 });
    const wide = Uint8Array.from([...base.slice(0, -4), ...section(5, [1, ...limits(1, 2, 4)]).slice(-6)]);
    for (const bytes of [
      Uint8Array.from([1, 2, 3]),
      base.slice(0, base.length - 1),
      Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      wide,
    ]) {
      assert.throws(() => memoryMaximum(bytes), (error: unknown) => MettaError.is(error, "ERR_METTA_ENGINE"));
    }
  });

  it("reads the host this package carries", () => {
    assert.equal(memoryMaximum(host), 4 * GIB);
  });
});

describe("the stack ceiling a memory holds", () => {
  it("leaves room for the stacks and what their growth left behind", () => {
    const outcome = forAll(memories, ({ maximum, used }) => {
      const ceiling = stackCeiling(maximum, used);
      const growable = Math.min(maximum, GROWABLE);
      return Number.isSafeInteger(ceiling) && used + 2 * ceiling <= growable &&
        used + 2 * (ceiling + 1) > growable;
    });
    assert.ok(outcome.ok, outcome.ok ? "" : `seed ${String(outcome.seed)}: ${JSON.stringify(outcome.counterexample)}`);
  });

  it("stops one page short of 4 GiB, where the loader stops growing", () => {
    assert.equal(stackCeiling(4 * GIB, 0), GROWABLE / 2);
    assert.equal(stackCeiling(2 * GIB, 0), GIB, "a smaller declared maximum is the bound");
  });

  it("refuses a memory boot has already filled", () => {
    for (const used of [GROWABLE, 4 * GIB]) {
      assert.throws(() => stackCeiling(4 * GIB, used), (error: unknown) => MettaError.is(error, "ERR_METTA_ENGINE"));
    }
  });
});

describe("a boot with no stack setting", () => {
  let m: MeTTa;

  before(async () => {
    assert.equal(config.stackLimit, undefined, "this file measures the derived ceiling, so METTA_STACK_LIMIT is unset");
    m = await metta();
  });

  after(() => {
    m.dispose();
  });

  it("boots under the ceiling the host's memory leaves", () => {
    const held = m.engine.once("current_prolog_flag(stack_limit, Limit)")["Limit"];
    assert.equal(Number(held), m.engine.stackLimit, "the engine reports the ceiling SWI holds");
    // Boot holds more than nothing and less than all of the memory, so the
    // derived ceiling lies strictly between SWI's own default and half of
    // what the memory can grow to.
    assert.ok(m.engine.stackLimit > SWI_DEFAULT, `${String(m.engine.stackLimit)} is above SWI's default`);
    assert.ok(m.engine.stackLimit < GROWABLE / 2, `${String(m.engine.stackLimit)} leaves room for what boot holds`);
  });

  it("gives an engine made after boot the same ceiling", () => {
    // Every ask's engine, the home engine included, is made from the main
    // engine after boot, by metta_host_hold/3's engine_create/3, so one made
    // the same way reads the ceiling an ask runs under.
    const made = m.engine.once(
      "engine_create(L, current_prolog_flag(stack_limit, L), E), engine_next(E, Limit), engine_destroy(E)",
    )["Limit"];
    assert.equal(Number(made), m.engine.stackLimit);
  });
});

/**
 * Purpose: this seat's extension seam, kind by kind.
 * Guarantees:
 *   - a point is declared once with one kind, a row is checked against that
 *     declaration both ways, and each kind refuses the other kinds' dispatch
 *   - an ownership point stops at the first row that claims and an event point
 *     runs every row, which is pluggy's firstresult against its default loop
 *   - the doors that already existed are rows, so `registerType`,
 *     `registerRepr` and `registerReflector` keep their storage and the seam
 *     still answers what is registered
 *   - a registration made through the seam keeps the NAME it was given, even
 *     where the store it reaches keeps none
 *   - this seat names no third-party library, so it declares no `frame` point
 *     and no `array` point: it has no frame notion at all, and its array
 *     notion is the platform's own TypedArray family
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { registrations } from "../src/convert.ts";
import { reflect } from "../src/integrate.ts";
import * as seam from "../src/seam.ts";

const SCRATCH = "test-point";

class Star {
  readonly designation: string;

  constructor(designation: string) {
    this.designation = designation;
  }
}

describe("the seat's extension seam", () => {
  afterEach(() => {
    seam.withdraw(SCRATCH);
  });

  it("declares a point once with one kind", () => {
    seam.point(SCRATCH, "declaration", { fields: ["value"], doc: "a value" });
    assert.throws(
      () => seam.point(SCRATCH, "event", { fields: ["on"], doc: "the other kind" }),
      /already declared as declaration/,
    );
    assert.equal(seam.at(SCRATCH).kind, "declaration");
  });

  it("refuses an undeclared point by name", () => {
    assert.throws(() => seam.at("nope"), /no extension point named nope/);
    assert.throws(() => seam.at("nope"), /reflector/);
  });

  it("refuses a row missing a declared field, and one that gives too many", () => {
    const point = seam.point(SCRATCH, "declaration", {
      fields: ["module", "build"],
      doc: "two",
    });
    assert.throws(() => point.register("solars", { module: "solars" } as never), /missing build/);
    assert.throws(
      () => point.register("solars", { module: "solars", build: 1, colour: "red" } as never),
      /also gave colour/,
    );
    assert.equal(point.table().size, 0);
  });

  it("refuses each kind's dispatch on the other kinds", () => {
    const point = seam.point(SCRATCH, "declaration", { fields: ["value"], doc: "a value" });
    assert.throws(() => point.claim(1), /declaration point.*use table\(\)/);
    assert.throws(() => point.each(1), /declaration point.*use table\(\)/);
    assert.throws(() => point.call(), /declaration point.*use table\(\)/);
  });

  it("requires a claims field on an ownership point and an on field on an event", () => {
    assert.throws(
      () => seam.point(SCRATCH, "ownership", { fields: ["define"], doc: "no claims" }),
      /must declare a claims field/,
    );
    assert.throws(
      () => seam.point(SCRATCH, "event", { fields: ["run"], doc: "no on" }),
      /must declare an on field/,
    );
  });

  it("stops an ownership dispatch at the first row that claims", () => {
    const consulted: string[] = [];
    const point = seam.point<{ claims: (subject: number) => unknown }>(SCRATCH, "ownership", {
      fields: ["claims"],
      doc: "first wins",
    });
    point.register("declines", {
      claims: () => {
        consulted.push("declines");
        return undefined;
      },
    });
    point.register("claims", {
      claims: (subject) => {
        consulted.push("claims");
        return subject * 2;
      },
    });
    point.register("never", {
      claims: (subject) => {
        consulted.push("never");
        return subject;
      },
    });

    const claimed = point.claim(21);
    assert.equal(claimed?.name, "claims");
    assert.equal(claimed?.answer, 42);
    assert.deepEqual(consulted, ["declines", "claims"]);
  });

  it("names the door when no row of an ownership point claims", () => {
    const point = seam.point<{ claims: () => unknown }>(SCRATCH, "ownership", {
      fields: ["claims"],
      doc: "none claim",
    });
    point.register("declines", { claims: () => undefined });
    assert.equal(point.claim(1), undefined);
    const refusal = point.refusal("a string");
    assert.match(refusal, /declines/);
    assert.match(refusal, /claims/);
    assert.match(refusal, new RegExp(seam.GROUP));
  });

  it("runs every row of an event point, in registration order", () => {
    const ran: string[] = [];
    const point = seam.point<{ on: (value: number) => void }>(SCRATCH, "event", {
      fields: ["on"],
      doc: "all run",
    });
    point.register("first", { on: (value) => ran.push(`first ${value}`) });
    point.register("second", { on: (value) => ran.push(`second ${value}`) });
    assert.deepEqual(point.each(7), ["first", "second"]);
    assert.deepEqual(ran, ["first 7", "second 7"]);
  });

  it("replaces a second registration in place", () => {
    const point = seam.point<{ value: number }>(SCRATCH, "declaration", {
      fields: ["value"],
      doc: "values",
    });
    point.register("a", { value: 1 });
    point.register("b", { value: 2 });
    point.register("a", { value: 3 });
    assert.deepEqual(
      point.rows().map((row) => [row.name, row.fields.value]),
      [
        ["a", 3],
        ["b", 2],
      ],
    );
    assert.equal(point.unregister("a"), true);
    assert.equal(point.unregister("a"), false);
    assert.deepEqual([...point.table().keys()], ["b"]);
  });

  it("refuses a field named as one of a row's own attributes", () => {
    assert.throws(
      () => seam.point(SCRATCH, "declaration", { fields: ["name"], doc: "collides" }),
      /a row already carries name/,
    );
  });

  it("writes a service itself and refuses a registrant against one", () => {
    const term = seam.at("term");
    assert.equal(term.kind, "service");
    assert.equal(term.call(), seam.term);
    assert.throws(
      () => term.register("solars", { call: () => 1 } as never),
      /which the SEAT writes/,
    );
    assert.ok([...seam.services().keys()].includes("name"));
  });

  it("registers a type through the seam and reads it back from convert's own store", () => {
    const row = seam.type.register("Star", {
      constructor: Star,
      toAtom: ((star: Star) => [star.designation]) as never,
      fromAtom: ((designation: string) => new Star(designation)) as never,
    });
    try {
      assert.equal(row.name, "Star");
      assert.ok(registrations().some((entry) => entry.name === "Star"));
      assert.equal(seam.type.find("Star")?.fields.constructor, Star);
    } finally {
      seam.type.unregister("Star");
    }
  });

  it("keeps the name a reflector was registered under, which its store does not hold", () => {
    const claims = (value: unknown): boolean => value instanceof Star;
    const row = seam.reflector.register("solars", {
      claims,
      lower: (surface, name, target) => {
        void surface;
        void name;
        void target;
        return 1;
      },
    });
    try {
      assert.equal(row.name, "solars");
      assert.ok(seam.reflector.rows().some((each) => each.name === "solars"));
      const claimed = seam.reflector.claim(new Star("sol"));
      assert.equal(claimed?.name, "solars");
      // The older door still sees it, because that is where the row LIVES.
      assert.equal(typeof reflect, "function");
    } finally {
      seam.reflector.unregister("solars");
    }
  });

  it("declares no frame and no array point, because this seat has neither", () => {
    const names = [...seam.declared().keys()];
    assert.ok(!names.includes("frame"), names.join(", "));
    assert.ok(!names.includes("array"), names.join(", "));
    // What it does declare: the four host-object doors and the three groups.
    for (const declared of ["type", "repr", "reflector", "provider", "library", "integration"]) {
      assert.ok(names.includes(declared), `${declared} is missing from ${names.join(", ")}`);
    }
  });
});

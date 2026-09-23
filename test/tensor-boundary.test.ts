/**
 * Purpose: verify tensor dimensions and coordinates at the numeric boundary.
 * Guarantees: malformed coordinates never alias an element
 *   [tested: npm test; commit=WORKTREE].
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Tensor } from "../src/arrays.ts";

test("rejects malformed tensor extents even when their product fits", () => {
  for (const shape of [[-2, -2], [0.5, 8], [NaN], [Infinity], [0, Infinity], [0, 2 ** 53]]) {
    assert.throws(() => new Tensor(new Float64Array(4), shape), /extents/);
  }
  assert.equal(new Tensor(new Float64Array([7]), []).at(), 7);
  assert.equal(new Tensor(new Float64Array(0), [0, 2]).size, 0);
});

test("coordinates are integral and bounded in every dimension", () => {
  for (let rows = 1; rows <= 8; rows += 1) {
    for (let columns = 1; columns <= 8; columns += 1) {
      const tensor = new Tensor(Float64Array.from({ length: rows * columns }, (_, i) => i), [rows, columns]);
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          assert.equal(tensor.at(row, column), row * columns + column);
        }
      }
      for (const invalid of [-1, 0.5, NaN, Infinity, 2 ** 53]) {
        assert.throws(() => tensor.at(invalid, 0), /index/);
        assert.throws(() => tensor.at(0, invalid), /index/);
      }
      assert.throws(() => tensor.at(rows, 0), /index/);
      assert.throws(() => tensor.at(0, columns), /index/);
    }
  }
});

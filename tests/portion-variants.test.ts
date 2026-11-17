import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateVariantNutrition,
  getAvailableVariants,
  getDefaultVariant,
  getIndividualVariantAmounts,
  getVariantAmount,
  normalizeOptionalVariants,
  suggestVariantAmounts,
} from "../shared/portion-variants";

test("zero is a configured variant quantity, not a missing value", () => {
  assert.equal(getVariantAmount({ variantAmountA: 0 }, "A"), 0);
  assert.equal(getVariantAmount({ variantAmountA: null }, "A"), null);
});

test("individual variants use saved quantities without scaling", () => {
  const rows = getIndividualVariantAmounts([
    { ingredientId: 1, variantAmountA: 0, variantAmountB: 60, variantAmountC: 80 },
    { ingredientId: 2, variantAmountA: 150, variantAmountB: 200, variantAmountC: 250 },
  ], "A");
  assert.deepEqual(rows.map((row) => row.amount), [0, 150]);
});

test("missing variant quantities fail explicitly rather than silently scaling", () => {
  assert.throws(() => getIndividualVariantAmounts([{ variantAmountA: 10 }], "C"), /Missing or invalid/);
});

test("default variant is per recipe/person data and falls back safely", () => {
  assert.equal(getDefaultVariant("individual", "C"), "C");
  assert.equal(getDefaultVariant("individual", "unknown"), "B");
  assert.equal(getDefaultVariant("shared", "A"), "B");
});

test("suggestions are editable initial values and permit zero", () => {
  assert.deepEqual(suggestVariantAmounts(0), { A: 0, B: 0, C: 0 });
  assert.deepEqual(suggestVariantAmounts(60), { A: 40.2, B: 60, C: 79.8 });
});

test("nutrition uses actual amounts, including zero, without intermediate rounding", () => {
  assert.deepEqual(calculateVariantNutrition([
    { amount: 0, calories: 100, protein: 10, carbs: 20, fat: 5 },
    { amount: 50, calories: 200, protein: 20, carbs: 30, fat: 10 },
  ]), { calories: 100, protein: 10, carbs: 15, fat: 5 });
});


test("a completely blank variant is absent", () => {
  assert.deepEqual(getAvailableVariants([
    { variantAmountA: 40, variantAmountB: 60, variantAmountC: null },
    { variantAmountA: 0, variantAmountB: 80, variantAmountC: null },
  ]), ["A", "B"]);
});

test("when a variant is partially configured, blank ingredient cells become zero", () => {
  const rows = normalizeOptionalVariants([
    { ingredientId: 1, variantAmountA: 30, variantAmountB: 60, variantAmountC: null },
    { ingredientId: 2, variantAmountA: null, variantAmountB: 0, variantAmountC: null },
  ]);
  assert.equal(rows[0].variantAmountC, null);
  assert.equal(rows[1].variantAmountC, null);
  assert.equal(rows[1].variantAmountA, 0);
  assert.deepEqual(getAvailableVariants(rows), ["A", "B"]);
});

test("an explicitly entered zero makes a variant available", () => {
  assert.deepEqual(getAvailableVariants([
    { variantAmountA: null, variantAmountB: null, variantAmountC: 0 },
  ]), ["C"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { getAdditionalMealIngredients, getFinalIngredientAmount, getScaledIngredientAmount, isValidBatchAllocation, restoreRecipeIngredientsPreservingAdditions, servingsFromAllocation, splitBatchIngredientAmounts } from "../shared/portioning";

test("standard scaling keeps ingredient quantities proportional to servings", () => {
  assert.equal(getScaledIngredientAmount({ baseAmount: 100, scalingType: "LINEAR" }, 2, 1), 200);
  assert.equal(getScaledIngredientAmount({ baseAmount: 50, scalingType: "LINEAR" }, 2, 1), 100);
});

test("STEP scaling uses its configured amount even for a one-serving recipe", () => {
  assert.equal(getScaledIngredientAmount({
    baseAmount: 100,
    scalingType: "STEP",
    stepThresholds: [
      { minServings: 1, maxServings: 1, amount: 70 },
      { minServings: 1, maxServings: 2, amount: 120 },
    ],
  }, 1, 1), 70);
});
test("an individual override only replaces that ingredient's calculated value", () => {
  assert.equal(getFinalIngredientAmount(getScaledIngredientAmount({ baseAmount: 100 }, 2, 1)), 200);
  assert.equal(getFinalIngredientAmount(getScaledIngredientAmount({ baseAmount: 50 }, 2, 1), 75), 75);
});
test("a 40/60 shared batch is valid and assigns the full batch", () => {
  assert.equal(isValidBatchAllocation({ A: 40, B: 60 }), true);
  assert.deepEqual(servingsFromAllocation(3, { A: 40, B: 60 }), { A: 1.2, B: 1.8 });
});
test("a batch allocation cannot be saved when it does not add up to 100%", () => assert.equal(isValidBatchAllocation({ A: 40, B: 50 }), false));

test("batch ingredient edits are split by each person's allocated servings", () => {
  const portions = splitBatchIngredientAmounts(
    [{ ingredientId: 10, amount: 300 }],
    [{ servings: 1 }, { servings: 2 }],
    3,
  );

  assert.deepEqual(portions, [
    [{ ingredientId: 10, amount: 100, scalingType: "FIXED" }],
    [{ ingredientId: 10, amount: 200, scalingType: "FIXED" }],
  ]);
});

test("batch ingredient edits preserve person-specific additions", () => {
  assert.deepEqual(
    getAdditionalMealIngredients(
      [
        { ingredientId: 1, amount: 100, scalingType: "FIXED" },
        { ingredientId: 2, amount: 20, scalingType: "FIXED" },
        { ingredientId: 1, amount: 15, scalingType: "FIXED" },
      ],
      [{ ingredientId: 1 }],
    ),
    [
      { ingredientId: 2, amount: 20, scalingType: "FIXED" },
      { ingredientId: 1, amount: 15, scalingType: "FIXED" },
    ],
  );
});

test("restoring recipe ingredients preserves meal-specific additions", () => {
  assert.deepEqual(
    restoreRecipeIngredientsPreservingAdditions(
      [
        { ingredientId: 1, amount: 999, scalingType: "FIXED" },
        { ingredientId: 2, amount: 20, scalingType: "FIXED" },
        { ingredientId: 1, amount: 15, scalingType: "FIXED" },
      ],
      [
        { ingredientId: 1, baseAmount: 100, scalingType: "LINEAR" },
        { ingredientId: 3, amount: 50, scalingType: "FIXED" },
      ],
    ),
    [
      { ingredientId: 1, amount: 100, scalingType: "LINEAR" },
      { ingredientId: 3, amount: 50, scalingType: "FIXED" },
      { ingredientId: 2, amount: 20, scalingType: "FIXED" },
      { ingredientId: 1, amount: 15, scalingType: "FIXED" },
    ],
  );
});

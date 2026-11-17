import { calculateScaledAmount } from "./scaling";

export type Person = "A" | "B";
export type PortionsByPerson = Record<Person, number>;
export type AllocationByPerson = Record<Person, number>;

export function getScaledIngredientAmount(ingredient: any, servings: number, recipeServings: number) {
  return calculateScaledAmount(ingredient, servings, recipeServings);
}

/** An override is a final amount, rather than another multiplier. */
export function getFinalIngredientAmount(defaultAmount: number, overrideAmount?: number | null) {
  return Number.isFinite(Number(overrideAmount)) && Number(overrideAmount) >= 0 ? Number(overrideAmount) : defaultAmount;
}

export function isValidBatchAllocation(allocation: AllocationByPerson) {
  return Math.abs((Number(allocation.A) || 0) + (Number(allocation.B) || 0) - 100) < 0.001;
}

export function servingsFromAllocation(totalServings: number, allocation: AllocationByPerson): PortionsByPerson {
  const total = Math.max(0, Number(totalServings) || 0);
  return { A: Math.round(total * (Number(allocation.A) || 0)) / 100, B: Math.round(total * (Number(allocation.B) || 0)) / 100 };
}

/**
 * Converts cooked-batch ingredient totals into the final, fixed quantity for
 * each person's allocated servings. The batch total is deliberately used as
 * the divisor, rather than the number of currently displayed participants:
 * a batch can also contain portions allocated for another day.
 */
export function splitBatchIngredientAmounts<T extends { servings?: number | null }>(
  ingredients: Array<{ ingredientId: number; amount: number }>,
  participants: T[],
  batchServings: number,
) {
  const totalServings = Number(batchServings);
  if (!Number.isFinite(totalServings) || totalServings <= 0) {
    return participants.map(() => []);
  }

  return participants.map((participant) => ingredients.map((ingredient) => ({
    ingredientId: Number(ingredient.ingredientId),
    amount: Math.round((Number(ingredient.amount) || 0) * (Number(participant.servings) || 0) / totalServings),
    scalingType: "FIXED" as const,
  })));
}

/** Keeps meal-specific additions out of a shared-batch ingredient update. */
export function getAdditionalMealIngredients(
  mealIngredients: Array<{ ingredientId: number; amount: number; scalingType?: "LINEAR" | "FIXED" | "STEP" | "FORMULA" }>,
  recipeIngredients: Array<{ ingredientId: number }>,
) {
  const recipeOccurrences = new Map<number, number>();
  recipeIngredients.forEach((ingredient) => {
    const id = Number(ingredient.ingredientId);
    recipeOccurrences.set(id, (recipeOccurrences.get(id) || 0) + 1);
  });

  const mealOccurrences = new Map<number, number>();
  return mealIngredients
    .filter((ingredient) => {
      const id = Number(ingredient.ingredientId);
      const occurrence = (mealOccurrences.get(id) || 0) + 1;
      mealOccurrences.set(id, occurrence);
      return occurrence > (recipeOccurrences.get(id) || 0);
    })
    .map((ingredient) => ({
      ingredientId: Number(ingredient.ingredientId),
      amount: Number(ingredient.amount) || 0,
      scalingType: ingredient.scalingType || "FIXED",
    }));
}

/**
 * Restores recipe ingredients for a meal without discarding ingredients added
 * specifically to that meal. This also supports duplicate recipe ingredients:
 * only occurrences beyond the recipe's own occurrences are additions.
 */
export function restoreRecipeIngredientsPreservingAdditions(
  mealIngredients: Array<{ ingredientId: number; amount: number; scalingType?: "LINEAR" | "FIXED" | "STEP" | "FORMULA" }>,
  recipeIngredients: Array<{ ingredientId: number; amount?: number; baseAmount?: number; scalingType?: "LINEAR" | "FIXED" | "STEP" | "FORMULA" }>,
) {
  const restoredRecipeIngredients = recipeIngredients.map((ingredient) => ({
    ingredientId: Number(ingredient.ingredientId),
    amount: Math.round(Number(ingredient.baseAmount ?? ingredient.amount) || 0),
    scalingType: ingredient.scalingType || "LINEAR",
  }));

  return [
    ...restoredRecipeIngredients,
    ...getAdditionalMealIngredients(mealIngredients, recipeIngredients),
  ];
}

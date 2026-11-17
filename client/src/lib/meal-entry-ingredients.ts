import { calculateScaledAmount } from "@shared/scaling";

const normalizeAmount = (value: any) => Math.round(Number(value) || 0);

const getRecipeBaseAmount = (recipeIngredient: any) => (
  Number(recipeIngredient?.baseAmount ?? recipeIngredient?.amount) || 0
);

const getCalculatedRecipeAmount = (recipeIngredient: any, servings: number, recipeServings: number) => calculateScaledAmount({
  baseAmount: getRecipeBaseAmount(recipeIngredient),
  scalingType: recipeIngredient?.scalingType || "LINEAR",
  scalingFormula: recipeIngredient?.scalingFormula,
  stepThresholds: recipeIngredient?.stepThresholds,
}, servings, recipeServings);

const matchesFreshMealEntrySnapshot = (mealIngredient: any, recipeIngredient: any) => {
  const storedAmount = normalizeAmount(mealIngredient?.amount);
  const baseSnapshotAmount = normalizeAmount(getRecipeBaseAmount(recipeIngredient));

  return storedAmount === baseSnapshotAmount;
};

export const hasEditedMealIngredients = (meal: any) => {
  if (!meal?.recipe || !Array.isArray(meal?.ingredients) || meal.ingredients.length === 0) return false;

  const servings = Number(meal?.servings) || 1;
  const recipeServings = Number(meal?.recipe?.servings) || 1;
  const recipeIngredients = Array.isArray(meal?.recipe?.ingredients) ? meal.recipe.ingredients : [];
  if (recipeIngredients.length === 0) return false;

  const recipeIngredientsById = new Map<number, any[]>();
  recipeIngredients.forEach((ingredient: any) => {
    const ingredientId = Number(ingredient?.ingredientId);
    const occurrences = recipeIngredientsById.get(ingredientId) || [];
    occurrences.push(ingredient);
    recipeIngredientsById.set(ingredientId, occurrences);
  });

  const mealOccurrences = new Map<number, number>();
  const matchedRecipeOccurrences = new Map<number, number>();
  for (const ingredient of meal.ingredients) {
    const ingredientId = Number(ingredient?.ingredientId);
    const occurrence = (mealOccurrences.get(ingredientId) || 0) + 1;
    mealOccurrences.set(ingredientId, occurrence);

    const recipeIngredient = recipeIngredientsById.get(ingredientId)?.[occurrence - 1];
    // Rows beyond the recipe's own ingredient occurrences are additions for
    // this meal entry and must not count as edits to the shared recipe base.
    if (!recipeIngredient) continue;
    matchedRecipeOccurrences.set(ingredientId, occurrence);

    if (matchesFreshMealEntrySnapshot(ingredient, recipeIngredient)) continue;

    const recipeAmount = getCalculatedRecipeAmount(recipeIngredient, servings, recipeServings);
    if (normalizeAmount(ingredient?.amount) !== normalizeAmount(recipeAmount)) return true;
  }

  return Array.from(recipeIngredientsById.entries()).some(([ingredientId, occurrences]) => (
    (matchedRecipeOccurrences.get(ingredientId) || 0) < occurrences.length
  ));
};

export type ProduceType = "vegetable" | "fruit";

export type ProduceIngredientSettings = {
  produceType?: string | null;
  producePercentage?: number | string | null;
  category?: string | null;
};

export type ProduceAmount = {
  produceType: ProduceType | null | undefined;
  /** Ingredient amount normalized to edible grams for this planned/eaten entry. */
  grams: number;
};

export type ProduceTotals = {
  vegetableGrams: number;
  fruitGrams: number;
  vegetableServings: number;
  fruitServings: number;
};

export const GRAMS_PER_PRODUCE_SERVING = 80;

/**
 * The person's combined daily produce target, in grams (vegetables + fruit).
 * The selected-period target is the sum of this daily value across included days.
 */
export function getDailyProduceGoalGrams(target: {
  vegetables?: number | string | null;
  fruits?: number | string | null;
}): number {
  const vegetables = Number(target.vegetables);
  const fruits = Number(target.fruits);
  return (Number.isFinite(vegetables) && vegetables > 0 ? vegetables : 0)
    + (Number.isFinite(fruits) && fruits > 0 ? fruits : 0);
}

/**
 * Apply the current configured daily goal to every non-excluded day in the
 * selected range. Historical settings rows are deliberately not used here:
 * the user's current daily target defines the goal for the whole selected range.
 */
export function getProduceRangeGoalGrams(
  dailyTarget: { vegetables?: number | string | null; fruits?: number | string | null },
  includedDays: number,
): number {
  const dayCount = Number.isFinite(Number(includedDays)) ? Math.max(0, Math.floor(Number(includedDays))) : 0;
  return getDailyProduceGoalGrams(dailyTarget) * dayCount;
}

/**
 * For a selected statistics range, add one daily goal for each included day.
 * Excluded days contribute no target. This deliberately makes a 500 g daily
 * goal equal 3,000 g across six included days.
 */
export function sumIncludedProduceGoalGrams(
  days: readonly ({ excluded: boolean } & { vegetables?: number | string | null; fruits?: number | string | null })[],
): number {
  return days.reduce(
    (total, day) => total + (day.excluded ? 0 : getDailyProduceGoalGrams(day)),
    0,
  );
}

export type StatsExclusionPerson = "A" | "B";
export type StatsExclusionRow = { date: string; person: StatsExclusionPerson; reason: string };

/** Preserve exclusions by their exact (date, person) key; never infer one person's state from the other. */
export function mapStatsExclusions(
  rows: readonly StatsExclusionRow[],
): Record<string, Partial<Record<StatsExclusionPerson, string>>> {
  const result: Record<string, Partial<Record<StatsExclusionPerson, string>>> = {};
  for (const row of rows) {
    result[row.date] = { ...result[row.date], [row.person]: row.reason };
  }
  return result;
}

/**
 * Resolve the ingredient's produce classification.
 * An explicit "none" is authoritative and must never fall back to its category.
 * Category inference is used only for legacy/automatic (null) settings.
 */
export function getProduceType(ingredient: ProduceIngredientSettings): ProduceType | null {
  const configuredType = String(ingredient?.produceType ?? "").trim().toLocaleLowerCase("pl-PL");
  if (configuredType === "none") return null;
  if (configuredType === "vegetable" || configuredType === "fruit") return configuredType;

  const category = String(ingredient?.category ?? "").toLocaleLowerCase("pl-PL");
  if (category.includes("warzyw")) return "vegetable";
  if (category.includes("owoc")) return "fruit";
  return null;
}

/** Apply the ingredient's configured inclusion percentage to already-edible grams. */
export function getProduceContribution(
  ingredient: ProduceIngredientSettings,
  edibleGrams: number,
): ProduceAmount {
  const produceType = getProduceType(ingredient);
  const grams = Number(edibleGrams);
  if (!produceType || !Number.isFinite(grams) || grams <= 0) {
    return { produceType: null, grams: 0 };
  }

  const rawPercentage = ingredient.producePercentage == null ? 100 : Number(ingredient.producePercentage);
  const percentage = Number.isFinite(rawPercentage) ? Math.min(100, Math.max(0, rawPercentage)) : 100;
  return { produceType, grams: grams * percentage / 100 };
}

/**
 * Aggregate already-scaled ingredient quantities. Unit conversion, edible
 * percentage, ingredient-level inclusion percentage, and selection of planned
 * vs eaten entries must happen upstream using the same amount logic.
 * Unclassified ingredients and invalid/negative quantities are ignored.
 */
export function calculateProduceTotals(amounts: readonly ProduceAmount[]): ProduceTotals {
  let vegetableGrams = 0;
  let fruitGrams = 0;

  for (const item of amounts) {
    const grams = Number(item.grams);
    if (!Number.isFinite(grams) || grams <= 0) continue;

    if (item.produceType === "vegetable") vegetableGrams += grams;
    if (item.produceType === "fruit") fruitGrams += grams;
  }

  return {
    vegetableGrams,
    fruitGrams,
    vegetableServings: vegetableGrams / GRAMS_PER_PRODUCE_SERVING,
    fruitServings: fruitGrams / GRAMS_PER_PRODUCE_SERVING,
  };
}

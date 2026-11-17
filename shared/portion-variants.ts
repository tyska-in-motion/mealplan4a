export type PortionVariant = "A" | "B" | "C";
export type PortioningMode = "shared" | "individual";

export type VariantAmounts = {
  variantAmountA?: number | string | null;
  variantAmountB?: number | string | null;
  variantAmountC?: number | string | null;
};

const VARIANT_FIELD: Record<PortionVariant, keyof VariantAmounts> = {
  A: "variantAmountA",
  B: "variantAmountB",
  C: "variantAmountC",
};

/** Return the saved quantity for a variant; zero is a valid, explicit amount. */
export function getVariantAmount(amounts: VariantAmounts, variant: PortionVariant): number | null {
  const raw = amounts[VARIANT_FIELD[variant]];
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return null;
  const parsed = typeof raw === "string" ? Number(raw.trim().replace(",", ".")) : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Resolve a per-recipe person's default variant without relying on their display name. */
export function getDefaultVariant(
  mode: PortioningMode,
  configuredVariant: string | null | undefined,
): PortionVariant {
  if (mode !== "individual") return "B";
  return configuredVariant === "A" || configuredVariant === "B" || configuredVariant === "C"
    ? configuredVariant
    : "B";
}

/** Resolve a configured variant, treating empty cells as zero and rejecting absent variants. */
export function getIndividualVariantAmountsOptional<T extends VariantAmounts>(ingredients: T[], variant: PortionVariant): Array<T & { amount: number }> {
  if (!getAvailableVariants(ingredients).includes(variant)) throw new Error(`Variant ${variant} is not configured for this recipe`);
  return ingredients.map((ingredient) => ({ ...ingredient, amount: getVariantAmount(ingredient, variant) ?? 0 }));
}

/** Scale is deliberately not applied: A/B/C amounts are saved final quantities. */
export function getIndividualVariantAmounts<T extends VariantAmounts>(
  ingredients: T[],
  variant: PortionVariant,
): Array<T & { amount: number }> {
  return ingredients.map((ingredient) => {
    const amount = getVariantAmount(ingredient, variant);
    if (amount === null) {
      throw new Error(`Missing or invalid amount for variant ${variant}`);
    }
    return { ...ingredient, amount };
  });
}

/** Generate editable starter quantities from B. These values are suggestions only. */
export function suggestVariantAmounts(baseAmount: number): Record<PortionVariant, number> {
  const base = Number(baseAmount);
  if (!Number.isFinite(base) || base < 0) throw new Error("Base amount must be a non-negative number");
  return { A: Math.round(base * 0.67 * 100) / 100, B: base, C: Math.round(base * 1.33 * 100) / 100 };
}

/** Macro values always use actual amounts and are not rounded before aggregation. */
export function calculateVariantNutrition<T extends {
  amount: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}>(ingredients: T[]) {
  return ingredients.reduce((total, ingredient) => {
    const amount = Number(ingredient.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Ingredient amount must be non-negative");
    const factor = amount / 100;
    return {
      calories: total.calories + factor * Number(ingredient.calories || 0),
      protein: total.protein + factor * Number(ingredient.protein || 0),
      carbs: total.carbs + factor * Number(ingredient.carbs || 0),
      fat: total.fat + factor * Number(ingredient.fat || 0),
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}


/** A variant exists only when at least one ingredient has an explicitly entered quantity. */
export function getAvailableVariants(ingredients: VariantAmounts[]): PortionVariant[] {
  const variants: PortionVariant[] = ["A", "B", "C"];
  return variants.filter((variant) => ingredients.some((ingredient) => getVariantAmount(ingredient, variant) !== null));
}

/** Keep wholly blank variants absent; for configured variants, blank ingredient cells mean zero. */
export function normalizeOptionalVariants<T extends VariantAmounts>(ingredients: T[]): T[] {
  const available = new Set(getAvailableVariants(ingredients));
  return ingredients.map((ingredient) => {
    const next: any = { ...ingredient };
    for (const variant of ["A", "B", "C"] as const) {
      const key = `variantAmount${variant}` as const;
      if (!available.has(variant)) next[key] = null;
      else if ((ingredient as any)[key] == null || (ingredient as any)[key] === "") next[key] = 0;
      else next[key] = Number(ingredient[key]);
    }
    return next as T;
  });
}

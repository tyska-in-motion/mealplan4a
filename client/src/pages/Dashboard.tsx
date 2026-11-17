import { fetchMealEntryFull, useDayPlanSummary, useUpdateMealEntry, useToggleEaten, useAddMealEntry, useDeleteMealEntry } from "@/hooks/use-meal-plan";
import { useAllIngredients } from "@/hooks/use-ingredients";
import { fetchRecipeDetails, useRecipeSearchIndex } from "@/hooks/use-recipes";
import { useToast } from "@/hooks/use-toast";
import { format, addDays, subDays } from "date-fns";
import { pl } from "date-fns/locale";
import { Layout } from "@/components/Layout";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { Flame, CheckCircle2, Circle, CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Settings2, Wallet, Eye, NotebookText, Check, ChevronsUpDown, X, PlusCircle, Plus, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { lazy, Suspense, type MouseEvent, type PointerEvent, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, fetchWithTimeout, queryClient } from "@/lib/queryClient";
import { api } from "@shared/routes";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
const RecipeView = lazy(() => import("@/components/RecipeView").then(({ RecipeView }) => ({ default: RecipeView })));
import { calculateNutritionAmount, calculatePurchaseAmount, calculateScaledAmount } from "@shared/scaling";
import { getProduceContribution } from "@shared/produce-tracking";
import { getAdditionalMealIngredients, restoreRecipeIngredientsPreservingAdditions, splitBatchIngredientAmounts } from "@shared/portioning";
import { buildSharedIngredientsSummary, buildWholeSharedBatchIngredients } from "@/lib/shared-ingredients";
import { hasEditedMealIngredients } from "@/lib/meal-entry-ingredients";
import { getAvailableVariants, getDefaultVariant, type PortionVariant } from "@shared/portion-variants";

export default function Dashboard() {
  type PersonTargets = { calories: number; protein: number; carbs: number; fat: number };
  type MacroKey = Exclude<keyof PersonTargets, "calories">;
  type MacroPercentages = Record<MacroKey, number>;
  type MacroPercentageRange = { min: number; max: number };
  type MacroPercentageRanges = Record<MacroKey, MacroPercentageRange>;
  type MacroStats = { calories: number; protein: number; carbs: number; fat: number; sugar: number; fiber: number };
  type NutrientRange = { min: number; max: number };
  type NutrientRanges = { sugar: NutrientRange; fiber: NutrientRange };
  type NutrientRangeDrafts = Record<"A" | "B", Record<keyof NutrientRanges, Record<keyof NutrientRange, string>>>;
  const mealTypeLabels: Record<string, string> = {
    breakfast: "Śniadanie",
    snack: "Lunch",
    lunch: "Obiad",
    dinner: "Kolacja",
  };
  const [date, setDate] = useState(new Date());
  const dateStr = format(date, "yyyy-MM-dd");
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const { data: dayPlan, isLoading: isLoadingPlan } = useDayPlanSummary(dateStr);
  const { mutate: toggleEaten } = useToggleEaten();
  const handleEatenButtonPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // Keep the touch on the checkbox button itself, so mobile browsers do not
    // treat a near-miss/drag as interaction with the recipe row next to it.
    event.stopPropagation();
  };
  const handleEatenButtonClick = (event: MouseEvent<HTMLButtonElement>, meal: any) => {
    event.preventDefault();
    event.stopPropagation();
    toggleEaten({ id: meal.id, isEaten: !meal.isEaten });
  };
  const [viewingRecipe, setViewingRecipe] = useState<any>(null);
  const [viewingMeal, setViewingMeal] = useState<any>(null);
  const [viewingPlannedServings, setViewingPlannedServings] = useState<number | undefined>(undefined);
  const [disableRecipeScaling, setDisableRecipeScaling] = useState(false);
  const [usePrecalculatedIngredientAmounts, setUsePrecalculatedIngredientAmounts] = useState(false);
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [quickAddMode, setQuickAddMode] = useState<"recipe" | "ingredient" | "custom">("recipe");
  const [quickMealType, setQuickMealType] = useState("lunch");
  const [quickPerson, setQuickPerson] = useState<"A" | "B">("A");
  const [quickRecipeId, setQuickRecipeId] = useState<number | null>(null);
  const [quickRecipeDetails, setQuickRecipeDetails] = useState<any>(null);
  const [quickPortionVariant, setQuickPortionVariant] = useState<PortionVariant>("B");
  const [variantOptionsByRecipe, setVariantOptionsByRecipe] = useState<Record<number, PortionVariant[]>>({});
  const [selectedVariantByEntry, setSelectedVariantByEntry] = useState<Record<number, PortionVariant>>({});
  const [quickCustomName, setQuickCustomName] = useState("");
  const [quickCustomCalories, setQuickCustomCalories] = useState<number>(450);
  const [quickCustomProtein, setQuickCustomProtein] = useState<number>(25);
  const [quickCustomCarbs, setQuickCustomCarbs] = useState<number>(45);
  const [quickCustomFat, setQuickCustomFat] = useState<number>(15);
  const [quickIngredientId, setQuickIngredientId] = useState<number | null>(null);
  const [quickIngredientAmount, setQuickIngredientAmount] = useState<number>(100);
  const [isQuickRecipePopoverOpen, setIsQuickRecipePopoverOpen] = useState(false);
  const [isQuickIngredientPopoverOpen, setIsQuickIngredientPopoverOpen] = useState(false);
  const [servingInputs, setServingInputs] = useState<Record<string, string>>({});
  const [targetsByPerson, setTargetsByPerson] = useState<Record<"A" | "B", PersonTargets>>({
    A: { calories: 1850, protein: 120, carbs: 205, fat: 61 },
    B: { calories: 2700, protein: 170, carbs: 302, fat: 90 },
  });
  const [macroPercentagesByPerson, setMacroPercentagesByPerson] = useState<Record<"A" | "B", MacroPercentages>>({
    A: { protein: 26, carbs: 44, fat: 30 },
    B: { protein: 25, carbs: 45, fat: 30 },
  });
  const [macroPercentageRangesByPerson, setMacroPercentageRangesByPerson] = useState<Record<"A" | "B", MacroPercentageRanges>>({
    A: { protein: { min: 26, max: 26 }, carbs: { min: 44, max: 44 }, fat: { min: 30, max: 30 } },
    B: { protein: { min: 25, max: 25 }, carbs: { min: 45, max: 45 }, fat: { min: 30, max: 30 } },
  });

  const [nutrientRangesByPerson, setNutrientRangesByPerson] = useState<Record<"A" | "B", NutrientRanges>>({
    A: { sugar: { min: 0, max: 0 }, fiber: { min: 0, max: 0 } },
    B: { sugar: { min: 0, max: 0 }, fiber: { min: 0, max: 0 } },
  });
  const [nutrientRangeInputsByPerson, setNutrientRangeInputsByPerson] = useState<NutrientRangeDrafts>({
    A: { sugar: { min: "0", max: "0" }, fiber: { min: "0", max: "0" } },
    B: { sugar: { min: "0", max: "0" }, fiber: { min: "0", max: "0" } },
  });
  const toNutrientRangeDrafts = (ranges: Record<"A" | "B", NutrientRanges>): NutrientRangeDrafts => ({
    A: {
      sugar: { min: String(ranges.A.sugar.min), max: String(ranges.A.sugar.max) },
      fiber: { min: String(ranges.A.fiber.min), max: String(ranges.A.fiber.max) },
    },
    B: {
      sugar: { min: String(ranges.B.sugar.min), max: String(ranges.B.sugar.max) },
      fiber: { min: String(ranges.B.fiber.min), max: String(ranges.B.fiber.max) },
    },
  });

  const [isEditingIngredients, setIsEditingIngredients] = useState(false);
  const [editingMealIngredients, setEditingMealIngredients] = useState<any[]>([]);
  const { data: allAvailableIngredients } = useAllIngredients(undefined, isQuickAddOpen || isEditingIngredients);
  const { toast } = useToast();

  const { mutate: updateMealEntry, mutateAsync: updateMealEntryAsync, isPending: isSaving } = useUpdateMealEntry();
  const { mutate: addEntry, isPending: isQuickAdding } = useAddMealEntry();
  const { mutate: deleteEntry, isPending: isDeletingMeal } = useDeleteMealEntry();
  const { data: recipes } = useRecipeSearchIndex(isQuickAddOpen);
  const { data: sharedBatches = [] } = useQuery<any[]>({
    queryKey: [api.sharedMeals.list.path],
    queryFn: async () => {
      const response = await fetchWithTimeout(api.sharedMeals.list.path);
      if (!response.ok) throw new Error("Nie udało się pobrać wspólnych posiłków");
      return response.json();
    },
  });
  const { data: mealPrepOpportunities } = useQuery<any>({
    queryKey: [api.mealPrep.opportunities.path, todayStr, 7],
    queryFn: async () => {
      const params = new URLSearchParams({ date: todayStr, lookAheadDays: "7" });
      const response = await fetchWithTimeout(`${api.mealPrep.opportunities.path}?${params.toString()}`);
      if (!response.ok) return { items: [] };
      return api.mealPrep.opportunities.responses[200].parse(await response.json());
    },
  });
  const hasActiveMealPrep = (mealPrepOpportunities?.items?.length || 0) > 0;
  const selectedQuickRecipe = useMemo(() => {
    const recipeFromList = recipes?.find((recipe: any) => recipe.id === quickRecipeId) || null;
    const loadedDetails = quickRecipeDetails?.id === quickRecipeId ? quickRecipeDetails : null;
    if (!loadedDetails) return recipeFromList;
    // The details endpoint may omit precomputed nutrition stats present in the recipe list.
    // Preserve those stats when the full recipe response does not include them.
    return {
      ...recipeFromList,
      ...loadedDetails,
      stats: loadedDetails.stats ?? recipeFromList?.stats,
    };
  }, [recipes, quickRecipeId, quickRecipeDetails]);
  const quickRecipeVariants = useMemo(() => getAvailableVariants(selectedQuickRecipe?.ingredients || []), [selectedQuickRecipe]);
  const isQuickRecipeVariant = selectedQuickRecipe?.portioningMode === "individual" || quickRecipeVariants.length > 0;
  const quickRecipeNutritionPreview = useMemo(() => {
    if (!selectedQuickRecipe) return null;
    if (isQuickRecipeVariant) {
      return (selectedQuickRecipe.ingredients || []).reduce((sum: any, ri: any) => {
        if (!ri?.ingredient) return sum;
        const amount = Math.max(0, Number(ri[`variantAmount${quickPortionVariant}`]) || 0);
        const nutritionAmount = calculateNutritionAmount(amount, ri.ingredient);
        const multiplier = nutritionAmount / 100;
        return {
          calories: sum.calories + (Number(ri.ingredient.calories) || 0) * multiplier,
          protein: sum.protein + (Number(ri.ingredient.protein) || 0) * multiplier,
          carbs: sum.carbs + (Number(ri.ingredient.carbs) || 0) * multiplier,
          fat: sum.fat + (Number(ri.ingredient.fat) || 0) * multiplier,
          sugar: sum.sugar + (Number(ri.ingredient.sugar) || 0) * multiplier,
          fiber: sum.fiber + (Number(ri.ingredient.fiber) || 0) * multiplier,
        };
      }, { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0 });
    }
    const baseServings = Math.max(0.1, Number(selectedQuickRecipe?.servings) || 1);
    return {
      calories: Math.round(Number(selectedQuickRecipe?.stats?.calories || 0) / baseServings),
      protein: Number((Number(selectedQuickRecipe?.stats?.protein || 0) / baseServings).toFixed(1)),
      carbs: Number((Number(selectedQuickRecipe?.stats?.carbs || 0) / baseServings).toFixed(1)),
      fat: Number((Number(selectedQuickRecipe?.stats?.fat || 0) / baseServings).toFixed(1)),
      sugar: Number((Number(selectedQuickRecipe?.stats?.sugar || 0) / baseServings).toFixed(1)),
      fiber: Number((Number(selectedQuickRecipe?.stats?.fiber || 0) / baseServings).toFixed(1)),
    };
  }, [selectedQuickRecipe, isQuickRecipeVariant, quickPortionVariant]);
  const selectedQuickIngredient = useMemo(
    () => allAvailableIngredients?.find((ingredient: any) => ingredient.id === quickIngredientId),
    [allAvailableIngredients, quickIngredientId]
  );
  const quickIngredientNutritionPreview = useMemo(() => {
    if (!selectedQuickIngredient) return null;
    const factor = Math.max(0, quickIngredientAmount) / 100;
    return {
      calories: Math.round((Number(selectedQuickIngredient?.calories) || 0) * factor),
      protein: Number(((Number(selectedQuickIngredient?.protein) || 0) * factor).toFixed(1)),
      carbs: Number(((Number(selectedQuickIngredient?.carbs) || 0) * factor).toFixed(1)),
      fat: Number(((Number(selectedQuickIngredient?.fat) || 0) * factor).toFixed(1)),
      sugar: Number(((Number(selectedQuickIngredient?.sugar) || 0) * factor).toFixed(1)),
      fiber: Number(((Number(selectedQuickIngredient?.fiber) || 0) * factor).toFixed(1)),
    };
  }, [selectedQuickIngredient, quickIngredientAmount]);

  const frequentAddonIngredientIds = useMemo(() => new Set(
    (viewingRecipe?.frequentAddons || []).map((addon: any) => Number(addon.ingredientId))
  ), [viewingRecipe?.frequentAddons]);
  const frequentAddonDefinitions = viewingRecipe?.frequentAddons || [];
  const getAddonBaseAmount = (addon: any) => Number(addon?.baseAmount ?? addon?.amount) || 0;
  const isWholeBatchPreview = Boolean(
    viewingPlannedServings !== undefined
    && Number(viewingMeal?.wholeRecipeBatchId || viewingMeal?.cookedBatchId || viewingMeal?.cookedBatch?.id || 0) > 0,
  );
  const getWholeBatchServings = () => (
    Number(viewingPlannedServings)
    || Number(viewingMeal?.wholeRecipeBatchServings)
    || Number(viewingMeal?.cookedBatch?.totalServings)
    || Number(viewingMeal?.servings)
    || 1
  );
  const getAddonIncrementAmount = (addon: any) => {
    const entryServings = isWholeBatchPreview ? getWholeBatchServings() : (Number(viewingMeal?.servings) || 1);
    const recipeServings = Number(viewingRecipe?.servings) || 1;
    const amount = calculateScaledAmount({
      baseAmount: getAddonBaseAmount(addon),
      scalingType: addon?.scalingType || "LINEAR",
      scalingFormula: addon?.scalingFormula,
      stepThresholds: addon?.stepThresholds,
    }, entryServings, recipeServings);

    return Number.isFinite(amount) ? amount : getAddonBaseAmount(addon);
  };


  const resolveRecipeIngredientSource = (ingredientId: number, occurrence: number) => {
    if (!viewingRecipe) return undefined;
    const recipeIngredients = (viewingRecipe.ingredients || []).filter((ri: any) => Number(ri?.ingredientId) === Number(ingredientId));
    const recipeFrequentAddons = (viewingRecipe.frequentAddons || []).filter((ri: any) => Number(ri?.ingredientId) === Number(ingredientId));
    const candidates = [...recipeIngredients, ...recipeFrequentAddons];
    return candidates[occurrence - 1] || candidates[0];
  };

  const getEffectiveIngredientAmount = (entry: any, ri: any) => {
    if (typeof ri?.calculatedAmount === "number") return ri.calculatedAmount;
    return calculateScaledAmount(
      ri,
      Number(entry?.servings) || 1,
      Number(entry?.recipe?.servings) || 1,
    );
  };

  const getEntryIngredients = (entry: any) => {
    if (Array.isArray(entry?.ingredients) && entry.ingredients.length > 0) return entry.ingredients;
    if (Array.isArray(entry?.recipe?.ingredients)) return entry.recipe.ingredients;
    return [];
  };


  const startEditing = () => {
    if (!viewingRecipe || !viewingMeal) return;

    const isBatchIngredientEdit = Number(viewingMeal?.wholeRecipeBatchId || 0) > 0;
    const sharedParticipants = [viewingMeal?.sharedParticipantEntries?.A, viewingMeal?.sharedParticipantEntries?.B]
      .filter((entry: any) => entry?.id);
    const isSharedRecipeIngredientEdit = !isBatchIngredientEdit && sharedParticipants.length > 0;
    const hasMealSpecificIngredients = Boolean(viewingMeal?.ingredients && viewingMeal.ingredients.length > 0);
    const currentIngredients = isBatchIngredientEdit || isSharedRecipeIngredientEdit
      // Shared and cooked-batch editors change only recipe ingredients.
      // Personal additions stay attached to their respective meal entries.
      ? viewingRecipe.ingredients
      : hasMealSpecificIngredients
      ? viewingMeal.ingredients
      : viewingRecipe.ingredients;

    const recipeIngredientCounts = (viewingRecipe.ingredients || []).reduce((acc: Map<number, number>, ingredient: any) => {
      const ingredientId = Number(ingredient?.ingredientId);
      if (!Number.isFinite(ingredientId)) return acc;
      acc.set(ingredientId, (acc.get(ingredientId) || 0) + 1);
      return acc;
    }, new Map<number, number>());
    const occurrenceMap = new Map<number, number>();
    const editingServings = isBatchIngredientEdit
      ? getWholeBatchServings()
      : isSharedRecipeIngredientEdit
      ? sharedParticipants.reduce((sum: number, entry: any) => sum + (Number(entry?.servings) || 0), 0)
      : (Number(viewingMeal?.servings) || 1);
    const recipeServings = Number(viewingRecipe?.servings) || 1;

    const mappedIngredients = currentIngredients.map((ri: any) => {
      const ingredientId = Number(ri.ingredientId);
      const occurrence = (occurrenceMap.get(ingredientId) || 0) + 1;
      occurrenceMap.set(ingredientId, occurrence);
      const recipeCount = recipeIngredientCounts.get(ingredientId) || 0;
      const isFrequentAddon = frequentAddonIngredientIds.has(ingredientId) && occurrence > recipeCount;

      const source = resolveRecipeIngredientSource(ingredientId, occurrence);
      const ingredientForScaling = {
        ...source,
        ...ri,
        baseAmount: Number(ri?.baseAmount ?? ri?.amount ?? source?.baseAmount ?? source?.amount ?? 0) || 0,
        scalingType: ri?.scalingType ?? source?.scalingType ?? "LINEAR",
        scalingFormula: ri?.scalingFormula ?? source?.scalingFormula,
        stepThresholds: ri?.stepThresholds ?? source?.stepThresholds,
      };
      const displayedAmount = isBatchIngredientEdit
        ? calculateScaledAmount(ingredientForScaling as any, editingServings, recipeServings)
        : isSharedRecipeIngredientEdit
        ? sharedParticipants.reduce((sum: number, entry: any) => (
          sum + calculateScaledAmount(ingredientForScaling as any, Number(entry?.servings) || 1, recipeServings)
        ), 0)
        : getEffectiveIngredientAmount(viewingMeal, ingredientForScaling as any);

      return {
        ingredientId: ri.ingredientId,
        amount: Math.round(displayedAmount),
        ingredient: ri.ingredient,
        isFrequentAddon,
        scalingType: ingredientForScaling.scalingType,
        scalingFormula: ingredientForScaling.scalingFormula,
        stepThresholds: ingredientForScaling.stepThresholds,
      };
    });

    setEditingMealIngredients([
      ...mappedIngredients.filter((item: any) => !item.isFrequentAddon),
      ...mappedIngredients.filter((item: any) => item.isFrequentAddon),
    ]);
    setIsEditingIngredients(true);
  };

  const addIngredientToEdit = () => {
    setEditingMealIngredients([...editingMealIngredients, { ingredientId: 0, amount: 100, ingredient: null }]);
  };

  const addFrequentAddonToEdit = (addon: any) => {
    const addonIngredientId = Number(addon.ingredientId);
    const addonStep = getAddonIncrementAmount(addon);
    if (!addonIngredientId || addonStep <= 0) return;

    setEditingMealIngredients((prev) => {
      const existingIndex = prev.findIndex((item: any) => Number(item.ingredientId) === addonIngredientId && item.isFrequentAddon);
      if (existingIndex >= 0) {
        return prev.map((item: any, idx: number) =>
          idx === existingIndex
            ? {
                ...item,
                amount: Number(item.amount || 0) + addonStep,
                isFrequentAddon: true,
                scalingType: addon?.scalingType || item.scalingType || "LINEAR",
                scalingFormula: addon?.scalingFormula ?? item.scalingFormula,
                stepThresholds: addon?.stepThresholds ?? item.stepThresholds,
              }
            : item
        );
      }

      return [...prev, {
        ingredientId: addonIngredientId,
        amount: addonStep,
        ingredient: addon.ingredient || null,
        isFrequentAddon: true,
        scalingType: addon?.scalingType || "LINEAR",
        scalingFormula: addon?.scalingFormula,
        stepThresholds: addon?.stepThresholds,
      }];
    });
  };

  const updateIngredientInEdit = (index: number, updates: any) => {
    const newIngredients = [...editingMealIngredients];
    newIngredients[index] = { ...newIngredients[index], ...updates };
    if (updates.ingredientId && allAvailableIngredients) {
      newIngredients[index].ingredient = allAvailableIngredients.find((i: any) => i.id === updates.ingredientId);
      newIngredients[index].isFrequentAddon = frequentAddonIngredientIds.has(Number(updates.ingredientId));
    }
    setEditingMealIngredients(newIngredients);
  };

  const removeIngredientFromEdit = (index: number) => {
    setEditingMealIngredients(editingMealIngredients.filter((_, i) => i !== index));
  };


  const splitSharedIngredientsByServings = (ingredients: any[], participants: any[]) => {
    const totalServings = participants.reduce((sum: number, entry: any) => sum + (Number(entry?.servings) || 0), 0);
    const participantAmounts = participants.map(() => [] as any[]);

    ingredients.forEach((ingredient: any) => {
      const totalAmount = Math.round(Number(ingredient.amount) || 0);
      let assignedAmount = 0;

      participants.forEach((entry: any, index: number) => {
        const isLastParticipant = index === participants.length - 1;
        const ratio = totalServings > 0 ? (Number(entry?.servings) || 0) / totalServings : 0;
        const amount = isLastParticipant ? totalAmount - assignedAmount : Math.round(totalAmount * ratio);
        assignedAmount += amount;

        participantAmounts[index].push({
          ingredientId: Number(ingredient.ingredientId),
          amount,
          scalingType: "FIXED" as const,
        });
      });
    });

    return participantAmounts;
  };

  const updateViewingMealServings = (nextServings: number) => {
    if (!viewingMeal) return;
    const safeServings = Math.max(0.5, Math.round(nextServings * 2) / 2);
    setViewingPlannedServings(safeServings);
    setViewingMeal((prev: any) => (prev ? { ...prev, servings: safeServings } : prev));
    updateMealEntry({
      id: viewingMeal.id,
      updates: {
        servings: safeServings,
        isEaten: !!viewingMeal.isEaten,
        date: viewingMeal.date,
        mealType: viewingMeal.mealType,
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/meal-plan/${dateStr}`] });
      },
    });
  };

  const saveIngredients = () => {
    if (!viewingMeal || !viewingRecipe) return;

    const ingredientsData = editingMealIngredients
      .filter(i => i.ingredientId > 0)
      .map(i => ({
        ingredientId: Number(i.ingredientId),
        amount: Number(i.amount) || 0,
        scalingType: "FIXED",
      }));

    if (ingredientsData.length === 0) {
      toast({ title: "Błąd", description: "Dodaj przynajmniej jeden składnik.", variant: "destructive" });
      return;
    }

    const participants = [viewingMeal?.sharedParticipantEntries?.A, viewingMeal?.sharedParticipantEntries?.B]
      .filter((entry: any) => entry?.id);
    const batchId = Number(viewingMeal?.wholeRecipeBatchId || 0);
    const batchServings = Number(viewingMeal?.wholeRecipeBatchServings || 0);

    if (batchId > 0 && batchServings > 0) {
      const recipeServings = Number(viewingRecipe.servings) || 1;
      const batchIngredients = ingredientsData.map((ingredient) => ({
        ingredientId: ingredient.ingredientId,
        // The editor shows the quantity for the entire cooked batch. Save the
        // recipe-base quantity, so every allocated portion gets its share.
        amount: Number(ingredient.amount) * recipeServings / batchServings,
        scalingType: "LINEAR",
      }));
      const perPersonIngredients = splitBatchIngredientAmounts(ingredientsData, participants, batchServings)
        .map((ingredientShare, index) => [
          ...ingredientShare,
          // Frequent and other person-specific additions are never part of a
          // batch edit. Keep each person's existing additions unchanged.
          ...getAdditionalMealIngredients(
            participants[index].ingredients || [],
            viewingRecipe.ingredients || [],
          ),
        ]);

      Promise.all([
        fetch(api.sharedMeals.updateBatch.path.replace(":id", String(batchId)), {
          method: api.sharedMeals.updateBatch.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ingredients: batchIngredients }),
        }).then(async (response) => {
          if (!response.ok) throw new Error("Nie udało się zapisać składników wspólnej partii.");
        }),
        ...participants.map((entry: any, index: number) => updateMealEntryAsync({
          id: entry.id,
          updates: {
            ingredients: perPersonIngredients[index],
            isEaten: !!entry.isEaten,
            date: entry.date,
            mealType: entry.mealType,
          },
        })),
      ]).then(() => {
        queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
        queryClient.invalidateQueries({ queryKey: [`/api/meal-plan/${dateStr}`] });
        setIsEditingIngredients(false);
        setViewingRecipe(null);
        setViewingMeal(null);
        toast({ title: "Sukces", description: "Zapisano składniki partii i rozdzielono je według liczby porcji." });
      }).catch((error: Error) => {
        toast({ title: "Błąd", description: error.message || "Nie udało się zapisać składników wspólnej partii.", variant: "destructive" });
      });
      return;
    }

    if (viewingMeal?.sharedParticipantEntries) {
      const totalSharedServings = participants.reduce((sum: number, entry: any) => sum + (Number(entry?.servings) || 0), 0);

      if (participants.length > 0 && totalSharedServings > 0) {
        const splitIngredients = splitSharedIngredientsByServings(ingredientsData, participants)
          .map((ingredientShare, index) => [
            ...ingredientShare,
            // Preserve additions attached to each person's meal entry.
            ...getAdditionalMealIngredients(
              participants[index].ingredients || [],
              viewingRecipe.ingredients || [],
            ),
          ]);

        Promise.all(participants.map((entry: any, index: number) => updateMealEntryAsync({
          id: entry.id,
          updates: {
            ingredients: splitIngredients[index],
            isEaten: !!entry.isEaten,
            date: entry.date,
            mealType: entry.mealType,
          },
        }))).then(() => {
          queryClient.invalidateQueries({ queryKey: [`/api/meal-plan/${dateStr}`] });
          setIsEditingIngredients(false);
          setViewingRecipe(null);
          setViewingMeal(null);
          toast({ title: "Sukces", description: "Składniki przepisu podzielono na porcje, a osobiste dodatki pozostały przy swoich osobach." });
        }).catch((error: Error) => {
          toast({ title: "Błąd", description: error.message || "Nie udało się zapisać wspólnych składników.", variant: "destructive" });
        });
        return;
      }
    }

    updateMealEntry({
      id: viewingMeal.id,
      updates: {
        ingredients: ingredientsData,
        isEaten: !!viewingMeal.isEaten,
        date: viewingMeal.date,
        mealType: viewingMeal.mealType
      }
    }, {
      onSuccess: () => {
        // Force immediate invalidation on success to be absolutely sure
        queryClient.invalidateQueries({ queryKey: [`/api/meal-plan/${dateStr}`] });
        setIsEditingIngredients(false);
        setViewingRecipe(null);
        setViewingMeal(null);
        toast({ title: "Sukces", description: "Składniki posiłku zostały zaktualizowane." });
      }
    });
  };

  const restoreOriginalIngredients = () => {
    if (!viewingMeal) return;
    updateMealEntry({
      id: viewingMeal.id,
      updates: {
        ingredients: restoreRecipeIngredientsPreservingAdditions(viewingMeal.ingredients || [], viewingMeal.recipe?.ingredients || []),
        isEaten: !!viewingMeal.isEaten,
        date: viewingMeal.date,
        mealType: viewingMeal.mealType,
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/meal-plan/${dateStr}`] });
        setViewingMeal((prev: any) => prev ? {
          ...prev,
          ingredients: restoreRecipeIngredientsPreservingAdditions(prev.ingredients || [], prev.recipe?.ingredients || []),
        } : prev);
        setDisableRecipeScaling(false);
        toast({ title: "Sukces", description: "Przywrócono domyślne składniki z przepisu." });
      },
    });
  };

  const { data: settings, isLoading: isLoadingSettings } = useQuery<any>({
    queryKey: ["/api/user-settings"],
  });
  const { data: userSettingsHistory, isLoading: isLoadingSettingsHistory } = useQuery<Record<"A" | "B", any[]>>({
    queryKey: [api.userSettings.history.path, "0001-01-01", dateStr],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate: "0001-01-01", endDate: dateStr });
      const response = await fetchWithTimeout(`${api.userSettings.history.path}?${params.toString()}`);
      if (!response.ok) throw new Error("Nie udało się pobrać historii ustawień");
      return api.userSettings.history.responses[200].parse(await response.json());
    },
  });

  useEffect(() => {
    if (!settings) return;
    const baseTargets = {
      A: {
        calories: settings?.A?.targetCalories ?? 2000,
        protein: settings?.A?.targetProtein ?? 150,
        carbs: settings?.A?.targetCarbs ?? 200,
        fat: settings?.A?.targetFat ?? 65,
      },
      B: {
        calories: settings?.B?.targetCalories ?? settings?.A?.targetCalories ?? 2000,
        protein: settings?.B?.targetProtein ?? settings?.A?.targetProtein ?? 150,
        carbs: settings?.B?.targetCarbs ?? settings?.A?.targetCarbs ?? 200,
        fat: settings?.B?.targetFat ?? settings?.A?.targetFat ?? 65,
      },
    };

    let localOverrides: any = {};
    let localPercentageOverrides: any = {};
    let localPercentageRangeOverrides: any = {};
    try {
      localOverrides = JSON.parse(localStorage.getItem("dashboard-person-targets") || "{}");
      localPercentageOverrides = JSON.parse(localStorage.getItem("dashboard-person-macro-percentages") || "{}");
      localPercentageRangeOverrides = JSON.parse(localStorage.getItem("dashboard-person-macro-percentage-ranges") || "{}");
    } catch {
      localOverrides = {};
      localPercentageOverrides = {};
      localPercentageRangeOverrides = {};
    }

    const nextTargets = {
      A: {
        calories: Number(localOverrides?.A?.calories ?? baseTargets.A.calories),
        protein: Number(localOverrides?.A?.protein ?? baseTargets.A.protein),
        carbs: Number(localOverrides?.A?.carbs ?? baseTargets.A.carbs),
        fat: Number(localOverrides?.A?.fat ?? baseTargets.A.fat),
      },
      B: {
        calories: Number(localOverrides?.B?.calories ?? baseTargets.B.calories),
        protein: Number(localOverrides?.B?.protein ?? baseTargets.B.protein),
        carbs: Number(localOverrides?.B?.carbs ?? baseTargets.B.carbs),
        fat: Number(localOverrides?.B?.fat ?? baseTargets.B.fat),
      },
    };

    setTargetsByPerson(nextTargets);
    const nextPercentages = {
      A: {
        protein: Number(localPercentageOverrides?.A?.protein ?? settings?.A?.targetProteinPercentage ?? getMacroPercentages(nextTargets.A).protein),
        carbs: Number(localPercentageOverrides?.A?.carbs ?? settings?.A?.targetCarbsPercentage ?? getMacroPercentages(nextTargets.A).carbs),
        fat: Number(localPercentageOverrides?.A?.fat ?? settings?.A?.targetFatPercentage ?? getMacroPercentages(nextTargets.A).fat),
      },
      B: {
        protein: Number(localPercentageOverrides?.B?.protein ?? settings?.B?.targetProteinPercentage ?? settings?.A?.targetProteinPercentage ?? getMacroPercentages(nextTargets.B).protein),
        carbs: Number(localPercentageOverrides?.B?.carbs ?? settings?.B?.targetCarbsPercentage ?? settings?.A?.targetCarbsPercentage ?? getMacroPercentages(nextTargets.B).carbs),
        fat: Number(localPercentageOverrides?.B?.fat ?? settings?.B?.targetFatPercentage ?? settings?.A?.targetFatPercentage ?? getMacroPercentages(nextTargets.B).fat),
      },
    };
    setMacroPercentagesByPerson(nextPercentages);
    setMacroPercentageRangesByPerson({
      A: buildMacroPercentageRanges("A", settings?.A, nextPercentages.A, localPercentageRangeOverrides?.A),
      B: buildMacroPercentageRanges("B", settings?.B ?? settings?.A, nextPercentages.B, localPercentageRangeOverrides?.B),
    });
    const rangeSource = (person: "A" | "B") => settings?.[person] ?? settings?.A ?? {};
    const nextNutrientRanges = {
      A: { sugar: { min: Number(rangeSource("A").targetSugarMin) || 0, max: Number(rangeSource("A").targetSugarMax) || 0 }, fiber: { min: Number(rangeSource("A").targetFiberMin) || 0, max: Number(rangeSource("A").targetFiberMax) || 0 } },
      B: { sugar: { min: Number(rangeSource("B").targetSugarMin) || 0, max: Number(rangeSource("B").targetSugarMax) || 0 }, fiber: { min: Number(rangeSource("B").targetFiberMin) || 0, max: Number(rangeSource("B").targetFiberMax) || 0 } },
    };
    setNutrientRangesByPerson(nextNutrientRanges);
    setNutrientRangeInputsByPerson(toNutrientRangeDrafts(nextNutrientRanges));
  }, [settings]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (newSettings: any) => {
      const res = await apiRequest("PATCH", "/api/user-settings", newSettings);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-settings"] });
      queryClient.invalidateQueries({ queryKey: [api.userSettings.history.path] });
    },
  });

  const isToday = dateStr === todayStr;
  const allEntries = dayPlan?.entries || [];
  useEffect(() => {
    const recipeIds: number[] = Array.from(new Set<number>(allEntries.map((entry: any): number => Number(entry.recipe?.id)).filter((id: number) => id > 0)));
    recipeIds.forEach(async (recipeId) => {
      if (variantOptionsByRecipe[recipeId]) return;
      try {
        const recipe = await fetchRecipeDetails(recipeId);
        const variants = getAvailableVariants(recipe?.ingredients || []);
        if (variants.length) setVariantOptionsByRecipe((prev) => ({ ...prev, [recipeId]: variants }));
      } catch (error) { console.error("Failed to detect dashboard recipe variants", error); }
    });
  }, [allEntries, variantOptionsByRecipe]);
  const personName: Record<string, string> = { A: "Tysia", B: "Mati" };
  const alternateViewingMeal = useMemo(() => {
    if (!viewingMeal?.recipeId) return null;
    const currentPerson: "A" | "B" = (viewingMeal.person || "A") === "B" ? "B" : "A";
    const otherPerson = currentPerson === "A" ? "B" : "A";
    const currentBatchId = Number(viewingMeal.cookedBatchId || 0);

    return allEntries.find((entry: any) => {
      if ((entry.person || "A") !== otherPerson) return false;
      if (Number(entry.recipeId || 0) !== Number(viewingMeal.recipeId || 0)) return false;
      if (entry.mealType !== viewingMeal.mealType) return false;
      if (String(entry.date || dateStr) !== String(viewingMeal.date || dateStr)) return false;
      const entryBatchId = Number(entry.cookedBatchId || 0);
      return currentBatchId > 0 ? entryBatchId === currentBatchId : true;
    }) || null;
  }, [allEntries, dateStr, viewingMeal]);


  const calculateConsumed = (entries: any[]): MacroStats => {
    const eatenEntries = entries.filter((e: any) => e.isEaten) || [];

    return eatenEntries.reduce((acc: any, entry: any) => {
      // Entries based on an ingredient retain both the custom macro fields and
      // their ingredient row. Prefer the server summary in that case: it is
      // the source that also includes sugar and fibre. Checking recipeId
      // prevents an old recipe entry with a stale customCalories value from
      // being treated as a custom meal.
      if (entry.totals) {
        return {
          calories: acc.calories + (Number(entry.totals.calories) || 0),
          protein: acc.protein + (Number(entry.totals.protein) || 0),
          carbs: acc.carbs + (Number(entry.totals.carbs) || 0),
          fat: acc.fat + (Number(entry.totals.fat) || 0),
          sugar: acc.sugar + (Number(entry.totals.sugar) || 0),
          fiber: acc.fiber + (Number(entry.totals.fiber) || 0),
        };
      }

      if (!entry.recipeId && entry.customCalories !== null) {
        const s = Number(entry.servings) || 1;
        return {
          ...acc,
          calories: acc.calories + (entry.customCalories || 0) * s,
          protein: acc.protein + (entry.customProtein || 0) * s,
          carbs: acc.carbs + (entry.customCarbs || 0) * s,
          fat: acc.fat + (entry.customFat || 0) * s,
          sugar: acc.sugar + (entry.customSugar || 0) * s,
          fiber: acc.fiber + (entry.customFiber || 0) * s,
        };
      }

      const entryIngredients = getEntryIngredients(entry);
      const stats = entryIngredients.reduce((sum: any, ri: any) => {
        if (!ri.ingredient) return sum;
        const effectiveAmount = getEffectiveIngredientAmount(entry, ri);
        const nutritionAmount = calculateNutritionAmount(effectiveAmount, ri.ingredient);
        return {
          calories: sum.calories + (ri.ingredient.calories * nutritionAmount / 100),
          protein: sum.protein + (ri.ingredient.protein * nutritionAmount / 100),
          carbs: sum.carbs + (ri.ingredient.carbs * nutritionAmount / 100),
          fat: sum.fat + (ri.ingredient.fat * nutritionAmount / 100),
          sugar: sum.sugar + ((Number(ri.ingredient.sugar) || 0) * nutritionAmount / 100),
          fiber: sum.fiber + ((Number(ri.ingredient.fiber) || 0) * nutritionAmount / 100),
        };
      }, { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0 });

      return {
        calories: acc.calories + stats.calories,
        protein: acc.protein + stats.protein,
        carbs: acc.carbs + stats.carbs,
        fat: acc.fat + stats.fat,
        sugar: acc.sugar + stats.sugar,
        fiber: acc.fiber + stats.fiber,
      };
    }, { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0 });
  };


  const getEffectiveTargetsForDay = (person: "A" | "B"): PersonTargets => {
    const history = [...(userSettingsHistory?.[person] || [])].sort((a, b) =>
      String(b.effectiveDate).localeCompare(String(a.effectiveDate))
    );
    const effective = history.find((row) => String(row.effectiveDate) <= dateStr);
    return {
      calories: Number(effective?.targetCalories ?? targetsByPerson[person].calories),
      protein: Number(effective?.targetProtein ?? targetsByPerson[person].protein),
      carbs: Number(effective?.targetCarbs ?? targetsByPerson[person].carbs),
      fat: Number(effective?.targetFat ?? targetsByPerson[person].fat),
    };
  };

  const effectiveTargetsByPerson = {
    A: getEffectiveTargetsForDay("A"),
    B: getEffectiveTargetsForDay("B"),
  };

  const isDashboardLoading = isLoadingPlan || isLoadingSettings || isLoadingSettingsHistory;

  const consumedA = calculateConsumed(allEntries.filter((e: any) => (e.person || "A") === "A"));
  const consumedB = calculateConsumed(allEntries.filter((e: any) => (e.person || "A") === "B"));

  const produceTotalsByPerson = useMemo(() => {
    const totals = {
      A: { vegetables: 0, fruits: 0 },
      B: { vegetables: 0, fruits: 0 },
    };
    for (const entry of allEntries.filter((item: any) => item.isEaten)) {
      const person: "A" | "B" = entry.person === "B" ? "B" : "A";
      for (const row of getEntryIngredients(entry)) {
        const ingredientId = Number(row.ingredientId ?? row.ingredient?.id);
        const currentIngredient = allAvailableIngredients?.find((item: any) => Number(item.id) === ingredientId);
        const ingredient = currentIngredient || row.ingredient;
        if (!ingredient) continue;
        const amount = calculateNutritionAmount(getEffectiveIngredientAmount(entry, row), ingredient);
        const contribution = getProduceContribution(ingredient, amount);
        if (contribution.produceType === "vegetable") totals[person].vegetables += contribution.grams;
        else if (contribution.produceType === "fruit") totals[person].fruits += contribution.grams;
      }
    }
    return totals;
  }, [allEntries, allAvailableIngredients]);

  const saveProduceGoal = (person: "A" | "B", field: "targetVegetables" | "targetFruits", value: string) => {
    const parsed = Math.max(0, Number(value.replace(",", ".")) || 0);
    updateSettingsMutation.mutate({ person, [field]: parsed });
  };

  const totalDayCost = (dayPlan?.entries || []).reduce((acc: number, entry: any) => {
    const entryIngredients = getEntryIngredients(entry);
    return acc + entryIngredients.reduce((sum: number, ri: any) => {
      const effectiveAmount = getEffectiveIngredientAmount(entry, ri);
      return sum + ((ri.ingredient?.price || 0) * calculatePurchaseAmount(effectiveAmount, ri.ingredient) / 100);
    }, 0);
  }, 0) || 0;

  const resetQuickAdd = () => {
    setQuickAddMode("recipe");
    setQuickMealType("lunch");
    setQuickPerson("A");
    setQuickRecipeId(null);
    setQuickPortionVariant("B");
    setQuickCustomName("");
    setQuickCustomCalories(450);
    setQuickCustomProtein(25);
    setQuickCustomCarbs(45);
    setQuickCustomFat(15);
    setQuickIngredientId(null);
    setQuickIngredientAmount(100);
    setIsQuickRecipePopoverOpen(false);
    setIsQuickIngredientPopoverOpen(false);
  };

  const macroCaloriesPerGram: Record<MacroKey, number> = {
    protein: 4,
    carbs: 4,
    fat: 9,
  };

  const macroPercentageLabels: Record<MacroKey, string> = {
    protein: "Białko",
    carbs: "Węglowodany",
    fat: "Tłuszcze",
  };


  const normalizeMacroPercentageRange = (range: MacroPercentageRange): MacroPercentageRange => {
    const min = Math.max(0, Math.min(100, Number(range.min) || 0));
    const max = Math.max(0, Math.min(100, Number(range.max) || 0));
    return min <= max ? { min, max } : { min: max, max: min };
  };

  const buildMacroPercentageRanges = (_person: "A" | "B", source: any, percentages: MacroPercentages, overrides?: any): MacroPercentageRanges => ({
    protein: normalizeMacroPercentageRange({
      min: Number(overrides?.protein?.min ?? source?.targetProteinPercentageMin ?? source?.targetProteinPercentage ?? percentages.protein),
      max: Number(overrides?.protein?.max ?? source?.targetProteinPercentageMax ?? source?.targetProteinPercentage ?? percentages.protein),
    }),
    carbs: normalizeMacroPercentageRange({
      min: Number(overrides?.carbs?.min ?? source?.targetCarbsPercentageMin ?? source?.targetCarbsPercentage ?? percentages.carbs),
      max: Number(overrides?.carbs?.max ?? source?.targetCarbsPercentageMax ?? source?.targetCarbsPercentage ?? percentages.carbs),
    }),
    fat: normalizeMacroPercentageRange({
      min: Number(overrides?.fat?.min ?? source?.targetFatPercentageMin ?? source?.targetFatPercentage ?? percentages.fat),
      max: Number(overrides?.fat?.max ?? source?.targetFatPercentageMax ?? source?.targetFatPercentage ?? percentages.fat),
    }),
  });

  const calculateMacroGramsFromPercentage = (calories: number, macroKey: MacroKey, percentage: number) => (
    Math.round((calories * (Number(percentage) || 0)) / 100 / macroCaloriesPerGram[macroKey])
  );

  const formatMacroRange = (range: MacroPercentageRange) => (
    range.min === range.max ? `${range.min}%` : `${range.min}-${range.max}%`
  );

  const formatMacroGramRange = (calories: number, macroKey: MacroKey, range: MacroPercentageRange) => {
    const min = calculateMacroGramsFromPercentage(calories, macroKey, range.min);
    const max = calculateMacroGramsFromPercentage(calories, macroKey, range.max);
    return min === max ? `${min} g` : `${min}-${max} g`;
  };

  const getMacroPercentages = (targets: PersonTargets): MacroPercentages => {
    if (targets.calories <= 0) return { protein: 0, carbs: 0, fat: 0 };

    return {
      protein: Math.round(((targets.protein * macroCaloriesPerGram.protein) / targets.calories) * 100),
      carbs: Math.round(((targets.carbs * macroCaloriesPerGram.carbs) / targets.calories) * 100),
      fat: Math.round(((targets.fat * macroCaloriesPerGram.fat) / targets.calories) * 100),
    };
  };

  const calculateTargetsFromPercentages = (calories: number, percentages: MacroPercentages): PersonTargets => ({
    calories,
    protein: Math.round((calories * (Number(percentages.protein) || 0)) / 100 / macroCaloriesPerGram.protein),
    carbs: Math.round((calories * (Number(percentages.carbs) || 0)) / 100 / macroCaloriesPerGram.carbs),
    fat: Math.round((calories * (Number(percentages.fat) || 0)) / 100 / macroCaloriesPerGram.fat),
  });

  const persistPersonTargets = (person: "A" | "B", nextTargets: PersonTargets, nextPercentages: MacroPercentages, nextRanges = macroPercentageRangesByPerson[person]) => {
    const normalizedRanges = {
      protein: normalizeMacroPercentageRange(nextRanges.protein),
      carbs: normalizeMacroPercentageRange(nextRanges.carbs),
      fat: normalizeMacroPercentageRange(nextRanges.fat),
    };
    const nextTargetsByPerson = { ...targetsByPerson, [person]: nextTargets };
    const nextPercentagesByPerson = { ...macroPercentagesByPerson, [person]: nextPercentages };
    const nextRangesByPerson = { ...macroPercentageRangesByPerson, [person]: normalizedRanges };

    setTargetsByPerson(nextTargetsByPerson);
    setMacroPercentagesByPerson(nextPercentagesByPerson);
    setMacroPercentageRangesByPerson(nextRangesByPerson);
    localStorage.setItem("dashboard-person-targets", JSON.stringify(nextTargetsByPerson));
    localStorage.setItem("dashboard-person-macro-percentages", JSON.stringify(nextPercentagesByPerson));
    localStorage.setItem("dashboard-person-macro-percentage-ranges", JSON.stringify(nextRangesByPerson));
    updateSettingsMutation.mutate({
      person,
      targetCalories: nextTargets.calories,
      targetProtein: nextTargets.protein,
      targetCarbs: nextTargets.carbs,
      targetFat: nextTargets.fat,
      targetProteinPercentage: nextPercentages.protein,
      targetCarbsPercentage: nextPercentages.carbs,
      targetFatPercentage: nextPercentages.fat,
      targetProteinPercentageMin: normalizedRanges.protein.min,
      targetProteinPercentageMax: normalizedRanges.protein.max,
      targetCarbsPercentageMin: normalizedRanges.carbs.min,
      targetCarbsPercentageMax: normalizedRanges.carbs.max,
      targetFatPercentageMin: normalizedRanges.fat.min,
      targetFatPercentageMax: normalizedRanges.fat.max,
    });
  };

  const updatePersonTargets = (person: "A" | "B", key: keyof PersonTargets, value: number) => {
    const cleanValue = Number(value) || 0;
    const currentTargets = targetsByPerson[person];
    const currentPercentages = macroPercentagesByPerson[person];
    const nextTargets = key === "calories"
      ? calculateTargetsFromPercentages(cleanValue, currentPercentages)
      : { ...currentTargets, [key]: cleanValue };
    const nextPercentages = key === "calories"
      ? currentPercentages
      : { ...currentPercentages, [key]: getMacroPercentages(nextTargets)[key] };

    const nextRanges = key === "calories" ? macroPercentageRangesByPerson[person] : {
      ...macroPercentageRangesByPerson[person],
      [key]: { min: nextPercentages[key], max: nextPercentages[key] },
    };
    persistPersonTargets(person, nextTargets, nextPercentages, nextRanges);
  };

  const updatePersonMacroPercentage = (person: "A" | "B", key: MacroKey, value: number) => {
    const nextPercentages = {
      ...macroPercentagesByPerson[person],
      [key]: Number(value) || 0,
    };
    const nextTargets = calculateTargetsFromPercentages(targetsByPerson[person].calories, nextPercentages);

    persistPersonTargets(person, nextTargets, nextPercentages, {
      ...macroPercentageRangesByPerson[person],
      [key]: { min: nextPercentages[key], max: nextPercentages[key] },
    });
  };

  const updatePersonMacroPercentageRange = (person: "A" | "B", key: MacroKey, edge: keyof MacroPercentageRange, value: number) => {
    const rawRange = { ...macroPercentageRangesByPerson[person][key], [edge]: Number(value) || 0 };
    const nextRanges = { ...macroPercentageRangesByPerson[person], [key]: normalizeMacroPercentageRange(rawRange) };
    const midpointPercentage = Math.round((nextRanges[key].min + nextRanges[key].max) / 2);
    const nextPercentages = { ...macroPercentagesByPerson[person], [key]: midpointPercentage };
    const nextTargets = calculateTargetsFromPercentages(targetsByPerson[person].calories, nextPercentages);
    persistPersonTargets(person, nextTargets, nextPercentages, nextRanges);
  };

  const updateNutrientRangeDraft = (person: "A" | "B", nutrient: keyof NutrientRanges, edge: keyof NutrientRange, value: string) => {
    setNutrientRangeInputsByPerson((current) => ({
      ...current,
      [person]: {
        ...current[person],
        [nutrient]: { ...current[person][nutrient], [edge]: value },
      },
    }));
  };

  const commitNutrientRange = (person: "A" | "B", nutrient: keyof NutrientRanges, edge: keyof NutrientRange) => {
    const rawValue = nutrientRangeInputsByPerson[person][nutrient][edge].trim().replace(",", ".");
    const parsedValue = Number(rawValue);
    const cleanValue = Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
    const current = nutrientRangesByPerson[person][nutrient];
    const nextRange = edge === "min"
      ? { min: cleanValue, max: Math.max(cleanValue, current.max) }
      : { min: Math.min(current.min, cleanValue), max: cleanValue };
    const next = { ...nutrientRangesByPerson, [person]: { ...nutrientRangesByPerson[person], [nutrient]: nextRange } };
    setNutrientRangesByPerson(next);
    setNutrientRangeInputsByPerson((previous) => ({
      ...previous,
      [person]: { ...previous[person], [nutrient]: { min: String(nextRange.min), max: String(nextRange.max) } },
    }));

    const nutrientPrefix = nutrient === "sugar" ? "Sugar" : "Fiber";
    updateSettingsMutation.mutate({
      person,
      [`target${nutrientPrefix}Min`]: nextRange.min,
      [`target${nutrientPrefix}Max`]: nextRange.max,
    });
  };

  const macrosConfig: { key: keyof PersonTargets; label: string; unit: string; barClassName: string }[] = [
    { key: "calories", label: "KCAL", unit: "kcal", barClassName: "bg-primary" },
    { key: "protein", label: "B", unit: "g", barClassName: "bg-blue-500" },
    { key: "carbs", label: "W", unit: "g", barClassName: "bg-amber-500" },
    { key: "fat", label: "T", unit: "g", barClassName: "bg-rose-500" },
  ];
  const additionalNutrientsConfig = [
    { key: "sugar" as const, label: "Cukry", barClassName: "bg-fuchsia-500" },
    { key: "fiber" as const, label: "Błonnik", barClassName: "bg-emerald-500" },
  ];

  const getProgressPercent = (current: number, target: number) => {
    if (target <= 0) return 0;
    return (current / target) * 100;
  };

  const getProgressBarWidth = (current: number, target: number) => Math.min(getProgressPercent(current, target), 100);

  const openMealRecipe = async (meal: any) => {
    // The eye is a per-person preview, including for meals assigned to a
    // shared batch. The notebook button remains the explicit whole-batch view.
    const fullMeal = await fetchMealEntryFull(Number(meal.id));
    setViewingRecipe(fullMeal.recipe || meal.recipe);
    setViewingMeal(fullMeal);
    setViewingPlannedServings(undefined);
    setDisableRecipeScaling(hasEditedMealIngredients(fullMeal));
    setUsePrecalculatedIngredientAmounts(Number(fullMeal?.cookedBatchId || fullMeal?.cookedBatch?.id) > 0);
  };

  const switchViewingMealPerson = async (meal: any) => {
    // Day-summary entries include amounts calculated for their own serving
    // count. Reload the full entry before rendering it so RecipeView receives
    // the uncalculated ingredient bases and can apply STEP/FIXED/FORMULA rules
    // for the newly selected person's servings.
    const fullMeal = await fetchMealEntryFull(Number(meal.id));
    setViewingRecipe(fullMeal.recipe || meal.recipe || viewingRecipe);
    setViewingMeal(fullMeal);
    setViewingPlannedServings(undefined);
    setDisableRecipeScaling(hasEditedMealIngredients(fullMeal));
    setUsePrecalculatedIngredientAmounts(Number(fullMeal?.cookedBatchId || fullMeal?.cookedBatch?.id) > 0);
  };

  const openWholeRecipe = async (meal: any) => {
    const batchId = Number(meal.cookedBatchId || 0);
    if (batchId > 0) {
      const sharedBatch = sharedBatches.find((batch: any) => Number(batch?.id) === batchId);
      const matchingEntries = sharedBatch?.mealEntries || allEntries.filter((entry: any) => Number(entry.cookedBatchId || 0) === batchId);
      const entriesToLoad = [meal, ...matchingEntries].filter((entry: any, index: number, entries: any[]) => (
        entries.findIndex((candidate: any) => Number(candidate.id) === Number(entry.id)) === index
      ));
      const fullEntries = await Promise.all(entriesToLoad.map((entry: any) => fetchMealEntryFull(Number(entry.id))));
      const fullMeal = fullEntries.find((entry: any) => Number(entry.id) === Number(meal.id)) || fullEntries[0];
      const batch = sharedBatch || fullMeal?.cookedBatch;
      const recipe = batch?.recipe || fullMeal?.recipe || meal.recipe;
      const totalServings = Number(batch?.totalServings) || Number(recipe?.servings) || 1;
      const participants = {
        A: fullEntries.find((entry: any) => (entry.person || "A") === "A"),
        B: fullEntries.find((entry: any) => entry.person === "B"),
      };

      setViewingRecipe(recipe);
      setViewingMeal({
        ...fullMeal,
        // Keep the preview scoped to the person who opened it. Only the
        // ingredient editor switches to the whole batch context.
        sharedParticipantEntries: participants,
        servings: totalServings,
        ingredients: buildWholeSharedBatchIngredients(batch || { recipe, totalServings }),
        wholeRecipeBatchId: batchId,
        wholeRecipeBatchServings: totalServings,
      });
      // RecipeView uses plannedServings to select the planned-recipe mode.
      // Keep it at the full batch size and retain the pre-calculated ingredient
      // amounts, otherwise it rescales the rows back to the opener's portion.
      setViewingPlannedServings(totalServings);
      setDisableRecipeScaling(false);
      setUsePrecalculatedIngredientAmounts(true);
      return;
    }
    const relatedMeals = allEntries.filter((entry: any) => {
      if (Number(entry.recipeId || 0) !== Number(meal.recipeId || 0)) return false;
      if (String(entry.date) !== String(meal.date)) return false;
      return batchId > 0 ? Number(entry.cookedBatchId || 0) === batchId : true;
    });
    const fullEntries = await Promise.all(relatedMeals.map((entry: any) => fetchMealEntryFull(Number(entry.id))));
    const fullMeal = fullEntries.find((entry: any) => Number(entry.id) === Number(meal.id)) || fullEntries[0];
    const participants = {
      A: fullEntries.find((entry: any) => (entry.person || "A") === "A"),
      B: fullEntries.find((entry: any) => entry.person === "B"),
    };

    const fullRecipe = fullMeal?.recipe || meal.recipe;
    const servings = fullEntries.reduce((total: number, entry: any) => total + (Number(entry.servings) || 0), 0);
    const ingredients = buildSharedIngredientsSummary({
      entriesA: fullEntries.filter((entry: any) => (entry.person || "A") === "A"),
      entriesB: fullEntries.filter((entry: any) => (entry.person || "A") === "B"),
      recipe: fullRecipe,
    });

    setViewingRecipe(fullRecipe);
    setViewingMeal({ ...fullMeal, ingredients, isSharedPreview: fullEntries.length > 1, sharedParticipantEntries: participants });
    setViewingPlannedServings(servings || undefined);
    setDisableRecipeScaling(true);
    setUsePrecalculatedIngredientAmounts(true);
  };

  const renderMacroTiles = (title: string, consumedPerson: MacroStats, targets: PersonTargets, ranges: NutrientRanges) => (
    <div className="rounded-xl border border-border/50 bg-white p-3 shadow-sm">
      <p className="mb-2 text-xs font-semibold text-foreground">{title}</p>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
        {macrosConfig.map((macro) => (
          <div key={macro.key} className="rounded-lg border border-border/60 bg-card px-2.5 py-2">
            <div className="mb-1 flex min-w-0 flex-col items-start gap-0.5"><p className="text-xs font-semibold leading-tight text-foreground">{macro.label}</p><p className="whitespace-nowrap text-[11px] leading-tight tabular-nums text-muted-foreground">{Math.round(consumedPerson[macro.key])} / {Math.round(targets[macro.key])} {macro.unit}</p></div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full transition-all duration-500", macro.barClassName)} style={{ width: `${getProgressBarWidth(consumedPerson[macro.key], targets[macro.key])}%` }} /></div>
          </div>
        ))}
        {(["vegetables", "fruits"] as const).map((kind) => {
          const isVegetable = kind === "vegetables";
          const label = isVegetable ? "Warzywa" : "Owoce";
          const field = isVegetable ? "targetVegetables" : "targetFruits";
          const current = produceTotalsByPerson[title === "Tysia" ? "A" : "B"][kind];
          const target = Number((settings as any)?.[title === "Tysia" ? "A" : "B"]?.[field] ?? 0);
          return <div key={kind} className="rounded-lg border border-border/60 bg-card px-2.5 py-2"><div className="mb-1 flex min-w-0 flex-col items-start gap-0.5"><p className="text-xs font-semibold leading-tight text-foreground">{label}</p><p className="whitespace-nowrap text-[11px] leading-tight tabular-nums text-muted-foreground">{Math.round(current)} / {Math.round(target)} g</p></div><div className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full transition-all duration-500", isVegetable ? "bg-green-600" : "bg-orange-500")} style={{ width: `${getProgressBarWidth(current, target)}%` }} /></div></div>;
        })}
        {additionalNutrientsConfig.map((nutrient) => {
          const range = ranges[nutrient.key];
          const progressTarget = nutrient.key === "sugar" ? range.max : range.min;
          return <div key={nutrient.key} className="rounded-lg border border-border/60 bg-card px-2.5 py-2"><div className="mb-1 flex min-w-0 flex-col items-start gap-0.5"><p className="text-xs font-semibold leading-tight text-foreground">{nutrient.label}</p><p className="whitespace-nowrap text-[11px] leading-tight tabular-nums text-muted-foreground">{Math.round(consumedPerson[nutrient.key] * 10) / 10} / {range.min}-{range.max} g</p></div><div className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full transition-all duration-500", nutrient.barClassName)} style={{ width: `${getProgressBarWidth(consumedPerson[nutrient.key], progressTarget)}%` }} /></div></div>;
        })}
      </div>
    </div>
  );


  const getServingInputKey = (entry: any) => `${entry.id}-${entry.person || "A"}`;

  const updateServingsQuick = (entry: any, nextServings: number) => {
    const parsed = Number(nextServings);
    if (!parsed || parsed <= 0) return;

    updateMealEntry({
      id: entry.id,
      updates: {
        servings: parsed,
        isEaten: !!entry.isEaten,
        person: entry.person || "A",
        date: entry.date,
        mealType: entry.mealType,
      },
    });
  };

  const applyServingInput = (entry: any) => {
    const inputKey = getServingInputKey(entry);
    const rawValue = servingInputs[inputKey];
    if (rawValue === undefined) return;
    const parsed = Number(rawValue.replace(",", "."));
    if (!parsed || parsed <= 0) {
      setServingInputs((prev) => {
        const next = { ...prev };
        delete next[inputKey];
        return next;
      });
      return;
    }

    const rounded = Math.round(parsed * 100) / 100;
    updateServingsQuick(entry, rounded);
    setServingInputs((prev) => {
      const next = { ...prev };
      delete next[inputKey];
      return next;
    });
  };

  const updateIngredientAmountQuick = (entry: any, nextAmount: number) => {
    const entryIngredient = entry?.ingredients?.[0];
    const parsed = Math.max(1, Math.round(Number(nextAmount) || 0));
    if (!entryIngredient?.ingredientId || parsed <= 0) return;

    const ingredient = entryIngredient.ingredient || allAvailableIngredients?.find((item: any) => Number(item.id) === Number(entryIngredient.ingredientId));
    const factor = parsed / 100;

    updateMealEntry({
      id: entry.id,
      updates: {
        ingredients: [{ ingredientId: entryIngredient.ingredientId, amount: parsed }],
        servings: Number(entry.servings) || 1,
        isEaten: !!entry.isEaten,
        person: entry.person || "A",
        date: entry.date,
        mealType: entry.mealType,
        ...(ingredient ? {
          customCalories: Math.round((Number(ingredient.calories) || 0) * factor),
          customProtein: Number(((Number(ingredient.protein) || 0) * factor).toFixed(1)),
          customCarbs: Number(((Number(ingredient.carbs) || 0) * factor).toFixed(1)),
          customFat: Number(((Number(ingredient.fat) || 0) * factor).toFixed(1)),
          customSugar: Number(((Number(ingredient.sugar) || 0) * factor).toFixed(1)),
          customFiber: Number(((Number(ingredient.fiber) || 0) * factor).toFixed(1)),
        } : {}),
      },
    });
  };

  const quickAddValidationMessage = useMemo(() => {
    if (quickAddMode === "recipe" && !quickRecipeId) return "Wybierz przepis, aby dodać posiłek.";
    if (quickAddMode === "ingredient" && !quickIngredientId) return "Wybierz składnik, aby dodać wpis.";
    if (quickAddMode === "ingredient" && quickIngredientAmount <= 0) return "Podaj gramaturę większą niż 0 g.";
    if (quickAddMode === "custom" && !quickCustomName.trim()) return "Podaj nazwę własnego posiłku.";
    return null;
  }, [quickAddMode, quickRecipeId, quickIngredientId, quickIngredientAmount, quickCustomName]);

  const handleQuickAddMeal = () => {
    if (quickAddMode === "recipe") {
      if (!quickRecipeId) {
        toast({ title: "Błąd", description: "Wybierz przepis.", variant: "destructive" });
        return;
      }

      addEntry({
        date: dateStr,
        mealType: quickMealType,
        person: quickPerson,
        recipeId: quickRecipeId,
        servings: 1,
        ...(isQuickRecipeVariant ? { portionVariant: quickPortionVariant } : {}),
        isEaten: true,
      }, {
        onSuccess: () => {
          setIsQuickAddOpen(false);
          resetQuickAdd();
          toast({ title: "Dodano", description: "Posiłek został dodany do planu i oznaczony jako zjedzony." });
        },
      });
      return;
    }

    if (quickAddMode === "ingredient") {
      if (!quickIngredientId || !allAvailableIngredients) {
        toast({ title: "Błąd", description: "Wybierz składnik.", variant: "destructive" });
        return;
      }

      if (quickIngredientAmount <= 0) {
        toast({ title: "Błąd", description: "Podaj poprawną gramaturę.", variant: "destructive" });
        return;
      }

      const ingredient = allAvailableIngredients.find((item: any) => item.id === quickIngredientId);
      if (!ingredient) {
        toast({ title: "Błąd", description: "Nie znaleziono składnika.", variant: "destructive" });
        return;
      }

      const factor = quickIngredientAmount / 100;
      addEntry({
        date: dateStr,
        mealType: quickMealType,
        person: quickPerson,
        customName: ingredient.name,
        customCalories: Math.round((ingredient.calories || 0) * factor),
        customProtein: Number(((ingredient.protein || 0) * factor).toFixed(1)),
        customCarbs: Number(((ingredient.carbs || 0) * factor).toFixed(1)),
        customFat: Number(((ingredient.fat || 0) * factor).toFixed(1)),
        customSugar: Number(((ingredient.sugar || 0) * factor).toFixed(1)),
        customFiber: Number(((ingredient.fiber || 0) * factor).toFixed(1)),
        servings: 1,
        isEaten: true,
        recipeId: null as any,
      }, {
        onSuccess: (entry) => {
          updateMealEntry({
            id: entry.id,
            updates: {
              ingredients: [{ ingredientId: quickIngredientId, amount: Math.round(quickIngredientAmount) }],
              servings: 1,
            },
          }, {
            onSuccess: () => {
              setIsQuickAddOpen(false);
              resetQuickAdd();
              toast({ title: "Dodano", description: "Składnik został dodany i oznaczony jako zjedzony." });
            },
          });
        },
      });
      return;
    }

    if (!quickCustomName.trim()) {
      toast({ title: "Błąd", description: "Podaj nazwę posiłku.", variant: "destructive" });
      return;
    }

    addEntry({
      date: dateStr,
      mealType: quickMealType,
      person: quickPerson,
      customName: quickCustomName.trim(),
      customCalories: Number(quickCustomCalories) || 0,
      customProtein: Number(quickCustomProtein) || 0,
      customCarbs: Number(quickCustomCarbs) || 0,
      customFat: Number(quickCustomFat) || 0,
      servings: 1,
      isEaten: true,
      recipeId: null as any,
    }, {
      onSuccess: () => {
        setIsQuickAddOpen(false);
        resetQuickAdd();
        toast({ title: "Dodano", description: "Posiłek został dodany do planu i oznaczony jako zjedzony." });
      },
    });
  };


  if (isDashboardLoading) return <Layout><LoadingSpinner /></Layout>;

  return (
    <Layout>
      <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-4">
            <p className="text-muted-foreground text-lg">
              {isToday ? "Podsumowanie na dziś," : "Podsumowanie na"} <span className="font-semibold text-foreground">{format(date, "EEEE, d MMMM", { locale: pl })}</span>
            </p>
            <div className="flex items-center gap-2 px-3 py-1 bg-primary/10 rounded-full text-primary font-bold text-sm">
              <Wallet className="w-4 h-4" />
              {Math.round(totalDayCost)} PLN
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={isQuickAddOpen} onOpenChange={(open) => {
            setIsQuickAddOpen(open);
            if (!open) resetQuickAdd();
          }}>
            <DialogTrigger asChild>
              <Button className="rounded-xl gap-2">
                <PlusCircle className="w-4 h-4" />
                Szybkie dodanie
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl bg-white">
              <DialogHeader>
                <DialogTitle>Szybko dodaj zjedzony posiłek</DialogTitle>
                <DialogDescription>Wybierz osobę i dodaj zjedzony posiłek z przepisu lub jako własny wpis.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium">Typ posiłku</label>
                    <Select value={quickMealType} onValueChange={setQuickMealType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="breakfast">Śniadanie</SelectItem>
                        <SelectItem value="snack">Lunch</SelectItem>
                        <SelectItem value="lunch">Obiad</SelectItem>
                        <SelectItem value="dinner">Kolacja</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Osoba</label>
                    <Select value={quickPerson} onValueChange={(v: "A" | "B") => {
                      setQuickPerson(v);
                      if (!selectedQuickRecipe) return;
                      const availableVariants = getAvailableVariants(selectedQuickRecipe.ingredients || []);
                      const configuredDefault = getDefaultVariant(
                        selectedQuickRecipe.portioningMode,
                        v === "A" ? selectedQuickRecipe.defaultVariantA : selectedQuickRecipe.defaultVariantB,
                      );
                      setQuickPortionVariant(
                        availableVariants.includes(configuredDefault)
                          ? configuredDefault
                          : (availableVariants[0] || configuredDefault),
                      );
                    }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="A">Tysia</SelectItem>
                        <SelectItem value="B">Mati</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button type="button" variant={quickAddMode === "recipe" ? "default" : "outline"} onClick={() => setQuickAddMode("recipe")} className="flex-1">
                    Z przepisu
                  </Button>
                  <Button type="button" variant={quickAddMode === "ingredient" ? "default" : "outline"} onClick={() => setQuickAddMode("ingredient")} className="flex-1">
                    Składnik
                  </Button>
                  <Button type="button" variant={quickAddMode === "custom" ? "default" : "outline"} onClick={() => setQuickAddMode("custom")} className="flex-1">
                    Własny posiłek
                  </Button>
                </div>

                {quickAddMode === "recipe" ? (
                  <div>
                    <label className="text-sm font-medium">Przepis</label>
                    <Popover open={isQuickRecipePopoverOpen} onOpenChange={setIsQuickRecipePopoverOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" role="combobox" className={cn("w-full justify-between", !quickRecipeId && "text-muted-foreground")}>
                          {quickRecipeId ? recipes?.find((r) => r.id === quickRecipeId)?.name : "Wybierz przepis..."}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[440px] p-0">
                        <Command>
                          <CommandInput placeholder="Szukaj przepisu..." />
                          <CommandList>
                            <CommandEmpty>Nie znaleziono przepisu.</CommandEmpty>
                            <CommandGroup>
                              {recipes?.map((recipe) => (
                                <PopoverClose asChild key={recipe.id}>
                                  <CommandItem
                                    value={recipe.name}
                                    onSelect={async () => {
                                      setQuickRecipeId(recipe.id);
                                      setQuickRecipeDetails(null);
                                      setIsQuickRecipePopoverOpen(false);
                                      try {
                                        const details = await fetchRecipeDetails(Number(recipe.id));
                                        setQuickRecipeDetails(details);
                                        const availableVariants = getAvailableVariants(details?.ingredients || []);
                                        const configuredDefault = getDefaultVariant(
                                          details?.portioningMode,
                                          quickPerson === "A" ? details?.defaultVariantA : details?.defaultVariantB,
                                        );
                                        setQuickPortionVariant(
                                          availableVariants.includes(configuredDefault)
                                            ? configuredDefault
                                            : (availableVariants[0] || configuredDefault),
                                        );
                                      } catch (error) {
                                        console.error("Failed to load full recipe details for variant selection", error);
                                      }
                                    }}
                                  >
                                    <Check className={cn("mr-2 h-4 w-4", quickRecipeId === recipe.id ? "opacity-100" : "opacity-0")} />
                                    {recipe.name}
                                  </CommandItem>
                                </PopoverClose>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    {isQuickRecipeVariant && (
                      <div className="mt-3 space-y-2 rounded-lg border p-3">
                        <p className="text-sm font-semibold">Wariant porcji</p>
                        <Select value={quickRecipeVariants.includes(quickPortionVariant) ? quickPortionVariant : (quickRecipeVariants[0] || "B")} onValueChange={(value) => setQuickPortionVariant(value as PortionVariant)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>{quickRecipeVariants.map((variant: PortionVariant) => <SelectItem key={variant} value={variant}>{variant} {variant === "A" ? "— mniejsza" : variant === "B" ? "— standardowa" : "— większa"}</SelectItem>)}</SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">Każdy wariant to jedna porcja o wielkości określonej ilościami składników.</p>
                      </div>
                    )}
                    {quickRecipeNutritionPreview && (
                      <div className="mt-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
                        <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                          {isQuickRecipeVariant ? `Makro i kcal dla wariantu ${quickPortionVariant} (1 porcja)` : "Makro i kcal dla 1 porcji"}
                        </p>
                        <p className="text-foreground">
                          {Number(quickRecipeNutritionPreview.calories.toFixed(1))} kcal • B: {Number(quickRecipeNutritionPreview.protein.toFixed(1))} g • W: {Number(quickRecipeNutritionPreview.carbs.toFixed(1))} g • T: {Number(quickRecipeNutritionPreview.fat.toFixed(1))} g • Cukry: {Number(quickRecipeNutritionPreview.sugar.toFixed(1))} g • Błonnik: {Number(quickRecipeNutritionPreview.fiber.toFixed(1))} g
                        </p>
                      </div>
                    )}
                  </div>
                ) : quickAddMode === "ingredient" ? (
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm font-medium">Składnik</label>
                      <Popover open={isQuickIngredientPopoverOpen} onOpenChange={setIsQuickIngredientPopoverOpen}>
                        <PopoverTrigger asChild>
                          <Button variant="outline" role="combobox" className={cn("w-full justify-between", !quickIngredientId && "text-muted-foreground")}>
                            {quickIngredientId ? allAvailableIngredients?.find((i: any) => i.id === quickIngredientId)?.name : "Wybierz składnik..."}
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[440px] p-0">
                          <Command>
                            <CommandInput placeholder="Szukaj składnika..." />
                            <CommandList>
                              <CommandEmpty>Nie znaleziono składnika.</CommandEmpty>
                              <CommandGroup>
                                {allAvailableIngredients?.map((ingredient: any) => (
                                  <PopoverClose asChild key={ingredient.id}>
                                    <CommandItem
                                      value={ingredient.name}
                                      onSelect={() => {
                                        setQuickIngredientId(ingredient.id);
                                        setIsQuickIngredientPopoverOpen(false);
                                      }}
                                    >
                                      <Check className={cn("mr-2 h-4 w-4", quickIngredientId === ingredient.id ? "opacity-100" : "opacity-0")} />
                                      {ingredient.name}
                                    </CommandItem>
                                  </PopoverClose>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div>
                      <label className="text-sm font-medium">Gramatura (g)</label>
                      <Input type="number" min={1} value={quickIngredientAmount} onChange={(e) => setQuickIngredientAmount(Number(e.target.value) || 0)} />
                    </div>
                    {selectedQuickIngredient && (
                      <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
                        <p className="font-semibold text-emerald-700 dark:text-emerald-300">{selectedQuickIngredient.name}</p>
                        {quickIngredientNutritionPreview && (
                          <p className="text-foreground">
                            Dla {Math.max(0, quickIngredientAmount)} g: {quickIngredientNutritionPreview.calories} kcal • B: {quickIngredientNutritionPreview.protein} g • W: {quickIngredientNutritionPreview.carbs} g • T: {quickIngredientNutritionPreview.fat} g • Cukry: {quickIngredientNutritionPreview.sugar} g • Błonnik: {quickIngredientNutritionPreview.fiber} g
                          </p>
                        )}
                        {Number(selectedQuickIngredient?.unitWeight || 0) > 0 && (
                          <p className="text-xs text-emerald-700 dark:text-emerald-300">
                            {selectedQuickIngredient.unitDescription ? `${selectedQuickIngredient.unitDescription} • ` : ""}
                            1 szt. ≈ {selectedQuickIngredient.unitWeight} g
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm font-medium">Nazwa posiłku</label>
                      <Input value={quickCustomName} onChange={(e) => setQuickCustomName(e.target.value)} placeholder="np. Kanapka po treningu" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className="text-sm font-medium">Kalorie</label><Input type="number" value={quickCustomCalories} onChange={(e) => setQuickCustomCalories(Number(e.target.value))} /></div>
                      <div><label className="text-sm font-medium">Białko (g)</label><Input type="number" value={quickCustomProtein} onChange={(e) => setQuickCustomProtein(Number(e.target.value))} /></div>
                      <div><label className="text-sm font-medium">Węglowodany (g)</label><Input type="number" value={quickCustomCarbs} onChange={(e) => setQuickCustomCarbs(Number(e.target.value))} /></div>
                      <div><label className="text-sm font-medium">Tłuszcz (g)</label><Input type="number" value={quickCustomFat} onChange={(e) => setQuickCustomFat(Number(e.target.value))} /></div>
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
                {quickAddValidationMessage ? (
                  <p className="text-xs text-muted-foreground sm:mr-auto">{quickAddValidationMessage}</p>
                ) : null}
                <Button variant="outline" onClick={() => setIsQuickAddOpen(false)}>Anuluj</Button>
                <Button onClick={handleQuickAddMeal} disabled={isQuickAdding || !!quickAddValidationMessage}>{isQuickAdding ? "Dodawanie..." : "Dodaj i oznacz jako zjedzone"}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="icon" className="rounded-xl">
                <Settings2 className="w-5 h-5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Ustawienia celów (osobno dla każdej osoby)</DialogTitle>
                <DialogDescription>Ustaw dzienne cele kalorii i makroskładników niezależnie dla Tysi oraz Matiego.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {(["A", "B"] as const).map((person) => {
                  const ranges = macroPercentageRangesByPerson[person];
                  return (
                    <div key={person} className="space-y-4 rounded-xl border border-border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{personName[person]}</p>
                          <p className="text-xs text-muted-foreground">Podaj kcal i zakres procentowy, np. 20-35%, a widełki gramów przeliczą się automatycznie.</p>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-medium">Tryb celu kalorycznego</label>
                        <Select value={(settings as any)?.[person]?.calorieGoalMode || "maintenance"} onValueChange={(value: "cut" | "bulk" | "maintenance") => updateSettingsMutation.mutate({ person, calorieGoalMode: value })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="cut">Redukcja</SelectItem>
                            <SelectItem value="bulk">Masa</SelectItem>
                            <SelectItem value="maintenance">Utrzymanie</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[11px] text-muted-foreground">Redukcja: do 105% celu · Masa: od 95% · Utrzymanie: 95–105%.</p>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium">Kalorie (kcal)</label>
                          <Input
                            type="number"
                            value={targetsByPerson[person].calories}
                            onChange={(e) => updatePersonTargets(person, "calories", Number(e.target.value))}
                          />
                        </div>
                        <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                          1 g białka = 4 kcal, 1 g węglowodanów = 4 kcal, 1 g tłuszczu = 9 kcal.
                        </div>
                      </div>

                      <div className="grid grid-cols-[1fr_4.5rem_4.5rem_5.5rem] items-end gap-2">
                        <p className="text-xs font-semibold text-muted-foreground">Makro</p>
                        <p className="text-xs font-semibold text-muted-foreground">Min %</p>
                        <p className="text-xs font-semibold text-muted-foreground">Max %</p>
                        <p className="text-xs font-semibold text-muted-foreground">Widełki</p>

                        {(["protein", "carbs", "fat"] as MacroKey[]).map((macroKey) => (
                          <div key={`${person}-${macroKey}`} className="contents">
                            <label className="pb-2 text-xs font-medium">{macroPercentageLabels[macroKey]}</label>
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={ranges[macroKey].min}
                              onChange={(e) => updatePersonMacroPercentageRange(person, macroKey, "min", Number(e.target.value))}
                              aria-label={`${macroPercentageLabels[macroKey]} minimalny procent kalorii dla ${personName[person]}`}
                            />
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={ranges[macroKey].max}
                              onChange={(e) => updatePersonMacroPercentageRange(person, macroKey, "max", Number(e.target.value))}
                              aria-label={`${macroPercentageLabels[macroKey]} maksymalny procent kalorii dla ${personName[person]}`}
                            />
                            <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs font-medium">
                              <div>{formatMacroRange(ranges[macroKey])}</div>
                              <div className="text-muted-foreground">{formatMacroGramRange(targetsByPerson[person].calories, macroKey, ranges[macroKey])}</div>
                            </div>
                          </div>
                        ))}
                      </div>

                      <p className="text-xs text-muted-foreground">Zakresy makroskładników są traktowane jako niezależne widełki — ich minima i maksima nie muszą sumować się do 100%.</p>
                      <div className="grid grid-cols-[1fr_5rem_5rem] items-end gap-2">
                        <p className="text-xs font-semibold text-muted-foreground">Cele warzyw i owoców (g)</p><p className="text-xs font-semibold text-muted-foreground">Cel</p><p className="text-xs font-semibold text-muted-foreground"> </p>
                        {(["targetVegetables", "targetFruits"] as const).map((field) => (
                          <div key={`${person}-${field}`} className="contents">
                            <label className="pb-2 text-xs font-medium">{field === "targetVegetables" ? "Warzywa" : "Owoce"}</label>
                            <Input type="number" min={0} step="10" defaultValue={String((settings as any)?.[person]?.[field] ?? 0)} onBlur={(e) => saveProduceGoal(person, field, e.target.value)} aria-label={`Cel ${field} dla ${personName[person]}`} />
                            <span />
                          </div>
                        ))}
                        <p className="text-xs font-semibold text-muted-foreground">Cukry i błonnik</p><p className="text-xs font-semibold text-muted-foreground">Min g</p><p className="text-xs font-semibold text-muted-foreground">Max g</p>
                        {(["sugar", "fiber"] as const).map((nutrient) => (
                          <div key={`${person}-${nutrient}`} className="contents">
                            <label className="pb-2 text-xs font-medium">{nutrient === "sugar" ? "Cukry" : "Błonnik"}</label>
                            <Input
                              type="number"
                              min={0}
                              step="0.1"
                              value={nutrientRangeInputsByPerson[person][nutrient].min}
                              onChange={(e) => updateNutrientRangeDraft(person, nutrient, "min", e.target.value)}
                              onBlur={() => commitNutrientRange(person, nutrient, "min")}
                              aria-label={`${nutrient} minimalna wartość dla ${personName[person]}`}
                            />
                            <Input
                              type="number"
                              min={0}
                              step="0.1"
                              value={nutrientRangeInputsByPerson[person][nutrient].max}
                              onChange={(e) => updateNutrientRangeDraft(person, nutrient, "max", e.target.value)}
                              onBlur={() => commitNutrientRange(person, nutrient, "max")}
                              aria-label={`${nutrient} maksymalna wartość dla ${personName[person]}`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </DialogContent>
          </Dialog>
          <div className="flex items-center gap-2 bg-white p-1 rounded-xl border border-border shadow-sm">
            <button
              onClick={() => setDate(d => subDays(d, 1))}
              className="p-2 hover:bg-muted rounded-lg transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => setDate(new Date())}
              className={cn(
                "px-3 py-1 text-sm font-medium rounded-lg transition-colors",
                isToday ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"
              )}
            >
              Dzisiaj
            </button>
            <button
              onClick={() => setDate(d => addDays(d, 1))}
              className="p-2 hover:bg-muted rounded-lg transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="space-y-4 mb-8">
        {renderMacroTiles("Tysia", consumedA, effectiveTargetsByPerson.A, nutrientRangesByPerson.A)}
        {renderMacroTiles("Mati", consumedB, effectiveTargetsByPerson.B, nutrientRangesByPerson.B)}
      </div>

      <Suspense fallback={null}>
      <RecipeView
        recipe={viewingRecipe}
        isOpen={!!viewingRecipe}
        onClose={() => {
          setViewingRecipe(null);
          setViewingMeal(null);
          setViewingPlannedServings(undefined);
          setDisableRecipeScaling(false);
          setUsePrecalculatedIngredientAmounts(false);
        }}
        plannedServings={viewingPlannedServings ?? (viewingMeal ? Number(viewingMeal.servings) : undefined)}
        mealEntryIngredients={viewingMeal?.ingredients}
        frequentAddonIds={viewingRecipe?.frequentAddons?.map((addon: any) => addon.ingredientId) || []}
        onEditIngredients={viewingMeal ? startEditing : undefined}
        onPlannedServingsChange={viewingMeal && !disableRecipeScaling && !viewingMeal?.wholeRecipeBatchId ? updateViewingMealServings : undefined}
        servingsLockedReason={hasEditedMealIngredients(viewingMeal) ? "Porcje zablokowane (edytowano składniki)" : undefined}
        allowIngredientEditing={!!viewingMeal}
        onRestoreOriginalIngredients={hasEditedMealIngredients(viewingMeal) ? restoreOriginalIngredients : undefined}
        usePrecalculatedAmounts={usePrecalculatedIngredientAmounts}
        switchPlannedPersonLabel={alternateViewingMeal ? `Pokaż: ${personName[(alternateViewingMeal.person || "A") as "A" | "B"]}` : undefined}
        onSwitchPlannedPerson={alternateViewingMeal ? () => switchViewingMealPerson(alternateViewingMeal) : undefined}
        compact
        showFooter={false}
        onAddToPlan={() => {}}
      />
      </Suspense>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Menu na {isToday ? "dziś" : format(date, "eeee", { locale: pl })}</h2>
          <div className="flex items-center gap-2">
            <Link href="/meal-prep">
              <Button variant="outline" size="sm" className="relative gap-1.5">
                <CalendarClock className="h-4 w-4" />
                Meal Prep
                {hasActiveMealPrep && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[11px] font-bold leading-none text-destructive-foreground" aria-label="Są aktywne zadania Meal Prep">
                    !
                  </span>
                )}
              </Button>
            </Link>

          </div>
        </div>

        {(mealPrepOpportunities?.items || []).length > 0 && (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 shadow-sm dark:border-emerald-900/60 dark:bg-emerald-950/20">
            <div className="mb-3 flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-emerald-700 dark:text-emerald-300" />
              <h3 className="font-semibold text-emerald-950 dark:text-emerald-100">Aktywny Meal Prep</h3>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              {(mealPrepOpportunities?.items || []).map((item: any) => {
                const distinctMeals = new Map<string, any>();
                (item.forMeals || []).forEach((meal: any) => {
                  const recipeName = String(meal.recipeName || item.title);
                  const key = `${String(meal.date).slice(0, 10)}::${recipeName.trim().toLocaleLowerCase("pl-PL")}`;
                  if (!distinctMeals.has(key)) distinctMeals.set(key, { recipeName, date: String(meal.date).slice(0, 10) });
                });
                const meals = Array.from(distinctMeals.values()).sort((a, b) => a.date.localeCompare(b.date) || a.recipeName.localeCompare(b.recipeName, "pl"));

                return (
                  <article key={item.groupKey} className="rounded-xl border border-emerald-200/80 bg-white/85 p-3 dark:border-emerald-900/60 dark:bg-background/70">
                    <h4 className="font-semibold text-foreground">{item.title}</h4>

                    {item.notes && (
                      <p className="mt-2 whitespace-pre-wrap rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100">
                        {item.notes}
                      </p>
                    )}

                    {meals.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {meals.map((meal) => (
                          <div key={`${item.groupKey}-${meal.date}-${meal.recipeName}`} className="rounded-lg border border-border/60 bg-background px-3 py-2">
                            <p className="text-sm font-medium">{meal.recipeName}</p>
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(`${meal.date}T12:00:00`), "d MMMM", { locale: pl })}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {allEntries.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-border">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <CalendarDays className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">Brak zaplanowanych posiłków na ten dzień</h3>
            <p className="text-muted-foreground mb-4">Zacznij dodawać zdrowe przepisy do swojego harmonogramu!</p>
            <Link href={`/meal-plan?date=${dateStr}`}>
              <button className="bg-primary text-primary-foreground px-6 py-2 rounded-xl font-medium hover:bg-primary/90 transition-colors">
                Zaplanuj posiłki
              </button>
            </Link>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4">
            {["breakfast", "snack", "lunch", "dinner"].map((type) => {
              const meals = allEntries.filter((e: any) => e.mealType === type);
              if (!meals?.length) return null;

              return (
                <div key={type} className="overflow-hidden rounded-2xl border border-border/60 bg-white shadow-sm">
                  <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-4 py-3">
                    <h3 className="text-sm font-bold tracking-tight text-foreground">{({ breakfast: "☀️", snack: "🥪", lunch: "🍽️", dinner: "🌙" } as Record<string, string>)[type]} {mealTypeLabels[type]}</h3>
                    <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">{meals.length} {meals.length === 1 ? "posiłek" : "posiłki"}</span>
                  </div>
                  <div className="space-y-2 p-3 sm:p-4">
                    {meals.map((meal: any) => (
                      <div
                        key={meal.id}
                        className={cn(
                          "group relative flex min-h-[76px] items-center gap-3 rounded-xl border px-3 py-3 pr-10 transition-colors",
                          meal.isEaten ? "border-emerald-300 bg-emerald-50/80 dark:border-emerald-800 dark:bg-emerald-950/50" : "border-border/60 bg-card hover:border-primary/30 hover:bg-muted/20"
                        )}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                          <button
                            type="button"
                            onPointerDown={handleEatenButtonPointerDown}
                            onClick={(event) => handleEatenButtonClick(event, meal)}
                            className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-300 touch-manipulation active:bg-primary/10",
                              meal.isEaten ? "text-primary" : "text-muted-foreground hover:text-primary/70"
                            )}
                            aria-label={meal.isEaten ? "Oznacz posiłek jako niezjedzony" : "Oznacz posiłek jako zjedzony"}
                          >
                            {meal.isEaten ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                          </button>

                          <div className="flex min-w-0 flex-1 flex-col">
                            <p className={cn(
                                "truncate pr-5 text-base font-semibold transition-all",
                                meal.isEaten && "text-muted-foreground dark:text-emerald-100 line-through decoration-primary/50"
                              )}>
                              {meal.recipe?.name || meal.customName}
                            </p>
                            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
                              {meal.recipe ? (
                                <div className="flex flex-wrap items-center gap-1">
                                  <span className="text-[9px] sm:text-[10px] font-bold text-primary bg-primary/10 px-1.5 sm:px-2 py-0.5 rounded-full whitespace-nowrap">
                                    {personName[meal.person || "A"]}: {(meal.portionVariant || meal.recipe?.portioningMode === "individual" || (variantOptionsByRecipe[Number(meal.recipe?.id)]?.length || 0) > 0) ? `wariant ${meal.portionVariant || (variantOptionsByRecipe[Number(meal.recipe?.id)] || [])[0] || "A"}` : `${(Number(meal.servings) || 1)}/${(Number(meal.recipe?.servings) || 1)} porcji`}
                                  </span>
                                  {(meal.portionVariant || meal.recipe?.portioningMode === "individual" || (variantOptionsByRecipe[Number(meal.recipe?.id)]?.length || 0) > 0) && (
                                    <div className="flex items-center gap-0.5 rounded-md border border-border/60">
                                      <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="Poprzedni wariant" onClick={async () => {
                                        const variants: PortionVariant[] = ["A", "B", "C"];
                                        const currentVariant = variants.includes(meal.portionVariant as PortionVariant) ? meal.portionVariant as PortionVariant : "B";
                                        const current = variants.indexOf(currentVariant);
                                        const next = variants[(current - 1 + variants.length) % variants.length];
                                        const modified = hasEditedMealIngredients(meal);
                                        if (modified && !window.confirm("Zmiana wariantu przywróci ilości składników zapisane w przepisie. Kontynuować?")) return;
                                        await updateMealEntryAsync({ id: Number(meal.id), updates: { portionVariant: next, ...(modified ? { confirmVariantReset: true } : {}) } });
                                      }}><Minus className="h-3 w-3" /></Button>
                                      <span className="min-w-4 text-center text-[10px] font-bold">{meal.portionVariant || (variantOptionsByRecipe[Number(meal.recipe?.id)] || [])[0] || "B"}</span>
                                      <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="Następny wariant" onClick={async () => {
                                        const variants: PortionVariant[] = ["A", "B", "C"];
                                        const currentVariant = variants.includes(meal.portionVariant as PortionVariant) ? meal.portionVariant as PortionVariant : "B";
                                        const current = variants.indexOf(currentVariant);
                                        const next = variants[(current + 1) % variants.length];
                                        const modified = hasEditedMealIngredients(meal);
                                        if (modified && !window.confirm("Zmiana wariantu przywróci ilości składników zapisane w przepisie. Kontynuować?")) return;
                                        await updateMealEntryAsync({ id: Number(meal.id), updates: { portionVariant: next, ...(modified ? { confirmVariantReset: true } : {}) } });
                                      }}><Plus className="h-3 w-3" /></Button>
                                    </div>
                                  )}
                                  {false && (
                                    <Select
                                      value={meal.portionVariant || "B"}
                                      onOpenChange={async (open) => {
                                        const recipeId = Number(meal.recipe?.id);
                                        if (!open || !recipeId || variantOptionsByRecipe[recipeId]?.length) return;
                                        try {
                                          const fullRecipe = await fetchRecipeDetails(recipeId);
                                          setVariantOptionsByRecipe((prev) => ({ ...prev, [recipeId]: getAvailableVariants(fullRecipe?.ingredients || []) }));
                                        } catch (error) {
                                          console.error("Failed to load dashboard meal variants", error);
                                        }
                                      }}
                                      onValueChange={async (variant) => {
                                        if (variant === meal.portionVariant) return;
                                        const recipeId = Number(meal.recipe?.id);
                                        const available = getAvailableVariants(meal.recipe?.ingredients || []);
                                        if (!available.includes(variant as PortionVariant)) return;
                                        const modified = hasEditedMealIngredients(meal);
                                        if (modified && !window.confirm("Zmiana wariantu przywróci zapisane ilości składników tego wariantu. Kontynuować?")) return;
                                        await updateMealEntryAsync({
                                          id: Number(meal.id),
                                          updates: { portionVariant: variant, ...(modified ? { confirmVariantReset: true } : {}) },
                                        });
                                      }}
                                    >
                                      <SelectTrigger className="h-6 w-[4.25rem] px-1 text-[10px]" aria-label="Zmień wariant przepisu">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {(variantOptionsByRecipe[Number(meal.recipe?.id)] || []).map((variant) => (
                                          <SelectItem key={variant} value={variant}>{variant}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                </div>
                              ) : (
                                <span className="text-[9px] sm:text-[10px] font-bold text-muted-foreground bg-secondary/60 px-1.5 sm:px-2 py-0.5 rounded-full whitespace-nowrap">
                                  {personName[meal.person || "A"]}: x{Number(meal.servings) || 1}
                                </span>
                              )}
                              {!meal.recipe && meal.ingredients?.length ? (
                                <div className="flex items-center gap-0.5 rounded-md border border-border/70 bg-muted/40 px-0.5 py-0.5">
                                  <button
                                    className="h-5 w-5 rounded text-xs hover:bg-white shrink-0"
                                    onClick={() => updateIngredientAmountQuick(meal, (Number(meal.ingredients[0]?.amount) || 0) - 10)}
                                    title="Zmniejsz gramaturę"
                                  >
                                    -
                                  </button>
                                  <Input
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    step={10}
                                    className="h-5 w-11 border-0 bg-transparent px-0 py-0 text-center text-[10px] font-semibold shadow-none"
                                    value={Number(meal.ingredients[0]?.amount) || 0}
                                    onChange={(e) => updateIngredientAmountQuick(meal, Number(e.target.value))}
                                    aria-label="Gramatura składnika"
                                  />
                                  <span className="text-[9px] font-medium text-muted-foreground">g</span>
                                  <button
                                    className="h-5 w-5 rounded text-xs hover:bg-white shrink-0"
                                    onClick={() => updateIngredientAmountQuick(meal, (Number(meal.ingredients[0]?.amount) || 0) + 10)}
                                    title="Zwiększ gramaturę"
                                  >
                                    +
                                  </button>
                                </div>
                              ) : (meal.recipe && (meal.recipe.portioningMode === "individual" || (variantOptionsByRecipe[Number(meal.recipe.id)]?.length || 0) > 0 || Boolean(meal.portionVariant))) ? null : (
                                <div className="flex items-center gap-0.5 rounded-md border border-border/70 bg-muted/40 px-0.5 py-0.5">
                                  <button
                                    className="h-5 w-5 rounded text-xs hover:bg-white shrink-0"
                                    onClick={() => updateServingsQuick(meal, Math.max(0.5, (Number(meal.servings) || 1) - 0.5))}
                                    title="Zmniejsz porcję"
                                  >
                                    -
                                  </button>
                                  <Input
                                    type="number"
                                    inputMode="decimal"
                                    min={0.5}
                                    step={0.5}
                                    className="h-5 w-10 border-0 bg-transparent px-0 py-0 text-center text-[10px] font-semibold shadow-none"
                                    value={servingInputs[getServingInputKey(meal)] ?? String(Number(meal.servings) || 1)}
                                    onChange={(e) => setServingInputs((prev) => ({ ...prev, [getServingInputKey(meal)]: e.target.value }))}
                                    onBlur={() => applyServingInput(meal)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.currentTarget.blur();
                                      }
                                    }}
                                    aria-label="Liczba porcji"
                                  />
                                  <button
                                    className="h-5 w-5 rounded text-xs hover:bg-white shrink-0"
                                    onClick={() => updateServingsQuick(meal, (Number(meal.servings) || 1) + 0.5)}
                                    title="Zwiększ porcję"
                                  >
                                    +
                                  </button>
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                                <Flame className="w-3 h-3" />
                                {meal.recipe ? (meal.totals?.calories ?? (() => {
                                  const total = (meal.ingredients && meal.ingredients.length > 0 ? meal.ingredients : (meal.recipe?.ingredients || [])).reduce((sum: number, ri: any) => {
                                    if (!ri.ingredient) return sum;
                                    const effectiveAmount = getEffectiveIngredientAmount(meal, ri);
                                    return sum + (ri.ingredient.calories * calculateNutritionAmount(effectiveAmount, ri.ingredient) / 100);
                                  }, 0);
                                  return Math.round(total);
                                })()) : ((meal.customCalories || 0) * (Number(meal.servings) || 1))} kcal
                              </p>
                              {meal.recipe && (
                                <p className="flex items-center gap-1 text-[10px] font-semibold text-primary/70">
                                  <Wallet className="w-3 h-3" />
                                  {meal.totals?.price ?? (() => {
                                    const total = (meal.ingredients && meal.ingredients.length > 0 ? meal.ingredients : (meal.recipe?.ingredients || [])).reduce((sum: number, ri: any) => {
                                      if (!ri.ingredient) return sum;
                                      const effectiveAmount = getEffectiveIngredientAmount(meal, ri);
                                      return sum + (ri.ingredient.price * calculatePurchaseAmount(effectiveAmount, ri.ingredient) / 100);
                                    }, 0);
                                    return Math.round(total);
                                  })()} PLN
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="absolute right-1 top-1 flex items-center gap-0.5">
                          {meal.recipe && (
                            <button
                              onClick={() => openMealRecipe(meal)}
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
                              title="Pokaż przepis"
                              aria-label={`Pokaż przepis: ${meal.recipe?.name}`}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {meal.recipe && (
                            <button
                              type="button"
                              onClick={() => openWholeRecipe(meal)}
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
                              title="Pokaż cały przepis"
                              aria-label={`Pokaż cały przepis: ${meal.recipe?.name}`}
                            >
                              <NotebookText className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            className="rounded p-1 text-muted-foreground opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                            title="Usuń posiłek"
                            onClick={() => {
                              const mealName = meal.recipe?.name || meal.customName || "ten posiłek";
                              if (window.confirm(`Czy na pewno usunąć ${mealName} z planu?`)) {
                                deleteEntry({ id: meal.id, date: meal.date });
                              }
                            }}
                            disabled={isDeletingMeal}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            </div>
          </>
        )}
      </div>

      <Dialog open={isEditingIngredients} onOpenChange={setIsEditingIngredients}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col bg-white">
          <DialogHeader>
            <DialogTitle>Edytuj składniki posiłku</DialogTitle>
            <DialogDescription>Dostosuj składniki i ilości dla wybranego posiłku.</DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-4 space-y-4">
            {frequentAddonDefinitions.length > 0 && !viewingMeal?.wholeRecipeBatchId && !viewingMeal?.sharedParticipantEntries && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Najczęstsze dodatki (opcjonalnie)</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {frequentAddonDefinitions.map((addon: any) => {
                    const isAlreadyAdded = editingMealIngredients.some((item: any) => Number(item.ingredientId) === Number(addon.ingredientId) && item.isFrequentAddon);
                    return (
                      <Button
                        key={`edit-addon-${addon.ingredientId}`}
                        type="button"
                        size="sm"
                        variant={isAlreadyAdded ? "secondary" : "outline"}
                        className={cn("h-8", isAlreadyAdded && "border-emerald-300 bg-emerald-100 text-emerald-900")}
                        onClick={() => addFrequentAddonToEdit(addon)}
                      >
                        + {Math.round(getAddonIncrementAmount(addon))}g {addon.ingredient?.name || "Składnik"}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            {editingMealIngredients.map((item, idx) => (
              <div
                key={idx}
                className={cn(
                  "flex gap-2 items-start bg-secondary/20 p-3 rounded-xl border border-transparent max-sm:gap-1.5 max-sm:p-2",
                  item.isFrequentAddon && "border-emerald-300 bg-emerald-50/50"
                )}
              >
                <div className="min-w-0 flex-1">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className={cn("w-full min-w-0 justify-between bg-white px-2 text-left max-sm:text-xs", !item.ingredientId && "text-muted-foreground")}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {item.ingredientId > 0
                            ? allAvailableIngredients?.find(i => i.id === item.ingredientId)?.name || item.ingredient?.name || "Nieznany składnik"
                            : "Wybierz składnik..."}
                        </span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[300px] p-0">
                      <Command>
                        <CommandInput placeholder="Szukaj składnika..." />
                        <CommandList>
                          <CommandEmpty>Nie znaleziono składnika.</CommandEmpty>
                          <CommandGroup>
                            {allAvailableIngredients?.map((i) => (
                              <PopoverClose asChild key={i.id}>
                                <CommandItem
                                  value={i.name}
                                  onSelect={() => updateIngredientInEdit(idx, { ingredientId: i.id })}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      item.ingredientId === i.id ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  {i.name}
                                </CommandItem>
                              </PopoverClose>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  {item.isFrequentAddon && (
                    <span className="mt-1 inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                      Najczęstszy dodatek
                    </span>
                  )}
                </div>

                <div className="w-36 shrink-0 max-sm:w-32">
                  <div className="relative">
                    <Input
                      type="number"
                      value={item.amount}
                      onChange={(e) => updateIngredientInEdit(idx, { amount: e.target.value })}
                      className="bg-white pr-8 max-sm:px-2"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-bold">
                      {item.ingredient?.unit || 'g'}
                    </span>
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeIngredientFromEdit(idx)}
                  className="shrink-0 text-destructive hover:text-destructive/80 hover:bg-destructive/10 max-sm:h-9 max-sm:w-9"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}

            <Button variant="outline" className="w-full border-dashed" onClick={addIngredientToEdit}>
              + Dodaj składnik
            </Button>
          </div>

          <DialogFooter className="pt-4 border-t">
            <Button variant="outline" onClick={() => setIsEditingIngredients(false)} disabled={isSaving}>Anuluj</Button>
            <Button onClick={saveIngredients} disabled={isSaving} className="bg-primary hover:bg-primary/90">
              {isSaving ? <LoadingSpinner /> : "Zapisz zmiany"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Clock, ChefHat, CalendarPlus, Settings2, Play, Pause, RotateCcw, ChefHatIcon, CalendarClock, Download, Printer } from "lucide-react";
import { calculateNutritionAmount, calculatePurchaseAmount, calculateScaledAmount } from "@shared/scaling";
import type { InstructionStep } from "@shared/schema";
import { getDisplayInstructionSteps } from "@/lib/instruction-steps";
import { useToast } from "@/hooks/use-toast";
import { getAvailableVariants } from "@shared/portion-variants";

const stripTimerTag = (text: string) => text.replace(/\s*\[timer\s*:[^\]]+\]/gi, "").trim();

const parseTimerFromStep = (step: string) => {
  const naturalLanguage = step.match(/(\d+(?:[.,]\d+)?)\s*(minut|minuty|minuta|godzin|godziny|godzina|h)\b/i);
  if (!naturalLanguage) {
    return { durationMinutes: 0, name: "" };
  }

  const parsedValue = Number(String(naturalLanguage[1]).replace(",", "."));
  const unit = naturalLanguage[2].toLowerCase();
  const naturalMinutes = unit.startsWith("godz") || unit === "h" ? parsedValue * 60 : parsedValue;

  const explicitTimer = step.match(/\[timer\s*:\s*([^\]]+)\]/i);
  let explicitDurationMinutes = 0;
  let timerName = "";
  if (explicitTimer?.[1]) {
    const parts = explicitTimer[1]
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);

    parts.forEach((part) => {
      const asNumber = Number(part.replace(",", "."));
      if (Number.isFinite(asNumber) && asNumber > 0) {
        explicitDurationMinutes = asNumber;
      } else if (!timerName) {
        timerName = part;
      }
    });
  }

  return {
    durationMinutes: explicitDurationMinutes > 0 ? explicitDurationMinutes : naturalMinutes,
    name: timerName,
  };
};

interface RecipeViewProps {
  recipe: any;
  isOpen: boolean;
  onClose: () => void;
  onAddToPlan: (recipe: any, servingsOverride?: number) => void;
  allRecipes?: any[];
  plannedServings?: number;
  onEditIngredients?: () => void;
  onPlannedServingsChange?: (servings: number) => void;
  showFooter?: boolean;
  mealEntryIngredients?: any[];
  frequentAddonIds?: number[];
  allowIngredientEditing?: boolean;
  usePrecalculatedAmounts?: boolean;
  switchPlannedPersonLabel?: string;
  onSwitchPlannedPerson?: () => void;
  servingsLockedReason?: string;
  onRestoreOriginalIngredients?: () => void;
  compact?: boolean;
}

interface CookingStepTimer {
  stepIndex: number;
  name: string;
  initialSeconds: number;
  remainingSeconds: number;
  isRunning: boolean;
}

type RecipeCardIngredientRow = {
  name: string;
  group: string;
  unit: string;
  tysia: number;
  mati: number;
  alternativeAmount: number;
  alternativeUnit: string;
  baseAmount: number;
};

const formatRecipeCardAmount = (value: number) => {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  const fixed = rounded.toFixed(2);
  if (fixed.endsWith("00")) return fixed.slice(0, -3);
  return fixed.replace(/0$/, "").replace(".", ",");
};

const buildRecipeCardRows = (recipe: any, tysiaServings: number, matiServings: number): RecipeCardIngredientRow[] => {
  const recipeServings = Math.max(0.1, Number(recipe?.servings) || 1);
  const rows: RecipeCardIngredientRow[] = (recipe?.ingredients || []).map((item: any) => ({
    name: String(item?.ingredient?.name || item?.name || "Składnik"),
    group: String(item?.groupName || ""),
    unit: String(item?.unit || item?.ingredient?.unit || "g"),
    tysia: calculateScaledAmount(item, tysiaServings, recipeServings),
    mati: calculateScaledAmount(item, matiServings, recipeServings),
    alternativeAmount: Number(item?.alternativeAmount) || 0,
    alternativeUnit: String(item?.alternativeUnit || ""),
    baseAmount: Number(item?.baseAmount ?? item?.amount) || 0,
  }));
  (recipe?.frequentAddons || []).forEach((item: any) => {
    const tysiaAmount = Math.max(0, Number(item?.defaultAmountA) || 0);
    const matiAmount = Math.max(0, Number(item?.defaultAmountB ?? item?.baseAmount ?? item?.amount) || 0);
    if (tysiaAmount <= 0 && matiAmount <= 0) return;
    rows.push({
      name: String(item?.ingredient?.name || item?.name || "Dodatek"),
      group: String(item?.groupName || "Dodatki"),
      unit: String(item?.unit || item?.ingredient?.unit || "g"),
      tysia: tysiaAmount,
      mati: matiAmount,
      alternativeAmount: 0,
      alternativeUnit: "",
      baseAmount: 0,
    });
  });
  return rows;
};

const formatRecipeCardAmountLabel = (row: RecipeCardIngredientRow, amount: number) => {
  if (amount <= 0) return "—";
  const unit = row.unit === "g" ? " g" : ` ${row.unit}`;
  const alternative = row.alternativeAmount > 0 && row.alternativeUnit && row.baseAmount > 0
    ? ` · ${formatRecipeCardAmount(row.alternativeAmount * amount / row.baseAmount)} ${row.alternativeUnit}`
    : "";
  return `${formatRecipeCardAmount(amount)}${unit}${alternative}`;
};

const escapeRecipeCardHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const getRecipeCardTimeLabel = (recipe: any, steps: string[]) => {
  const prepTime = Number(recipe?.prepTime) || 0;
  const timerMinutes = steps.reduce((total, step) => total + parseTimerFromStep(step).durationMinutes, 0);
  if (prepTime > 0 && timerMinutes > 0) return `Przygotowanie: ${prepTime} min · czas z instrukcji: ${formatRecipeCardAmount(timerMinutes)} min`;
  if (prepTime > 0) return `Czas przygotowania: ${prepTime} min`;
  if (timerMinutes > 0) return `Czas z instrukcji: ${formatRecipeCardAmount(timerMinutes)} min`;
  return "";
};
export function RecipeView({ 
  recipe, 
  isOpen, 
  onClose, 
  onAddToPlan, 
  allRecipes = [],
  plannedServings, 
  onEditIngredients,
  onPlannedServingsChange,
  showFooter = true,
  mealEntryIngredients,
  frequentAddonIds = [],
  allowIngredientEditing = true,
  usePrecalculatedAmounts = false,
  switchPlannedPersonLabel,
  onSwitchPlannedPerson,
  servingsLockedReason,
  onRestoreOriginalIngredients,
  compact = false,
}: RecipeViewProps) {
  const { toast } = useToast();
  const [isCookingMode, setIsCookingMode] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [stepTimers, setStepTimers] = useState<CookingStepTimer[]>([]);

  const instructionSteps = useMemo<InstructionStep[]>(() => getDisplayInstructionSteps(recipe), [recipe?.instructionSteps, recipe?.instructions]);

  const isPlannedView = plannedServings !== undefined;
  const isVariantRecipe = recipe?.portioningMode === "individual" || getAvailableVariants(recipe?.ingredients || []).length > 0;
  const recipeServings = Number(recipe?.servings) || 1;
  const servingsToUse = isPlannedView ? plannedServings : recipeServings;
  
  // Use entry-specific ingredients if provided (for Meal Plan/Dashboard view of a planned meal)
  const baseIngredients = (mealEntryIngredients && mealEntryIngredients.length > 0) 
    ? mealEntryIngredients 
    : (recipe?.ingredients || []);

  const frequentAddonSet = new Set((frequentAddonIds || []).map((id) => Number(id)));
  const recipeIngredientCounts = useMemo(() => {
    const counts = new Map<number, number>();
    (recipe?.ingredients || []).forEach((ri: any) => {
      const id = Number(ri?.ingredientId);
      if (!Number.isFinite(id)) return;
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    return counts;
  }, [recipe?.ingredients]);

  const ingredientRows = useMemo(() => {
    const seen = new Map<number, number>();
    const rows = baseIngredients.map((ri: any) => {
      const id = Number(ri?.ingredientId);
      const nextOccurrence = (seen.get(id) || 0) + 1;
      seen.set(id, nextOccurrence);
      const isFrequentAddonId = frequentAddonSet.has(id);
      const recipeCount = recipeIngredientCounts.get(id) || 0;
      const isFrequentAddon = isFrequentAddonId && nextOccurrence > recipeCount;

      const matchingRecipeIngredients = (recipe?.ingredients || []).filter((item: any) => Number(item?.ingredientId) === id);
      const matchingFrequentAddons = (recipe?.frequentAddons || []).filter((item: any) => Number(item?.ingredientId) === id);
      const sourceCandidates = [...matchingRecipeIngredients, ...matchingFrequentAddons];
      const source = sourceCandidates[nextOccurrence - 1] || sourceCandidates[0] || {};

      const resolvedIngredient = ri?.ingredient || source?.ingredient || null;
      const resolvedUnit = ri?.unit || source?.unit || resolvedIngredient?.unit || "g";
      const displayIngredient = {
        ...ri,
        groupName: ri?.groupName ?? source?.groupName ?? null,
        ingredient: resolvedIngredient,
        unit: resolvedUnit,
        alternativeAmount: ri?.alternativeAmount ?? source?.alternativeAmount,
        alternativeUnit: ri?.alternativeUnit ?? source?.alternativeUnit,
      };
      const scalingIngredient = {
        ...source,
        ...ri,
        ingredient: resolvedIngredient,
        unit: resolvedUnit,
        baseAmount: Number(ri?.baseAmount ?? ri?.amount ?? source?.baseAmount ?? source?.amount ?? 0) || 0,
        scalingType: ri?.scalingType ?? source?.scalingType ?? "LINEAR",
        scalingFormula: ri?.scalingFormula ?? source?.scalingFormula,
        stepThresholds: ri?.stepThresholds ?? source?.stepThresholds,
      };

      return { ri: displayIngredient, isFrequentAddon, scalingIngredient, sourceIngredient: source };
    });

    const groupedRows = new Map<string, typeof rows>();
    rows.forEach((row: any, index: number) => {
      const groupName = String(row.ri?.groupName || "").trim();
      const key = groupName ? `group:${groupName}` : `ungrouped:${index}`;
      const groupRows = groupedRows.get(key) || [];
      groupRows.push(row);
      groupedRows.set(key, groupRows);
    });

    return Array.from(groupedRows.values()).flat();
  }, [baseIngredients, frequentAddonSet, recipeIngredientCounts, recipe?.ingredients, recipe?.frequentAddons]);

  const suggestedRecipes = useMemo(() => {
    const structured = ((recipe?.suggestedRecipes || []) as any[])
      .map((item: any) => ({ recipeId: Number(item?.recipeId), servings: Number(item?.servings) || 1 }))
      .filter((item: any) => Number.isFinite(item.recipeId) && item.recipeId > 0);

    const legacy = (recipe?.suggestedRecipeIds || [])
      .map((id: any) => ({ recipeId: Number(id), servings: 1 }))
      .filter((item: any) => Number.isFinite(item.recipeId) && item.recipeId > 0);

    const candidates = structured.length > 0 ? structured : legacy;

    return candidates
      .map((item: any) => ({
        recipe: (allRecipes || []).find((candidate: any) => Number(candidate?.id) === Number(item.recipeId)),
        servings: item.servings,
      }))
      .filter((entry: any) => !!entry.recipe);
  }, [recipe?.suggestedRecipes, recipe?.suggestedRecipeIds, allRecipes]);

  const currentStep = instructionSteps[currentStepIndex];
  const recipeComment = (recipe?.comments || "").trim();
  const currentStepText = (currentStep?.segments || []).map((segment: any) => segment.text).join("") || "";
  const currentStepTimerDetails = parseTimerFromStep(currentStepText);
  const currentStepDurationMinutes = currentStepTimerDetails.durationMinutes;
  const currentStepTimerName = currentStepTimerDetails.name || `Krok ${currentStepIndex + 1}`;
  const currentStepTimer = stepTimers.find((timer) => timer.stepIndex === currentStepIndex);
  const hasCurrentStepTimerDefinition = currentStepDurationMinutes > 0;
  const timerRemainingSeconds = currentStepTimer?.remainingSeconds ?? (hasCurrentStepTimerDefinition ? currentStepDurationMinutes * 60 : 0);
  const isTimerRunning = currentStepTimer?.isRunning ?? false;

  useEffect(() => {
    if (!isOpen) {
      setIsCookingMode(false);
      setCurrentStepIndex(0);
      setStepTimers([]);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isCookingMode) {
      return;
    }

    const interval = window.setInterval(() => {
      setStepTimers((prev) =>
        prev.map((timer) => {
          if (!timer.isRunning) return timer;
          const nextRemaining = Math.max(0, timer.remainingSeconds - 1);
          return {
            ...timer,
            remainingSeconds: nextRemaining,
            isRunning: nextRemaining > 0 ? timer.isRunning : false,
          };
        })
      );
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isCookingMode]);

  useEffect(() => {
    if (!isCookingMode || !("wakeLock" in navigator)) return;

    let wakeLock: any;
    const requestWakeLock = async () => {
      try {
        wakeLock = await (navigator as any).wakeLock.request("screen");
      } catch {
        // Ignore if the browser blocks Wake Lock API.
      }
    };

    requestWakeLock();

    return () => {
      if (wakeLock) {
        wakeLock.release().catch(() => undefined);
      }
    };
  }, [isCookingMode]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

  const getScaledAmount = (ri: any, isFrequentAddon = false, scalingIngredient?: any) => {
    const hasPrecalculatedAmount = typeof ri?.calculatedAmount === "number" && Number.isFinite(ri.calculatedAmount);
    const hasPerPersonSharedBreakdown = !!ri?.sharedAddonAmounts && typeof ri.sharedAddonAmounts === "object";

    if ((usePrecalculatedAmounts || hasPerPersonSharedBreakdown) && hasPrecalculatedAmount) {
      return ri.calculatedAmount;
    }

    if (!isPlannedView && hasPrecalculatedAmount) {
      return ri.calculatedAmount;
    }

    const ingredientForScaling = scalingIngredient || ri;
    return calculateScaledAmount(ingredientForScaling, servingsToUse, recipeServings);
  };

  const formatAmount = (value: number) => {
    if (!Number.isFinite(value)) return "0";
    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
  };

  const updateServings = (nextValue: number) => {
    if (!isPlannedView || !onPlannedServingsChange) return;
    const safeValue = Math.max(0.5, Math.round(nextValue * 2) / 2);
    onPlannedServingsChange(safeValue);
  };

  const getIngredientAmountLabel = (ri: any, isFrequentAddon = false, scalingIngredient?: any) => {
    const grams = getScaledAmount(ri, isFrequentAddon, scalingIngredient);
    const source = scalingIngredient || ri;
    const altAmountRaw = Number(source?.alternativeAmount ?? ri?.alternativeAmount);
    const altUnit = String(source?.alternativeUnit ?? ri?.alternativeUnit ?? "").trim();
    const baseAmount = Number(source?.baseAmount ?? ri?.baseAmount ?? source?.amount ?? ri?.amount ?? grams) || grams;
    const unit = source?.unit || ri?.unit || "g";

    if (altAmountRaw > 0 && altUnit) {
      const scaledAlternativeAmount = (altAmountRaw * grams) / (baseAmount || 1);
      return `${formatAmount(scaledAlternativeAmount)} ${altUnit} (${formatAmount(grams)}${unit})`;
    }

    return `${formatAmount(grams)}${unit}`;
  };


  const getSharedAddonPersonInfo = (ri: any) => {
    const ty = Number(ri?.sharedAddonAmounts?.A);
    const ma = Number(ri?.sharedAddonAmounts?.B);
    if (!Number.isFinite(ty) && !Number.isFinite(ma)) return null;

    const unit = ri?.unit || ri?.ingredient?.unit || "g";
    const tyLabel = `${formatAmount(Number.isFinite(ty) ? ty : 0)}${unit}`;
    const maLabel = `${formatAmount(Number.isFinite(ma) ? ma : 0)}${unit}`;

    return `Mati: ${maLabel} • Tysia: ${tyLabel}`;
  };


  const getCookingModeIngredientLabel = (segment: { text: string; ingredientId: number; ingredientIds?: number[]; ingredientSource?: "ingredient" | "frequentAddon"; ingredientGroupName?: string; multiplier?: number }) => {
    const multiplier = typeof segment.multiplier === "number" && segment.multiplier > 0 ? segment.multiplier : 1;
    const ingredientIds = (segment.ingredientIds && segment.ingredientIds.length > 0)
      ? segment.ingredientIds
      : [segment.ingredientId];

    const labels = ingredientIds
      .map((id) => {
        const matchingRows = ingredientRows.filter(({ ri, isFrequentAddon }: any) =>
          Number(ri.ingredientId) === Number(id) &&
          (segment.ingredientSource === "frequentAddon" ? isFrequentAddon : !isFrequentAddon)
        );
        const matchingGroup = typeof segment.ingredientGroupName === "string"
          ? matchingRows.find(({ ri }: any) => String(ri?.groupName || "").trim() === segment.ingredientGroupName!.trim())
          : undefined;

        // Group metadata can differ between mapped instruction segments and recipe rows.
        // Keep the ingredient ID/source as the reliable match instead of showing "#ID".
        return matchingGroup || matchingRows[0];
      })
      .filter(Boolean)
      .map((ingredientRow: any) => {
        const amount = getScaledAmount(ingredientRow.ri, segment.ingredientSource === "frequentAddon", ingredientRow.scalingIngredient) * multiplier;
        const unit = ingredientRow.ri.unit || ingredientRow.ri.ingredient?.unit || "g";
        const source = ingredientRow.scalingIngredient || ingredientRow.ri;
        const sourceIngredient = ingredientRow.sourceIngredient || {};
        const altAmountRaw = Number(
          ingredientRow.ri?.alternativeAmount
          ?? source?.alternativeAmount
          ?? sourceIngredient?.alternativeAmount
        );
        const altUnit = String(
          ingredientRow.ri?.alternativeUnit
          ?? source?.alternativeUnit
          ?? sourceIngredient?.alternativeUnit
          ?? ""
        ).trim();
        const baseAmount = Number(
          ingredientRow.ri?.baseAmount
          ?? source?.baseAmount
          ?? sourceIngredient?.baseAmount
          ?? ingredientRow.ri?.amount
          ?? source?.amount
          ?? sourceIngredient?.amount
          ?? amount
        ) || amount;
        const scaledAlternativeAmount = altAmountRaw > 0 && altUnit
          ? (altAmountRaw * amount) / (baseAmount || 1)
          : null;

        const alternativeLabel = scaledAlternativeAmount !== null
          ? ` (${formatAmount(scaledAlternativeAmount)} ${altUnit})`
          : "";

        const ingredientName = ingredientRow.ri?.ingredient?.name
          || ingredientRow.scalingIngredient?.ingredient?.name
          || ingredientRow.sourceIngredient?.ingredient?.name
          || ingredientRow.ri?.name
          || segment.text;
        return `${ingredientName} - ${formatAmount(amount)}${unit}${alternativeLabel}`;
      });

    if (labels.length === 0) return segment.text;
    return labels.join(", ");
  };

  const nutritionTotals = useMemo(() => {
    const totals = ingredientRows.reduce((sum: { calories: number; protein: number; carbs: number; fat: number; price: number }, row: any) => {
      const ingredient = row.ri?.ingredient || row.scalingIngredient?.ingredient;
      if (!ingredient) return sum;
      const amount = getScaledAmount(row.ri, row.isFrequentAddon, row.scalingIngredient);
      const nutritionAmount = calculateNutritionAmount(amount, ingredient);
      const purchaseAmount = calculatePurchaseAmount(amount, ingredient);
      return {
        calories: sum.calories + ((Number(ingredient.calories) || 0) * nutritionAmount / 100),
        protein: sum.protein + ((Number(ingredient.protein) || 0) * nutritionAmount / 100),
        carbs: sum.carbs + ((Number(ingredient.carbs) || 0) * nutritionAmount / 100),
        fat: sum.fat + ((Number(ingredient.fat) || 0) * nutritionAmount / 100),
        price: sum.price + ((Number(ingredient.price) || 0) * purchaseAmount / 100),
      };
    }, { calories: 0, protein: 0, carbs: 0, fat: 0, price: 0 });

    const divisor = Number(recipeServings) || 1;
    const safeDivisor = divisor > 0 ? divisor : 1;

    return {
      total: totals,
      perServing: {
        calories: totals.calories / safeDivisor,
        protein: totals.protein / safeDivisor,
        carbs: totals.carbs / safeDivisor,
        fat: totals.fat / safeDivisor,
        price: totals.price / safeDivisor,
      },
    };
  }, [ingredientRows, recipeServings, servingsToUse, usePrecalculatedAmounts]);

  const displayedNutrition = isPlannedView ? nutritionTotals.total : nutritionTotals.perServing;
  const nutritionScopeLabel = isPlannedView ? "łącznie" : "na porcję";
  const [isExportingPng, setIsExportingPng] = useState(false);

  const printRecipeAsA5 = () => {
    if (!recipe) return;
    const printWindow = window.open("", "_blank", "width=900,height=900");
    if (!printWindow) {
      toast({ title: "Nie udało się otworzyć wydruku", description: "Zezwól przeglądarce na otwieranie wyskakujących okien.", variant: "destructive" });
      return;
    }
    const recipeServingsForPrint = Math.max(0.1, Number(recipe.servings) || 1);
    const tysiaServings = Math.max(0.1, Number(recipe.defaultServingsA) || recipeServingsForPrint);
    const matiServings = Math.max(0.1, Number(recipe.defaultServingsB) || recipeServingsForPrint);
    const rows = buildRecipeCardRows(recipe, tysiaServings, matiServings);
    const steps = instructionSteps.map((step) => stripTimerTag((step.segments || []).map((segment: any) => segment.text || "").join("")).trim()).filter(Boolean);
    const timeLabel = getRecipeCardTimeLabel(recipe, steps);
    const servingsLabel = (value: number) => {
      const rounded = Math.round(value * 100) / 100;
      const integer = Number.isInteger(rounded);
      const lastTwoDigits = integer ? rounded % 100 : 0;
      const lastDigit = integer ? rounded % 10 : 0;
      const noun = rounded === 1 ? "porcja" : integer && ![12, 13, 14].includes(lastTwoDigits) && lastDigit >= 2 && lastDigit <= 4 ? "porcje" : "porcji";
      return `${formatRecipeCardAmount(value)} ${noun}`;
    };
    let imageSource = "";
    try {
      const imageUrl = String(recipe.imageUrl || "").trim();
      if (imageUrl) {
        const resolved = new URL(imageUrl, window.location.href);
        if (resolved.protocol === "http:" || resolved.protocol === "https:") {
          imageSource = resolved.origin === window.location.origin ? resolved.href : "/api/recipe-image?url=" + encodeURIComponent(resolved.href);
        }
      }
    } catch { imageSource = ""; }
    const renderStep = (step: string) => {
      const escaped = escapeRecipeCardHtml(step);
      const actionVerb = step.match(/^(przepłucz|przepłukać|gotuj|ugotuj|wymieszaj|wymieszać|dodaj|dodać|pokrój|pokroić|rozgrzej|rozgrzać|podsmaż|podsmażyć|wlej|wlać|wsyp|wsypać|odcedź|odcedzić|zblenduj|zmiksuj|zmiksować|przełóż|przełożyć|ułóż|ułożyć|podawaj|podaj|piecz|upiecz|zagotuj|odstaw|odstawić|posyp|dopraw|obierz|zetrzyj|duś|smaż|wstaw|wyjmij|połącz|przykryj|odwróć|zdejmij|przygotuj|następnie|na koniec)\b/i);
      if (!actionVerb) return escaped;
      const verb = escapeRecipeCardHtml(actionVerb[0]);
      return "<strong>" + verb + "</strong>" + escaped.slice(verb.length);
    };
    let previousGroup = "";
    const tableRows = rows.map((row) => {
      const groupRow = row.group && row.group !== previousGroup ? '<tr class="group-row"><th colspan="4">' + escapeRecipeCardHtml(row.group) + "</th></tr>" : "";
      previousGroup = row.group;
      return groupRow + "<tr>" + '<th scope="row">' + escapeRecipeCardHtml(row.name) + "</th>"
        + "<td>" + escapeRecipeCardHtml(formatRecipeCardAmountLabel(row, row.tysia)) + "</td>"
        + "<td>" + escapeRecipeCardHtml(formatRecipeCardAmountLabel(row, row.mati)) + "</td>"
        + '<td class="total">' + escapeRecipeCardHtml(formatRecipeCardAmountLabel(row, row.tysia + row.mati)) + "</td></tr>";
    }).join("");
    const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeRecipeCardHtml(recipe.name || "Przepis")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lora:wght@500;600;700&display=swap" rel="stylesheet">
<style>@page{size:A5 portrait;margin:8mm}*{box-sizing:border-box}html{background:#e7e6df;color:#25291f;font-family:Inter,Arial,sans-serif;font-size:9.5pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;padding:18px 0}.sheet{width:148mm;min-height:210mm;margin:0 auto;padding:8mm;background:#F6F3EA;box-shadow:0 12px 36px rgba(30,36,22,.16)}.hero{height:45mm;overflow:hidden;background:#E8EBDD;border-radius:2mm}.hero img{display:block;width:100%;height:100%;object-fit:cover}.title{margin:4mm 0 1mm;color:#25291F;font:700 25pt/1.08 Lora,Georgia,serif;letter-spacing:-.03em}.time{min-height:5mm;color:#465331;font-size:9pt;font-weight:600}.section{margin-top:4mm}.section-title{margin:0 0 2mm;color:#465331;font:700 14pt/1.15 Lora,Georgia,serif}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9pt}col.name{width:46%}col.qty{width:18%}thead{display:table-header-group}thead th{padding:1.8mm 1mm;background:#E8EBDD;color:#25291F;font-size:8.5pt;font-weight:700;text-align:center}thead th:first-child{text-align:left}thead small{font-size:7pt;font-weight:500}tbody tr{break-inside:avoid;page-break-inside:avoid}tbody th,tbody td{padding:1.4mm 1mm;border-bottom:.25mm solid #DADCCD;vertical-align:middle}tbody th{font-weight:500;text-align:left;overflow-wrap:anywhere}tbody td{text-align:center;font-size:9pt;font-weight:600;font-variant-numeric:tabular-nums;white-space:normal}tbody tr:nth-child(even):not(.group-row){background:rgba(232,235,221,.42)}tbody td.total{background:rgba(70,83,49,.09);font-weight:700}tbody tr.group-row th{padding:1.7mm 1mm .6mm;border:0;color:#465331;font-size:8pt;font-weight:700;text-align:left;text-transform:uppercase;letter-spacing:.04em}.instructions{font-size:9pt;line-height:1.35}.step{margin:0 0 2mm;break-inside:avoid;page-break-inside:avoid}.step:last-child{margin-bottom:0}.step strong{color:#465331;font-weight:700}.empty-image{height:45mm;display:grid;place-items:center;color:#465331;font-size:9pt}@media screen{.sheet{border:1px solid #d4d1c7}}@media print{html{background:#fff}body{padding:0;background:#fff}.sheet{width:auto;min-height:194mm;margin:0;padding:0;box-shadow:none;border:0}.hero{border-radius:0}}</style></head><body><main class="sheet">
${imageSource ? '<div class="hero"><img id="recipe-photo" src="' + escapeRecipeCardHtml(imageSource) + '" alt="' + escapeRecipeCardHtml(recipe.name || "") + '"></div>' : '<div class="empty-image">Zdjęcie przepisu</div>'}
<header><h1 class="title">${escapeRecipeCardHtml(recipe.name || "Przepis")}</h1>${timeLabel ? '<div class="time">' + escapeRecipeCardHtml(timeLabel) + "</div>" : ""}</header>
<section class="section"><h2 class="section-title">Składniki</h2><table><colgroup><col class="name"><col class="qty"><col class="qty"><col class="qty"></colgroup><thead><tr>
<th scope="col">Składnik</th><th scope="col">Tysia<br><small>${escapeRecipeCardHtml(servingsLabel(tysiaServings))}</small></th><th scope="col">Mati<br><small>${escapeRecipeCardHtml(servingsLabel(matiServings))}</small></th><th scope="col">Razem</th>
</tr></thead><tbody>${tableRows}</tbody></table></section>
<section class="section"><h2 class="section-title">Sposób przygotowania</h2><div class="instructions">${steps.length ? steps.map((step) => '<p class="step">' + renderStep(step) + "</p>").join("") : '<p class="step">Brak instrukcji.</p>'}</div></section></main></body></html>`;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    const photo = printWindow.document.getElementById("recipe-photo") as HTMLImageElement | null;
    const imageReady = !photo || photo.complete ? Promise.resolve() : Promise.race([
      new Promise<void>((resolve) => { photo.addEventListener("load", () => resolve(), { once: true }); photo.addEventListener("error", () => resolve(), { once: true }); }),
      new Promise<void>((resolve) => printWindow.setTimeout(resolve, 12000)),
    ]);
    const fontsReady = Promise.race([printWindow.document.fonts?.ready || Promise.resolve(), new Promise<void>((resolve) => printWindow.setTimeout(resolve, 2500))]);
    void Promise.all([imageReady, fontsReady]).then(() => {
      if (photo && photo.naturalWidth === 0) {
        printWindow.close();
        toast({ title: "Nie udało się wczytać zdjęcia", description: "Sprawdź URL zdjęcia w przepisie.", variant: "destructive" });
        return;
      }
      printWindow.focus();
      printWindow.print();
    });
    printWindow.onafterprint = () => printWindow.close();
  };
  const exportRecipeAsPng = async () => {
    if (!recipe || isExportingPng) return;
    setIsExportingPng(true);
    try {
      await Promise.all([document.fonts.load('700 25pt "Lora"'), document.fonts.load('600 9.5pt "Inter"'), document.fonts.load('700 14pt "Lora"')]).catch(() => undefined);
      const recipeServings = Math.max(0.1, Number(recipe.servings) || 1);
      const tysiaServings = Math.max(0.1, Number(recipe.defaultServingsA) || recipeServings);
      const matiServings = Math.max(0.1, Number(recipe.defaultServingsB) || recipeServings);
      const rows = buildRecipeCardRows(recipe, tysiaServings, matiServings);
      const steps = instructionSteps.map((step) => stripTimerTag((step.segments || []).map((segment: any) => segment.text || "").join("")).trim()).filter(Boolean);
      if (steps.length === 0) steps.push("Brak instrukcji.");
      const timeLabel = getRecipeCardTimeLabel(recipe, steps);
      const imageUrl = String(recipe.imageUrl || "").trim();
      if (!imageUrl) { toast({ title: "Brak zdjęcia", description: "Dodaj URL zdjęcia w edycji przepisu, aby wyeksportować kartę.", variant: "destructive" }); return; }
      const resolvedImageUrl = new URL(imageUrl, window.location.href);
      if (resolvedImageUrl.protocol !== "http:" && resolvedImageUrl.protocol !== "https:") throw new Error("Nieobsługiwany adres zdjęcia");
      const imageSource = resolvedImageUrl.origin === window.location.origin ? resolvedImageUrl.href : "/api/recipe-image?url=" + encodeURIComponent(resolvedImageUrl.href);
      const image = new Image();
      const imageLoaded = await Promise.race([new Promise<boolean>((resolve) => { image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = imageSource; }), new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 15000))]);
      if (!imageLoaded || image.naturalWidth === 0) { toast({ title: "Nie udało się wczytać zdjęcia", description: "Sprawdź, czy URL zdjęcia z przepisu jest dostępny.", variant: "destructive" }); return; }

      const canvas = document.createElement("canvas");
      const width = 1200;
      const pxPerMm = width / 148;
      const cssPxScale = width / (148 * 96 / 25.4);
      const ptScale = (96 / 72) * cssPxScale;
      const pageHeight = Math.round(210 * pxPerMm);
      const margin = 8 * pxPerMm;
      const contentWidth = width - margin * 2;
      const titleFontSize = 25 * ptScale;
      const titleLineHeight = titleFontSize * 1.08;
      const sectionFontSize = 14 * ptScale;
      const sectionLineHeight = sectionFontSize * 1.15;
      const bodyFontSize = 9 * ptScale;
      const bodyLineHeight = bodyFontSize * 1.35;
      const bodyFont = "400 " + bodyFontSize + 'px "Inter", Arial, sans-serif';
      const titleFont = "700 " + titleFontSize + 'px "Lora", Georgia, serif';
      const sectionFont = "700 " + sectionFontSize + 'px "Lora", Georgia, serif';
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is not available");
      const wrapText = (text: string, maxWidth: number, font: string) => {
        context.font = font; const lines: string[] = [];
        for (const paragraph of String(text || "").split(String.fromCharCode(10))) {
          const words = paragraph.trim().split(/\s+/).filter(Boolean); let line = "";
          words.forEach((word) => { const candidate = line ? line + " " + word : word; if (line && context.measureText(candidate).width > maxWidth) { lines.push(line); line = word; } else line = candidate; });
          if (line || words.length === 0) lines.push(line);
        }
        return lines.length ? lines : [""];
      };
      const titleLines = wrapText(String(recipe.name || "Przepis"), contentWidth, titleFont);
      const ingredientColumnWidth = contentWidth * 0.46;
      const quantityColumnWidth = (contentWidth - ingredientColumnWidth) / 3;
      const ingredientFontSize = 9.5 * ptScale;
      const quantityFontSize = 9 * ptScale;
      const ingredientFont = "500 " + ingredientFontSize + 'px "Inter", Arial, sans-serif';
      const quantityFont = "600 " + quantityFontSize + 'px "Inter", Arial, sans-serif';
      const ingredientLayouts = rows.map((row) => ({ row, lines: wrapText(row.name, ingredientColumnWidth - 20, ingredientFont) }));
      const servingsLabel = (value: number) => { const rounded = Math.round(value * 100) / 100; const integer = Number.isInteger(rounded); const lastTwo = integer ? rounded % 100 : 0; const last = integer ? rounded % 10 : 0; const noun = rounded === 1 ? "porcja" : integer && ![12, 13, 14].includes(lastTwo) && last >= 2 && last <= 4 ? "porcje" : "porcji"; return formatRecipeCardAmount(value) + " " + noun; };
      let imageHeight = 45 * pxPerMm;
      const titleBlockHeight = titleLines.length * titleLineHeight + (timeLabel ? Math.max(5 * pxPerMm, 9 * ptScale * 1.25) : 0);
      const tableHeadHeight = 8.5 * ptScale * 2.2 + 3.6 * pxPerMm;
      const rowLayouts = ingredientLayouts.map(({ row, lines }, index) => { const previousGroup = index > 0 ? ingredientLayouts[index - 1].row.group : ""; const groupHeight = row.group && row.group !== previousGroup ? 3.2 * 9 * ptScale : 0; const rowHeight = Math.max(7.5 * pxPerMm, Math.max(lines.length, 1) * bodyLineHeight + 2.8 * pxPerMm); return { row, lines, groupHeight, rowHeight }; });
      const tableBodyHeight = rowLayouts.reduce((sum, row) => sum + row.groupHeight + row.rowHeight, 0);
      const stepLayouts = steps.map((step) => ({ step, lines: wrapText(step, contentWidth, bodyFont) }));
      const instructionsHeight = stepLayouts.reduce((sum, item) => sum + item.lines.length * bodyLineHeight + 2 * pxPerMm, 0);
      const estimateHeight = (photoHeight: number) => margin * 2 + photoHeight + 4 * pxPerMm + titleBlockHeight + 4 * pxPerMm + sectionLineHeight + 4 * pxPerMm + tableHeadHeight + tableBodyHeight + 4 * pxPerMm + sectionLineHeight + 4 * pxPerMm + instructionsHeight;
      if (estimateHeight(imageHeight) > pageHeight) imageHeight = 38 * pxPerMm;
      if (estimateHeight(imageHeight) > pageHeight) imageHeight = 30 * pxPerMm;
      const canvasHeight = Math.max(pageHeight, Math.ceil(estimateHeight(imageHeight)));
      canvas.width = width; canvas.height = canvasHeight;
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas is not available");
      ctx.fillStyle = "#F6F3EA"; ctx.fillRect(0, 0, width, canvasHeight);
      const photoX = margin, photoY = margin, photoWidth = contentWidth, photoHeight = imageHeight;
      const sourceRatio = image.naturalWidth / image.naturalHeight;
      const targetRatio = photoWidth / photoHeight;
      let sourceX = 0, sourceY = 0, sourceWidth = image.naturalWidth, sourceHeight = image.naturalHeight;
      if (sourceRatio > targetRatio) {
        sourceWidth = image.naturalHeight * targetRatio;
        sourceX = (image.naturalWidth - sourceWidth) / 2;
      } else {
        sourceHeight = image.naturalWidth / targetRatio;
        sourceY = (image.naturalHeight - sourceHeight) / 2;
      }
      const photoRadius = 18 * cssPxScale;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(photoX + photoRadius, photoY);
      ctx.lineTo(photoX + photoWidth - photoRadius, photoY);
      ctx.arcTo(photoX + photoWidth, photoY, photoX + photoWidth, photoY + photoRadius, photoRadius);
      ctx.lineTo(photoX + photoWidth, photoY + photoHeight - photoRadius);
      ctx.arcTo(photoX + photoWidth, photoY + photoHeight, photoX + photoWidth - photoRadius, photoY + photoHeight, photoRadius);
      ctx.lineTo(photoX + photoRadius, photoY + photoHeight);
      ctx.arcTo(photoX, photoY + photoHeight, photoX, photoY + photoHeight - photoRadius, photoRadius);
      ctx.lineTo(photoX, photoY + photoRadius);
      ctx.arcTo(photoX, photoY, photoX + photoRadius, photoY, photoRadius);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, photoX, photoY, photoWidth, photoHeight);
      ctx.restore();
      let y = margin + imageHeight + 4 * pxPerMm;
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#25291F"; ctx.font = titleFont;
      titleLines.forEach((line) => { y += titleLineHeight * 0.86; ctx.fillText(line, margin, y); y += titleLineHeight * 0.14; });
      if (timeLabel) { ctx.font = "600 " + (9 * ptScale) + 'px "Inter", Arial, sans-serif'; ctx.fillStyle = "#465331"; y += 1 * pxPerMm + 9 * ptScale; ctx.fillText(timeLabel, margin, y); y += Math.max(5 * pxPerMm, 9 * ptScale * 1.25) - 9 * ptScale; }
      y += 4 * pxPerMm;
      const drawSectionTitle = (label: string) => { ctx.font = sectionFont; ctx.fillStyle = "#465331"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; y += sectionLineHeight * 0.88; ctx.fillText(label, margin, y); y += sectionLineHeight * 0.12 + 4 * pxPerMm; };
      drawSectionTitle("Składniki");
      const headerY = y; ctx.fillStyle = "#E8EBDD"; ctx.fillRect(margin, headerY, contentWidth, tableHeadHeight);
      ctx.fillStyle = "#25291F"; ctx.font = "700 " + (8.5 * ptScale) + 'px "Inter", Arial, sans-serif'; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillText("Składnik", margin + pxPerMm, headerY + tableHeadHeight / 2);
      ctx.textAlign = "center";
      const firstQuantityCenter = margin + ingredientColumnWidth + quantityColumnWidth / 2;
      const secondQuantityCenter = firstQuantityCenter + quantityColumnWidth;
      const totalCenter = secondQuantityCenter + quantityColumnWidth;
      const smallHeaderFont = "500 " + (7 * ptScale) + 'px "Inter", Arial, sans-serif';
      const headerFont = "700 " + (8.5 * ptScale) + 'px "Inter", Arial, sans-serif';
      [[firstQuantityCenter, "Tysia", servingsLabel(tysiaServings)], [secondQuantityCenter, "Mati", servingsLabel(matiServings)]].forEach(([x, name, count]) => { ctx.font = headerFont; ctx.fillText(String(name), Number(x), headerY + tableHeadHeight * 0.38); ctx.font = smallHeaderFont; ctx.fillText(String(count), Number(x), headerY + tableHeadHeight * 0.72); });
      ctx.font = headerFont; ctx.fillText("Razem", totalCenter, headerY + tableHeadHeight / 2);
      y = headerY + tableHeadHeight;
      rowLayouts.forEach(({ row, lines, groupHeight, rowHeight }, index) => {
        if (groupHeight > 0) { y += groupHeight * 0.72; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#465331"; ctx.font = "700 " + (8 * ptScale) + 'px "Inter", Arial, sans-serif'; ctx.fillText(row.group.toLocaleUpperCase("pl-PL"), margin + pxPerMm, y); y += groupHeight * 0.28; }
        const rowY = y; if (index % 2 === 1) { ctx.fillStyle = "rgba(232,235,221,0.42)"; ctx.fillRect(margin, rowY, contentWidth, rowHeight); }
        ctx.fillStyle = "#E8EBDD"; ctx.fillRect(margin + ingredientColumnWidth + quantityColumnWidth * 2, rowY, quantityColumnWidth, rowHeight);
        ctx.fillStyle = "#25291F"; ctx.font = ingredientFont; ctx.textAlign = "left"; ctx.textBaseline = "middle"; const nameLineHeight = ingredientFontSize * 1.25; const nameBase = rowY + rowHeight / 2 - ((lines.length - 1) * nameLineHeight) / 2; lines.forEach((line, lineIndex) => ctx.fillText(line, margin + pxPerMm, nameBase + lineIndex * nameLineHeight));
        const drawValue = (value: string, center: number) => { ctx.font = quantityFont; ctx.fillStyle = "#25291F"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; const valueLines = wrapText(value, quantityColumnWidth - 8, quantityFont); const lineHeight = quantityFontSize * 1.2; const base = rowY + rowHeight / 2 - ((valueLines.length - 1) * lineHeight) / 2; valueLines.forEach((line, lineIndex) => ctx.fillText(line, center, base + lineIndex * lineHeight)); };
        drawValue(formatRecipeCardAmountLabel(row, row.tysia), firstQuantityCenter); drawValue(formatRecipeCardAmountLabel(row, row.mati), secondQuantityCenter); drawValue(formatRecipeCardAmountLabel(row, row.tysia + row.mati), totalCenter);
        ctx.strokeStyle = "#DADCCD"; ctx.lineWidth = Math.max(1, 0.25 * pxPerMm); ctx.beginPath(); ctx.moveTo(margin, rowY + rowHeight); ctx.lineTo(margin + contentWidth, rowY + rowHeight); ctx.stroke(); y += rowHeight;
      });
      y += 4 * pxPerMm; drawSectionTitle("Sposób przygotowania");
      const actionVerbPattern = /^(przepłucz|przepłukać|gotuj|ugotuj|wymieszaj|wymieszać|dodaj|dodać|pokrój|pokroić|rozgrzej|rozgrzać|podsmaż|podsmażyć|wlej|wlać|wsyp|wsypać|odcedź|odcedzić|zblenduj|zmiksuj|zmiksować|przełóż|przełożyć|ułóż|ułożyć|podawaj|podaj|piecz|upiecz|zagotuj|odstaw|odstawić|posyp|dopraw|obierz|zetrzyj|duś|smaż|wstaw|wyjmij|połącz|przykryj|odwróć|zdejmij|przygotuj|następnie|na koniec)\b/i;
      stepLayouts.forEach(({ step, lines }) => {
        const firstToken = step.match(/^([^\s,.;:]+)/)?.[1] || ""; const boldVerb = actionVerbPattern.test(firstToken) ? firstToken : "";
        lines.forEach((line, lineIndex) => { const baseline = y + bodyFontSize * 0.85; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#25291F"; if (lineIndex === 0 && boldVerb && line.startsWith(boldVerb)) { ctx.font = "700 " + bodyFontSize + 'px "Inter", Arial, sans-serif'; ctx.fillText(boldVerb, margin, baseline); const verbWidth = ctx.measureText(boldVerb).width; ctx.font = bodyFont; ctx.fillText(line.slice(boldVerb.length), margin + verbWidth, baseline); } else { ctx.font = bodyFont; ctx.fillText(line, margin, baseline); } y += bodyLineHeight; });
        y += 2 * pxPerMm;
      });
      const filename = String(recipe.name || "przepis").replaceAll("/", "-");
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")); if (!blob) throw new Error("Nie udało się utworzyć PNG");
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename + ".png"; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { console.error("Recipe PNG export failed:", error); toast({ title: "Błąd eksportu", description: "Nie udało się przygotować pliku PNG.", variant: "destructive" }); }
    finally { setIsExportingPng(false); }
  };
  if (!recipe) return null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setIsCookingMode(false);
          onClose();
        }
      }}
    >
      <DialogContent
        className={isCookingMode
          ? "max-w-3xl h-[92vh] overflow-hidden bg-white p-3 sm:p-4 max-sm:left-1/2 max-sm:top-1/2 max-sm:h-[calc(100dvh-1rem)] max-sm:w-[calc(100vw-1rem)] max-sm:max-w-[calc(100vw-1rem)] max-sm:translate-x-[-50%] max-sm:translate-y-[-50%] max-sm:rounded-2xl"
          : compact
            ? "max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden bg-white p-3 sm:p-4 max-sm:left-1/2 max-sm:top-1/2 max-sm:h-[calc(100dvh-1rem)] max-sm:w-[calc(100vw-1rem)] max-sm:max-w-[calc(100vw-1rem)] max-sm:translate-x-[-50%] max-sm:translate-y-[-50%] max-sm:rounded-2xl max-sm:p-2"
            : "max-w-3xl max-h-[90vh] overflow-y-auto overflow-x-hidden bg-white max-sm:left-1/2 max-sm:top-1/2 max-sm:h-[calc(100dvh-1rem)] max-sm:w-[calc(100vw-1rem)] max-sm:max-w-[calc(100vw-1rem)] max-sm:translate-x-[-50%] max-sm:translate-y-[-50%] max-sm:rounded-2xl max-sm:p-3"
        }
      >
        {isCookingMode ? (
          <div className="h-full flex flex-col gap-3">
            <DialogHeader>
              <DialogTitle className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-base sm:text-lg"><ChefHatIcon className="w-4 h-4 sm:w-5 sm:h-5" /> Tryb gotowania</span>
                <Button size="sm" variant="outline" onClick={() => setIsCookingMode(false)}>Wyjdź</Button>
              </DialogTitle>
            </DialogHeader>

            <div className="rounded-2xl bg-secondary/30 p-3 sm:p-4 text-center space-y-2">
              <p className="text-xs sm:text-sm text-muted-foreground">Krok {Math.min(currentStepIndex + 1, instructionSteps.length)} / {instructionSteps.length || 1}</p>
              <p className="text-lg sm:text-2xl font-bold leading-snug">
                {(currentStep?.segments || []).length > 0 ? currentStep.segments.map((segment: any, idx: number) => (
                  segment.type === "ingredient" ? (
                    <span
                      key={`${segment.ingredientId}-${idx}`}
                      className="inline rounded-full bg-primary/10 text-primary px-2 py-0.5 mx-0.5"
                    >{stripTimerTag(getCookingModeIngredientLabel(segment))}</span>
                  ) : <span key={`${segment.text}-${idx}`}>{stripTimerTag(segment.text)}</span>
                )) : "Brak kroków. Dodaj instrukcje do przepisu."}
              </p>
              {currentStepDurationMinutes > 0 && (
                <p className="text-xs sm:text-sm text-muted-foreground">Wykryto timer: {currentStepTimerName} ({currentStepDurationMinutes} min)</p>
              )}
            </div>

            {hasCurrentStepTimerDefinition && (
              <div className="rounded-2xl border p-3 sm:p-4 space-y-2">
                <p className="text-3xl sm:text-4xl font-bold text-center tabular-nums">{formatTime(timerRemainingSeconds)}</p>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    className="h-11 sm:h-12 text-sm sm:text-base"
                    onClick={() => {
                      const existingTimer = stepTimers.find((timer) => timer.stepIndex === currentStepIndex);
                      if (existingTimer) {
                        setStepTimers((prev) =>
                          prev.map((timer) =>
                            timer.stepIndex === currentStepIndex
                              ? {
                                  ...timer,
                                  remainingSeconds: timer.remainingSeconds <= 0 ? timer.initialSeconds : timer.remainingSeconds,
                                  isRunning: timer.remainingSeconds <= 0 ? timer.initialSeconds > 0 : !timer.isRunning,
                                }
                              : timer
                          )
                        );
                        return;
                      }

                      if (currentStepDurationMinutes <= 0) return;
                      const initialSeconds = currentStepDurationMinutes * 60;
                      setStepTimers((prev) => [
                        ...prev,
                        {
                          stepIndex: currentStepIndex,
                          name: currentStepTimerName,
                          initialSeconds,
                          remainingSeconds: initialSeconds,
                          isRunning: true,
                        },
                      ]);
                    }}
                  >
                    {isTimerRunning ? <Pause className="w-5 h-5 mr-2" /> : <Play className="w-5 h-5 mr-2" />}
                    {isTimerRunning ? "Pauza" : "Start"}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 sm:h-12 text-sm sm:text-base"
                    onClick={() => {
                      const initialSeconds = currentStepTimer?.initialSeconds || (currentStepDurationMinutes * 60);
                      if (initialSeconds <= 0) return;
                      setStepTimers((prev) => {
                        const hasCurrentStepTimer = prev.some((timer) => timer.stepIndex === currentStepIndex);
                        if (!hasCurrentStepTimer) {
                          return [
                            ...prev,
                            {
                              stepIndex: currentStepIndex,
                              name: currentStepTimerName,
                              initialSeconds,
                              remainingSeconds: initialSeconds,
                              isRunning: false,
                            },
                          ];
                        }
                        return prev.map((timer) =>
                          timer.stepIndex === currentStepIndex
                            ? { ...timer, remainingSeconds: initialSeconds, isRunning: false }
                            : timer
                        );
                      });
                    }}
                  >
                    <RotateCcw className="w-5 h-5 mr-2" />
                    Reset
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 sm:h-12 text-sm sm:text-base"
                    onClick={() => {
                      setStepTimers((prev) => prev.filter((timer) => timer.stepIndex !== currentStepIndex));
                    }}
                    disabled={!currentStepTimer}
                  >
                    Stop
                  </Button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 mt-auto">
              <Button
                variant="outline"
                className="h-12 sm:h-14 text-base sm:text-lg font-semibold"
                onClick={() => {
                  const prevIndex = Math.max(currentStepIndex - 1, 0);
                  setCurrentStepIndex(prevIndex);
                }}
                disabled={currentStepIndex <= 0}
              >
                Poprzedni krok
              </Button>
              <Button
                className="h-12 sm:h-14 text-base sm:text-lg font-bold"
                onClick={() => {
                  const nextIndex = Math.min(currentStepIndex + 1, Math.max(instructionSteps.length - 1, 0));
                  setCurrentStepIndex(nextIndex);
                }}
                disabled={currentStepIndex >= Math.max(instructionSteps.length - 1, 0)}
              >
                Następny krok
              </Button>
            </div>

            {stepTimers.length > 0 && (
              <div className="border rounded-2xl p-2 sm:p-3">
                <p className="text-[11px] sm:text-xs text-muted-foreground mb-2">Aktywne timery</p>
                <div className="flex flex-wrap gap-2">
                  {stepTimers.map((timer) => (
                    <div key={`timer-${timer.stepIndex}`} className="rounded-xl border px-2 py-1.5 sm:px-3 sm:py-2 min-w-[130px] bg-background">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] sm:text-xs font-medium">{timer.name || `Krok ${timer.stepIndex + 1}`}</span>
                        <span className="text-sm sm:text-base font-bold tabular-nums">{formatTime(timer.remainingSeconds)}</span>
                      </div>
                      <div className="flex gap-1 mt-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[10px] sm:text-xs"
                          onClick={() => {
                            setStepTimers((prev) =>
                              prev.map((item) =>
                                item.stepIndex === timer.stepIndex
                                  ? {
                                      ...item,
                                      remainingSeconds: item.remainingSeconds <= 0 ? item.initialSeconds : item.remainingSeconds,
                                      isRunning: item.remainingSeconds <= 0 ? item.initialSeconds > 0 : !item.isRunning,
                                    }
                                  : item
                              )
                            );
                          }}
                        >
                          {timer.isRunning ? "Pauza" : "Start"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[10px] sm:text-xs"
                          onClick={() => {
                            setStepTimers((prev) =>
                              prev.map((item) =>
                                item.stepIndex === timer.stepIndex
                                  ? { ...item, remainingSeconds: item.initialSeconds, isRunning: false }
                                  : item
                              )
                            );
                          }}
                        >
                          Reset
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[10px] sm:text-xs"
                          onClick={() => {
                            setStepTimers((prev) => prev.filter((item) => item.stepIndex !== timer.stepIndex));
                          }}
                        >
                          Stop
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        ) : (
        <div className={compact ? "space-y-3 overflow-x-hidden text-sm" : "space-y-6 overflow-x-hidden"}>
          {!compact && (
            <div 
              className="h-64 rounded-2xl bg-cover bg-center"
              style={{ backgroundImage: `url(${recipe.imageUrl || 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800'})` }}
            />
          )}
          <div>
            <h2 className={compact ? "text-xl font-bold font-display leading-tight" : "text-3xl font-bold font-display"}>{recipe.name}</h2>
            <div className="flex flex-wrap gap-1 mt-2">
              {recipe.tags?.map((tag: string, i: number) => (
                <span key={i} className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-lg font-bold">
                  {tag}
                </span>
              ))}
            </div>
            <div className="flex gap-2 mt-2 text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1 bg-secondary/50 px-2 py-1 rounded-lg text-xs"><Clock className="w-4 h-4" /> {recipe.prepTime} min</span>
              <span className="flex items-center gap-1 bg-secondary/50 px-2 py-1 rounded-lg text-xs"><ChefHat className="w-4 h-4" /> {baseIngredients.length} składników</span>
              {isVariantRecipe ? (
                <span className="flex items-center gap-1 bg-primary/10 text-primary font-bold px-2 py-1 rounded-lg text-xs">Wariant {getAvailableVariants(recipe?.ingredients || []).join("/")}</span>
              ) : (
                <span className="flex items-center gap-1 bg-primary/10 text-primary font-bold px-2 py-1 rounded-lg text-xs">
                  {isPlannedView ? `${servingsToUse} zaplanowanych porcji` : `${recipeServings} porcji`}
                </span>
              )}
              {isPlannedView && onSwitchPlannedPerson && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-lg px-2 text-xs"
                  onClick={onSwitchPlannedPerson}
                >
                  {switchPlannedPersonLabel || "Pokaż drugą osobę"}
                </Button>
              )}
              {isPlannedView && onPlannedServingsChange && !isVariantRecipe && (
                <div className="flex items-center gap-1 bg-secondary/60 px-2 py-1 rounded-lg text-xs">
                  <button
                    className="h-5 w-5 rounded-full border border-border text-[11px] leading-none"
                    onClick={() => updateServings(servingsToUse - 0.5)}
                    title="Zmniejsz porcje"
                  >
                    −
                  </button>
                  <span className="font-semibold min-w-12 text-center">{formatAmount(servingsToUse)}</span>
                  <button
                    className="h-5 w-5 rounded-full border border-border text-[11px] leading-none"
                    onClick={() => updateServings(servingsToUse + 0.5)}
                    title="Zwiększ porcje"
                  >
                    +
                  </button>
                </div>
              )}
              {isPlannedView && !onPlannedServingsChange && servingsLockedReason && !isVariantRecipe && (
                <span className="flex items-center gap-1 border border-amber-400/60 bg-amber-100 text-amber-900 dark:bg-amber-300/20 dark:text-amber-100 dark:border-amber-300/40 font-semibold px-2 py-1 rounded-lg text-xs max-w-full break-words">
                  {servingsLockedReason}
                </span>
              )}
              {!isPlannedView && !isVariantRecipe && (
                <span className="flex items-center gap-1 bg-amber-100/60 text-amber-900 font-semibold px-2 py-1 rounded-lg text-xs">
                  {`${Math.round(nutritionTotals.perServing.calories)} kcal / porcja`}
                </span>
              )}
            </div>
          </div>
          
          <div className={compact ? "grid grid-cols-5 gap-1 rounded-xl bg-secondary/30 p-2 text-center" : "grid grid-cols-5 gap-4 p-4 bg-secondary/30 rounded-2xl text-center"}>
            <div>
              <p className="text-[10px] uppercase font-bold text-muted-foreground">Kalorie</p>
              <p className={compact ? "text-base font-bold text-primary" : "text-xl font-bold text-primary"}>
                {Math.round(displayedNutrition.calories)}
              </p>
              <p className="text-[8px] text-muted-foreground">{nutritionScopeLabel}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase font-bold text-muted-foreground">Białko</p>
              <p className={compact ? "text-base font-bold" : "text-xl font-bold"}>
                {Math.round(displayedNutrition.protein)}g
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase font-bold text-muted-foreground">Węgle</p>
              <p className={compact ? "text-base font-bold" : "text-xl font-bold"}>
                {Math.round(displayedNutrition.carbs)}g
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase font-bold text-muted-foreground">Tłuszcz</p>
              <p className={compact ? "text-base font-bold" : "text-xl font-bold"}>
                {Math.round(displayedNutrition.fat)}g
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase font-bold text-muted-foreground">Cena</p>
              <p className={compact ? "text-base font-bold text-primary" : "text-xl font-bold text-primary"}>
                {displayedNutrition.price.toFixed(2)} zł
              </p>
              <p className="text-[8px] text-muted-foreground">{nutritionScopeLabel}</p>
            </div>
          </div>
          
          <div className={compact ? "grid gap-3 md:grid-cols-2 md:gap-4" : "grid md:grid-cols-2 gap-8"}>
            <div>
              <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <h3 className={compact ? "text-base font-bold" : "text-lg font-bold"}>Składniki</h3>
                <div className="flex w-full flex-col items-stretch gap-2 md:w-full md:flex-row md:flex-wrap md:items-center">
                  <Button variant="outline" size="icon" onClick={exportRecipeAsPng} disabled={isExportingPng} title="Pobierz kartę PNG" aria-label="Pobierz kartę PNG" className="h-8 w-8 shrink-0">
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="icon" onClick={printRecipeAsA5} title="Drukuj lub zapisz jako PDF" aria-label="Drukuj lub zapisz jako PDF" className="h-8 w-8 shrink-0">
                    <Printer className="h-4 w-4" />
                  </Button>
                  {onEditIngredients && allowIngredientEditing && (
                    <Button variant="ghost" size="sm" onClick={onEditIngredients} className="h-auto min-h-8 justify-start whitespace-normal text-left text-xs leading-tight text-primary hover:text-primary/80 md:justify-center">
                      <Settings2 className="w-3 h-3 mr-1" />
                      Dostosuj składniki
                    </Button>
                  )}
                  {onRestoreOriginalIngredients && (
                    <Button variant="outline" size="sm" onClick={onRestoreOriginalIngredients} className="h-auto min-h-8 justify-start whitespace-normal text-left text-xs leading-tight md:justify-center">
                      <RotateCcw className="w-3 h-3 mr-1" />
                      Przywróć składniki z przepisu
                    </Button>
                  )}
                </div>
              </div>
              <ul className={compact ? "space-y-1 text-xs" : "space-y-2"}>
                {ingredientRows.map(({ ri, isFrequentAddon, scalingIngredient }: any, idx: number) => {
                  const ingredientItemClass = isFrequentAddon
                    ? "border-emerald-300 bg-emerald-50/70"
                    : "border-transparent bg-secondary/50";

                  return (
                  <li key={idx} className="list-none">
                    {ri.groupName && (idx === 0 || ingredientRows[idx - 1]?.ri?.groupName !== ri.groupName) && (
                      <h4 className={`${idx > 0 ? "mt-3" : ""} mb-1 px-1 text-xs font-bold uppercase tracking-wide text-primary`}>
                        {ri.groupName}
                      </h4>
                    )}
                    <div className={`${compact ? "p-1.5" : "p-2"} rounded-lg border ${ingredientItemClass}`}>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
                      <span className="font-semibold min-w-0 break-words pr-2">
                        {ri.ingredient?.name}
                        {isFrequentAddon && (
                          <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                            Dodatek
                          </span>
                        )}
                      </span>
                      <span className="text-right font-medium whitespace-nowrap pl-2">
                        {getIngredientAmountLabel(ri, isFrequentAddon, scalingIngredient)}
                      </span>
                    </div>
                    {(() => {
                      const sharedInfo = getSharedAddonPersonInfo(ri);
                      if (!sharedInfo) return null;
                      return (
                        <span className="mt-1 block text-[10px] leading-tight text-emerald-700">
                          {sharedInfo}
                        </span>
                      );
                    })()}
                    {Number(ri.ingredient?.unitWeight || 0) > 0 && (
                      <span className="text-[10px] text-muted-foreground italic">
                        ({ri.ingredient.unitDescription ? `${ri.ingredient.unitDescription} - ` : ""}1 sztuka to ok. {ri.ingredient.unitWeight}g)
                      </span>
                    )}
                    </div>
                  </li>
                );
                })}
              </ul>
              {(recipe?.prepTasks || []).length > 0 && (
                <div className="mt-5 rounded-xl border border-primary/15 bg-primary/5 p-3">
                  <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <CalendarClock className="h-4 w-4 text-primary" /> Meal Prep
                  </h4>
                  <ul className={compact ? "space-y-1 text-xs" : "space-y-2"}>
                    {(recipe.prepTasks || []).map((task: any) => (
                      <li key={task.id || `${task.title}-${task.ingredientId}`} className="rounded-lg bg-background/80 p-2 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium">{task.title}</span>
                          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">do {task.maxDaysBefore} dni</span>
                        </div>
                        {(task.ingredient?.name || task.notes) && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {task.ingredient?.name ? `${task.ingredient.name}${task.notes ? " · " : ""}` : ""}{task.notes || ""}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div>
              <h3 className={compact ? "mb-2 text-base font-bold" : "text-lg font-bold mb-3"}>Instrukcje</h3>
              {recipeComment && (
                <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                  <p className="text-xs font-semibold uppercase tracking-wide">Komentarz</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{recipeComment}</p>
                </div>
              )}
              {instructionSteps.length > 0 ? (
                <ol className={compact ? "list-decimal space-y-1 pl-4 text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]" : "list-decimal pl-5 space-y-2 text-muted-foreground leading-relaxed [overflow-wrap:anywhere]"}>
                  {instructionSteps.map((step: InstructionStep, idx: number) => (
                    <li key={`step-${idx}`} className="[overflow-wrap:anywhere]">
                      {step.segments.map((segment: any, segmentIdx: number) => (
                        segment.type === "ingredient" ? (
                          <span
                            key={`${segment.ingredientId}-${segmentIdx}`}
                            className="inline rounded-full bg-primary/10 text-primary px-2 py-0.5 mx-0.5 [overflow-wrap:anywhere]"
                          >{stripTimerTag(segment.text)}</span>
                        ) : <span key={`${segment.text}-${segmentIdx}`}>{stripTimerTag(segment.text)}</span>
                      ))}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className={compact ? "whitespace-pre-wrap text-xs leading-snug text-muted-foreground" : "whitespace-pre-wrap text-muted-foreground leading-relaxed"}>Brak instrukcji.</p>
              )}
              {instructionSteps.length > 0 && (
                <Button size={compact ? "sm" : "default"} className={compact ? "mt-3 h-8 text-xs" : "mt-4"} onClick={() => {
                  setCurrentStepIndex(0);
                  setStepTimers([]);
                  setIsCookingMode(true);
                }}>
                  <ChefHatIcon className="w-4 h-4 mr-2" />
                  Uruchom cooking mode
                </Button>
              )}
            </div>
          </div>

          {suggestedRecipes.length > 0 && (
            <div>
              <h3 className="text-lg font-bold mb-3">Sugerowane dodatki (inne przepisy)</h3>
              <div className="flex flex-wrap gap-2">
                {suggestedRecipes.map((suggestion: any) => (
                  <Button
                    key={suggestion.recipe.id}
                    variant="outline"
                    className="h-8"
                    onClick={() => onAddToPlan(suggestion.recipe, suggestion.servings)}
                  >
                    <CalendarPlus className="w-3 h-3 mr-1" />
                    {suggestion.recipe.name} ({formatAmount(suggestion.servings)} por.)
                  </Button>
                ))}
              </div>
            </div>
          )}
          {showFooter && (
            <DialogFooter>
              <Button 
                className="w-full sm:w-auto gap-2"
                onClick={() => onAddToPlan(recipe)}
              >
                <CalendarPlus className="w-4 h-4" />
                Dodaj do planu
              </Button>
            </DialogFooter>
          )}
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

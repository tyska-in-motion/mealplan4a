import { lazy, Suspense, useState, useMemo, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { Layout } from "@/components/Layout";
import { format, addDays, subDays, eachDayOfInterval } from "date-fns";
import { pl } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Plus, X, CheckCircle2, Circle, Minus, Eye, NotebookText, Carrot, Copy, Trash2, Download, GripVertical, MoreHorizontal, Pencil } from "lucide-react";
import { fetchMealEntryFull, useDayPlanSummary, useAddMealEntry, useDeleteMealEntry, useToggleEaten, useUpdateMealEntry, useCopyDayPlan } from "@/hooks/use-meal-plan";
import { fetchRecipeDetails, useRecipeSearchIndex } from "@/hooks/use-recipes";
import { useAllIngredients } from "@/hooks/use-ingredients";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
const RecipeView = lazy(() => import("@/components/RecipeView").then(({ RecipeView }) => ({ default: RecipeView })));
import { calculateNutritionAmount, calculatePurchaseAmount, calculateScaledAmount } from "@shared/scaling";
import { getProduceContribution } from "@shared/produce-tracking";
import { useToast } from "@/hooks/use-toast";
import { Check, ChevronsUpDown } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, buildUrl } from "@shared/routes";
import { fetchWithTimeout } from "@/lib/queryClient";
import { canvasToPdfBlob, downloadBlob } from "@/lib/pdf";
import { normalizeSearchText } from "@/lib/text-normalize";
import { buildSharedIngredientsSummary, buildWholeSharedBatchIngredients } from "@/lib/shared-ingredients";
import { hasEditedMealIngredients } from "@/lib/meal-entry-ingredients";
import { getAvailableVariants, type PortionVariant } from "@shared/portion-variants";
import { getAdditionalMealIngredients, restoreRecipeIngredientsPreservingAdditions, splitBatchIngredientAmounts, type PortionsByPerson } from "@shared/portioning";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const isIndividualVariantRecipe = (recipe: any) =>
  recipe?.portioningMode === "individual" || getAvailableVariants(recipe?.ingredients || []).length > 0;

const getRecipeNutritionAtServings = (recipe: any, servings: number) => {
  const recipeServings = Math.max(0.1, Number(recipe?.servings) || 1);
  return (recipe?.ingredients || []).reduce((sum: any, ri: any) => {
    if (!ri?.ingredient) return sum;
    const amount = calculateScaledAmount(ri, servings, recipeServings);
    const nutritionAmount = calculateNutritionAmount(amount, ri.ingredient);
    const multiplier = nutritionAmount / 100;
    return {
      calories: sum.calories + (Number(ri.ingredient.calories) || 0) * multiplier,
      protein: sum.protein + (Number(ri.ingredient.protein) || 0) * multiplier,
      carbs: sum.carbs + (Number(ri.ingredient.carbs) || 0) * multiplier,
      fat: sum.fat + (Number(ri.ingredient.fat) || 0) * multiplier,
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
};

export default function MealPlan({ mode = "plan" }: { mode?: "plan" | "shared"; [key: string]: unknown } = {}) {
  const [location] = useLocation();
  const isSharedView = mode === "shared";
  const [baseDate, setBaseDate] = useState(new Date());
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isEditingIngredients, setIsEditingIngredients] = useState(false);

  const [touchMoveEntry, setTouchMoveEntry] = useState<{ id: number; date: string; mode?: "move" | "copy"; entry?: any } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.split("?")[1] || "");
    const dateParam = params.get("date");
    if (!dateParam) return;

    const parsedDate = new Date(`${dateParam}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) return;
    setBaseDate(parsedDate);
  }, [location]);

  const weekDays = useMemo(() => {
    const start = baseDate;
    return eachDayOfInterval({
      start,
      end: addDays(start, 6)
    });
  }, [baseDate]);

  const weekDateStrings = useMemo(() => weekDays.map((day) => format(day, "yyyy-MM-dd")), [weekDays]);
  useEffect(() => {
    if (isSharedView) return;

    const query = location.split("?")[1] || "";
    const hash = location.includes("#") ? location.split("#")[1] : "";
    const params = new URLSearchParams(query.split("#")[0] || "");
    const requestedDate = params.get("date") || format(new Date(), "yyyy-MM-dd");
    const targetId = hash || `day-${requestedDate}`;

    const scrollToTarget = () => {
      const target = document.getElementById(targetId);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const timer = window.setTimeout(scrollToTarget, 120);
    return () => window.clearTimeout(timer);
  }, [isSharedView, location, weekDays]);

  const { mutate: addEntry } = useAddMealEntry();
  const { mutate: deleteEntry } = useDeleteMealEntry();
  const { mutate: toggleEaten } = useToggleEaten();
  const { mutate: updateMealEntry, mutateAsync: updateMealEntryAsync, isPending: isSaving } = useUpdateMealEntry();
  const { mutate: copyDayPlan, isPending: isCopyingDay } = useCopyDayPlan();
  const { data: allAvailableIngredients } = useAllIngredients(undefined, isAddOpen || isEditingIngredients);
  const ingredientSettingsById = useMemo(() => {
    const settings = new Map<number, any>();
    (allAvailableIngredients || []).forEach((ingredient: any) => {
      const id = Number(ingredient?.id);
      if (Number.isFinite(id) && id > 0) settings.set(id, ingredient);
    });
    return settings;
  }, [allAvailableIngredients]);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [sharedRecipeId, setSharedRecipeId] = useState<number>(0);
  const [sharedRecipeSearch, setSharedRecipeSearch] = useState("");
  const [sharedTotalServings, setSharedTotalServings] = useState<number>(6);
  const [sharedNote, setSharedNote] = useState("");
  const [selectedArchivedBatchIds, setSelectedArchivedBatchIds] = useState<number[]>([]);
  const [allocationForms, setAllocationForms] = useState<Record<number, { date: string; mealType: string; person: "A" | "B"; servings: number }>>({});
  const [isViewingSharedDayRecipe, setIsViewingSharedDayRecipe] = useState(false);

  const { data: userSettings } = useQuery<any>({
    queryKey: ["/api/user-settings"],
  });

  const { data: sharedBatches = [] } = useQuery<any[]>({
    queryKey: [api.sharedMeals.list.path],
    queryFn: async () => {
      const res = await fetch(api.sharedMeals.list.path);
      if (!res.ok) throw new Error("Nie udało się pobrać wspólnych posiłków");
      return res.json();
    },
  });

  const { data: archivedSharedBatches = [] } = useQuery<any[]>({
    queryKey: [api.sharedMeals.list.path, "archived"],
    queryFn: async () => {
      const res = await fetch(`${api.sharedMeals.list.path}?includeArchived=true`);
      if (!res.ok) throw new Error("Nie udało się pobrać archiwalnych wspólnych posiłków");
      return res.json();
    },
  });

  const allKnownSharedBatches = useMemo(() => {
    const byId = new Map<number, any>();
    [...(sharedBatches || []), ...(archivedSharedBatches || [])].forEach((batch: any) => {
      const id = Number(batch?.id);
      if (Number.isFinite(id) && id > 0) byId.set(id, batch);
    });
    return byId;
  }, [sharedBatches, archivedSharedBatches]);

  const createSharedBatch = useMutation({
    mutationFn: async () => {
      const payload = { recipeId: sharedRecipeId, totalServings: sharedTotalServings, note: sharedNote || undefined };
      const res = await fetchWithTimeout(api.sharedMeals.createBatch.path, {
        method: api.sharedMeals.createBatch.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.message || "Nie udało się utworzyć partii");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
      setSharedRecipeId(0);
      setSharedRecipeSearch("");
      setSharedTotalServings(6);
      setSharedNote("");
      toast({ title: "Dodano", description: "Nowa partia wspólnego posiłku została zapisana." });
    },
    onError: (error: any) => toast({ title: "Błąd", description: error?.message || "Nie udało się dodać partii", variant: "destructive" }),
  });

  const archiveBatch = useMutation({
    mutationFn: async ({ id, isArchived }: { id: number; isArchived: boolean }) => {
      const path = api.sharedMeals.archiveBatch.path.replace(":id", String(id));
      const res = await fetch(path, {
        method: api.sharedMeals.archiveBatch.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isArchived }),
      });
      if (!res.ok) throw new Error("Nie udało się zarchiwizować partii");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path, "archived"] });
    },
  });

  const deleteBatch = useMutation({
    mutationFn: async (id: number) => {
      const path = api.sharedMeals.deleteBatch.path.replace(":id", String(id));
      const res = await fetch(path, {
        method: api.sharedMeals.deleteBatch.method,
      });
      if (!res.ok) throw new Error("Nie udało się usunąć partii");
      return null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path, "archived"] });
      toast({ title: "Usunięto", description: "Partia została trwale usunięta." });
    },
    onError: (error: any) => toast({ title: "Błąd", description: error?.message || "Nie udało się usunąć partii", variant: "destructive" }),
  });

  const bulkDeleteArchivedBatches = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(ids.map(async (id) => {
        const path = api.sharedMeals.deleteBatch.path.replace(":id", String(id));
        const res = await fetch(path, { method: api.sharedMeals.deleteBatch.method });
        if (!res.ok) throw new Error("Nie udało się usunąć wszystkich partii");
      }));
      return ids.length;
    },
    onSuccess: (count: number) => {
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path, "archived"] });
      setSelectedArchivedBatchIds([]);
      toast({ title: "Usunięto", description: `Usunięto ${count} ${count === 1 ? "partię" : "partii"} z archiwum.` });
    },
    onError: (error: any) => toast({ title: "Błąd", description: error?.message || "Nie udało się usunąć zaznaczonych partii", variant: "destructive" }),
  });

  useEffect(() => {
    const availableIds = new Set((archivedSharedBatches || []).map((batch: any) => Number(batch.id)));
    setSelectedArchivedBatchIds((prev) => prev.filter((id) => availableIds.has(id)));
  }, [archivedSharedBatches]);

  const updateBatch = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: { totalServings?: number; finishedWeightGrams?: number | null; note?: string | null; ingredients?: any[] } }) => {
      const path = api.sharedMeals.updateBatch.path.replace(":id", String(id));
      const res = await fetch(path, {
        method: api.sharedMeals.updateBatch.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...updates,
          ...(updates.totalServings !== undefined ? { totalServings: Math.max(0.25, updates.totalServings) } : {}),
          ...(updates.finishedWeightGrams !== undefined ? { finishedWeightGrams: updates.finishedWeightGrams } : {}),
          ...(updates.note !== undefined ? { note: updates.note?.trim() || null } : {}),
        }),
      });
      if (!res.ok) throw new Error("Nie udało się zapisać zmian partii");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path, "archived"] });
      toast({ title: "Zapisano", description: "Partia została zaktualizowana." });
    },
    onError: (error: any) => toast({ title: "Błąd", description: error?.message || "Nie udało się zapisać partii", variant: "destructive" }),
  });

  const createSharedBatchForEntry = async ({ recipeId, totalServings, note }: { recipeId: number; totalServings: number; note?: string }) => {
    const res = await fetchWithTimeout(api.sharedMeals.createBatch.path, {
      method: api.sharedMeals.createBatch.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipeId,
        totalServings: Math.max(0.25, Number(totalServings) || 1),
        note: note?.trim() || undefined,
      }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error?.message || "Nie udało się utworzyć nowej partii");
    }
    return res.json();
  };


  const [pendingDuplicateOverflow, setPendingDuplicateOverflow] = useState<null | {
    entry: any;
    updates: { date: string; mealType: string; person: "A" | "B" };
    batch: any;
    requestedServings: number;
    remainingServings: number;
    projectedAllocated: number;
    overflow: number;
  }>(null);

  const createDuplicatedMealEntry = (
    entry: any,
    updates: { date: string; mealType: string; person: "A" | "B" },
    options: { servings?: number; cookedBatchId?: number | null; successDescription?: string } = {},
  ) => {
    if (!entry?.id) return;

    const servings = Math.round(Math.max(0.1, Number(options.servings ?? entry.servings) || 1) * 100) / 100;
    const cookedBatchId = Number(options.cookedBatchId ?? entry.cookedBatchId ?? 0);
    const ingredients = (entry.ingredients || [])
      .map((ingredient: any) => ({
        ingredientId: Number(ingredient.ingredientId),
        amount: Number(ingredient.amount ?? ingredient.baseAmount) || 0,
        scalingType: ingredient.scalingType || "FIXED",
      }))
      .filter((ingredient: any) => Number.isFinite(ingredient.ingredientId) && ingredient.ingredientId > 0);

    addEntry({
      date: updates.date,
      mealType: updates.mealType,
      person: updates.person,
      recipeId: entry.recipeId ? Number(entry.recipeId) : null as any,
      customName: entry.customName || null,
      customCalories: entry.customCalories ?? null,
      customProtein: entry.customProtein ?? null,
      customCarbs: entry.customCarbs ?? null,
      customFat: entry.customFat ?? null,
      servings,
      isEaten: false,
      ...(cookedBatchId > 0 ? { cookedBatchId } : {}),
    } as any, {
      onSuccess: (createdEntry) => {
        if (ingredients.length > 0) {
          updateMealEntry({
            id: createdEntry.id,
            updates: { ingredients, servings },
          }, {
            onSuccess: () => toast({ title: "Skopiowano", description: options.successDescription || "Posiłek został zduplikowany w wybranym slocie." }),
          });
          return;
        }

        toast({ title: "Skopiowano", description: options.successDescription || "Posiłek został zduplikowany w wybranym slocie." });
      },
      onError: (error: any) => {
        toast({
          title: "Błąd",
          description: error?.message || "Nie udało się zduplikować posiłku.",
          variant: "destructive",
        });
      },
    });
  };

  const duplicateMealEntry = (entry: any, updates: { date: string; mealType: string; person: "A" | "B" }) => {
    if (!entry?.id) return;

    const batchId = Number(entry?.cookedBatchId || 0);
    const requestedServings = Math.round(Math.max(0.1, Number(entry.servings) || 1) * 100) / 100;
    if (batchId <= 0) {
      createDuplicatedMealEntry(entry, updates);
      return;
    }

    const batch = allKnownSharedBatches.get(batchId);
    if (!batch) {
      createDuplicatedMealEntry(entry, updates, { cookedBatchId: batchId });
      return;
    }

    const allocatedServings = Number(batch?.allocatedServings) || 0;
    const totalServings = Number(batch?.totalServings) || 0;
    const remainingServings = Math.max(0, Math.round((totalServings - allocatedServings) * 100) / 100);
    const projectedAllocated = Math.round((allocatedServings + requestedServings) * 100) / 100;

    if (projectedAllocated <= totalServings + 1e-9) {
      createDuplicatedMealEntry(entry, updates, { cookedBatchId: batchId });
      return;
    }

    const overflow = Math.round((projectedAllocated - totalServings) * 100) / 100;
    setPendingDuplicateOverflow({
      entry,
      updates,
      batch,
      requestedServings,
      remainingServings,
      projectedAllocated,
      overflow,
    });
    toast({
      title: "Przekroczysz porcje wspólnego posiłku",
      description: `Duplikacja doda ${requestedServings} porcji, a w partii zostało ${remainingServings}. Wybierz, co zrobić dalej.`,
      variant: "destructive",
    });
  };

  const cancelPendingDuplicateOverflow = () => setPendingDuplicateOverflow(null);

  const duplicateWithRemainingSharedServings = () => {
    const pending = pendingDuplicateOverflow;
    if (!pending || pending.remainingServings <= 0) return;

    createDuplicatedMealEntry(pending.entry, pending.updates, {
      servings: pending.remainingServings,
      cookedBatchId: Number(pending.batch?.id) || Number(pending.entry?.cookedBatchId) || null,
      successDescription: `Posiłek zduplikowano z liczbą porcji zmniejszoną do ${pending.remainingServings}, więc pozostałe porcje wspólnego posiłku wynoszą 0.`,
    });
    setPendingDuplicateOverflow(null);
  };

  const duplicateIntoNewSharedBatch = async () => {
    const pending = pendingDuplicateOverflow;
    if (!pending) return;

    try {
      const newBatch = await createSharedBatchForEntry({
        recipeId: Number(pending.batch?.recipeId || pending.entry?.recipeId),
        totalServings: pending.requestedServings,
        note: `Duplikacja z planu (wpis #${pending.entry.id})`,
      });
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path, "archived"] });
      createDuplicatedMealEntry(pending.entry, pending.updates, {
        servings: pending.requestedServings,
        cookedBatchId: Number(newBatch?.id) || null,
        successDescription: `Utworzono nowy wspólny posiłek #${newBatch?.id} i przypisano do niego duplikat.`,
      });
      setPendingDuplicateOverflow(null);
    } catch (error: any) {
      toast({
        title: "Błąd",
        description: error?.message || "Nie udało się utworzyć nowego wspólnego posiłku",
        variant: "destructive",
      });
    }
  };

  const handleEntryUpdate = async (entry: any, updates: any) => {
    if (!entry?.id) return;

    const hasServingsUpdate = updates && Object.prototype.hasOwnProperty.call(updates, "servings");
    const batchId = Number(entry?.cookedBatchId || 0);
    if (!hasServingsUpdate || batchId <= 0) {
      updateMealEntry({ id: entry.id, updates });
      return;
    }

    const batch = allKnownSharedBatches.get(batchId);
    if (!batch) {
      updateMealEntry({ id: entry.id, updates });
      return;
    }

    const currentServings = Number(entry?.servings) || 1;
    const requestedServings = Math.max(0.25, Number(updates?.servings) || currentServings);
    const allocatedServings = Number(batch?.allocatedServings) || 0;
    const totalServings = Number(batch?.totalServings) || 0;
    const projectedAllocated = allocatedServings - currentServings + requestedServings;

    if (projectedAllocated <= totalServings + 1e-9) {
      updateMealEntry({
        id: entry.id,
        updates: { ...updates, servings: requestedServings },
      });
      return;
    }

    const maxEntryServings = Math.max(0.25, totalServings - (allocatedServings - currentServings));
    const cappedServings = Math.round(maxEntryServings * 100) / 100;
    if (requestedServings > cappedServings + 1e-9) {
      updateMealEntry({
        id: entry.id,
        updates: { ...updates, servings: cappedServings },
      });
    }

    const overflow = Math.round((projectedAllocated - totalServings) * 100) / 100;
    toast({
      title: "Przekroczono ilość porcji w batchu",
      description: `Zatrzymałem na ${cappedServings}. Brakuje ${overflow} porcji względem przygotowanej partii (${totalServings}).`,
      variant: "destructive",
    });

    const wantsToExtendBatch = window.confirm(
      `Przekraczasz ilość przygotowanych porcji w batchu (#${batchId}).\n\n` +
      `Obecnie przygotowane: ${totalServings}\n` +
      `Po zmianie byłoby: ${Math.round(projectedAllocated * 100) / 100}\n\n` +
      `Czy chcesz dodać ${overflow} porcji do tego batcha?`,
    );

    if (wantsToExtendBatch) {
      try {
        await updateBatch.mutateAsync({
          id: batchId,
          updates: {
            totalServings: totalServings + overflow,
            note: String(batch?.note || ""),
          },
        });
        updateMealEntry({
          id: entry.id,
          updates: { ...updates, servings: requestedServings },
        });
      } catch {
        // updateBatch mutation already shows a toast
      }
      return;
    }

    const wantsNewBatch = window.confirm(
      `Czy chcesz utworzyć nowy batch dla tego przepisu i przypisać do niego ten wpis?`,
    );

    if (!wantsNewBatch) return;

    try {
      const newBatch = await createSharedBatchForEntry({
        recipeId: Number(batch?.recipeId || entry?.recipeId),
        totalServings: requestedServings,
        note: `Auto z planu (wpis #${entry.id})`,
      });
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path, "archived"] });
      updateMealEntry({
        id: entry.id,
        updates: {
          ...updates,
          servings: requestedServings,
          cookedBatchId: Number(newBatch?.id) || undefined,
        },
      });
      toast({
        title: "Utworzono nowy batch",
        description: `Wpis został przypisany do nowego batcha #${newBatch?.id}.`,
      });
    } catch (error: any) {
      toast({
        title: "Błąd",
        description: error?.message || "Nie udało się utworzyć nowego batcha",
        variant: "destructive",
      });
    }
  };

  const [isAddingRecipe, setIsAddingRecipe] = useState(false);
  const isAddingRecipeRef = useRef(false);
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const [isIngredientOpen, setIsIngredientOpen] = useState(false);
  const [selectedMealType, setSelectedMealType] = useState<string | null>(null);
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<"A" | "B">("A");
  const [selectedRecipeToAdd, setSelectedRecipeToAdd] = useState<any>(null);
  const [selectedPortionVariants, setSelectedPortionVariants] = useState<Record<"A" | "B", PortionVariant>>({ A: "B", B: "B" });
  const [selectedRecommendedBatchId, setSelectedRecommendedBatchId] = useState<number | null>(null);
  const [selectedFrequentAddons, setSelectedFrequentAddons] = useState<Record<"A" | "B", Record<number, number>>>({ A: {}, B: {} });
  const [addRecipeForBothPeople, setAddRecipeForBothPeople] = useState(false);
  const [pendingSharedBatchPrompt, setPendingSharedBatchPrompt] = useState<{ recipeId: number; recipe: any } | null>(null);
  const [selectedRecipeServings, setSelectedRecipeServings] = useState(1);
  const [selectedPersonServings, setSelectedPersonServings] = useState<PortionsByPerson>({ A: 1, B: 1 });
  const [selectedSuggestedRecipes, setSelectedSuggestedRecipes] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [recipeSort, setRecipeSort] = useState("popular");

  const { data: recipes, isFetching: isFetchingRecipes } = useRecipeSearchIndex(isAddOpen || isSharedView);
  const filteredSharedRecipes = useMemo(() => {
    const normalizedQuery = normalizeSearchText(sharedRecipeSearch);
    if (!normalizedQuery) return recipes || [];
    return (recipes || []).filter((recipe: any) =>
      normalizeSearchText(recipe?.name || "").includes(normalizedQuery) ||
      (recipe?.tags || []).some((tag: string) => normalizeSearchText(tag).includes(normalizedQuery))
    );
  }, [recipes, sharedRecipeSearch]);

  const [viewingRecipe, setViewingRecipe] = useState<any>(null);
  const [viewingMeal, setViewingMeal] = useState<any>(null);
  const [viewingServings, setViewingServings] = useState<number | undefined>(undefined);
  const [viewingSharedPerson, setViewingSharedPerson] = useState<"A" | "B">("A");
  const [isSharedRecipeView, setIsSharedRecipeView] = useState(false);

  const [editingMealIngredients, setEditingMealIngredients] = useState<any[]>([]);
  const [viewingSharedBatchId, setViewingSharedBatchId] = useState<number | null>(null);
  const [ingredientSearch, setIngredientSearch] = useState("");
  const [ingredientDialogDragY, setIngredientDialogDragY] = useState(0);
  const [isIngredientDialogExpanded, setIsIngredientDialogExpanded] = useState(false);
  const [isIngredientDialogDragging, setIsIngredientDialogDragging] = useState(false);
  const ingredientDialogDragStartYRef = useRef<number | null>(null);
  const [selectedIngredientId, setSelectedIngredientId] = useState<number | null>(null);
  const [ingredientAmount, setIngredientAmount] = useState(100);
  const [copySourceDate, setCopySourceDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [copyTargetDate, setCopyTargetDate] = useState(format(addDays(new Date(), 1), "yyyy-MM-dd"));
  const [isCopyDayOpen, setIsCopyDayOpen] = useState(false);
  const personName: Record<"A" | "B", string> = { A: "Tysia", B: "Mati" };
  const getRecipeDefaultServingsForPerson = (recipe: any, person: "A" | "B") => {
    const fallback = Number(recipe?.servings) || 1;
    const value = person === "A" ? Number(recipe?.defaultServingsA) : Number(recipe?.defaultServingsB);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const getDefaultFrequentAddonsSelection = (recipe: any): Record<"A" | "B", Record<number, number>> => {
    const next: Record<"A" | "B", Record<number, number>> = { A: {}, B: {} };
    (recipe?.frequentAddons || []).forEach((addon: any) => {
      const ingredientId = Number(addon?.ingredientId);
      if (!Number.isFinite(ingredientId) || ingredientId <= 0) return;
      next.A[ingredientId] = Math.max(0, Math.round(Number(addon?.defaultAmountA) || 0));
      const fallbackB = Number(addon?.baseAmount ?? addon?.amount) || 0;
      next.B[ingredientId] = Math.max(0, Math.round(Number(addon?.defaultAmountB ?? fallbackB) || 0));
    });
    return next;
  };

  const frequentAddonDefinitions = viewingRecipe?.frequentAddons || [];
  const getAddonBaseAmount = (addon: any) => Number(addon?.baseAmount ?? addon?.amount) || 0;
  const frequentAddonIngredientIds = useMemo(() => new Set(
    frequentAddonDefinitions.map((addon: any) => addon.ingredientId)
  ), [frequentAddonDefinitions]);


  const resolveRecipeIngredientSource = (ingredientId: number, occurrence: number) => {
    if (!viewingRecipe) return undefined;
    const recipeIngredients = (viewingRecipe.ingredients || []).filter((ri: any) => Number(ri?.ingredientId) === Number(ingredientId));
    const recipeFrequentAddons = (viewingRecipe.frequentAddons || []).filter((ri: any) => Number(ri?.ingredientId) === Number(ingredientId));
    const candidates = [...recipeIngredients, ...recipeFrequentAddons];
    return candidates[occurrence - 1] || candidates[0];
  };

  const splitSharedIngredientsByServings = (ingredients: any[], participants: any[], recipeServings: number) => {
    const participantAmounts = participants.map(() => [] as any[]);

    ingredients.forEach((ingredient: any) => {
      const totalAmount = Math.round(Number(ingredient.amount) || 0);
      const scalingType = ingredient.scalingType || "LINEAR";
      const weights = participants.map((entry: any) => {
        const weight = calculateScaledAmount(
          { ...ingredient, baseAmount: 1, scalingType } as any,
          Number(entry?.servings) || 0,
          recipeServings,
        );
        return Number.isFinite(weight) && weight > 0 ? weight : 0;
      });
      const totalWeight = weights.reduce((sum: number, weight: number) => sum + weight, 0);
      let assignedAmount = 0;

      participants.forEach((_entry: any, index: number) => {
        const isLastParticipant = index === participants.length - 1;
        const ratio = totalWeight > 0 ? weights[index] / totalWeight : 1 / Math.max(1, participants.length);
        const amount = isLastParticipant
          ? totalAmount - assignedAmount
          : Math.round(totalAmount * ratio);
        assignedAmount += amount;

        participantAmounts[index].push({
          ingredientId: Number(ingredient.ingredientId),
          amount,
          // Meal-entry ingredient amounts are final per-person overrides.
          scalingType: "FIXED" as const,
        });
      });
    });

    return participantAmounts;
  };

  const startEditing = () => {
    if (!viewingRecipe || !viewingMeal) return;

    const isBatchIngredientEdit = Number(viewingMeal?.wholeRecipeBatchId || 0) > 0;
    const sharedParticipants = [viewingMeal?.sharedParticipantEntries?.A, viewingMeal?.sharedParticipantEntries?.B]
      .filter((entry: any) => entry?.id);
    const isSharedRecipeIngredientEdit = !isBatchIngredientEdit && sharedParticipants.length > 0;
    const currentIngredients = isBatchIngredientEdit || isSharedRecipeIngredientEdit
      // Shared and cooked-batch editors change only the recipe base. Personal
      // additions stay attached to their respective meal entries.
      ? viewingRecipe.ingredients
      : (viewingMeal.ingredients && viewingMeal.ingredients.length > 0)
      ? viewingMeal.ingredients
      : viewingRecipe.ingredients;

    const entryServings = isBatchIngredientEdit
      ? Number(viewingMeal?.wholeRecipeBatchServings) || Number(viewingMeal?.servings) || 1
      : isSharedRecipeIngredientEdit
      ? sharedParticipants.reduce((sum: number, entry: any) => sum + (Number(entry?.servings) || 0), 0)
      : Number(viewingMeal.servings) || 1;
    const recipeServings = Number(viewingRecipe.servings) || 1;
    const recipeIngredientCounts = (viewingRecipe.ingredients || []).reduce((acc: Map<number, number>, ingredient: any) => {
      const ingredientId = Number(ingredient?.ingredientId);
      if (!Number.isFinite(ingredientId)) return acc;
      acc.set(ingredientId, (acc.get(ingredientId) || 0) + 1);
      return acc;
    }, new Map<number, number>());
    const occurrenceMap = new Map<number, number>();

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
      const displayedAmount = isSharedRecipeIngredientEdit
        ? sharedParticipants.reduce((sum: number, entry: any) => (
          sum + calculateScaledAmount(ingredientForScaling as any, Number(entry?.servings) || 1, recipeServings)
        ), 0)
        : calculateScaledAmount(ingredientForScaling as any, entryServings, recipeServings);

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
    const addonStep = getAddonBaseAmount(addon);
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

  const saveIngredients = () => {
    if (!viewingMeal || !viewingRecipe) return;

    const ingredientsData = editingMealIngredients
      .filter(i => i.ingredientId > 0)
      .map(i => ({
        ingredientId: Number(i.ingredientId),
        amount: Number(i.amount) || 0,
        scalingType: i.scalingType || "LINEAR",
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
        amount: Number(ingredient.amount) * recipeServings / batchServings,
        scalingType: "LINEAR",
      }));
      const perPersonIngredients = splitBatchIngredientAmounts(ingredientsData, participants, batchServings)
        .map((ingredientShare, index) => [
          ...ingredientShare,
          ...getAdditionalMealIngredients(participants[index].ingredients || [], viewingRecipe.ingredients || []),
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
        weekDateStrings.forEach((date) => queryClient.invalidateQueries({ queryKey: [`/api/meal-plan/${date}`] }));
        setIsEditingIngredients(false);
        setViewingRecipe(null);
        setViewingMeal(null);
        setViewingServings(undefined);
        setIsSharedRecipeView(false);
        setViewingSharedBatchId(null);
        toast({ title: "Sukces", description: "Zapisano składniki partii i rozdzielono je według liczby porcji." });
      }).catch((error: Error) => {
        toast({ title: "Błąd", description: error.message || "Nie udało się zapisać składników wspólnej partii.", variant: "destructive" });
      });
      return;
    }

    if (viewingMeal?.sharedParticipantEntries) {
      const totalSharedServings = participants.reduce((sum: number, entry: any) => sum + (Number(entry?.servings) || 0), 0);

      if (participants.length > 0 && totalSharedServings > 0) {
        const splitIngredients = splitSharedIngredientsByServings(
          ingredientsData,
          participants,
          Number(viewingRecipe.servings) || 1,
        )
          .map((ingredientShare, index) => [
            ...ingredientShare,
            // Keep additions for this person out of the shared recipe edit.
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
          setIsEditingIngredients(false);
          setViewingRecipe(null);
          setViewingMeal(null);
          setViewingServings(undefined);
          setViewingSharedPerson("A");
          setIsSharedRecipeView(false);
          setViewingSharedBatchId(null);
          toast({ title: "Zapisano", description: "Składniki przepisu podzielono na porcje, a osobiste dodatki pozostały przy swoich osobach." });
        }).catch((error: Error) => {
          toast({ title: "Błąd", description: error.message || "Nie udało się zapisać wspólnych składników.", variant: "destructive" });
        });
        return;
      }
    }

    if (!viewingMeal?.id && isSharedRecipeView && viewingSharedBatchId) {
      // A batch edit describes the entire cooked batch. Store the corresponding
      // recipe-base amount so each later allocation still scales to its portion.
      const recipeServings = Number(viewingRecipe.servings) || 1;
      const entryServings = Number(viewingMeal.servings) || 1;
      const batchIngredients = editingMealIngredients
        .filter((item) => item.ingredientId > 0)
        .map((item) => ({
          ingredientId: Number(item.ingredientId),
          amount: (Number(item.amount) || 0) * recipeServings / entryServings,
          scalingType: "LINEAR" as const,
        }));
      updateBatch.mutate({ id: viewingSharedBatchId, updates: { ingredients: batchIngredients } }, {
        onSuccess: () => {
          setViewingMeal((prev: any) => (prev ? { ...prev, ingredients: ingredientsData } : prev));
          setIsEditingIngredients(false);
          toast({ title: "Zapisano", description: "Składniki wspólnego przepisu zostały zapisane dla tej partii." });
        },
      });
      return;
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
        setIsEditingIngredients(false);
        setViewingRecipe(null);
        setViewingMeal(null);
        setViewingServings(undefined);
      }
    });
  };

  const getEditedSharedParticipantEntries = (meal: any) => {
    if (!meal?.sharedParticipantEntries) return [];

    return [meal.sharedParticipantEntries.A, meal.sharedParticipantEntries.B]
      .filter((entry: any) => entry?.id && hasEditedMealIngredients(entry));
  };

  const restoreSharedParticipantIngredients = async () => {
    const editedParticipants = getEditedSharedParticipantEntries(viewingMeal);
    if (editedParticipants.length === 0) return false;

    const shouldRestore = window.confirm(
      `Oddzielne porcje ${editedParticipants.length === 1 ? "mają już własną edycję składników" : "mają już własne edycje składników"}. Żeby edytować wspólny przepis, najpierw trzeba cofnąć edycje oddzielnych porcji. Cofnąć je teraz?`
    );

    if (!shouldRestore) return false;

    try {
      await Promise.all(editedParticipants.map((entry: any) => updateMealEntryAsync({
        id: entry.id,
        updates: {
          ingredients: restoreRecipeIngredientsPreservingAdditions(entry.ingredients || [], entry.recipe?.ingredients || []),
          isEaten: !!entry.isEaten,
          date: entry.date,
          mealType: entry.mealType,
        },
      })));

      const resetEntry = (entry: any) => entry?.id && editedParticipants.some((edited: any) => Number(edited.id) === Number(entry.id))
        ? { ...entry, ingredients: restoreRecipeIngredientsPreservingAdditions(entry.ingredients || [], entry.recipe?.ingredients || []) }
        : entry;
      const nextParticipantEntries = viewingMeal?.sharedParticipantEntries ? {
        A: resetEntry(viewingMeal.sharedParticipantEntries.A),
        B: resetEntry(viewingMeal.sharedParticipantEntries.B),
      } : null;
      const nextSharedIngredients = nextParticipantEntries ? buildSharedIngredientsSummary({
        entriesA: nextParticipantEntries.A ? [nextParticipantEntries.A] : [],
        entriesB: nextParticipantEntries.B ? [nextParticipantEntries.B] : [],
        recipe: viewingRecipe || viewingMeal?.recipe,
      }) : [];
      const nextServings = nextParticipantEntries
        ? [nextParticipantEntries.A, nextParticipantEntries.B]
          .reduce((sum: number, entry: any) => sum + (Number(entry?.servings) || 0), 0)
        : 0;

      if (nextServings > 0) {
        setViewingServings(nextServings);
      }
      setViewingMeal((prev: any) => {
        if (!prev?.sharedParticipantEntries || !nextParticipantEntries) return prev;

        return {
          ...prev,
          servings: nextServings > 0 ? nextServings : prev.servings,
          ingredients: nextSharedIngredients,
          sharedParticipantEntries: nextParticipantEntries,
        };
      });
      toast({ title: "Sukces", description: "Cofnięto edycje oddzielnych porcji. Możesz teraz ponownie wybrać edycję wspólnego przepisu." });
      return true;
    } catch (error: any) {
      toast({ title: "Błąd", description: error?.message || "Nie udało się cofnąć edycji oddzielnych porcji.", variant: "destructive" });
      return false;
    }
  };

  const startEditingSharedIngredients = () => {
    if (getEditedSharedParticipantEntries(viewingMeal).length > 0) {
      void restoreSharedParticipantIngredients();
      return;
    }

    startEditing();
  };

  const restoreOriginalIngredients = () => {
    if (isSharedRecipeView && viewingMeal?.sharedParticipantEntries) {
      void restoreSharedParticipantIngredients();
      return;
    }

    if (!viewingMeal?.id) return;

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
        setViewingMeal((prev: any) => prev ? {
          ...prev,
          ingredients: restoreRecipeIngredientsPreservingAdditions(prev.ingredients || [], prev.recipe?.ingredients || []),
        } : prev);
        toast({ title: "Sukces", description: "Przywrócono domyślne składniki z przepisu." });
      },
    });
  };

  const allTags = useMemo(() => {
    if (!recipes) return [];
    const tags = new Set<string>();
    recipes.forEach(r => r.tags?.forEach((t: string) => tags.add(t)));
    return Array.from(tags).sort();
  }, [recipes]);

  const filteredRecipes = useMemo(() => {
    if (!recipes) return [];
    const normalizedQuery = normalizeSearchText(searchQuery);

    const getPerServingNutrient = (recipe: any, nutrient: "calories" | "protein" | "carbs" | "fat") => (
      getRecipeNutritionAtServings(recipe, 1)[nutrient]
    );

    return recipes.filter(recipe => {
      const ingredientNames = [
        ...(recipe.ingredients || []).map((ri: any) => ri.ingredient?.name),
        ...(recipe.frequentAddons || []).map((addon: any) => addon.ingredient?.name),
      ];
      const matchesSearch = !normalizedQuery
        || normalizeSearchText(recipe.name).includes(normalizedQuery)
        || ingredientNames.some((name) => normalizeSearchText(name).includes(normalizedQuery));
      const matchesTag = !selectedTag || recipe.tags?.includes(selectedTag);
      return matchesSearch && matchesTag;
    }).sort((a: any, b: any) => {
      switch (recipeSort) {
        case "calories-asc":
          return getPerServingNutrient(a, "calories") - getPerServingNutrient(b, "calories");
        case "calories-desc":
          return getPerServingNutrient(b, "calories") - getPerServingNutrient(a, "calories");
        case "protein-desc":
          return getPerServingNutrient(b, "protein") - getPerServingNutrient(a, "protein");
        case "carbs-desc":
          return getPerServingNutrient(b, "carbs") - getPerServingNutrient(a, "carbs");
        case "fat-desc":
          return getPerServingNutrient(b, "fat") - getPerServingNutrient(a, "fat");
        default: {
          const eatCountA = Number(a?.stats?.eatCount) || 0;
          const eatCountB = Number(b?.stats?.eatCount) || 0;
          if (eatCountA !== eatCountB) return eatCountB - eatCountA;
          return String(a?.name || "").localeCompare(String(b?.name || ""), "pl");
        }
      }
    });
  }, [recipes, searchQuery, selectedTag, recipeSort]);

  const handleOpenAdd = (mealType: string, dateStr: string, person: "A" | "B") => {
    setSelectedMealType(mealType);
    setSelectedDateStr(dateStr);
    setSearchQuery("");
    setSelectedTag(null);
    setRecipeSort("popular");
    setSelectedPerson(person);
    setSelectedRecipeToAdd(null);
    setSelectedRecommendedBatchId(null);
    setSelectedFrequentAddons({ A: {}, B: {} });
    setAddRecipeForBothPeople(true);
    setSelectedRecipeServings(1);
    setSelectedPersonServings({ A: 1, B: 1 });
    setSelectedSuggestedRecipes({});
    setIsAddOpen(true);
  };

  const handleOpenCustom = (mealType: string, dateStr: string, person: "A" | "B") => {
    setSelectedMealType(mealType);
    setSelectedDateStr(dateStr);
    setSelectedPerson(person);
    setIsCustomOpen(true);
  };

  const handleOpenIngredient = (mealType: string, dateStr: string, person: "A" | "B") => {
    setSelectedMealType(mealType);
    setSelectedDateStr(dateStr);
    setIngredientSearch("");
    setSelectedIngredientId(null);
    setIngredientAmount(100);
    setIngredientDialogDragY(0);
    setIsIngredientDialogExpanded(false);
    setIsIngredientDialogDragging(false);
    ingredientDialogDragStartYRef.current = null;
    setSelectedPerson(person);
    setIsIngredientOpen(true);
  };

  const startIngredientDialogDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    ingredientDialogDragStartYRef.current = event.clientY;
    setIsIngredientDialogDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveIngredientDialogDrag = (event: PointerEvent<HTMLDivElement>) => {
    const startY = ingredientDialogDragStartYRef.current;
    if (startY === null) return;
    setIngredientDialogDragY(Math.max(-120, Math.min(280, event.clientY - startY)));
  };

  const finishIngredientDialogDrag = (event: PointerEvent<HTMLDivElement>) => {
    const startY = ingredientDialogDragStartYRef.current;
    if (startY === null) return;
    const deltaY = event.clientY - startY;
    ingredientDialogDragStartYRef.current = null;
    setIsIngredientDialogDragging(false);
    setIngredientDialogDragY(0);
    if (deltaY > 160) {
      setIsIngredientOpen(false);
    } else if (deltaY > 60) {
      setIsIngredientDialogExpanded(false);
    } else if (deltaY < -60) {
      setIsIngredientDialogExpanded(true);
    }
  };

  const closeAddDialog = () => {
    isAddingRecipeRef.current = false;
    setIsAddingRecipe(false);
    setIsAddOpen(false);
    setSelectedMealType(null);
    setSelectedDateStr(null);
    setSelectedRecipeToAdd(null);
    setSelectedRecommendedBatchId(null);
    setSelectedFrequentAddons({ A: {}, B: {} });
    setAddRecipeForBothPeople(false);
    setSelectedRecipeServings(1);
    setSelectedSuggestedRecipes({});
  };

  const getSelectedAddonsForPerson = (recipe: any, person: "A" | "B") => {
    return (recipe?.frequentAddons || [])
      .map((addon: any) => ({
        ...addon,
        amount: Number(selectedFrequentAddons?.[person]?.[addon.ingredientId] || 0),
      }))
      .filter((addon: any) => addon.amount > 0);
  };

  const suggestedRecipeOptionsForAdd = useMemo(() => {
    if (!selectedRecipeToAdd) return [] as { recipe: any; servings: number }[];

    const structured = (selectedRecipeToAdd?.suggestedRecipes || [])
      .map((item: any) => ({ recipeId: Number(item?.recipeId), servings: Number(item?.servings) || 1 }))
      .filter((item: any) => Number.isFinite(item.recipeId) && item.recipeId > 0);

    const legacy = (selectedRecipeToAdd?.suggestedRecipeIds || [])
      .map((id: any) => ({ recipeId: Number(id), servings: 1 }))
      .filter((item: any) => Number.isFinite(item.recipeId) && item.recipeId > 0);

    const entries = structured.length > 0 ? structured : legacy;
    return entries
      .map((entry: any) => ({
        recipe: (recipes || []).find((candidate: any) => Number(candidate?.id) === Number(entry.recipeId)),
        servings: entry.servings,
      }))
      .filter((entry: any) => !!entry.recipe);
  }, [selectedRecipeToAdd, recipes]);

  const selectedRecipeNutritionPreview = useMemo(() => {
    if (!selectedRecipeToAdd) return null;
    const calculateForPerson = (person: "A" | "B", servings: number) => {
      const totals = isIndividualVariantRecipe(selectedRecipeToAdd)
        ? (selectedRecipeToAdd?.ingredients || []).reduce((sum: any, ri: any) => {
            if (!ri?.ingredient) return sum;
            const variant = selectedPortionVariants[person];
            const amount = Math.max(0, Number(ri[`variantAmount${variant}`]) || 0);
            const nutritionAmount = calculateNutritionAmount(amount, ri.ingredient);
            const multiplier = nutritionAmount / 100;
            return {
              calories: sum.calories + (Number(ri.ingredient.calories) || 0) * multiplier,
              protein: sum.protein + (Number(ri.ingredient.protein) || 0) * multiplier,
              carbs: sum.carbs + (Number(ri.ingredient.carbs) || 0) * multiplier,
              fat: sum.fat + (Number(ri.ingredient.fat) || 0) * multiplier,
            };
          }, { calories: 0, protein: 0, carbs: 0, fat: 0 })
        : getRecipeNutritionAtServings(selectedRecipeToAdd, servings);

      (selectedRecipeToAdd?.frequentAddons || []).forEach((addon: any) => {
        if (!addon?.ingredient) return;
        const amount = Math.max(0, Number(selectedFrequentAddons?.[person]?.[Number(addon.ingredientId)] || 0));
        const nutritionAmount = calculateNutritionAmount(amount, addon.ingredient);
        const multiplier = nutritionAmount / 100;
        totals.calories += (Number(addon.ingredient.calories) || 0) * multiplier;
        totals.protein += (Number(addon.ingredient.protein) || 0) * multiplier;
        totals.carbs += (Number(addon.ingredient.carbs) || 0) * multiplier;
        totals.fat += (Number(addon.ingredient.fat) || 0) * multiplier;
      });

      return {
        servings,
        calories: Math.round(totals.calories),
        protein: Math.round(totals.protein),
        carbs: Math.round(totals.carbs),
        fat: Math.round(totals.fat),
      };
    };

    const servingsForPerson = (person: "A" | "B") => {
      if (!addRecipeForBothPeople) return person === selectedPerson ? selectedRecipeServings : 0;
      return selectedPersonServings[person];
    };

    return {
      A: calculateForPerson("A", servingsForPerson("A")),
      B: calculateForPerson("B", servingsForPerson("B")),
    };
  }, [
    selectedRecipeToAdd,
    selectedRecipeServings,
    selectedPersonServings,
    selectedPerson,
    addRecipeForBothPeople,
    selectedFrequentAddons,
  ]);

  const selectedIngredientForQuickAdd = useMemo(
    () => (allAvailableIngredients || []).find((i: any) => i.id === selectedIngredientId) || null,
    [allAvailableIngredients, selectedIngredientId],
  );

  const selectedIngredientNutritionPreview = useMemo(() => {
    if (!selectedIngredientForQuickAdd || ingredientAmount <= 0) return null;
    const factor = ingredientAmount / 100;
    return {
      calories: Math.round((Number(selectedIngredientForQuickAdd?.calories) || 0) * factor),
      protein: Number((((Number(selectedIngredientForQuickAdd?.protein) || 0) * factor)).toFixed(1)),
      carbs: Number((((Number(selectedIngredientForQuickAdd?.carbs) || 0) * factor)).toFixed(1)),
      fat: Number((((Number(selectedIngredientForQuickAdd?.fat) || 0) * factor)).toFixed(1)),
    };
  }, [selectedIngredientForQuickAdd, ingredientAmount]);

  const handleAdd = (recipeId: number, recipe?: any, createSharedBatchOverride?: boolean) => {
    if (!selectedMealType || !selectedDateStr) return;
    const shouldCreateSharedBatch = createSharedBatchOverride ?? false;
    if (isAddingRecipeRef.current) return;

    isAddingRecipeRef.current = true;
    setIsAddingRecipe(true);
    const unlockRecipeAddition = () => {
      isAddingRecipeRef.current = false;
      setIsAddingRecipe(false);
    };
    const getServingsForPerson = (person: "A" | "B") => {
      if (!recipe) return selectedRecipeServings;
      if (!addRecipeForBothPeople) return selectedRecipeServings;
      return selectedPersonServings[person];
    };

    const createEntryWithAddons = (person: "A" | "B", onSuccess?: () => void) => addEntry({
      date: selectedDateStr,
      recipeId,
      mealType: selectedMealType,
      person,
      isEaten: false,
      servings: isIndividualVariantRecipe(recipe) ? 1 : getServingsForPerson(person),
      ...(isIndividualVariantRecipe(recipe) ? { portionVariant: selectedPortionVariants[person] } : {}),
      createSharedBatch: isIndividualVariantRecipe(recipe) ? false : shouldCreateSharedBatch,
      sharedBatchServings: shouldCreateSharedBatch ? Number(recipe?.servings) || undefined : undefined,
    }, {
      onError: unlockRecipeAddition,
      onSuccess: async (entry) => {
        const selectedAddons = getSelectedAddonsForPerson(recipe, person);

        if (!recipe || selectedAddons.length === 0) {
          const selectedSuggestions = suggestedRecipeOptionsForAdd
            .filter((item: any) => Number(selectedSuggestedRecipes[String(item.recipe.id)] || 0) > 0)
            .map((item: any) => ({ recipeId: Number(item.recipe.id), servings: Number(selectedSuggestedRecipes[String(item.recipe.id)] || 0) }));
          for (const suggestion of selectedSuggestions) {
            await new Promise<void>((resolve) => {
              addEntry({
                date: selectedDateStr,
                recipeId: suggestion.recipeId,
                mealType: selectedMealType,
                person,
                isEaten: false,
                servings: suggestion.servings,
                createSharedBatch: shouldCreateSharedBatch,
                sharedBatchServings: shouldCreateSharedBatch ? Number(recipe?.servings) || undefined : undefined,
              }, { onSuccess: () => resolve(), onError: () => resolve() });
            });
          }
          onSuccess?.();
          return;
        }

        const selectedVariant = selectedPortionVariants[person];
        const mergedIngredients = (recipe.ingredients || []).map((ri: any) => ({
          ingredientId: ri.ingredientId,
          amount: recipe.portioningMode === "individual"
            ? (Number(ri[`variantAmount${selectedVariant}`]) || 0)
            : (Number(ri.baseAmount ?? ri.amount) || 0),
          scalingType: ri.scalingType || "LINEAR",
        })).filter((ri: any) => Number(ri.amount) > 0);

        selectedAddons.forEach((addon: any) => {
          mergedIngredients.push({
            ingredientId: addon.ingredientId,
            amount: Number(addon.amount) || 0,
            scalingType: "FIXED",
          });
        });

        updateMealEntry({
          id: entry.id,
          updates: {
            ingredients: mergedIngredients,
            servings: isIndividualVariantRecipe(recipe) ? 1 : getServingsForPerson(person),
          },
        }, {
          onError: unlockRecipeAddition,
          onSuccess: async () => {
            const selectedSuggestions = suggestedRecipeOptionsForAdd
              .filter((item: any) => Number(selectedSuggestedRecipes[String(item.recipe.id)] || 0) > 0)
              .map((item: any) => ({ recipeId: Number(item.recipe.id), servings: Number(selectedSuggestedRecipes[String(item.recipe.id)] || 0) }));
            for (const suggestion of selectedSuggestions) {
              await new Promise<void>((resolve) => {
                addEntry({
                  date: selectedDateStr,
                  recipeId: suggestion.recipeId,
                  mealType: selectedMealType,
                  person,
                  isEaten: false,
                  servings: suggestion.servings,
                  createSharedBatch: shouldCreateSharedBatch,
                  sharedBatchServings: shouldCreateSharedBatch ? Number(recipe?.servings) || undefined : undefined,
                }, { onSuccess: () => resolve(), onError: () => resolve() });
              });
            }
            onSuccess?.();
          },
        });
      }
    });

    if (addRecipeForBothPeople) {
      const otherPerson: "A" | "B" = selectedPerson === "A" ? "B" : "A";
      createEntryWithAddons(selectedPerson, () => {
        createEntryWithAddons(otherPerson, closeAddDialog);
      });
      return;
    }

    createEntryWithAddons(selectedPerson, closeAddDialog);
  };

  const requestAddRecipe = (recipeId: number, recipe: any) => {
    if (isAddingRecipeRef.current) return;
    if (isIndividualVariantRecipe(recipe)) {
      handleAdd(recipeId, recipe, false);
      return;
    }
    const recipeServings = Number(recipe?.servings) || 1;
    const plannedServings = addRecipeForBothPeople
      ? Number(selectedPersonServings.A || 0) + Number(selectedPersonServings.B || 0)
      : Number(selectedRecipeServings) || 0;

    if (recipeServings > plannedServings + 1e-9) {
      setPendingSharedBatchPrompt({ recipeId, recipe });
      return;
    }

    handleAdd(recipeId, recipe);
  };



  const increaseAddonAmount = (addon: any, person: "A" | "B") => {
    const addonStep = getAddonBaseAmount(addon);
    if (addonStep <= 0) return;

    setSelectedFrequentAddons((prev) => ({
      ...prev,
      [person]: {
        ...(prev?.[person] || {}),
        [addon.ingredientId]: ((prev?.[person] || {})[addon.ingredientId] || 0) + addonStep,
      },
    }));
  };

  const decreaseAddonAmount = (addon: any, person: "A" | "B") => {
    const addonStep = getAddonBaseAmount(addon);
    if (addonStep <= 0) return;

    setSelectedFrequentAddons((prev) => {
      const personAddons = prev?.[person] || {};
      const current = personAddons[addon.ingredientId] || 0;
      const nextAmount = Math.max(0, current - addonStep);
      if (nextAmount === 0) {
        const { [addon.ingredientId]: _removed, ...rest } = personAddons;
        return {
          ...prev,
          [person]: rest,
        };
      }

      return {
        ...prev,
        [person]: {
          ...personAddons,
          [addon.ingredientId]: nextAmount,
        },
      };
    });
  };

  const setAddonAmount = (ingredientId: number, amount: number, person: "A" | "B") => {
    setSelectedFrequentAddons((prev) => {
      const personAddons = prev?.[person] || {};
      const nextAmount = Math.max(0, Math.round(amount));
      if (nextAmount === 0) {
        const { [ingredientId]: _removed, ...rest } = personAddons;
        return {
          ...prev,
          [person]: rest,
        };
      }

      return {
        ...prev,
        [person]: {
          ...personAddons,
          [ingredientId]: nextAmount,
        },
      };
    });
  };

  const handleAddCustom = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    if (!selectedMealType || !selectedDateStr) return;

    addEntry({
      date: selectedDateStr,
      mealType: selectedMealType,
      person: selectedPerson,
      customName: formData.get("name") as string,
      customCalories: parseInt(formData.get("calories") as string),
      customProtein: parseFloat(formData.get("protein") as string),
      customCarbs: parseFloat(formData.get("carbs") as string),
      customFat: parseFloat(formData.get("fat") as string),
      isEaten: true,
      recipeId: null as any,
    }, {
      onSuccess: () => {
        setIsCustomOpen(false);
        setSelectedMealType(null);
        setSelectedDateStr(null);
      }
    });
  };

  const handleAddIngredient = () => {
    if (!selectedMealType || !selectedDateStr || !selectedIngredientId || ingredientAmount <= 0 || !allAvailableIngredients) return;

    const ingredient = allAvailableIngredients.find((i: any) => i.id === selectedIngredientId);
    if (!ingredient) return;

    const factor = ingredientAmount / 100;

    addEntry({
      date: selectedDateStr,
      mealType: selectedMealType,
      person: selectedPerson,
      customName: ingredient.name,
      customCalories: Math.round((ingredient.calories || 0) * factor),
      customProtein: Number(((ingredient.protein || 0) * factor).toFixed(1)),
      customCarbs: Number(((ingredient.carbs || 0) * factor).toFixed(1)),
      customFat: Number(((ingredient.fat || 0) * factor).toFixed(1)),
      customSugar: Number(((ingredient.sugar || 0) * factor).toFixed(1)),
      customFiber: Number(((ingredient.fiber || 0) * factor).toFixed(1)),
      servings: 1,
      isEaten: false,
      recipeId: null as any,
    }, {
      onSuccess: (entry) => {
        updateMealEntry({
          id: entry.id,
          updates: {
            ingredients: [{ ingredientId: selectedIngredientId, amount: Math.round(ingredientAmount) }],
            servings: 1,
          },
        }, {
          onSuccess: () => {
            setIsIngredientOpen(false);
            setSelectedMealType(null);
            setSelectedDateStr(null);
          }
        });
      }
    });
  };

  const handleCopyDay = () => {
    if (!copySourceDate || !copyTargetDate) {
      toast({ title: "Błąd", description: "Wybierz dzień źródłowy i docelowy.", variant: "destructive" });
      return;
    }

    if (copySourceDate === copyTargetDate) {
      toast({ title: "Błąd", description: "Wybierz różne dni.", variant: "destructive" });
      return;
    }

    copyDayPlan({ sourceDate: copySourceDate, targetDate: copyTargetDate }, {
      onSuccess: () => setIsCopyDayOpen(false),
    });
  };

  const openCopyDayDialog = (sourceDate: string) => {
    setCopySourceDate(sourceDate);
    setCopyTargetDate(format(addDays(new Date(`${sourceDate}T00:00:00`), 1), "yyyy-MM-dd"));
    setIsCopyDayOpen(true);
  };


  const getAllocationForm = (batchId: number) => allocationForms[batchId] || {
    date: format(new Date(), "yyyy-MM-dd"),
    mealType: "lunch",
    person: "A" as "A" | "B",
    servings: 1,
  };

  const updateAllocationForm = (batchId: number, updates: Partial<{ date: string; mealType: string; person: "A" | "B"; servings: number }>) => {
    setAllocationForms((prev) => ({
      ...prev,
      [batchId]: { ...getAllocationForm(batchId), ...updates },
    }));
  };

  const getBatchBaseIngredients = (batch: any) => {
    const sourceIngredients = batch?.recipe?.ingredients || [];
    const allocatedByPerson = (batch?.mealEntries || []).reduce((acc: { A: number; B: number }, entry: any) => {
      const person = entry?.person === "B" ? "B" : "A";
      acc[person] += Number(entry?.servings) || 0;
      return acc;
    }, { A: 0, B: 0 });
    const allocatedServings = allocatedByPerson.A + allocatedByPerson.B;
    const totalServings = Number(batch?.totalServings) || Number(batch?.recipe?.servings) || 1;
    const recipeServings = Number(batch?.recipe?.servings) || 1;
    const occurrenceMap = new Map<number, number>();

    return sourceIngredients.map((ri: any) => {
      const ingredientId = Number(ri.ingredientId);
      const occurrence = (occurrenceMap.get(ingredientId) || 0) + 1;
      occurrenceMap.set(ingredientId, occurrence);
      const recipeIngredientCandidates = (batch?.recipe?.ingredients || []).filter((item: any) => Number(item?.ingredientId) === ingredientId);
      const frequentAddonCandidates = (batch?.recipe?.frequentAddons || []).filter((item: any) => Number(item?.ingredientId) === ingredientId);
      const fallbackSource = [...recipeIngredientCandidates, ...frequentAddonCandidates][occurrence - 1]
        || recipeIngredientCandidates[0]
        || frequentAddonCandidates[0]
        || {};

      const baseAmount = Number(ri.baseAmount ?? ri.amount ?? fallbackSource.baseAmount ?? fallbackSource.amount) || 0;
      const scalingIngredient = {
        ...fallbackSource,
        ...ri,
        baseAmount,
        scalingType: ri.scalingType || fallbackSource.scalingType || "LINEAR",
        scalingFormula: ri.scalingFormula ?? fallbackSource.scalingFormula,
        stepThresholds: ri.stepThresholds ?? fallbackSource.stepThresholds,
      };
      const amountForServings = (servings: number) => calculateScaledAmount(scalingIngredient, servings, recipeServings);
      const calculatedAmount = allocatedServings > 0
        ? (batch?.mealEntries || []).reduce((sum: number, entry: any) => sum + amountForServings(Number(entry?.servings) || 0), 0)
        : amountForServings(totalServings);
      const sharedAddonAmounts = allocatedServings > 0
        ? {
          A: (batch?.mealEntries || [])
            .filter((entry: any) => (entry?.person === "B" ? "B" : "A") === "A")
            .reduce((sum: number, entry: any) => sum + amountForServings(Number(entry?.servings) || 0), 0),
          B: (batch?.mealEntries || [])
            .filter((entry: any) => (entry?.person === "B" ? "B" : "A") === "B")
            .reduce((sum: number, entry: any) => sum + amountForServings(Number(entry?.servings) || 0), 0),
        }
        : undefined;

      return {
        ...fallbackSource,
        ...ri,
        ingredientId,
        ingredient: ri.ingredient || fallbackSource.ingredient || null,
        amount: baseAmount,
        baseAmount,
        calculatedAmount,
        unit: ri.unit || fallbackSource.unit || ri.ingredient?.unit || fallbackSource.ingredient?.unit || "g",
        alternativeAmount: ri.alternativeAmount ?? fallbackSource.alternativeAmount,
        alternativeUnit: ri.alternativeUnit ?? fallbackSource.alternativeUnit,
        scalingType: scalingIngredient.scalingType,
        scalingFormula: scalingIngredient.scalingFormula,
        stepThresholds: scalingIngredient.stepThresholds,
        sharedAddonAmounts,
      };
    });
  };

  const allocateFromBatch = (batch: any) => {
    const form = getAllocationForm(batch.id);
    const person = form.person;
    const servings = Math.max(0.25, Number(form.servings) || 1);
    const addonsForPerson = selectedFrequentAddons[person] || {};

    if (servings > Number(batch.remainingServings || 0)) {
      toast({ title: "Za dużo", description: "Liczba porcji przekracza pulę pozostałych porcji.", variant: "destructive" });
      return;
    }

    addEntry({
      date: form.date,
      recipeId: Number(batch.recipeId),
      mealType: form.mealType,
      person,
      servings,
      cookedBatchId: Number(batch.id),
    } as any, {
      onSuccess: async (entry) => {
        const selectedAddons = (batch?.recipe?.frequentAddons || [])
          .map((addon: any) => ({
            ingredientId: Number(addon.ingredientId),
            amount: Number(addonsForPerson[addon.ingredientId] || 0),
          }))
          .filter((addon: any) => addon.amount > 0);

        const baseIngredients = getBatchBaseIngredients(batch);
        const addonIngredients = selectedAddons.map((addon: any) => ({
          ...addon,
          scalingType: "FIXED",
        }));

        if (selectedAddons.length === 0) {
          queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
          toast({ title: "Dodano", description: "Porcje zostały dodane do planu." });
          return;
        }

        updateMealEntry({
          id: entry.id,
          updates: {
            ingredients: [...baseIngredients, ...addonIngredients],
            servings,
          },
        }, {
          onSuccess: () => {
            setSelectedFrequentAddons((prev) => ({
              ...prev,
              [person]: {},
            }));
            queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
            toast({ title: "Dodano", description: "Porcje i dodatki zostały dodane do planu." });
          },
        });
      },
    });
  };

  const recommendedSharedBatches = useMemo(() => {
    if (!selectedDateStr || !selectedMealType) return [] as any[];
    return (sharedBatches || [])
      .filter((batch: any) => Number(batch?.remainingServings || 0) > 0)
      .slice(0, 4);
  }, [sharedBatches, selectedDateStr, selectedMealType]);

  const addRecommendedBatchToPlan = (batch: any) => {
    if (!selectedDateStr || !selectedMealType) return;
    const preferredServings = getRecipeDefaultServingsForPerson(batch?.recipe, selectedPerson);
    const remaining = Number(batch?.remainingServings || 0);
    const servings = Math.max(0.25, Math.min(preferredServings, remaining));
    const addonsForPerson = selectedFrequentAddons[selectedPerson] || {};

    if (servings > remaining) {
      toast({ title: "Za dużo", description: "Liczba porcji przekracza pulę pozostałych porcji.", variant: "destructive" });
      return;
    }

    addEntry({
      date: selectedDateStr,
      mealType: selectedMealType,
      person: selectedPerson,
      recipeId: Number(batch.recipeId),
      cookedBatchId: Number(batch.id),
      servings,
      isEaten: false,
    } as any, {
      onSuccess: (entry) => {
        const selectedAddons = (batch?.recipe?.frequentAddons || [])
          .map((addon: any) => ({
            ingredientId: Number(addon.ingredientId),
            amount: Number(addonsForPerson[addon.ingredientId] || 0),
          }))
          .filter((addon: any) => addon.amount > 0);

        const baseIngredients = getBatchBaseIngredients(batch);
        const addonIngredients = selectedAddons.map((addon: any) => ({
          ...addon,
          scalingType: "FIXED",
        }));

        if (addonIngredients.length === 0) {
          queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
          toast({ title: "Dodano", description: "Dodano polecaną porcję ze wspólnego gotowania." });
          closeAddDialog();
          return;
        }

        updateMealEntry({
          id: entry.id,
          updates: {
            ingredients: [...baseIngredients, ...addonIngredients],
            servings,
          },
        }, {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: [api.sharedMeals.list.path] });
            toast({ title: "Dodano", description: "Dodano polecaną porcję i dodatki ze wspólnego gotowania." });
            closeAddDialog();
          },
        });
      },
    });
  };

  const handleRecommendedBatchClick = (batch: any) => {
    const hasAddons = (batch?.recipe?.frequentAddons || []).length > 0;
    if (!hasAddons) {
      addRecommendedBatchToPlan(batch);
      return;
    }

    setSelectedRecipeToAdd(null);
    setSelectedRecommendedBatchId(Number(batch.id));
    setSelectedFrequentAddons(getDefaultFrequentAddonsSelection(batch.recipe));
  };

  const filteredIngredients = useMemo(() => {
    const ingredients = Array.isArray(allAvailableIngredients) ? allAvailableIngredients : [];
    const query = normalizeSearchText(ingredientSearch).replace(/\s+/g, " ");
    const queryTokens = query.split(" ").filter(Boolean);
    if (queryTokens.length === 0) return ingredients;

    return ingredients
      .map((ingredient: any, index: number) => {
        const name = normalizeSearchText(ingredient?.name).replace(/\s+/g, " ");
        const nameWords = name.split(/[\s-]+/);
        if (!queryTokens.every((token) => name.includes(token))) return null;

        const rank = name === query
          ? 0
          : name.startsWith(query)
            ? 1
            : queryTokens.every((token) => nameWords.some((word) => word.startsWith(token)))
              ? 2
              : 3;
        return { ingredient, index, name, rank };
      })
      .filter((match): match is { ingredient: any; index: number; name: string; rank: number } => match !== null)
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "pl") || a.index - b.index)
      .map(({ ingredient }) => ingredient);
  }, [allAvailableIngredients, ingredientSearch]);

  const saveDayAsIdeal = async (date: string) => {
    try {
      const url = buildUrl(api.mealPlan.getDay.path, { date });
      const response = await fetchWithTimeout(url, {}, 15000);
      if (!response.ok) throw new Error(`Nie udało się pobrać dnia ${date}`);
      const day = await response.json();
      const prepTimesByRecipeId = new Map<number, number>();
      (day.entries || []).forEach((entry: any) => {
        const recipeId = Number(entry?.recipeId ?? entry?.recipe?.id ?? entry?.recipeSnapshot?.id);
        const rawPrepTime = entry?.recipe?.prepTime ?? entry?.recipeSnapshot?.prepTime;
        const prepTime = Number(rawPrepTime);
        if (recipeId > 0 && Number.isFinite(recipeId) && !prepTimesByRecipeId.has(recipeId)
          && rawPrepTime != null && Number.isFinite(prepTime) && prepTime >= 0) {
          prepTimesByRecipeId.set(recipeId, prepTime);
        }
      });
      const totalPrepTime = Array.from(prepTimesByRecipeId.values()).reduce((sum, prepTime) => sum + prepTime, 0);
      const entries = (day.entries || []).map((entry: any) => ({
        name: entry.recipe?.name || entry.customName || "Posiłek własny",
        mealType: entry.mealType,
        person: (entry.person || "A") as "A" | "B",
      }));
      const snapshotEntries = (day.entries || []).map((entry: any) => ({
        recipeId: entry.recipeId ?? null,
        recipeSnapshot: entry.recipeSnapshot ?? null,
        recipePrepTime: entry.recipe?.prepTime ?? entry.recipeSnapshot?.prepTime ?? null,
        customName: entry.customName ?? null,
        customCalories: entry.customCalories ?? null,
        customProtein: entry.customProtein ?? null,
        customCarbs: entry.customCarbs ?? null,
        customFat: entry.customFat ?? null,
        customSugar: entry.customSugar ?? 0,
        customFiber: entry.customFiber ?? 0,
        mealType: String(entry.mealType || "lunch"),
        person: entry.person === "B" ? "B" : "A",
        servings: Math.max(0.1, Number(entry.servings) || 1),
        ingredients: (entry.ingredients || [])
          .map((ingredient: any) => ({
            ingredientId: Number(ingredient.ingredientId),
            amount: Number(ingredient.amount) || 0,
            scalingType: ingredient.scalingType || "LINEAR",
          }))
          .filter((ingredient: any) => Number.isFinite(ingredient.ingredientId) && ingredient.ingredientId > 0),
      }));
      const idealDay = {
        id: `${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sourceDate: date,
        totalPrice: Number(day.totalPrice) || 0,
        totalPrepTime,
        entries,
        snapshotEntries,
        createdAt: new Date().toISOString(),
      };
      const localKey = "ideal-meal-plan-days-v1";
      const raw = localStorage.getItem(localKey);
      let localDays: any[] = [];
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        localDays = Array.isArray(parsed) ? parsed : [];
      } catch {
        localDays = [];
      }
      localStorage.setItem(localKey, JSON.stringify([idealDay, ...localDays]));
      const stateUrl = buildUrl(api.appState.append.path, { key: localKey });
      const saveResponse = await fetchWithTimeout(stateUrl, {
        method: api.appState.append.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: idealDay }),
      });
      if (!saveResponse.ok) throw new Error("Zapisano kopię lokalnie, ale nie udało się zsynchronizować idealnego dnia z serwerem.");
      const savedState = await saveResponse.json();
      if (Array.isArray(savedState?.data)) localStorage.setItem(localKey, JSON.stringify(savedState.data));
      toast({ title: "Dodano", description: "Dzień zapisano jako idealny i będzie dostępny także na innym urządzeniu." });
    } catch (error: any) {
      toast({ title: "Błąd", description: error?.message || "Nie udało się zapisać idealnego dnia.", variant: "destructive" });
    }
  };

  const exportWeekToPdf = async () => {
    try {
      const dayPlans = await Promise.all(
        weekDays.map(async (day) => {
          const date = format(day, "yyyy-MM-dd");
          const url = buildUrl(api.mealPlan.getDay.path, { date });
          const response = await fetchWithTimeout(url, {}, 15000);
          if (!response.ok) throw new Error(`Nie udało się pobrać dnia ${date}`);
          const dayPlan = await response.json();
          return { date, day, entries: dayPlan?.entries || [] };
        }),
      );

      const canvas = document.createElement("canvas");
      canvas.width = 1800;
      canvas.height = 1200;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Brak kontekstu Canvas");

      const mealRows = [
        { key: "breakfast", label: "Śniadanie" },
        { key: "snack", label: "Lunch" },
        { key: "lunch", label: "Obiad" },
        { key: "dinner", label: "Kolacja" },
      ] as const;
      const personLabel = { A: "Tysia", B: "Mati" } as const;

      const wrapText = (text: string, maxWidth: number) => {
        const words = text.split(" ");
        const lines: string[] = [];
        let current = "";
        for (const word of words) {
          const candidate = current ? `${current} ${word}` : word;
          if (ctx.measureText(candidate).width <= maxWidth) {
            current = candidate;
          } else {
            if (current) lines.push(current);
            current = word;
          }
        }
        if (current) lines.push(current);
        return lines;
      };

      const drawRoundedRect = (x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      };

      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawRoundedRect(34, 28, canvas.width - 68, 94, 22, "#ffffff", "#cbd5e1");
      ctx.fillStyle = "#0f172a";
      ctx.font = "700 42px 'Inter', 'Segoe UI', sans-serif";
      ctx.fillText("Plan posiłków — wspólny tydzień", 64, 86);
      ctx.fillStyle = "#475569";
      ctx.font = "500 24px 'Inter', 'Segoe UI', sans-serif";
      ctx.fillText(`${format(weekDays[0], "d MMM yyyy", { locale: pl })} – ${format(weekDays[6], "d MMM yyyy", { locale: pl })}`, 64, 116);

      const tableX = 34;
      const tableY = 146;
      const tableW = canvas.width - 68;
      const tableH = canvas.height - 178;
      const cols = 8;
      const rows = 5;
      const cellW = tableW / cols;
      const cellH = tableH / rows;

      drawRoundedRect(tableX, tableY, tableW, tableH, 18, "#ffffff", "#cbd5e1");
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(tableX + 18, tableY);
      ctx.arcTo(tableX + tableW, tableY, tableX + tableW, tableY + tableH, 18);
      ctx.arcTo(tableX + tableW, tableY + tableH, tableX, tableY + tableH, 18);
      ctx.arcTo(tableX, tableY + tableH, tableX, tableY, 18);
      ctx.arcTo(tableX, tableY, tableX + tableW, tableY, 18);
      ctx.closePath();
      ctx.clip();

      for (let c = 0; c < cols; c += 1) {
        ctx.fillStyle = c === 0 ? "#dbeafe" : "#e2e8f0";
        ctx.fillRect(tableX + c * cellW, tableY, cellW, cellH);
      }
      for (let r = 1; r < rows; r += 1) {
        ctx.fillStyle = r % 2 === 0 ? "#f8fafc" : "#ffffff";
        ctx.fillRect(tableX, tableY + r * cellH, tableW, cellH);
      }

      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 2;
      for (let c = 1; c < cols; c += 1) {
        ctx.beginPath();
        ctx.moveTo(tableX + c * cellW, tableY);
        ctx.lineTo(tableX + c * cellW, tableY + tableH);
        ctx.stroke();
      }
      for (let r = 1; r < rows; r += 1) {
        ctx.beginPath();
        ctx.moveTo(tableX, tableY + r * cellH);
        ctx.lineTo(tableX + tableW, tableY + r * cellH);
        ctx.stroke();
      }

      ctx.fillStyle = "#1e3a8a";
      ctx.font = "700 24px 'Inter', 'Segoe UI', sans-serif";
      ctx.fillText("Posiłek", tableX + 20, tableY + 48);
      dayPlans.forEach(({ day }, index) => {
        const x = tableX + (index + 1) * cellW + 10;
        ctx.fillText(format(day, "EEE dd.MM", { locale: pl }), x, tableY + 48);
      });

      mealRows.forEach((meal, rowIndex) => {
        const rowY = tableY + (rowIndex + 1) * cellH;
        ctx.fillStyle = "#0f172a";
        ctx.font = "700 24px 'Inter', 'Segoe UI', sans-serif";
        ctx.fillText(meal.label, tableX + 20, rowY + 40);

        dayPlans.forEach(({ entries }, dayIndex) => {
          const mealEntries = entries.filter((entry: any) => entry.mealType === meal.key);
          const personA = mealEntries.filter((entry: any) => (entry.person || "A") === "A");
          const personB = mealEntries.filter((entry: any) => (entry.person || "A") === "B");

          const listForPerson = (personEntries: any[]) =>
            personEntries.map((entry: any) => `${entry.recipe?.name || entry.customMealName || entry.customIngredientName || "—"}`).join(", ");

          const aList = listForPerson(personA);
          const bList = listForPerson(personB);
          const lines: string[] = [];

          if (aList && bList && aList === bList) {
            lines.push(`Tysia + Mati: ${aList}`);
          } else {
            if (aList) lines.push(`${personLabel.A}: ${aList}`);
            if (bList) lines.push(`${personLabel.B}: ${bList}`);
          }
          if (lines.length === 0) lines.push("—");

          const cellX = tableX + (dayIndex + 1) * cellW + 10;
          let textY = rowY + 30;
          for (const line of lines) {
            ctx.fillStyle = line === "—" ? "#94a3b8" : "#1f2937";
            ctx.font = "500 17px 'Inter', 'Segoe UI', sans-serif";
            const wrapped = wrapText(line, cellW - 18).slice(0, 4);
            for (const wrappedLine of wrapped) {
              ctx.fillText(wrappedLine, cellX, textY);
              textY += 20;
            }
          }
        });
      });

      ctx.restore();
      ctx.fillStyle = "#64748b";
      ctx.font = "500 16px 'Inter', 'Segoe UI', sans-serif";
      ctx.fillText("Wspólny układ: dni w kolumnach, posiłki w rzędach, Tysia i Mati razem w każdej komórce.", 40, canvas.height - 22);

      const blob = await canvasToPdfBlob(canvas, "landscape");
      downloadBlob(blob, `plan-posilkow-${format(weekDays[0], "yyyy-MM-dd")}.pdf`);
      toast({ title: "Gotowe", description: "Wyeksportowano plan posiłków do PDF." });
    } catch (error: any) {
      toast({
        title: "Błąd eksportu",
        description: error?.message || "Nie udało się wyeksportować planu do PDF.",
        variant: "destructive",
      });
    }
  };

  return (
    <Layout>
      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {!isSharedView && (
          <div className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-white p-2 shadow-sm sm:w-auto sm:justify-start sm:gap-4">
            <button onClick={() => setBaseDate(d => subDays(d, 7))} className="p-2 hover:bg-muted rounded-lg transition-colors">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <span className="min-w-0 flex-1 text-center text-sm font-semibold tabular-nums sm:w-48 sm:flex-none sm:text-base">
              {format(weekDays[0], "d MMM", { locale: pl })} - {format(weekDays[6], "d MMM, yyyy", { locale: pl })}
            </span>
            <button onClick={() => setBaseDate(d => addDays(d, 7))} className="p-2 hover:bg-muted rounded-lg transition-colors">
              <ChevronRight className="w-5 h-5" />
            </button>
            <Button variant="outline" className="h-9" onClick={() => void exportWeekToPdf()}>
              <Download className="mr-2 h-4 w-4" />
              Eksport PDF
            </Button>
          </div>
        )}
      </div>

      {!isSharedView && (
      <>
      <div className="flex flex-col gap-12">
        {weekDays.map((day) => (
          <DaySection
            key={day.toISOString()}
            day={day}
            sectionId={`day-${format(day, "yyyy-MM-dd")}`}
            recipes={recipes}
            userSettings={userSettings}
            allAvailableIngredients={allAvailableIngredients || []}
            onAddMeal={handleOpenAdd}
            onAddCustom={handleOpenCustom}
            onAddIngredient={handleOpenIngredient}
            onDeleteMeal={(params: any) => deleteEntry(params)}
            onToggleEaten={(params: any) => toggleEaten(params)}
            onUpdateEntry={(entry: any, updates: any) => { void handleEntryUpdate(entry, updates); }}
            onDuplicateEntry={duplicateMealEntry}
            touchMoveEntry={touchMoveEntry}
            setTouchMoveEntry={setTouchMoveEntry}
            onViewRecipe={async (recipe: any) => setViewingRecipe(await fetchRecipeDetails(Number(recipe.id)))}
            onViewWholeRecipe={async (meal: any, relatedMeals: any[]) => {
              const batchId = Number(meal?.cookedBatchId || meal?.cookedBatch?.id || 0);
              const sharedBatch = batchId > 0
                ? sharedBatches.find((batch: any) => Number(batch?.id) === batchId)
                : null;
              const matchingMeals = (batchId > 0 ? sharedBatch?.mealEntries || relatedMeals || [] : relatedMeals || []).filter((entry: any) => {
                if (batchId > 0) return Number(entry?.cookedBatchId || entry?.cookedBatch?.id || 0) === batchId;
                return Number(entry?.recipeId || 0) === Number(meal?.recipeId || 0)
                  && String(entry?.date || "") === String(meal?.date || "");
              });
              const entriesToLoad = [meal, ...matchingMeals].filter((entry: any, index: number, entries: any[]) =>
                entries.findIndex((candidate: any) => Number(candidate?.id) === Number(entry?.id)) === index
              );
              const fullEntries = await Promise.all(entriesToLoad.map((entry: any) => fetchMealEntryFull(Number(entry.id))));
              const fullMeal = fullEntries.find((entry: any) => Number(entry?.id) === Number(meal?.id)) || fullEntries[0];
              const recipe = sharedBatch?.recipe || fullMeal?.cookedBatch?.recipe || fullMeal?.recipe || meal?.recipe;
              const totalServings = batchId > 0
                ? Number(sharedBatch?.totalServings || fullMeal?.cookedBatch?.totalServings) || Number(recipe?.servings) || 1
                : fullEntries.reduce((total: number, entry: any) => total + (Number(entry?.servings) || 0), 0);
              const sharedIngredients = batchId > 0
                ? buildWholeSharedBatchIngredients(sharedBatch || { recipe, totalServings })
                : buildSharedIngredientsSummary({
                entriesA: fullEntries.filter((entry: any) => (entry?.person || "A") === "A"),
                entriesB: fullEntries.filter((entry: any) => (entry?.person || "A") === "B"),
                recipe,
              });
              const allocatedServings = fullEntries.reduce(
                (total: number, entry: any) => total + (Number(entry?.servings) || 0),
                0,
              );

              setViewingRecipe(recipe);
              setViewingMeal({
                ...fullMeal,
                servings: batchId > 0 ? totalServings : allocatedServings,
                ingredients: sharedIngredients,
                sharedParticipantEntries: {
                  A: fullEntries.find((entry: any) => (entry?.person || "A") === "A"),
                  B: fullEntries.find((entry: any) => entry?.person === "B"),
                },
                wholeRecipeBatchId: batchId || undefined,
                wholeRecipeBatchServings: batchId > 0 ? totalServings : undefined,
                isWholeRecipeView: true,
              });
              // The values are already either summed for both people or
              // calculated for the full shared batch. RecipeView must not
              // scale them a second time.
              setViewingServings(batchId > 0 ? totalServings : allocatedServings || undefined);
              setIsSharedRecipeView(true);
              setViewingSharedBatchId(batchId || null);
            }}
            onCopyDay={openCopyDayDialog}
            onSaveIdealDay={(date: string) => void saveDayAsIdeal(date)}
            onViewPlannedRecipe={async (recipe: any, meal: any, options?: { shared?: boolean }) => {
              const servingsForView = Number(meal?.servings) || 1;
              const cookedBatchId = Number(meal?.cookedBatchId || meal?.cookedBatch?.id) || 0;

              if (options?.shared && meal?.sharedParticipantEntries) {
                const [fullRecipe, fullEntryA, fullEntryB] = await Promise.all([
                  fetchRecipeDetails(Number(recipe.id)),
                  meal.sharedParticipantEntries.A?.id
                    ? fetchMealEntryFull(Number(meal.sharedParticipantEntries.A.id))
                    : Promise.resolve(meal.sharedParticipantEntries.A),
                  meal.sharedParticipantEntries.B?.id
                    ? fetchMealEntryFull(Number(meal.sharedParticipantEntries.B.id))
                    : Promise.resolve(meal.sharedParticipantEntries.B),
                ]);

                const sharedIngredients = buildSharedIngredientsSummary({
                  entriesA: fullEntryA ? [fullEntryA] : [],
                  entriesB: fullEntryB ? [fullEntryB] : [],
                  recipe: fullRecipe,
                });

                setViewingRecipe(fullRecipe);
                setViewingMeal({
                  ...meal,
                  servings: servingsForView,
                  ingredients: sharedIngredients,
                  sharedParticipantEntries: {
                    A: fullEntryA,
                    B: fullEntryB,
                  },
                });
                setViewingServings(servingsForView);
                setViewingSharedPerson(meal?.person === "B" ? "B" : "A");
                setIsSharedRecipeView(true);
                setViewingSharedBatchId(cookedBatchId || null);
                return;
              }

              const fullMeal = meal?.id ? await fetchMealEntryFull(Number(meal.id)) : null;
              setViewingRecipe(fullMeal?.recipe || await fetchRecipeDetails(Number(recipe.id)));
              setViewingMeal({ ...(fullMeal || meal), servings: servingsForView });
              setViewingServings(servingsForView);
              setIsSharedRecipeView(!!options?.shared || cookedBatchId > 0);
              setViewingSharedBatchId(cookedBatchId || null);
            }}
          />
        ))}
      </div>
      </>
      )}

      {isSharedView && (
        <section className="space-y-4">
          <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
            <h2 className="text-lg font-semibold mb-3">Nowe gotowanie wspólnego posiłku</h2>
            <div className="grid min-w-0 gap-3 md:grid-cols-5">
              <Input
                className="h-8 min-w-0 px-2 text-sm"
                value={sharedRecipeSearch}
                onChange={(e) => setSharedRecipeSearch(e.target.value)}
                placeholder="Szukaj przepisu"
              />
              <select
                className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                value={sharedRecipeId || ""}
                onChange={(e) => {
                  const selectedRecipeId = Number(e.target.value) || 0;
                  setSharedRecipeId(selectedRecipeId);
                  const selectedRecipe = (recipes || []).find((recipe: any) => Number(recipe?.id) === selectedRecipeId);
                  if (selectedRecipe) {
                    setSharedTotalServings(Math.max(0.25, Number(selectedRecipe?.servings) || 1));
                  }
                }}
              >
                <option value="">Wybierz przepis</option>
                {filteredSharedRecipes.map((recipe: any) => {
                  const servings = Number(recipe?.servings) || 1;
                  const servingsLabel = Number.isInteger(servings) ? servings : String(servings).replace(".", ",");
                  return <option key={recipe.id} value={recipe.id}>{recipe.name} ({servingsLabel} porcji)</option>;
                })}
              </select>
              <Input className="h-8 min-w-0 px-2 text-sm" type="number" min={0.25} step={0.25} value={sharedTotalServings} onChange={(e) => setSharedTotalServings(Math.max(0.25, Number(e.target.value) || 1))} placeholder="Liczba porcji" />
              <Input className="h-8 min-w-0 px-2 text-sm" value={sharedNote} onChange={(e) => setSharedNote(e.target.value)} placeholder="Notatka (opcjonalnie)" />
              <Button className="h-8 w-full min-w-0 px-3 text-sm" disabled={!sharedRecipeId || createSharedBatch.isPending} onClick={() => createSharedBatch.mutate()}>Dodaj do wspólnych</Button>
            </div>
          </div>

          <div className="space-y-3">
            {sharedBatches.length === 0 && <div className="text-sm text-muted-foreground">Brak aktywnych wspólnych posiłków.</div>}
            {sharedBatches.map((batch: any) => {
              const form = getAllocationForm(batch.id);
              const batchDate = form.date || format(new Date(), "yyyy-MM-dd");
              const plannedDays = Array.from(new Set((batch.mealEntries || []).map((entry: any) => String(entry?.date || "")).filter(Boolean))).sort();
              const imageUrl = batch.recipe?.imageUrl || "https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800";
              const allocatedByPerson = (batch.mealEntries || []).reduce((acc: { A: number; B: number }, entry: any) => {
                const person = entry?.person === "B" ? "B" : "A";
                acc[person] += Number(entry?.servings) || 0;
                return acc;
              }, { A: 0, B: 0 });
              return (
                <div key={batch.id} className="rounded-2xl border border-emerald-200 bg-card p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-start gap-3">
                      <div className="h-14 w-14 rounded-lg bg-muted bg-cover bg-center shrink-0" style={{ backgroundImage: `url(${imageUrl})` }} />
                      <div>
                        <p className="font-semibold">{batch.recipe?.name}</p>
                        <p className="text-xs text-muted-foreground">Ugotowane: {Number(batch.totalServings) || 0} porcji • W planie: {Number(batch.allocatedServings) || 0} • Pozostało: <span className="font-semibold text-emerald-700">{Number(batch.remainingServings) || 0}</span></p>
                        <p className="text-[11px] text-muted-foreground">Zjedzone/zaplanowane: Tysia {allocatedByPerson.A} • Mati {allocatedByPerson.B} porcji</p>
                        <p className="text-[11px] text-muted-foreground">
                          Porcje dodane na dni:{" "}
                          {plannedDays.length
                            ? plannedDays.map((dateStr) => format(new Date(`${dateStr}T00:00:00`), "dd.MM.yyyy", { locale: pl })).join(", ")
                            : "brak"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setViewingRecipe(batch.recipe);
                          setViewingMeal({
                            servings: Number(batch.totalServings) || 1,
                            ingredients: getBatchBaseIngredients(batch),
                            date: batchDate,
                          });
                          setViewingServings(Number(batch.totalServings) || 1);
                          setIsSharedRecipeView(true);
                          setIsViewingSharedDayRecipe(true);
                          setViewingSharedBatchId(Number(batch.id) || null);
                        }}
                      >
                        Pokaż przepis dnia
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => archiveBatch.mutate({ id: batch.id, isArchived: true })}>Archiwizuj</Button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-5">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      Masa gotowej partii (g)
                      <Input
                        key={`batch-weight-${batch.id}-${batch.finishedWeightGrams ?? "empty"}`}
                        type="number"
                        min={1}
                        step={1}
                        defaultValue={batch.finishedWeightGrams ?? ""}
                        placeholder="Opcjonalnie"
                        onBlur={(e) => {
                          const raw = e.currentTarget.value.trim();
                          const nextWeight = raw === "" ? null : Number(raw);
                          if (raw !== "" && (nextWeight === null || !Number.isFinite(nextWeight) || nextWeight <= 0)) return;
                          if ((Number(batch.finishedWeightGrams) || null) !== nextWeight) {
                            updateBatch.mutate({ id: Number(batch.id), updates: { finishedWeightGrams: nextWeight } });
                          }
                        }}
                      />
                    </label>
                    <Input type="date" value={form.date} onChange={(e) => updateAllocationForm(batch.id, { date: e.target.value })} />
                    <select className="h-10 rounded-md border border-input bg-background px-3 text-foreground" value={form.mealType} onChange={(e) => updateAllocationForm(batch.id, { mealType: e.target.value })}>
                      <option value="breakfast">Śniadanie</option><option value="snack">Lunch</option><option value="lunch">Obiad</option><option value="dinner">Kolacja</option>
                    </select>
                    <select className="h-10 rounded-md border border-input bg-background px-3 text-foreground" value={form.person} onChange={(e) => updateAllocationForm(batch.id, { person: (e.target.value as "A" | "B") })}>
                      <option value="A">Tysia</option><option value="B">Mati</option>
                    </select>
                    <Input type="number" min={0.25} step={0.25} value={form.servings} onChange={(e) => updateAllocationForm(batch.id, { servings: Math.max(0.25, Number(e.target.value) || 1) })} />
                    <Button disabled={(Number(batch.remainingServings) || 0) <= 0} onClick={() => allocateFromBatch(batch)}>Dodaj porcje do planu</Button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[0.5, 1, 1.5, 2].map((preset) => (
                      <Button key={`preset-${batch.id}-${preset}`} variant="outline" size="sm" onClick={() => updateAllocationForm(batch.id, { servings: preset })}>
                        {preset} porcji
                      </Button>
                    ))}
                  </div>

                  {(batch.logs || []).length > 0 && (
                    <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 p-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dziennik zmian</p>
                      <div className="mt-1 space-y-1">
                        {batch.logs.slice(0, 6).map((log: any) => (
                          <p key={`log-${log.id}`} className="text-xs text-muted-foreground">
                            {format(new Date(log.createdAt), "yyyy-MM-dd HH:mm")} • {log.action}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {(batch?.recipe?.frequentAddons || []).length > 0 && (
                    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Dodatki wspólne dla {personName[form.person]}</p>
                        <button
                          type="button"
                          className="text-xs font-medium text-emerald-700 underline underline-offset-2"
                          onClick={() => setSelectedFrequentAddons((prev) => ({ ...prev, [form.person]: {} }))}
                        >
                          Wyczyść
                        </button>
                      </div>
                      <div className="space-y-2">
                        {(batch.recipe.frequentAddons || []).map((addon: any) => {
                          const addonStep = getAddonBaseAmount(addon);
                          const currentAmount = Number(selectedFrequentAddons[form.person]?.[addon.ingredientId] || 0);
                          return (
                            <div key={`shared-addon-${batch.id}-${form.person}-${addon.ingredientId}`} className="flex items-center justify-between gap-2 rounded-lg border border-emerald-100 bg-white p-2">
                              <span className="text-sm font-medium">{addon.ingredient?.name || "Składnik"}</span>
                              <div className="flex items-center gap-1">
                                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAddonAmount(Number(addon.ingredientId), currentAmount - addonStep, form.person)}>
                                  <Minus className="h-3.5 w-3.5" />
                                </Button>
                                <Input
                                  type="number"
                                  min={0}
                                  step={Math.max(1, addonStep)}
                                  value={currentAmount}
                                  onChange={(e) => setAddonAmount(Number(addon.ingredientId), Number(e.target.value) || 0, form.person)}
                                  className="h-8 w-20 text-center"
                                />
                                <span className="text-xs text-muted-foreground">g</span>
                                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAddonAmount(Number(addon.ingredientId), currentAmount + addonStep, form.person)}>
                                  <Plus className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Archiwum partii</h3>
              {archivedSharedBatches.length > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (selectedArchivedBatchIds.length === archivedSharedBatches.length) {
                        setSelectedArchivedBatchIds([]);
                        return;
                      }
                      setSelectedArchivedBatchIds(archivedSharedBatches.map((batch: any) => Number(batch.id)));
                    }}
                  >
                    {selectedArchivedBatchIds.length === archivedSharedBatches.length ? "Odznacz wszystkie" : "Zaznacz wszystkie"}
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={selectedArchivedBatchIds.length === 0 || bulkDeleteArchivedBatches.isPending}
                      >
                        Usuń zaznaczone ({selectedArchivedBatchIds.length})
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Usunąć zaznaczone partie z archiwum?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Ta operacja jest nieodwracalna. Trwale usuniętych zostanie {selectedArchivedBatchIds.length} partii wraz z powiązanymi wpisami planu.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Anuluj</AlertDialogCancel>
                        <AlertDialogAction onClick={() => bulkDeleteArchivedBatches.mutate(selectedArchivedBatchIds)}>
                          Usuń zaznaczone
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            </div>
            {archivedSharedBatches.length === 0 && <div className="text-sm text-muted-foreground">Brak zarchiwizowanych partii.</div>}
            {archivedSharedBatches.map((batch: any) => (
              <div key={`archived-${batch.id}`} className="rounded-2xl border border-border/60 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 cursor-pointer rounded border-input"
                      checked={selectedArchivedBatchIds.includes(Number(batch.id))}
                      onChange={(e) => {
                        const id = Number(batch.id);
                        setSelectedArchivedBatchIds((prev) => {
                          if (e.target.checked) return Array.from(new Set([...prev, id]));
                          return prev.filter((value) => value !== id);
                        });
                      }}
                    />
                    <div>
                    <p className="font-semibold">{batch.recipe?.name}</p>
                    <p className="text-xs text-muted-foreground">Ugotowane: {Number(batch.totalServings) || 0} porcji</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSelectedArchivedBatchIds((prev) => prev.filter((value) => value !== Number(batch.id)));
                        archiveBatch.mutate({ id: batch.id, isArchived: false });
                      }}
                    >
                      Przywróć
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive" size="sm">Usuń</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Usunąć partię z archiwum?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Ta operacja jest nieodwracalna. Usunięta zostanie partia i powiązane wpisy w planie posiłków.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Anuluj</AlertDialogCancel>
                          <AlertDialogAction onClick={() => {
                            setSelectedArchivedBatchIds((prev) => prev.filter((value) => value !== Number(batch.id)));
                            deleteBatch.mutate(batch.id);
                          }}
                          >
                            Usuń na stałe
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}


      <Dialog open={isCopyDayOpen} onOpenChange={setIsCopyDayOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Kopiuj na inny dzień</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Kopiuj z dnia</label>
              <Input
                type="date"
                value={copySourceDate}
                onChange={(e) => setCopySourceDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Wklej do dnia</label>
              <Input
                type="date"
                value={copyTargetDate}
                onChange={(e) => setCopyTargetDate(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Skopiowanie zastępuje plan docelowego dnia wpisami z dnia źródłowego dla Tysi i Matiego.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCopyDayOpen(false)} disabled={isCopyingDay}>Anuluj</Button>
            <Button onClick={handleCopyDay} disabled={isCopyingDay}>
              <Copy className="mr-2 h-4 w-4" />
              {isCopyingDay ? "Kopiowanie..." : "Kopiuj"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {viewingMeal?.id && viewingRecipe?.portioningMode === "individual" && !isSharedRecipeView && !viewingMeal?.isWholeRecipeView && (
        <div className="mx-auto mb-3 w-full max-w-3xl rounded-xl border bg-background p-3 sm:p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-sm font-semibold">Indywidualny wariant porcji</p><p className="text-xs text-muted-foreground">Zmiana wariantu ustawia składniki na zapisane ilości A/B/C.</p></div>
            <Select value={getAvailableVariants(viewingRecipe.ingredients || []).includes(viewingMeal.portionVariant as PortionVariant) ? viewingMeal.portionVariant : getAvailableVariants(viewingRecipe.ingredients || [])[0] || "B"} onValueChange={async (variant) => {
              if (variant === viewingMeal.portionVariant) return;
              const modified = !!viewingMeal.ingredientsModified;
              if (modified && !window.confirm("Składniki tego posiłku były zmieniane ręcznie. Zmiana wariantu przywróci ilości z przepisu i usunie te zmiany. Kontynuować?")) return;
              try {
                await updateMealEntryAsync({ id: Number(viewingMeal.id), updates: { portionVariant: variant, ...(modified ? { confirmVariantReset: true } : {}) } });
                const refreshed = await fetchMealEntryFull(Number(viewingMeal.id));
                setViewingMeal((prev: any) => ({ ...prev, ...(refreshed || {}), portionVariant: variant, ingredientsModified: false }));
                setViewingRecipe((prev: any) => refreshed?.recipe || prev);
                toast({ title: "Zmieniono wariant", description: `Zastosowano wariant ${variant} i zapisane ilości składników.` });
              } catch (error: any) {
                toast({ title: "Nie udało się zmienić wariantu", description: error?.message || "Spróbuj ponownie.", variant: "destructive" });
              }
            }}>
              <SelectTrigger className="w-full sm:w-56"><SelectValue placeholder="Wybierz wariant" /></SelectTrigger>
              <SelectContent>{getAvailableVariants(viewingRecipe.ingredients || []).map((variant) => <SelectItem key={variant} value={variant}>{variant} {variant === "A" ? "— mniejsza porcja" : variant === "B" ? "— standardowa porcja" : "— większa porcja"}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
      <RecipeView
        recipe={viewingRecipe}
        isOpen={!!viewingRecipe}
        onClose={() => {
          setViewingRecipe(null);
          setViewingMeal(null);
          setViewingServings(undefined);
          setViewingSharedPerson("A");
          setIsSharedRecipeView(false);
          setIsViewingSharedDayRecipe(false);
          setViewingSharedBatchId(null);
        }}
        plannedServings={viewingMeal?.isWholeRecipeView
          ? viewingServings
          : isSharedRecipeView && viewingMeal?.sharedParticipantEntries
            ? Number(viewingMeal.sharedParticipantEntries[viewingSharedPerson]?.servings) || 1
            : viewingServings}
        mealEntryIngredients={viewingMeal?.isWholeRecipeView
          ? viewingMeal?.ingredients
          : isSharedRecipeView && viewingMeal?.sharedParticipantEntries ? undefined : viewingMeal?.ingredients}
        frequentAddonIds={viewingRecipe?.frequentAddons?.map((addon: any) => addon.ingredientId) || []}
        onEditIngredients={viewingMeal && !(viewingMeal?.isWholeRecipeView && isIndividualVariantRecipe(viewingRecipe)) ? (isSharedRecipeView ? startEditingSharedIngredients : startEditing) : undefined}
        allowIngredientEditing={!!viewingMeal && !(viewingMeal?.isWholeRecipeView && isIndividualVariantRecipe(viewingRecipe)) && !(isSharedRecipeView && viewingMeal?.id && getEditedSharedParticipantEntries(viewingMeal).length > 0)}
        servingsLockedReason={!isSharedRecipeView && hasEditedMealIngredients(viewingMeal) ? "Porcje zablokowane (edytowano składniki)" : undefined}
        onRestoreOriginalIngredients={!(viewingMeal?.isWholeRecipeView && isIndividualVariantRecipe(viewingRecipe)) && ((isSharedRecipeView && getEditedSharedParticipantEntries(viewingMeal).length > 0) || (!isSharedRecipeView && hasEditedMealIngredients(viewingMeal))) ? restoreOriginalIngredients : undefined}
        usePrecalculatedAmounts={!!viewingMeal?.isWholeRecipeView || (isSharedRecipeView && !viewingMeal?.sharedParticipantEntries)}
        switchPlannedPersonLabel={viewingMeal?.sharedParticipantEntries ? (viewingSharedPerson === "A" ? "Pokaż Matiego" : "Pokaż Tysię") : undefined}
        onSwitchPlannedPerson={viewingMeal?.sharedParticipantEntries ? () => setViewingSharedPerson((person) => person === "A" ? "B" : "A") : undefined}
        onPlannedServingsChange={isSharedRecipeView && viewingMeal?.sharedParticipantEntries ? (nextServings: number) => {
          const entry = viewingMeal.sharedParticipantEntries[viewingSharedPerson];
          if (!entry?.id) return;
          const servings = Math.max(0.25, Math.round(nextServings * 100) / 100);
          const previousServings = Number(entry.servings) || 1;
          if (Math.abs(servings - previousServings) < 1e-9) return;
          setViewingMeal((prev: any) => prev?.sharedParticipantEntries ? ({
            ...prev,
            servings: Math.max(0, (Number(prev.sharedParticipantEntries.A?.servings) || 0)
              + (Number(prev.sharedParticipantEntries.B?.servings) || 0)
              + servings - previousServings),
            sharedParticipantEntries: {
              ...prev.sharedParticipantEntries,
              [viewingSharedPerson]: { ...prev.sharedParticipantEntries[viewingSharedPerson], servings },
            },
          }) : prev);
          setViewingServings((prev) => Math.max(0, (Number(prev) || 0) + servings - previousServings));
          void handleEntryUpdate(entry, { servings });
        } : undefined}
        compact
        showFooter={!viewingMeal && !isViewingSharedDayRecipe && !isAddOpen}
        onAddToPlan={(recipe) => {
          setViewingRecipe(null);
          setViewingMeal(null);
          setViewingServings(undefined);
          setIsSharedRecipeView(false);
          setViewingSharedBatchId(null);
          handleAdd(recipe.id);
        }}
      />
      </Suspense>

      <Dialog open={isEditingIngredients} onOpenChange={setIsEditingIngredients}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col bg-white sm:max-h-[90vh] max-sm:h-[100dvh] max-sm:max-h-none">
          <DialogHeader>
            <DialogTitle>Dostosuj składniki</DialogTitle>
            <p className="text-sm text-muted-foreground">Domyślne ilości są wyliczane z porcji. Zmieniaj tylko te składniki, które chcesz dostosować.</p>
            {viewingMeal?.wholeRecipeBatchId ? (
              <p className="text-sm text-muted-foreground">
                Zmieniasz składniki całej wspólnej partii. Ilości zostaną rozdzielone według liczby porcji, a osobiste dodatki pozostaną przy swoich porcjach.
              </p>
            ) : viewingMeal?.cookedBatchId && (
              <p className="text-sm text-muted-foreground">
                Zmieniasz tylko składniki tego wpisu w planie ({personName[viewingMeal.person === "B" ? "B" : "A"]}). Wspólny posiłek ani bazowy przepis nie zostaną zmienione.
              </p>
            )}
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
                        + {Math.round(getAddonBaseAmount(addon))}g {addon.ingredient?.name || "Składnik"}
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
                            ? allAvailableIngredients?.find((i: any) => i.id === item.ingredientId)?.name || item.ingredient?.name || "Wybierz składnik..."
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
                            {allAvailableIngredients?.map((i: any) => (
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
                      onChange={(e) => updateIngredientInEdit(idx, { amount: e.target.value, isOverride: true })}
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
            <Button variant="outline" onClick={() => setIsEditingIngredients(false)} disabled={isSaving || updateBatch.isPending}>Anuluj</Button>
            <Button onClick={saveIngredients} disabled={isSaving || updateBatch.isPending} className="bg-primary hover:bg-primary/90">
              {isSaving || updateBatch.isPending ? <LoadingSpinner /> : "Zapisz zmiany"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isAddOpen}
        onOpenChange={(open) => {
          if (!open && !isAddingRecipe) {
            closeAddDialog();
            return;
          }
          if (open) setIsAddOpen(true);
        }}
      >
        <DialogContent className="w-[calc(100vw-1rem)] max-w-4xl max-h-[90vh] overflow-y-auto overflow-x-hidden sm:w-full sm:max-h-[90vh] max-sm:h-[100dvh] max-sm:w-[100dvw] max-sm:max-w-[100dvw] max-sm:max-h-none max-sm:p-3 max-sm:[&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="break-words pr-8 text-base leading-snug sm:text-lg">Dodaj do posiłku: {
              selectedMealType === "breakfast" ? "Śniadanie" :
              selectedMealType === "snack" ? "Lunch" :
              selectedMealType === "lunch" ? "Obiad" : "Kolacja"
            } ({selectedDateStr}) • {personName[selectedPerson]}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2 sm:mt-4">
            {recommendedSharedBatches.length > 0 && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Polecane pozostałe porcje ze wspólnych posiłków</p>
                <div className="mt-2 space-y-2">
                  {recommendedSharedBatches.map((batch: any) => {
                    const isSelectingAddons = selectedRecommendedBatchId === Number(batch.id);
                    const preferredServings = Math.max(0.25, Math.min(
                      getRecipeDefaultServingsForPerson(batch?.recipe, selectedPerson),
                      Number(batch.remainingServings) || 0
                    ));

                    return (
                      <div key={`recommended-batch-${batch.id}`} className="rounded-lg border border-emerald-100 bg-white px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium">{batch.recipe?.name}</p>
                            <p className="text-[11px] text-muted-foreground">Pozostało: {Number(batch.remainingServings) || 0} porcji • dodasz {preferredServings} porcji</p>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => handleRecommendedBatchClick(batch)}>
                            {(batch?.recipe?.frequentAddons || []).length > 0 ? "Wybierz dodatki" : "Dodaj z partii"}
                          </Button>
                        </div>

                        {isSelectingAddons && (batch?.recipe?.frequentAddons || []).length > 0 && (
                          <div className="mt-3 space-y-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Opcjonalne dodatki dla {personName[selectedPerson]}</p>
                              <button
                                type="button"
                                className="text-xs font-medium text-emerald-700 underline underline-offset-2"
                                onClick={() => setSelectedFrequentAddons((prev) => ({ ...prev, [selectedPerson]: {} }))}
                              >
                                Wyczyść
                              </button>
                            </div>

                            <div className="space-y-2">
                              {(batch.recipe.frequentAddons || []).map((addon: any) => {
                                const addonStep = getAddonBaseAmount(addon) || 1;
                                const currentAmount = Number(selectedFrequentAddons[selectedPerson]?.[addon.ingredientId] || 0);
                                const repeatCount = Math.round(currentAmount / addonStep);

                                return (
                                  <div key={`recommended-addon-${batch.id}-${selectedPerson}-${addon.ingredientId}`} className={cn(
                                    "flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white p-2 transition-colors",
                                    currentAmount > 0 ? "border-emerald-200" : "border-emerald-100"
                                  )}>
                                    <span className="text-sm font-medium">{addon.ingredient?.name || "Składnik"}</span>
                                    <div className="flex items-center gap-1">
                                      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAddonAmount(Number(addon.ingredientId), currentAmount - addonStep, selectedPerson)}>
                                        <Minus className="h-3.5 w-3.5" />
                                      </Button>
                                      <Input
                                        type="number"
                                        min={0}
                                        step={Math.max(1, addonStep)}
                                        value={currentAmount}
                                        onChange={(e) => setAddonAmount(Number(addon.ingredientId), Number(e.target.value) || 0, selectedPerson)}
                                        className="h-8 w-20 text-center"
                                      />
                                      <span className="text-xs text-muted-foreground">g</span>
                                      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAddonAmount(Number(addon.ingredientId), currentAmount + addonStep, selectedPerson)}>
                                        <Plus className="h-3.5 w-3.5" />
                                      </Button>
                                      <span className="min-w-6 text-[11px] text-muted-foreground">x{Math.max(0, repeatCount)}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            <div className="flex justify-end gap-2">
                              <Button type="button" variant="ghost" size="sm" onClick={() => {
                                setSelectedRecommendedBatchId(null);
                                setSelectedFrequentAddons({ A: {}, B: {} });
                              }}>
                                Anuluj
                              </Button>
                              <Button type="button" size="sm" onClick={() => addRecommendedBatchToPlan(batch)}>
                                Dodaj porcję i dodatki
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <input
                type="text"
                placeholder="Szukaj po przepisie lub składniku..."
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />

              <Select value={selectedTag || "__all"} onValueChange={(value) => setSelectedTag(value === "__all" ? null : value)}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Kategoria przepisu" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">Wszystkie kategorie</SelectItem>
                  {allTags.map((tag) => (
                    <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={recipeSort} onValueChange={setRecipeSort}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Sortuj przepisy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="popular">Najczęściej używane</SelectItem>
                  <SelectItem value="calories-asc">Kalorie / porcję (rosnąco)</SelectItem>
                  <SelectItem value="calories-desc">Kalorie / porcję (malejąco)</SelectItem>
                  <SelectItem value="protein-desc">Białko / porcję (najwięcej)</SelectItem>
                  <SelectItem value="carbs-desc">Węglowodany / porcję (najwięcej)</SelectItem>
                  <SelectItem value="fat-desc">Tłuszcz / porcję (najwięcej)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2 max-h-[50vh] overflow-y-auto pr-0 sm:pr-2">
              {isFetchingRecipes && !recipes ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  Szukam przepisów...
                </div>
              ) : filteredRecipes.length > 0 ? (
                filteredRecipes.map((recipe: any) => (
                  <div key={recipe.id} className="flex min-w-0 items-center gap-1.5">
                    <button
                      onClick={async () => {
                        const fullRecipe = await fetchRecipeDetails(Number(recipe.id));
                        setSelectedRecipeToAdd(fullRecipe);
                        const availableVariants = getAvailableVariants(fullRecipe?.ingredients || []);
                        const defaultA = ["A", "B", "C"].includes(fullRecipe?.defaultVariantA) ? fullRecipe.defaultVariantA as PortionVariant : "B";
                        const defaultB = ["A", "B", "C"].includes(fullRecipe?.defaultVariantB) ? fullRecipe.defaultVariantB as PortionVariant : "B";
                        const firstAvailable = availableVariants[0] || "B";
                        setSelectedPortionVariants({
                          A: availableVariants.includes(defaultA) ? defaultA : firstAvailable,
                          B: availableVariants.includes(defaultB) ? defaultB : firstAvailable,
                        });
                        setSelectedRecommendedBatchId(null);
                        setSelectedFrequentAddons(getDefaultFrequentAddonsSelection(recipe));
                        setAddRecipeForBothPeople(true);
                        setSelectedRecipeServings(getRecipeDefaultServingsForPerson(recipe, selectedPerson));
                        setSelectedPersonServings({ A: getRecipeDefaultServingsForPerson(recipe, "A"), B: getRecipeDefaultServingsForPerson(recipe, "B") });
                                            const initialSuggestions = ((recipe?.suggestedRecipes || []) as any[]).reduce((acc: Record<string, number>, item: any) => {
                          const recipeId = Number(item?.recipeId);
                          const servings = Number(item?.servings) || 0;
                          if (Number.isFinite(recipeId) && recipeId > 0 && servings > 0) acc[String(recipeId)] = servings;
                          return acc;
                        }, {});
                        setSelectedSuggestedRecipes(initialSuggestions);
                      }}
                      className="flex w-full min-w-0 items-center gap-2 sm:gap-4 p-2.5 sm:p-3 rounded-xl hover:bg-secondary transition-colors text-left border border-transparent hover:border-border"
                    >
                      <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-cover bg-center bg-muted flex-shrink-0" style={{ backgroundImage: `url(${recipe.imageUrl})` }} />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold truncate">{recipe.name}</p>
                        <div className="flex min-w-0 flex-wrap items-center gap-1 sm:gap-2">
                          <p className="text-[11px] text-muted-foreground">{recipe.prepTime} min</p>
                          {!isIndividualVariantRecipe(recipe) && (
                            <p className="text-[11px] text-muted-foreground">
                              {Number(recipe?.servings) || 1} porcji w przepisie
                            </p>
                          )}
                          <p className="text-[11px] text-muted-foreground">
                            ~{Math.round(getRecipeNutritionAtServings(recipe, 1).calories)} kcal/porcję
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Zjedzone: {Number(recipe?.stats?.eatCount) || 0}x
                          </p>
                          {recipe.tags?.map((tag: string) => (
                            <span key={tag} className="max-w-full truncate text-[10px] bg-secondary px-1.5 py-0.5 rounded text-muted-foreground uppercase tracking-wider font-medium">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      title="Pokaż składniki i wykonanie"
                      aria-label={`Pokaż składniki i wykonanie przepisu: ${recipe.name}`}
                      onClick={async () => {
                        try {
                          const fullRecipe = await fetchRecipeDetails(Number(recipe.id));
                          setViewingRecipe(fullRecipe);
                          setViewingMeal(null);
                          setViewingServings(undefined);
                          setIsSharedRecipeView(false);
                          setIsViewingSharedDayRecipe(false);
                          setViewingSharedBatchId(null);
                        } catch (error) {
                          toast({
                            title: "Błąd",
                            description: error instanceof Error ? error.message : "Nie udało się otworzyć przepisu.",
                            variant: "destructive",
                          });
                        }
                      }}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground italic text-sm">
                  Nie znaleziono przepisów spełniających kryteria
                </div>
              )}
            </div>

            {selectedRecipeToAdd && (
              <div className="space-y-3 rounded-xl border border-border/70 bg-secondary/20 p-3">
                <p className="break-words text-sm font-semibold">Wybrany przepis: {selectedRecipeToAdd.name}</p>
                {isIndividualVariantRecipe(selectedRecipeToAdd) && (() => {
                  const availableVariants = getAvailableVariants(selectedRecipeToAdd.ingredients || []);
                  const people = addRecipeForBothPeople ? (["A", "B"] as const) : ([selectedPerson] as const);
                  return <div className="grid gap-2 rounded-lg border p-3">
                    <p className="text-xs font-semibold">Wariant porcji</p>
                    {people.map((person) => <label key={person} className="flex items-center justify-between gap-3 text-sm">
                      <span>{personName[person]}</span>
                      <Select value={availableVariants.includes(selectedPortionVariants[person]) ? selectedPortionVariants[person] : (availableVariants[0] || "B")} onValueChange={(value) => setSelectedPortionVariants((previous) => ({ ...previous, [person]: value as PortionVariant }))}>
                        <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                        <SelectContent>{availableVariants.map((variant) => <SelectItem key={variant} value={variant}>{variant} {variant === "A" ? "— mniejsza" : variant === "B" ? "— standardowa" : "— większa"}</SelectItem>)}</SelectContent>
                      </Select>
                    </label>)}
                  </div>;
                })()}
                {isIndividualVariantRecipe(selectedRecipeToAdd) ? (
                  <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                    Każdy wybrany wariant A/B/C to jedna porcja. Wielkość porcji określają ilości składników zapisane w wariancie.
                  </p>
                ) : addRecipeForBothPeople ? (
                  <div className="grid gap-2">
                    <p className="text-xs font-medium text-muted-foreground">Porcje</p>
                    {(["A", "B"] as const).map((person) => (
                      <label key={person} className="flex items-center justify-between gap-3 text-sm">
                        <span>{personName[person]}</span>
                        <div className="flex items-center gap-2">
                          <Input type="number" step="0.25" min={0.25} className="h-8 w-20" value={selectedPersonServings[person]} onChange={(e) => setSelectedPersonServings((previous) => ({ ...previous, [person]: Math.max(0.25, Number(e.target.value) || 1) }))} />
                          <span className="text-xs text-muted-foreground">porcji</span>
                        </div>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <label className="text-xs font-medium text-muted-foreground">Porcje głównego przepisu</label>
                    <Input type="number" step="0.25" min={0.25} value={selectedRecipeServings} onChange={(e) => setSelectedRecipeServings(Math.max(0.25, Number(e.target.value) || 1))} className="h-8 w-28" />
                  </div>
                )}
                {selectedRecipeNutritionPreview && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-emerald-800">
                      {isIndividualVariantRecipe(selectedRecipeToAdd) ? "Makro i kcal dla wybranego wariantu i dodatków" : "Makro i kcal dla wybranych porcji przepisu i dodatków"}
                    </p>
                    {(["A", "B"] as const)
                      .filter((person) => addRecipeForBothPeople || person === selectedPerson)
                      .map((person) => {
                        const nutrition = selectedRecipeNutritionPreview[person];
                        return (
                          <p key={person} className="mt-1 text-sm text-emerald-950">
                            {personName[person]} ({nutrition.servings} porcji): {nutrition.calories} kcal • B: {nutrition.protein} g • W: {nutrition.carbs} g • T: {nutrition.fat} g
                          </p>
                        );
                      })}
                  </div>
                )}

                {suggestedRecipeOptionsForAdd.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">A może chcesz dodać też ten przepis?</p>
                    <div className="space-y-2 rounded-xl border border-border/60 bg-white p-2">
                      {suggestedRecipeOptionsForAdd.map((item: any) => {
                        const key = String(item.recipe.id);
                        const amount = Number(selectedSuggestedRecipes[key] ?? 0);
                        return (
                          <div key={item.recipe.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={amount > 0}
                                onChange={(e) => setSelectedSuggestedRecipes((prev) => ({
                                  ...prev,
                                  [key]: e.target.checked ? (amount > 0 ? amount : Number(item.servings) || 1) : 0,
                                }))}
                              />
                              <span className="min-w-0 break-words">{item.recipe.name}</span>
                            </label>
                            <Input
                              type="number"
                              step="0.25"
                              min={0.25}
                              className="h-8 w-24"
                              disabled={amount <= 0}
                              value={amount > 0 ? amount : Number(item.servings) || 1}
                              onChange={(e) => {
                                const nextAmount = Math.max(0.25, Number(e.target.value) || Number(item.servings) || 1);
                                setSelectedSuggestedRecipes((prev) => ({ ...prev, [key]: nextAmount }));
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {(selectedRecipeToAdd.frequentAddons || []).length > 0 && (
                  <div className="space-y-3">
                    <p className="text-xs font-medium text-muted-foreground">Opcjonalne dodatki:</p>

                    <div className="flex flex-wrap gap-2">
                      {(selectedRecipeToAdd.frequentAddons || []).map((addon: any) => (
                        <div
                          key={addon.ingredientId}
                          className="flex min-w-0 flex-wrap items-center gap-1 rounded-2xl border border-border bg-white px-2 py-1"
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-full"
                            onClick={() => decreaseAddonAmount(addon, selectedPerson)}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </Button>

                          <button
                            type="button"
                            onClick={() => increaseAddonAmount(addon, selectedPerson)}
                            className="min-w-0 max-w-full rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800 transition-colors hover:bg-emerald-100 break-words"
                          >
                            + {Math.round(getAddonBaseAmount(addon))}g {addon.ingredient?.name || "Składnik"}
                          </button>

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-full"
                            onClick={() => increaseAddonAmount(addon, selectedPerson)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-2">
                      {(selectedRecipeToAdd.frequentAddons || []).map((addon: any) => {
                        const selectedAmountA = selectedFrequentAddons.A[addon.ingredientId] || 0;
                        const selectedAmountB = selectedFrequentAddons.B[addon.ingredientId] || 0;
                        const baseAmount = getAddonBaseAmount(addon) || 1;
                        const repeatCountA = Math.round(selectedAmountA / baseAmount);
                        const repeatCountB = Math.round(selectedAmountB / baseAmount);

                        return (
                          <div
                            key={`selected-${addon.ingredientId}`}
                            className={cn(
                              "space-y-2 rounded-lg border bg-white p-2 transition-colors",
                              selectedAmountA > 0 || selectedAmountB > 0 ? "border-emerald-200" : "border-border"
                            )}
                          >
                            <span className="text-sm font-medium sm:min-w-[140px]">
                              {addon.ingredient?.name || "Składnik"}
                            </span>

                            {(["A", "B"] as const).map((person) => {
                              const selectedAmount = person === "A" ? selectedAmountA : selectedAmountB;
                              const repeatCount = person === "A" ? repeatCountA : repeatCountB;
                              return (
                                <div key={`${addon.ingredientId}-${person}`} className="flex flex-wrap items-center gap-2">
                                  <span className="w-12 text-xs font-semibold text-muted-foreground">{personName[person]}</span>

                                  <Button type="button" variant="outline" size="icon" className="h-7 w-7 sm:h-8 sm:w-8" onClick={() => decreaseAddonAmount(addon, person)}>
                                    <Minus className="h-4 w-4" />
                                  </Button>

                                  <Input
                                    type="number"
                                    min={0}
                                    value={selectedAmount}
                                    onChange={(e) => setAddonAmount(addon.ingredientId, Number(e.target.value) || 0, person)}
                                    className="h-7 w-16 text-xs sm:h-8 sm:w-24 sm:text-sm"
                                  />

                                  <span className="text-[11px] text-muted-foreground">g</span>

                                  <Button type="button" variant="outline" size="icon" className="h-8 w-8" onClick={() => increaseAddonAmount(addon, person)}>
                                    <Plus className="h-4 w-4" />
                                  </Button>

                                  <span className="text-[11px] text-muted-foreground">x{Math.max(0, repeatCount)}</span>

                                  {selectedAmount > 0 && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 sm:h-8 sm:w-8 text-muted-foreground"
                                      onClick={() => setAddonAmount(addon.ingredientId, 0, person)}
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}



                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={addRecipeForBothPeople}
                    onChange={(e) => setAddRecipeForBothPeople(e.target.checked)}
                  />
                  Dodaj ten przepis od razu dla obu osób
                </label>

                <DialogFooter className="gap-2 sm:gap-0">
                  <Button className="max-sm:w-full" variant="ghost" onClick={closeAddDialog} disabled={isAddingRecipe}>Anuluj</Button>
                  <Button
                    className="max-sm:w-full"
                    onClick={() => requestAddRecipe(selectedRecipeToAdd.id, selectedRecipeToAdd)}
                    disabled={isAddingRecipe}
                  >
                    {isAddingRecipe ? "Dodawanie..." : "Dodaj do planu"}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isCustomOpen} onOpenChange={setIsCustomOpen}>
        <DialogContent className="max-sm:h-[100dvh] max-sm:w-screen max-sm:max-h-none max-sm:max-w-none max-sm:overflow-x-hidden max-sm:p-3">
          <DialogHeader>
            <DialogTitle>Dodaj własny produkt • {personName[selectedPerson]}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddCustom} className="grid gap-4 mt-4">
            <div className="grid gap-2">
              <label className="text-sm font-medium">Nazwa</label>
              <input name="name" required className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" placeholder="np. Przekąska na mieście" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <label className="text-sm font-medium">Kalorie (kcal)</label>
                <input name="calories" type="number" required className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Białko (g)</label>
                <input name="protein" type="number" step="0.1" required className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Węglowodany (g)</label>
                <input name="carbs" type="number" step="0.1" required className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium">Tłuszcze (g)</label>
                <input name="fat" type="number" step="0.1" required className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              </div>
            </div>
            <Button type="submit">Dodaj własny produkt</Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isIngredientOpen} onOpenChange={(open) => {
        setIsIngredientOpen(open);
        if (!open) {
          setIngredientDialogDragY(0);
          setIsIngredientDialogExpanded(false);
          setIsIngredientDialogDragging(false);
          ingredientDialogDragStartYRef.current = null;
        }
      }}>
        <DialogContent
          className={cn(
            "max-sm:!bottom-0 max-sm:!left-0 max-sm:!top-auto max-sm:!h-[82dvh] max-sm:!w-full max-sm:!max-w-none max-sm:!max-h-[96dvh] max-sm:!translate-x-0 max-sm:!translate-y-[var(--ingredient-dialog-drag-y)] max-sm:!rounded-t-3xl max-sm:!rounded-b-none max-sm:!p-3",
            isIngredientDialogExpanded && "max-sm:!h-[96dvh]",
            isIngredientDialogDragging ? "max-sm:!duration-0" : "max-sm:!duration-200"
          )}
          style={{ "--ingredient-dialog-drag-y": `${ingredientDialogDragY}px` } as React.CSSProperties}
        >
          <div
            aria-hidden="true"
            className="mx-auto mb-1 h-1.5 w-12 cursor-grab touch-none rounded-full bg-muted-foreground/30 active:cursor-grabbing sm:hidden"
            onPointerDown={startIngredientDialogDrag}
            onPointerMove={moveIngredientDialogDrag}
            onPointerUp={finishIngredientDialogDrag}
            onPointerCancel={finishIngredientDialogDrag}
          />
          <DialogHeader>
            <DialogTitle>Dodaj składnik do posiłku</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <Input
              value={ingredientSearch}
              onChange={(e) => setIngredientSearch(e.target.value)}
              placeholder="Szukaj składnika..."
            />

            <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
              {filteredIngredients.map((ingredient: any) => (
                <button
                  key={ingredient.id}
                  onClick={() => setSelectedIngredientId(ingredient.id)}
                  className={cn(
                    "w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors",
                    selectedIngredientId === ingredient.id && "bg-primary/15 text-foreground font-medium"
                  )}
                >
                  <p>{ingredient.name}</p>
                  <p className={cn("text-xs text-muted-foreground", selectedIngredientId === ingredient.id && "text-foreground/85")}>
                    {Number(ingredient?.calories) || 0} kcal / 100g • B {Number(ingredient?.protein || 0).toFixed(1)} • W {Number(ingredient?.carbs || 0).toFixed(1)} • T {Number(ingredient?.fat || 0).toFixed(1)}
                  </p>
                  {Number(ingredient?.unitWeight || 0) > 0 && (
                    <p className={cn("text-[11px] text-muted-foreground", selectedIngredientId === ingredient.id && "text-foreground/75")}>
                      {ingredient.unitDescription ? `${ingredient.unitDescription} • ` : ""}1 szt. ≈ {ingredient.unitWeight} g
                    </p>
                  )}
                </button>
              ))}
              {filteredIngredients.length === 0 && (
                <p className="text-sm text-muted-foreground p-3">Brak składników.</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Ilość (g)</label>
              <Input
                type="number"
                min={1}
                value={ingredientAmount}
                onChange={(e) => setIngredientAmount(Number(e.target.value) || 0)}
              />
            </div>

            {selectedIngredientForQuickAdd && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
                <p className="font-semibold text-emerald-700 dark:text-emerald-300">{selectedIngredientForQuickAdd.name}</p>
                {selectedIngredientNutritionPreview && (
                  <p className="text-foreground">
                    Dla {Math.max(0, ingredientAmount)} g: {selectedIngredientNutritionPreview.calories} kcal • B: {selectedIngredientNutritionPreview.protein} g • W: {selectedIngredientNutritionPreview.carbs} g • T: {selectedIngredientNutritionPreview.fat} g
                  </p>
                )}
                {Number(selectedIngredientForQuickAdd?.unitWeight || 0) > 0 && (
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    {selectedIngredientForQuickAdd.unitDescription ? `${selectedIngredientForQuickAdd.unitDescription} • ` : ""}
                    1 szt. ≈ {selectedIngredientForQuickAdd.unitWeight} g
                  </p>
                )}
              </div>
            )}

            <Button
              className="w-full bg-emerald-600 hover:bg-emerald-700"
              onClick={handleAddIngredient}
              disabled={!selectedIngredientId || ingredientAmount <= 0}
            >
              Dodaj składnik
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingDuplicateOverflow} onOpenChange={(open) => { if (!open) cancelPendingDuplicateOverflow(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Duplikacja przekroczy porcje wspólnego posiłku</DialogTitle>
          </DialogHeader>

          {pendingDuplicateOverflow && (
            <div className="space-y-4 text-sm">
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                <p className="font-semibold">
                  „{pendingDuplicateOverflow.entry?.recipe?.name || pendingDuplicateOverflow.entry?.customName || "Posiłek"}” jest przypisany do zakładki „Wspólne posiłki”.
                </p>
                <p className="mt-1">
                  Duplikat doda {pendingDuplicateOverflow.requestedServings} porcji. W tej partii zostało {pendingDuplicateOverflow.remainingServings} z {Number(pendingDuplicateOverflow.batch?.totalServings) || 0} porcji, więc zabraknie {pendingDuplicateOverflow.overflow} porcji.
                </p>
              </div>

              <div className="grid gap-2">
                <Button
                  onClick={duplicateWithRemainingSharedServings}
                  disabled={pendingDuplicateOverflow.remainingServings <= 0}
                  variant="outline"
                  className="h-auto justify-start whitespace-normal py-3 text-left"
                >
                  Zmniejsz duplikat do {pendingDuplicateOverflow.remainingServings} porcji, żeby pozostało 0
                </Button>
                <Button
                  onClick={duplicateIntoNewSharedBatch}
                  className="h-auto justify-start whitespace-normal py-3 text-left"
                >
                  Utwórz nowy wspólny posiłek dla {pendingDuplicateOverflow.requestedServings} porcji
                </Button>
                <Button variant="ghost" onClick={cancelPendingDuplicateOverflow}>
                  Zrezygnuj z duplikacji
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={pendingSharedBatchPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSharedBatchPrompt(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Utworzyć wspólny posiłek?</AlertDialogTitle>
            <AlertDialogDescription>
              Przepis „{pendingSharedBatchPrompt?.recipe?.name}” ma {Number(pendingSharedBatchPrompt?.recipe?.servings) || 1} porcji, a do planu dodajesz teraz {addRecipeForBothPeople
                ? Number(selectedPersonServings.A || 0) + Number(selectedPersonServings.B || 0)
                : Number(selectedRecipeServings) || 0}. Utworzenie wspólnego posiłku zachowa pozostałe porcje do późniejszego rozdysponowania.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              const pending = pendingSharedBatchPrompt;
              setPendingSharedBatchPrompt(null);
              if (pending) handleAdd(pending.recipeId, pending.recipe, false);
            }}>
              Nie, dodaj bez wspólnego posiłku
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              const pending = pendingSharedBatchPrompt;
              setPendingSharedBatchPrompt(null);
              if (pending) handleAdd(pending.recipeId, pending.recipe, true);
            }}>
              Tak, utwórz wspólny posiłek
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}

function DaySection({ day, sectionId, recipes, userSettings, allAvailableIngredients = [], onAddMeal, onAddCustom, onAddIngredient, onDeleteMeal, onToggleEaten, onUpdateEntry, onDuplicateEntry, touchMoveEntry, setTouchMoveEntry, onCopyDay, onSaveIdealDay, onViewRecipe, onViewWholeRecipe, onViewPlannedRecipe }: any) {
  const [servingInputs, setServingInputs] = useState<Record<number, string>>({});
  const [variantOptionsByRecipe, setVariantOptionsByRecipe] = useState<Record<number, PortionVariant[]>>({});
  const [selectedVariantByEntry, setSelectedVariantByEntry] = useState<Record<number, PortionVariant>>({});
  const [selectedEntries, setSelectedEntries] = useState<Record<number, boolean>>({});
  const [draggedEntryId, setDraggedEntryId] = useState<number | null>(null);
  const [isCopyDragging, setIsCopyDragging] = useState(false);
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);
  const [mobileTransferEntry, setMobileTransferEntry] = useState<any | null>(null);
  const [mobileTransferForm, setMobileTransferForm] = useState<{ mode: "move" | "copy"; date: string; mealType: string; person: "A" | "B" }>({
    mode: "move",
    date: format(day, "yyyy-MM-dd"),
    mealType: "lunch",
    person: "A",
  });
  const [editingCustomEntry, setEditingCustomEntry] = useState<any | null>(null);
  const [customEditForm, setCustomEditForm] = useState({
    name: "",
    calories: "",
    protein: "",
    carbs: "",
    fat: "",
    ingredientId: "",
    amount: "",
  });
  const ingredientSettingsById = useMemo(() => {
    const byId = new Map<number, any>();
    (allAvailableIngredients || []).forEach((ingredient: any) => {
      const id = Number(ingredient?.id);
      if (Number.isFinite(id) && id > 0) byId.set(id, ingredient);
    });
    return byId;
  }, [allAvailableIngredients]);
  const dateStr = format(day, "yyyy-MM-dd");
  const { data: dayPlan, isLoading } = useDayPlanSummary(dateStr);
  useEffect(() => {
    const recipeIds: number[] = Array.from(new Set<number>((((dayPlan as any)?.entries || []) as any[]).map((entry: any): number => Number(entry.recipe?.id)).filter((id: number) => id > 0)));
    recipeIds.forEach(async (recipeId) => {
      if (variantOptionsByRecipe[recipeId]) return;
      try {
        const recipe = await fetchRecipeDetails(recipeId);
        const variants = getAvailableVariants(recipe?.ingredients || []);
        if (variants.length) setVariantOptionsByRecipe((prev) => ({ ...prev, [recipeId]: variants }));
      } catch (error) { console.error("Failed to detect meal plan recipe variants", error); }
    });
  }, [dayPlan, variantOptionsByRecipe]);
  const isToday = dateStr === format(new Date(), "yyyy-MM-dd");

  useEffect(() => {
    setSelectedEntries({});
  }, [dateStr]);

  const getEffectiveIngredientAmount = (ri: any, entry: any) => {
    if (typeof ri?.calculatedAmount === "number") return ri.calculatedAmount;
    const entryServings = Number(entry?.servings) || 1;
    const recipeServings = Number(entry?.recipe?.servings) || 1;
    return calculateScaledAmount(ri, entryServings, recipeServings);
  };

  const calculateEntrySummary = (entry: any) => {
    if (entry.totals) {
      return {
        calories: Number((Number(entry.totals.calories) || 0).toFixed(1)),
        protein: Number((Number(entry.totals.protein) || 0).toFixed(1)),
        carbs: Number((Number(entry.totals.carbs) || 0).toFixed(1)),
        fat: Number((Number(entry.totals.fat) || 0).toFixed(1)),
        sugar: Math.round((Number(entry.totals.sugar) || 0) * 10) / 10,
        fiber: Math.round((Number(entry.totals.fiber) || 0) * 10) / 10,
        price: Math.round((Number(entry.totals.price) || 0) * 100) / 100,
      };
    }
    const entryServings = Number(entry.servings) || 1;
    const ingredientsToUse = entry.ingredients?.length > 0 ? entry.ingredients : (entry.recipe?.ingredients || []);
    let calories = 0;
    let protein = 0;
    let carbs = 0;
    let fat = 0;
    let sugar = 0;
    let fiber = 0;
    let price = 0;

    if (ingredientsToUse.length > 0) {
      ingredientsToUse.forEach((ri: any) => {
        if (!ri.ingredient) return;
        const effectiveAmount = getEffectiveIngredientAmount(ri, entry);
        const nutritionAmount = calculateNutritionAmount(effectiveAmount, ri.ingredient);
        const purchaseAmount = calculatePurchaseAmount(effectiveAmount, ri.ingredient);
        const multiplier = nutritionAmount / 100;
        calories += (ri.ingredient.calories || 0) * multiplier;
        protein += (ri.ingredient.protein || 0) * multiplier;
        carbs += (ri.ingredient.carbs || 0) * multiplier;
        fat += (ri.ingredient.fat || 0) * multiplier;
        sugar += (ri.ingredient.sugar || 0) * multiplier;
        fiber += (ri.ingredient.fiber || 0) * multiplier;
        price += (ri.ingredient.price || 0) * (purchaseAmount / 100);
      });
    } else {
      calories += (entry.customCalories || 0) * entryServings;
      protein += (entry.customProtein || 0) * entryServings;
      carbs += (entry.customCarbs || 0) * entryServings;
      fat += (entry.customFat || 0) * entryServings;
      sugar += (entry.customSugar || 0) * entryServings;
      fiber += (entry.customFiber || 0) * entryServings;
      price += (entry.customPrice || 0) * entryServings;
    }

    return {
      calories: Number(calories.toFixed(1)),
      protein: Number(protein.toFixed(1)),
      carbs: Number(carbs.toFixed(1)),
      fat: Number(fat.toFixed(1)),
      sugar: Math.round(sugar * 10) / 10,
      fiber: Math.round(fiber * 10) / 10,
      price: Math.round(price * 100) / 100,
    };
  };

  const calculateSummary = (entries: any[]) => entries.reduce((sum, entry: any) => {
    const entrySummary = calculateEntrySummary(entry);
    return {
      calories: sum.calories + entrySummary.calories,
      protein: sum.protein + entrySummary.protein,
      carbs: sum.carbs + entrySummary.carbs,
      fat: sum.fat + entrySummary.fat,
      sugar: sum.sugar + entrySummary.sugar,
      fiber: sum.fiber + entrySummary.fiber,
      price: Math.round((sum.price + entrySummary.price) * 100) / 100,
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0, price: 0 });

  const people = ["A", "B"] as const;
  const personName: Record<"A" | "B", string> = { A: "Tysia", B: "Mati" };
  const personEntries = useMemo(() => ({
    A: dayPlan?.entries.filter((e: any) => (e.person || "A") === "A") || [],
    B: dayPlan?.entries.filter((e: any) => (e.person || "A") === "B") || [],
  }), [dayPlan]);

  const personSummary = useMemo(() => ({
    A: calculateSummary(personEntries.A),
    B: calculateSummary(personEntries.B),
  }), [personEntries]);

  // Planned produce amounts are calculated per person from the actual recipe
  // ingredient quantities (including serving scaling and edible percentages).
  const personProduceTotals = useMemo(() => {
    const totals = {
      A: { vegetables: 0, fruits: 0 },
      B: { vegetables: 0, fruits: 0 },
    };
    for (const person of people) {
      for (const entry of personEntries[person]) {
        const rows = Array.isArray(entry.ingredients) && entry.ingredients.length
          ? entry.ingredients
          : (entry.recipe?.ingredients || []);
        for (const row of rows) {
          const ingredientId = Number(row.ingredientId ?? row.ingredient?.id);
          const ingredient = ingredientSettingsById.get(ingredientId) || row.ingredient;
          if (!ingredient) continue;
          const amount = getEffectiveIngredientAmount(row, entry);
          const edibleGrams = calculateNutritionAmount(amount, ingredient);
          const contribution = getProduceContribution(ingredient, edibleGrams);
          if (contribution.produceType === "vegetable") totals[person].vegetables += contribution.grams;
          else if (contribution.produceType === "fruit") totals[person].fruits += contribution.grams;
        }
      }
    }
    return totals;
  }, [personEntries, ingredientSettingsById]);

  const macroCaloriesPerGram = { protein: 4, carbs: 4, fat: 9 } as const;
  const getMacroPercentageRange = (settings: any, macro: "Protein" | "Carbs" | "Fat", fallbackPercentage: number) => {
    const min = Number(settings?.[`target${macro}PercentageMin`] ?? settings?.[`target${macro}Percentage`] ?? fallbackPercentage);
    const max = Number(settings?.[`target${macro}PercentageMax`] ?? settings?.[`target${macro}Percentage`] ?? fallbackPercentage);
    return min <= max ? { min, max } : { min: max, max: min };
  };
  const getMacroGramRange = (calories: number, macroKey: "protein" | "carbs" | "fat", range: { min: number; max: number }) => {
    const min = Math.round((calories * range.min) / 100 / macroCaloriesPerGram[macroKey]);
    const max = Math.round((calories * range.max) / 100 / macroCaloriesPerGram[macroKey]);
    return min === max ? `cel: ${min} g` : `cel: ${min}-${max} g`;
  };
  const getNutrientRange = (minValue: unknown, maxValue: unknown) => {
    const min = Number(minValue) || 0;
    const max = Number(maxValue) || 0;
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);
    return { min: lower, max: upper };
  };
  const formatNutrientRange = (range: { min: number; max: number }) => {
    const min = Math.round(range.min * 10) / 10;
    const max = Math.round(range.max * 10) / 10;
    return min === max ? `cel: ${min} g` : `cel: ${min}-${max} g`;
  };

  const personTargets = useMemo(() => {
    const buildTargets = (settings: any, fallback: any) => {
      const calories = Number(settings?.targetCalories ?? fallback?.targetCalories ?? 2000);
      return {
        calories,
        protein: Number(settings?.targetProtein ?? fallback?.targetProtein ?? 150),
        carbs: Number(settings?.targetCarbs ?? fallback?.targetCarbs ?? 200),
        fat: Number(settings?.targetFat ?? fallback?.targetFat ?? 65),
        proteinRange: getMacroPercentageRange(settings ?? fallback, "Protein", 30),
        carbsRange: getMacroPercentageRange(settings ?? fallback, "Carbs", 40),
        fatRange: getMacroPercentageRange(settings ?? fallback, "Fat", 30),
        sugarRange: getNutrientRange(
          settings?.targetSugarMin ?? fallback?.targetSugarMin,
          settings?.targetSugarMax ?? fallback?.targetSugarMax,
        ),
        fiberRange: getNutrientRange(
          settings?.targetFiberMin ?? fallback?.targetFiberMin,
          settings?.targetFiberMax ?? fallback?.targetFiberMax,
        ),
      };
    };
    return {
      A: buildTargets(userSettings?.A, null),
      B: buildTargets(userSettings?.B, userSettings?.A),
    };
  }, [userSettings]);

  const sharedEntries = useMemo(() => {
    const sharedMap = new Map<string, { A: any; B: any }>();

    personEntries.A.forEach((entry: any) => {
      if (!entry.recipeId || entry.isEaten === true) return;
      const batchId = Number(entry.cookedBatchId || 0);
      const key = batchId > 0 ? `batch:${batchId}` : `fallback:${entry.mealType}__${entry.recipeId}`;
      sharedMap.set(key, { A: entry, B: null as any });
    });

    personEntries.B.forEach((entry: any) => {
      if (!entry.recipeId || entry.isEaten === true) return;
      const batchId = Number(entry.cookedBatchId || 0);
      const key = batchId > 0 ? `batch:${batchId}` : `fallback:${entry.mealType}__${entry.recipeId}`;
      const current = sharedMap.get(key);
      if (current?.A) {
        current.B = entry;
        sharedMap.set(key, current);
      } else if (batchId > 0) {
        sharedMap.set(key, { A: null as any, B: entry });
      }
    });

    const mealOrder: Record<string, number> = { breakfast: 0, snack: 1, lunch: 2, dinner: 3 };
    return Array.from(sharedMap.values())
      .filter((pair) => {
        if (pair.A && pair.B) return true;
        const singleEntry = pair.A || pair.B;
        return Number(singleEntry?.cookedBatchId || 0) > 0;
      })
      .sort((left, right) => (mealOrder[(left.A || left.B)?.mealType] ?? 99) - (mealOrder[(right.A || right.B)?.mealType] ?? 99))
      .map((pair) => {
        const primaryEntry = pair.A || pair.B;
        const allocatedServings = (Number(pair.A?.servings) || 0) + (Number(pair.B?.servings) || 0);
        const scaledIngredients = buildSharedIngredientsSummary({
          entriesA: pair.A ? [pair.A] : [],
          entriesB: pair.B ? [pair.B] : [],
          recipe: primaryEntry?.recipe,
        });

        return {
          mealType: primaryEntry?.mealType,
          recipe: primaryEntry?.recipe,
          servings: allocatedServings,
          ingredients: scaledIngredients,
          entryA: pair.A || primaryEntry,
          entryB: pair.B || null,
        };
      });
  }, [personEntries]);

  const applyServingInput = (entry: any) => {
    const rawValue = servingInputs[entry.id];
    if (rawValue === undefined) return;

    const parsed = Number(rawValue.replace(",", "."));
    if (!parsed || parsed <= 0) {
      setServingInputs((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
      return;
    }

    const rounded = Math.round(parsed * 100) / 100;
    onUpdateEntry(entry, { servings: rounded });
    setServingInputs((prev) => {
      const next = { ...prev };
      delete next[entry.id];
      return next;
    });
  };

  const dayEntries = dayPlan?.entries || [];
  const selectedEntryIds = Object.entries(selectedEntries)
    .filter(([, checked]) => checked)
    .map(([id]) => Number(id))
    .filter((id) => Number.isFinite(id));

  const deleteEntries = (entryIds: number[]) => {
    entryIds.forEach((id) => onDeleteMeal({ id, date: dateStr }));
    setSelectedEntries((prev) => {
      const next = { ...prev };
      entryIds.forEach((id) => {
        delete next[id];
      });
      return next;
    });
  };

  const clearPersonDay = (person: "A" | "B") => {
    const ids = dayEntries
      .filter((entry: any) => (entry.person || "A") === person)
      .map((entry: any) => Number(entry.id))
      .filter((id: number) => Number.isFinite(id));
    deleteEntries(ids);
  };

  const clearWholeDay = () => {
    const ids = dayEntries
      .map((entry: any) => Number(entry.id))
      .filter((id: number) => Number.isFinite(id));
    deleteEntries(ids);
  };

  const handleEatenButtonPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // Match Dashboard behavior: keep the interaction on the eaten toggle so
    // mobile taps do not fall through to the draggable card or select text.
    event.stopPropagation();
  };

  const handleEatenButtonClick = (event: MouseEvent<HTMLButtonElement>, entry: any) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleEaten({ id: entry.id, isEaten: !entry.isEaten });
  };

  const mealTypeLabels: Record<string, string> = {
    breakfast: "Śniadanie",
    snack: "Lunch",
    lunch: "Obiad",
    dinner: "Kolacja",
  };

  const openMobileTransferSheet = (entry: any) => {
    setTouchMoveEntry(null);
    setMobileTransferEntry(entry);
    setMobileTransferForm({
      mode: "move",
      date: String(entry.date || dateStr),
      mealType: String(entry.mealType || "lunch"),
      person: (entry.person || "A") as "A" | "B",
    });
  };

  const submitMobileTransfer = () => {
    if (!mobileTransferEntry?.id) return;

    const target = {
      date: mobileTransferForm.date || dateStr,
      mealType: mobileTransferForm.mealType || "lunch",
      person: mobileTransferForm.person || "A",
    };

    if (mobileTransferForm.mode === "copy") {
      onDuplicateEntry(mobileTransferEntry, target);
    } else {
      onUpdateEntry(mobileTransferEntry, target);
    }

    setMobileTransferEntry(null);
    setDraggedEntryId(null);
    setIsCopyDragging(false);
    setTouchMoveEntry(null);
    setDragOverSlot(null);
  };

  const handleDropEntry = (entryId: number | null, sourceDate: string, targetMealType: string, targetPerson: "A" | "B", mode: "move" | "copy" = "move", sourceEntrySnapshot?: any) => {
    if (!entryId) return;
    const sourceEntry = sourceEntrySnapshot || dayEntries.find((entry: any) => Number(entry.id) === Number(entryId));
    if (mode === "copy" && sourceEntry) {
      onDuplicateEntry(sourceEntry, { date: dateStr, mealType: targetMealType, person: targetPerson });
    } else {
      const draggedEntry = { id: entryId, date: sourceDate };
      onUpdateEntry(draggedEntry, { date: dateStr, mealType: targetMealType, person: targetPerson });
    }
    setDraggedEntryId(null);
    setIsCopyDragging(false);
    setTouchMoveEntry(null);
    setDragOverSlot(null);
  };

  const openCustomEditDialog = (entry: any) => {
    const firstIngredient = entry?.ingredients?.[0];
    setEditingCustomEntry(entry);
    setCustomEditForm({
      name: String(entry?.customName || ""),
      calories: String(entry?.customCalories ?? ""),
      protein: String(entry?.customProtein ?? ""),
      carbs: String(entry?.customCarbs ?? ""),
      fat: String(entry?.customFat ?? ""),
      ingredientId: firstIngredient?.ingredientId ? String(firstIngredient.ingredientId) : "",
      amount: firstIngredient?.amount ? String(firstIngredient.amount) : "",
    });
  };

  const updateCustomEditForm = (field: keyof typeof customEditForm, value: string) => {
    setCustomEditForm((prev) => ({ ...prev, [field]: value }));
  };

  const selectedCustomIngredient = useMemo(() => (allAvailableIngredients || []).find((ingredient: any) => String(ingredient.id) === customEditForm.ingredientId) || null, [allAvailableIngredients, customEditForm.ingredientId]);

  const saveCustomEdit = () => {
    if (!editingCustomEntry?.id) return;

    const amount = Math.max(1, Math.round(Number(customEditForm.amount) || 0));
    if (editingCustomEntry.ingredients?.length && selectedCustomIngredient && amount > 0) {
      const factor = amount / 100;
      onUpdateEntry(editingCustomEntry, {
        customName: selectedCustomIngredient.name,
        customCalories: Math.round((selectedCustomIngredient.calories || 0) * factor),
        customProtein: Number(((selectedCustomIngredient.protein || 0) * factor).toFixed(1)),
        customCarbs: Number(((selectedCustomIngredient.carbs || 0) * factor).toFixed(1)),
        customFat: Number(((selectedCustomIngredient.fat || 0) * factor).toFixed(1)),
        customSugar: Number(((selectedCustomIngredient.sugar || 0) * factor).toFixed(1)),
        customFiber: Number(((selectedCustomIngredient.fiber || 0) * factor).toFixed(1)),
        ingredients: [{ ingredientId: Number(selectedCustomIngredient.id), amount }],
        servings: 1,
      });
    } else {
      onUpdateEntry(editingCustomEntry, {
        customName: customEditForm.name.trim() || editingCustomEntry.customName || "Własny posiłek",
        customCalories: Math.max(0, Math.round(Number(customEditForm.calories) || 0)),
        customProtein: Math.max(0, Number(Number(customEditForm.protein || 0).toFixed(1))),
        customCarbs: Math.max(0, Number(Number(customEditForm.carbs || 0).toFixed(1))),
        customFat: Math.max(0, Number(Number(customEditForm.fat || 0).toFixed(1))),
      });
    }

    setEditingCustomEntry(null);
  };

  return (
    <div id={sectionId} className={cn("space-y-4", isToday && "bg-primary/5 -mx-4 px-4 py-6 rounded-3xl border border-primary/10")}>
      <div className="flex flex-col md:flex-row md:items-baseline gap-4 mb-4">
        <div className="flex flex-wrap items-baseline gap-2 sm:gap-4">
          <h2 className="text-2xl font-bold font-display">{format(day, "EEEE", { locale: pl })}</h2>
          <span className="text-muted-foreground">{format(day, "d MMMM", { locale: pl })}</span>
          {isToday && <span className="text-xs font-bold uppercase tracking-wider text-primary bg-primary/10 px-2 py-1 rounded-full">Dzisiaj</span>}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label="Opcje dnia">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Opcje dnia</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onCopyDay(dateStr)}>
              <Copy className="h-4 w-4" />
              Kopiuj na inny dzień
            </DropdownMenuItem>
            <DropdownMenuItem disabled={dayEntries.length === 0} onSelect={() => onSaveIdealDay(dateStr)}>
              <CheckCircle2 className="h-4 w-4" />
              Dodaj do idealnych dni
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={selectedEntryIds.length === 0}
              onSelect={() => deleteEntries(selectedEntryIds)}
            >
              <Trash2 className="h-4 w-4" />
              Usuń zaznaczone ({selectedEntryIds.length})
            </DropdownMenuItem>
            <DropdownMenuItem disabled={personEntries.A.length === 0} onSelect={() => clearPersonDay("A")}>
              Wyczyść dzień Tysi
            </DropdownMenuItem>
            <DropdownMenuItem disabled={personEntries.B.length === 0} onSelect={() => clearPersonDay("B")}>
              Wyczyść dzień Matiego
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={dayEntries.length === 0}
              onSelect={clearWholeDay}
              className="text-destructive focus:text-destructive"
            >
              Wyczyść cały dzień
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel>Przepisy na wspólne posiłki</DropdownMenuLabel>
            {sharedEntries.length > 0 ? (
              sharedEntries.map((shared: any, idx: number) => (
                <DropdownMenuItem
                  key={`shared-menu-${shared.mealType}-${shared.recipe?.id}-${idx}`}
                  onSelect={() => onViewPlannedRecipe(shared.recipe, {
                    ...shared.entryA,
                    servings: shared.servings,
                    ingredients: shared.ingredients,
                    sharedParticipantEntries: { A: shared.entryA, B: shared.entryB },
                  }, { shared: true })}
                  className="items-start"
                >
                  <Eye className="mt-0.5 h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">{shared.recipe?.name || "Wspólny posiłek"}</span>
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>Brak wspólnych posiłków</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>


        {dayPlan && (
          <div className="w-full grid grid-cols-1 xl:grid-cols-2 gap-3">
            {people.map((person) => (
              <div key={person} className="rounded-xl border border-border/60 bg-white/70 p-2.5 dark:bg-card/70">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-bold">{personName[person]}</span>
                  <span className="text-[11px] font-medium text-muted-foreground dark:text-foreground/80">Koszt dnia: {personSummary[person].price.toFixed(2)} PLN</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <div className="flex min-w-[64px] flex-col items-center rounded-lg border border-border bg-white px-2 py-0.5 shadow-sm dark:bg-background/70">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">kcal</span>
                    <span className="text-sm font-bold text-primary">{personSummary[person].calories}</span>
                    <span className="text-[10px] text-muted-foreground">cel: {Math.round(personTargets[person].calories)} kcal</span>
                  </div>
                  <div className="flex min-w-[56px] flex-col items-center rounded-lg border border-border bg-white px-2 py-0.5 shadow-sm dark:bg-background/70">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">P</span>
                    <span className="text-sm font-bold text-blue-600">{personSummary[person].protein}g</span>
                    <span className="text-[10px] text-muted-foreground">{getMacroGramRange(personTargets[person].calories, "protein", personTargets[person].proteinRange)}</span>
                  </div>
                  <div className="flex min-w-[56px] flex-col items-center rounded-lg border border-border bg-white px-2 py-0.5 shadow-sm dark:bg-background/70">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">C</span>
                    <span className="text-sm font-bold text-amber-600">{personSummary[person].carbs}g</span>
                    <span className="text-[10px] text-muted-foreground">{getMacroGramRange(personTargets[person].calories, "carbs", personTargets[person].carbsRange)}</span>
                  </div>
                  <div className="flex min-w-[56px] flex-col items-center rounded-lg border border-border bg-white px-2 py-0.5 shadow-sm dark:bg-background/70">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">F</span>
                    <span className="text-sm font-bold text-rose-600">{personSummary[person].fat}g</span>
                    <span className="text-[10px] text-muted-foreground">{getMacroGramRange(personTargets[person].calories, "fat", personTargets[person].fatRange)}</span>
                  </div>
                  <div className="flex min-w-[56px] flex-col items-center rounded-lg border border-border bg-white px-2 py-0.5 shadow-sm dark:bg-background/70">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Cukry</span>
                    <span className="text-sm font-bold text-orange-600">{Math.round(personSummary[person].sugar * 10) / 10}g</span>
                    <span className="text-[10px] text-muted-foreground">{formatNutrientRange(personTargets[person].sugarRange)}</span>
                  </div>
                  <div className="flex min-w-[56px] flex-col items-center rounded-lg border border-border bg-white px-2 py-0.5 shadow-sm dark:bg-background/70">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Błonnik</span>
                    <span className="text-sm font-bold text-green-600">{Math.round(personSummary[person].fiber * 10) / 10}g</span>
                    <span className="text-[10px] text-muted-foreground">{formatNutrientRange(personTargets[person].fiberRange)}</span>
                  </div>
                  <div className="flex min-w-[68px] flex-col items-center rounded-lg border border-border bg-white px-2 py-0.5 shadow-sm dark:bg-background/70">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Warzywa</span>
                    <span className="text-sm font-bold text-emerald-700">{Math.round(personProduceTotals[person].vegetables)}g</span>
                    <span className="text-[10px] text-muted-foreground">cel: {Math.round(Number(userSettings?.[person]?.targetVegetables) || 0)}g</span>
                  </div>
                  <div className="flex min-w-[68px] flex-col items-center rounded-lg border border-border bg-white px-2 py-0.5 shadow-sm dark:bg-background/70">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Owoce</span>
                    <span className="text-sm font-bold text-orange-600">{Math.round(personProduceTotals[person].fruits)}g</span>
                    <span className="text-[10px] text-muted-foreground">cel: {Math.round(Number(userSettings?.[person]?.targetFruits) || 0)}g</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stabilized render tree for dual-person meal plan layout */}
      {isLoading ? <LoadingSpinner /> : (
        <div className="space-y-3">
          {people.map((person) => (
            <div key={person} className="space-y-2">
              <div className="text-sm font-bold text-muted-foreground uppercase tracking-wider">{personName[person]}</div>
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-4">
                {["breakfast", "snack", "lunch", "dinner"].map((mealType) => {
                  const entries = dayPlan?.entries.filter((e: any) => e.mealType === mealType && (e.person || "A") === person) || [];
                  const mealSummary = calculateSummary(entries);

                  return (
                    <div
                      key={`${person}-${mealType}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        const copyMode = e.altKey || e.ctrlKey || e.metaKey;
                        e.dataTransfer.dropEffect = copyMode ? "copy" : "move";
                        setIsCopyDragging(copyMode);
                        setDragOverSlot(`${person}-${mealType}`);
                      }}
                      onDragLeave={() => setDragOverSlot((prev) => (prev === `${person}-${mealType}` ? null : prev))}
                      onDrop={(e) => {
                        e.preventDefault();
                        const droppedId = Number(e.dataTransfer.getData("text/meal-entry-id")) || draggedEntryId;
                        const droppedDate = e.dataTransfer.getData("text/meal-entry-date") || dateStr;
                        const dropMode = e.altKey || e.ctrlKey || e.metaKey ? "copy" : "move";
                        const droppedEntryJson = e.dataTransfer.getData("text/meal-entry-json");
                        const droppedEntry = droppedEntryJson ? JSON.parse(droppedEntryJson) : undefined;
                        handleDropEntry(droppedId, droppedDate, mealType, person, dropMode, droppedEntry);
                      }}
                      onClick={() => {
                        if (touchMoveEntry?.id) {
                          handleDropEntry(touchMoveEntry.id, touchMoveEntry.date, mealType, person, touchMoveEntry.mode || "move", touchMoveEntry.entry);
                        }
                      }}
                      className={cn(
                        "flex flex-col rounded-xl border border-border/60 bg-white p-2.5 shadow-sm transition-colors",
                        dragOverSlot === `${person}-${mealType}` && (isCopyDragging ? "border-emerald-500/70 bg-emerald-50" : "border-primary/70 bg-primary/5"),
                        touchMoveEntry?.id && (touchMoveEntry.mode === "copy" ? "cursor-copy" : "cursor-move")
                      )}
                    >
                      <div className="mb-2 flex items-start justify-between gap-2 border-b border-border/50 pb-1.5">
                        <div className="min-w-0">
                          <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                            {mealTypeLabels[mealType] || mealType}
                          </h3>
                          {entries.length > 0 && (
                            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                              {mealSummary.calories} kcal · B {mealSummary.protein} g · W {mealSummary.carbs} g · T {mealSummary.fat} g
                              <br />
                              Cukry {mealSummary.sugar} g · Błonnik {mealSummary.fiber} g
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50" onClick={() => onAddIngredient(mealType, dateStr, person)} title="Dodaj składnik">
                            <Carrot className="w-3.5 h-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-primary" onClick={() => onAddCustom(mealType, dateStr, person)} title="Add Custom">
                            <Plus className="w-3 h-3 border rounded-full p-0.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-primary" onClick={() => onAddMeal(mealType, dateStr, person)} title="Add Recipe">
                            <Plus className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="flex-1 space-y-1.5">
                        {entries.map((entry: any) => (
                          <div
                            key={entry.id}
                            draggable
                            onDragStart={(e) => {
                              setDraggedEntryId(Number(entry.id));
                              e.dataTransfer.effectAllowed = "copyMove";
                              e.dataTransfer.setData("text/meal-entry-id", String(entry.id));
                              e.dataTransfer.setData("text/meal-entry-date", String(entry.date || dateStr));
                              e.dataTransfer.setData("text/meal-entry-json", JSON.stringify(entry));
                            }}
                            onDragEnd={() => {
                              setDraggedEntryId(null);
                              setIsCopyDragging(false);
                              setDragOverSlot(null);
                            }}
                            className={cn(
                              "group relative flex flex-col gap-1.5 overflow-hidden rounded-lg border p-1.5 transition-colors",
                              entry.isEaten
                                ? "bg-emerald-100 border-emerald-300 dark:bg-emerald-950/50 dark:border-emerald-800"
                                : "bg-background border-border",
                              draggedEntryId === Number(entry.id) && "opacity-60",
                              touchMoveEntry?.id === Number(entry.id) && (touchMoveEntry.mode === "copy" ? "ring-2 ring-emerald-500/60" : "ring-2 ring-primary/60"),
                            )}
                          >
                            <div className="flex min-w-0 items-start gap-1.5">
                              <input
                                type="checkbox"
                                checked={!!selectedEntries[entry.id]}
                                onChange={(e) => setSelectedEntries((prev) => ({ ...prev, [entry.id]: e.target.checked }))}
                                aria-label={`Zaznacz posiłek ${entry.recipe?.name || entry.customName}`}
                                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                              />
                              {entry.recipe ? (
                                <div className="h-9 w-9 shrink-0 rounded-lg bg-cover bg-center" style={{ backgroundImage: `url(${entry.recipe.imageUrl})` }} />
                              ) : (
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                                  <Plus className="h-4 w-4 text-muted-foreground/30" />
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-start gap-1">
                                  <p className={cn("min-w-0 flex-1 truncate text-sm font-semibold leading-snug", entry.isEaten && "line-through text-muted-foreground dark:text-emerald-100")} title={entry.recipe?.name || entry.customName}>
                                    {entry.recipe?.name || entry.customName}
                                  </p>
                                  {entry.recipe && (
                                    <button onClick={() => onViewPlannedRecipe(entry.recipe, entry)} className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary" title="Podgląd przepisu" aria-label="Podgląd przepisu">
                                      <Eye className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {entry.recipe && (
                                    <button onClick={() => onViewWholeRecipe(entry, dayEntries)} className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary" title="Pokaż cały przepis" aria-label={`Pokaż cały przepis: ${entry.recipe?.name}`}>
                                      <NotebookText className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {!entry.recipe && (
                                    <button onClick={() => openCustomEditDialog(entry)} className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary" title="Edytuj własny posiłek" aria-label="Edytuj własny posiłek">
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                                <p className="text-[10px] text-muted-foreground">
                                  {calculateEntrySummary(entry).calories} kcal • Cena: {calculateEntrySummary(entry).price.toFixed(2)} zł
                                  {!entry.recipe && (entry.ingredients?.length ? ` • ${entry.ingredients[0]?.amount || 0} g` : " • Custom Item")}
                                </p>
                              </div>
                            </div>

                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-1 pl-5">
                              <div className="flex min-w-0 flex-wrap items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => setTouchMoveEntry((prev: any) => (prev?.id === Number(entry.id) && prev?.mode === "move" ? null : { id: Number(entry.id), date: String(entry.date || dateStr), mode: "move", entry }))}
                                  className={cn(
                                    "hidden rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-primary md:inline-flex",
                                    touchMoveEntry?.id === Number(entry.id) && touchMoveEntry.mode !== "copy" && "bg-primary/10 text-primary"
                                  )}
                                  title="Przenieś: kliknij, potem stuknij slot docelowy"
                                  aria-label="Przenieś posiłek do innego slotu"
                                >
                                  <GripVertical className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setTouchMoveEntry((prev: any) => (prev?.id === Number(entry.id) && prev?.mode === "copy" ? null : { id: Number(entry.id), date: String(entry.date || dateStr), mode: "copy", entry }))}
                                  className={cn(
                                    "hidden rounded-md p-1 text-muted-foreground hover:bg-emerald-50 hover:text-emerald-700 md:inline-flex",
                                    touchMoveEntry?.id === Number(entry.id) && touchMoveEntry.mode === "copy" && "bg-emerald-50 text-emerald-700"
                                  )}
                                  title="Duplikuj: kliknij, potem stuknij slot docelowy"
                                  aria-label="Duplikuj posiłek do innego slotu"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openMobileTransferSheet(entry)}
                                  className="inline-flex items-center gap-1 rounded-md bg-muted/70 px-2 py-1 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-primary md:hidden"
                                  title="Przenieś albo duplikuj"
                                  aria-label="Otwórz przenoszenie lub duplikowanie posiłku"
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                  Akcje
                                </button>
                                {!entry.recipe && entry.ingredients?.length ? (
                                  <>
                                    <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => {
                                      const currentAmount = Number(entry.ingredients[0]?.amount) || 0;
                                      const nextAmount = Math.max(1, currentAmount - 10);
                                      onUpdateEntry(entry, { ingredients: [{ ingredientId: entry.ingredients[0].ingredientId, amount: nextAmount }] });
                                    }}>
                                      <Minus className="h-3 w-3" />
                                    </Button>
                                    <button type="button" onClick={() => openCustomEditDialog(entry)} className="min-w-[42px] rounded px-1 text-center text-[10px] font-medium hover:bg-muted" title="Edytuj składnik i ilość">{entry.ingredients[0]?.amount || 0} g</button>
                                    <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => {
                                      const currentAmount = Number(entry.ingredients[0]?.amount) || 0;
                                      onUpdateEntry(entry, { ingredients: [{ ingredientId: entry.ingredients[0].ingredientId, amount: currentAmount + 10 }] });
                                    }}>
                                      <Plus className="h-3 w-3" />
                                    </Button>
                                  </>
                                ) : (isIndividualVariantRecipe(entry.recipe) || (variantOptionsByRecipe[Number(entry.recipe?.id)]?.length || 0) > 0) ? (
                                  <div className="flex min-w-0 items-center gap-1">
                                    <Button size="icon" variant="ghost" className="h-6 w-6 rounded-full" aria-label="Poprzedni wariant" onClick={async () => {
                                        const recipeId = Number(entry.recipe?.id);
                                        const configured = variantOptionsByRecipe[recipeId] || getAvailableVariants(entry.recipe?.ingredients || []);
                                        const variants: PortionVariant[] = configured;
                                        if (!variants.length) return;
                                        const displayedVariant = selectedVariantByEntry[Number(entry.id)] || entry.portionVariant || variants[0] || "B";
                                        const current = Math.max(0, variants.indexOf(displayedVariant as PortionVariant));
                                        const next = variants[(current - 1 + variants.length) % variants.length];
                                        const modified = hasEditedMealIngredients(entry);
                                        if (modified && !window.confirm("Zmiana wariantu przywróci ilości składników zapisane w przepisie. Kontynuować?")) return;
                                        // DaySection receives onUpdateEntry from the parent; updateMealEntryAsync
                                        // is scoped to MealPlan and is not available in this component.
                                        onUpdateEntry(entry, { portionVariant: next, ...(modified ? { confirmVariantReset: true } : {}) });
                                      }}><Minus className="h-3 w-3" /></Button>
                                    <span className="min-w-5 text-center text-[11px] font-bold">{selectedVariantByEntry[Number(entry.id)] || entry.portionVariant || (variantOptionsByRecipe[Number(entry.recipe?.id)] || [])[0] || "B"}</span>
                                    <Button size="icon" variant="ghost" className="h-6 w-6 rounded-full" aria-label="Następny wariant" onClick={async () => {
                                        const recipeId = Number(entry.recipe?.id);
                                        const configured = variantOptionsByRecipe[recipeId] || getAvailableVariants(entry.recipe?.ingredients || []);
                                        const variants: PortionVariant[] = configured.length ? configured : ["A", "B", "C"];
                                        const displayedVariant = selectedVariantByEntry[Number(entry.id)] || entry.portionVariant || variants[0] || "B";
                                        const current = Math.max(0, variants.indexOf(displayedVariant as PortionVariant));
                                        const next = variants[(current + 1) % variants.length];
                                        const modified = hasEditedMealIngredients(entry);
                                        if (modified && !window.confirm("Zmiana wariantu przywróci ilości składników zapisane w przepisie. Kontynuować?")) return;
                                        // DaySection receives onUpdateEntry from the parent; updateMealEntryAsync
                                        // is scoped to MealPlan and is not available in this component.
                                        onUpdateEntry(entry, { portionVariant: next, ...(modified ? { confirmVariantReset: true } : {}) });
                                      }}><Plus className="h-3 w-3" /></Button>
                                  </div>
                                ) : (entry.recipe && isIndividualVariantRecipe(entry.recipe)) ? null : (
                                  <>
                                    <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0 rounded-full" onClick={() => onUpdateEntry(entry, { servings: Math.max(0.5, (Number(entry.servings) || 1) - 0.5) })}>
                                      <Minus className="h-3 w-3" />
                                    </Button>
                                    <div className="flex min-w-0 shrink items-center gap-1">
                                      <Input
                                        type="number"
                                        inputMode="decimal"
                                        min={0.5}
                                        step={0.5}
                                        className="h-5 w-10 px-1 py-0 text-center text-[10px] font-medium sm:w-12"
                                        value={servingInputs[entry.id] ?? String(Number(entry.servings) || 1)}
                                        onChange={(e) => setServingInputs((prev) => ({ ...prev, [entry.id]: e.target.value }))}
                                        onBlur={() => applyServingInput(entry)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            e.currentTarget.blur();
                                          }
                                        }}
                                        aria-label="Liczba porcji"
                                      />
{Number(entry.cookedBatch?.finishedWeightGrams) > 0 && (
                                        <label className="flex items-center gap-1 text-[9px] text-muted-foreground">
                                          <span>g*</span>
                                          <Input
                                            key={`consumed-weight-${entry.id}-${entry.consumedWeightGrams ?? "empty"}`}
                                            type="number"
                                            min={1}
                                            step={1}
                                            inputMode="numeric"
                                            className="h-5 w-12 px-1 py-0 text-center text-[10px]"
                                            defaultValue={entry.consumedWeightGrams ?? ""}
                                            placeholder="wymagana"
                                            onBlur={(e) => {
                                              const raw = e.currentTarget.value.trim();
                                              const nextWeight = raw === "" ? null : Number(raw);
                                              if (raw !== "" && (nextWeight === null || !Number.isFinite(nextWeight) || nextWeight <= 0)) return;
                                              if ((Number(entry.consumedWeightGrams) || null) !== nextWeight) {
                                                onUpdateEntry(entry, { consumedWeightGrams: nextWeight });
                                              }
                                            }}
                                            aria-label="Wymagana masa zjedzonej porcji w gramach"
                                          />
                                        </label>
                                      )}
                                      {entry.recipe && (
                                        <span className="shrink-0 whitespace-nowrap text-[8px] font-medium text-muted-foreground sm:text-[9px]">/ {Number(entry.recipe.servings) || 1}</span>
                                      )}
                                    </div>
                                    <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0 rounded-full" onClick={() => onUpdateEntry(entry, { servings: (Number(entry.servings) || 1) + 0.5 })}>
                                      <Plus className="h-3 w-3" />
                                    </Button>
                                  </>
                                )}
                              </div>

                              <div className="flex shrink-0 items-center">
                                <button
                                  type="button"
                                  onPointerDown={handleEatenButtonPointerDown}
                                  onClick={(event) => handleEatenButtonClick(event, entry)}
                                  className={cn(
                                    "-mr-2 flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full transition-colors touch-manipulation active:bg-primary/10 sm:mr-0 sm:h-7 sm:w-7",
                                    entry.isEaten ? "bg-emerald-200 text-emerald-800 dark:bg-emerald-800 dark:text-emerald-50" : "text-muted-foreground hover:bg-muted"
                                  )}
                                  aria-label={entry.isEaten ? "Oznacz jako niezjedzone" : "Oznacz jako zjedzone"}
                                >
                                  {entry.isEaten ? <CheckCircle2 className="h-6 w-6 sm:h-4 sm:w-4" /> : <Circle className="h-6 w-6 sm:h-4 sm:w-4" />}
                                </button>
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <button className="p-1 text-muted-foreground opacity-0 transition-all hover:text-red-500 group-hover:opacity-100" aria-label="Usuń posiłek">
                                      <X className="h-4 w-4" />
                                    </button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Remove from plan?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        Remove "{entry.recipe?.name || entry.customName}" from {format(day, "EEEE", { locale: pl })}'s plan?
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                                      <AlertDialogAction onClick={() => onDeleteMeal({ id: entry.id, date: dateStr })} className="bg-red-500 hover:bg-red-600">
                                        Remove
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </div>
                            </div>
                          </div>
                        ))}

                        {entries.length === 0 && (
                          <div className="flex items-center justify-center py-2 text-xs italic text-muted-foreground/30">
                            Empty
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        )}

      <Dialog open={!!editingCustomEntry} onOpenChange={(open) => !open && setEditingCustomEntry(null)}>
        <DialogContent className="max-sm:w-[calc(100vw-1rem)]">
          <DialogHeader>
            <DialogTitle>Edytuj własny posiłek</DialogTitle>
          </DialogHeader>

          {editingCustomEntry?.ingredients?.length ? (
            <div className="space-y-4 py-2">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Składnik</span>
                <select
                  value={customEditForm.ingredientId}
                  onChange={(e) => updateCustomEditForm("ingredientId", e.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  <option value="">Wybierz składnik...</option>
                  {(allAvailableIngredients || []).map((ingredient: any) => (
                    <option key={ingredient.id} value={ingredient.id}>{ingredient.name}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Ilość (g)</span>
                <Input
                  type="number"
                  min={1}
                  value={customEditForm.amount}
                  onChange={(e) => updateCustomEditForm("amount", e.target.value)}
                />
              </label>
              {selectedCustomIngredient && (
                <p className="rounded-lg bg-muted p-2 text-xs text-muted-foreground">
                  Po zapisie nazwa i makro wpisu zostaną przeliczone z wybranego składnika oraz ilości.
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-3 py-2">
              <label className="grid gap-1.5 text-sm font-medium">Nazwa<Input value={customEditForm.name} onChange={(e) => updateCustomEditForm("name", e.target.value)} /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 text-sm font-medium">Kalorie<Input type="number" value={customEditForm.calories} onChange={(e) => updateCustomEditForm("calories", e.target.value)} /></label>
                <label className="grid gap-1.5 text-sm font-medium">Białko<Input type="number" step="0.1" value={customEditForm.protein} onChange={(e) => updateCustomEditForm("protein", e.target.value)} /></label>
                <label className="grid gap-1.5 text-sm font-medium">Węglowodany<Input type="number" step="0.1" value={customEditForm.carbs} onChange={(e) => updateCustomEditForm("carbs", e.target.value)} /></label>
                <label className="grid gap-1.5 text-sm font-medium">Tłuszcze<Input type="number" step="0.1" value={customEditForm.fat} onChange={(e) => updateCustomEditForm("fat", e.target.value)} /></label>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingCustomEntry(null)}>Anuluj</Button>
            <Button onClick={saveCustomEdit} disabled={!!editingCustomEntry?.ingredients?.length && (!selectedCustomIngredient || Number(customEditForm.amount) <= 0)}>Zapisz zmiany</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={!!mobileTransferEntry} onOpenChange={(open) => !open && setMobileTransferEntry(null)}>
        <SheetContent side="bottom" className="rounded-t-3xl pb-8 md:hidden">
          <SheetHeader className="text-left">
            <SheetTitle>Przenieś lub duplikuj posiłek</SheetTitle>
            <SheetDescription>
              Wybierz akcję, dzień, osobę i posiłek docelowy dla „{mobileTransferEntry?.recipe?.name || mobileTransferEntry?.customName || "posiłku"}”.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/60 p-1">
              <button
                type="button"
                onClick={() => setMobileTransferForm((prev) => ({ ...prev, mode: "move" }))}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
                  mobileTransferForm.mode === "move" ? "bg-background text-primary shadow-sm" : "text-muted-foreground"
                )}
              >
                <GripVertical className="h-4 w-4" />
                Przenieś
              </button>
              <button
                type="button"
                onClick={() => setMobileTransferForm((prev) => ({ ...prev, mode: "copy" }))}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
                  mobileTransferForm.mode === "copy" ? "bg-background text-emerald-700 shadow-sm" : "text-muted-foreground"
                )}
              >
                <Copy className="h-4 w-4" />
                Duplikuj
              </button>
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Dzień</span>
              <Input
                type="date"
                value={mobileTransferForm.date}
                onChange={(e) => setMobileTransferForm((prev) => ({ ...prev, date: e.target.value }))}
                className="h-11 text-base"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Osoba</span>
                <select
                  value={mobileTransferForm.person}
                  onChange={(e) => setMobileTransferForm((prev) => ({ ...prev, person: e.target.value as "A" | "B" }))}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground"
                >
                  {people.map((person) => (
                    <option key={person} value={person}>{personName[person]}</option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Posiłek</span>
                <select
                  value={mobileTransferForm.mealType}
                  onChange={(e) => setMobileTransferForm((prev) => ({ ...prev, mealType: e.target.value }))}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground"
                >
                  {Object.entries(mealTypeLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <SheetFooter className="mt-6 gap-2 sm:space-x-0">
            <Button variant="outline" onClick={() => setMobileTransferEntry(null)} className="h-11 w-full">Anuluj</Button>
            <Button onClick={submitMobileTransfer} className="h-11 w-full">
              {mobileTransferForm.mode === "copy" ? "Duplikuj tutaj" : "Przenieś tutaj"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      {/* End of DaySection content */}
    </div>
  );
}

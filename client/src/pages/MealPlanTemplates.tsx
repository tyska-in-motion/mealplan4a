import { useEffect, useRef, useState } from "react";
import { Layout } from "@/components/Layout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { api, buildUrl } from "@shared/routes";
import { fetchWithTimeout } from "@/lib/queryClient";
import { addDays, format, startOfWeek } from "date-fns";
import { pl } from "date-fns/locale";

type MealEntrySnapshot = {
  recipeId: number | null;
  recipeSnapshot?: Record<string, any> | null;
  recipePrepTime?: number | null;
  customName?: string | null;
  customCalories?: number | null;
  customProtein?: number | null;
  customCarbs?: number | null;
  customFat?: number | null;
  customSugar?: number | null;
  customFiber?: number | null;
  mealType: string;
  person: "A" | "B";
  servings: number;
  ingredients: { ingredientId: number; amount: number; scalingType: string }[];
};

type TemplateDay = {
  id: string;
  sourceDate: string;
  totalPrice: number;
  totalPrepTime?: number;
  entries: { name: string; mealType: string; person: "A" | "B" }[];
  snapshotEntries?: MealEntrySnapshot[];
};

type MealPlanTemplate = {
  id: string;
  name: string;
  createdAt: string;
  days: TemplateDay[];
};

type IdealDay = TemplateDay & {
  createdAt?: string;
};

type SelectedIdealDay = {
  selectionId: string;
  day: IdealDay;
};

const STORAGE_KEY = "meal-plan-templates-v2";
const IDEAL_DAYS_STORAGE_KEY = "ideal-meal-plan-days-v1";

const readLocalArray = (key: string): any[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const mergeById = (preferred: any[], fallback: any[]) => {
  const merged = [...preferred];
  const seen = new Set(merged.map((item) => String(item?.id || "")));
  fallback.forEach((item) => {
    const id = String(item?.id || "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    merged.push(item);
  });
  return merged;
};

const getSnapshotEntries = (entries: any[]): MealEntrySnapshot[] => (entries || []).map((entry: any) => ({
  recipeId: Number(entry?.recipeId) > 0 ? Number(entry.recipeId) : null,
  recipeSnapshot: entry?.recipeSnapshot && typeof entry.recipeSnapshot === "object" ? entry.recipeSnapshot : null,
  recipePrepTime: entry?.recipe?.prepTime != null && Number.isFinite(Number(entry.recipe.prepTime)) ? Number(entry.recipe.prepTime) : null,
  customName: entry?.customName ?? null,
  customCalories: entry?.customCalories ?? null,
  customProtein: entry?.customProtein ?? null,
  customCarbs: entry?.customCarbs ?? null,
  customFat: entry?.customFat ?? null,
  customSugar: entry?.customSugar ?? 0,
  customFiber: entry?.customFiber ?? 0,
  mealType: String(entry?.mealType || "lunch"),
  person: entry?.person === "B" ? "B" : "A",
  servings: Math.max(0.1, Number(entry?.servings) || 1),
  ingredients: (entry?.ingredients || [])
    .map((ingredient: any) => ({
      ingredientId: Number(ingredient?.ingredientId),
      amount: Number(ingredient?.amount) || 0,
      scalingType: ["LINEAR", "FIXED", "STEP", "FORMULA"].includes(ingredient?.scalingType) ? ingredient.scalingType : "LINEAR",
    }))
    .filter((ingredient: any) => Number.isFinite(ingredient.ingredientId) && ingredient.ingredientId > 0),
}));

const getUniqueRecipePrepTime = (entries: any[] = []) => {
  const prepTimesByRecipeId = new Map<number, number>();
  (entries || []).forEach((entry: any) => {
    const recipeId = Number(entry?.recipeId ?? entry?.recipe?.id ?? entry?.recipeSnapshot?.id);
    const rawPrepTime = entry?.recipe?.prepTime ?? entry?.recipePrepTime ?? entry?.recipeSnapshot?.prepTime;
    const prepTime = Number(rawPrepTime);
    if (recipeId > 0 && Number.isFinite(recipeId) && !prepTimesByRecipeId.has(recipeId)
      && rawPrepTime != null && Number.isFinite(prepTime) && prepTime >= 0) {
      prepTimesByRecipeId.set(recipeId, prepTime);
    }
  });
  return Array.from(prepTimesByRecipeId.values()).reduce((sum, prepTime) => sum + prepTime, 0);
};

const getSavedDayPrepTime = (day: any) => {
  const storedPrepTime = Number(day?.totalPrepTime);
  if (day?.totalPrepTime != null && Number.isFinite(storedPrepTime) && storedPrepTime >= 0) return storedPrepTime;
  return getUniqueRecipePrepTime(day?.snapshotEntries || []);
};

const mealTypeLabel: Record<string, string> = {
  breakfast: "Śniadanie",
  lunch: "Obiad",
  dinner: "Kolacja",
  snack: "LUNCH",
};

export default function MealPlanTemplates() {
  const { toast } = useToast();
  const [templateName, setTemplateName] = useState("");
  const [sourceDates, setSourceDates] = useState<string[]>(Array.from({ length: 7 }).map((_, index) => format(addDays(startOfWeek(new Date(), { weekStartsOn: 1 }), index), "yyyy-MM-dd")));
  const [targetWeekStart, setTargetWeekStart] = useState(format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd"));
  const [templates, setTemplates] = useState<MealPlanTemplate[]>(() => (
    typeof window === "undefined" ? [] : readLocalArray(STORAGE_KEY) as MealPlanTemplate[]
  ));
  const [idealDays, setIdealDays] = useState<IdealDay[]>(() => (
    typeof window === "undefined" ? [] : readLocalArray(IDEAL_DAYS_STORAGE_KEY) as IdealDay[]
  ));
  const [selectedIdealDays, setSelectedIdealDays] = useState<SelectedIdealDay[]>([]);
  const [isLoadingSavedPlans, setIsLoadingSavedPlans] = useState(() => (
    typeof window === "undefined"
      || (readLocalArray(STORAGE_KEY).length === 0 && readLocalArray(IDEAL_DAYS_STORAGE_KEY).length === 0)
  ));
  const [isSaving, setIsSaving] = useState(false);
  const [isApplyingId, setIsApplyingId] = useState<string | null>(null);
  const deletedIdealDayIdsRef = useRef(new Set<string>());
  const deletedTemplateIdsRef = useRef(new Set<string>());

  const loadSavedPlans = async () => {
    const localTemplates = readLocalArray(STORAGE_KEY)
      .filter((item) => !deletedTemplateIdsRef.current.has(String(item?.id || "")));
    const localIdealDays = readLocalArray(IDEAL_DAYS_STORAGE_KEY)
      .filter((item) => !deletedIdealDayIdsRef.current.has(String(item?.id || "")));
    setTemplates(localTemplates as MealPlanTemplate[]);
    setIdealDays(localIdealDays as IdealDay[]);
    setIsLoadingSavedPlans(localTemplates.length === 0 && localIdealDays.length === 0);

    try {
      const [templatesRes, idealDaysRes] = await Promise.all([
        fetchWithTimeout(buildUrl(api.appState.get.path, { key: STORAGE_KEY })),
        fetchWithTimeout(buildUrl(api.appState.get.path, { key: IDEAL_DAYS_STORAGE_KEY })),
      ]);
      if (!templatesRes.ok || !idealDaysRes.ok) throw new Error("Nie udało się pobrać zapisanych jadłospisów");
      const [templatesPayload, idealDaysPayload] = await Promise.all([templatesRes.json(), idealDaysRes.json()]);
      const serverTemplates = (Array.isArray(templatesPayload?.data) ? templatesPayload.data : [])
        .filter((item: any) => !deletedTemplateIdsRef.current.has(String(item?.id || "")));
      const serverIdealDays = (Array.isArray(idealDaysPayload?.data) ? idealDaysPayload.data : [])
        .filter((item: any) => !deletedIdealDayIdsRef.current.has(String(item?.id || "")));
      const currentLocalTemplates = readLocalArray(STORAGE_KEY)
        .filter((item) => !deletedTemplateIdsRef.current.has(String(item?.id || "")));
      const currentLocalIdealDays = readLocalArray(IDEAL_DAYS_STORAGE_KEY)
        .filter((item) => !deletedIdealDayIdsRef.current.has(String(item?.id || "")));
      const mergedTemplates = mergeById(serverTemplates, currentLocalTemplates);
      const mergedIdealDays = mergeById(serverIdealDays, currentLocalIdealDays);

      setTemplates(mergedTemplates);
      setIdealDays(mergedIdealDays);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedTemplates));
      localStorage.setItem(IDEAL_DAYS_STORAGE_KEY, JSON.stringify(mergedIdealDays));
      setIsLoadingSavedPlans(false);

      // Legacy local entries are already visible, so syncing them must not delay the page.
      const migrateLocalItems = async (key: string, serverItems: any[], localItems: any[]) => {
        const serverIds = new Set(serverItems.map((item) => String(item?.id || "")));
        for (const item of localItems) {
          const id = String(item?.id || "");
          if (!id || serverIds.has(id)) continue;
          if ((key === STORAGE_KEY && deletedTemplateIdsRef.current.has(id))
            || (key === IDEAL_DAYS_STORAGE_KEY && deletedIdealDayIdsRef.current.has(id))) continue;

          const isStillSavedLocally = () => readLocalArray(key).some((localItem) => String(localItem?.id || "") === id);
          if (!isStillSavedLocally()) continue;

          await appendSavedItem(key, item);
          serverIds.add(id);

          // A delete can finish while this append is in flight; make sure it stays deleted.
          if ((key === STORAGE_KEY && deletedTemplateIdsRef.current.has(id))
            || (key === IDEAL_DAYS_STORAGE_KEY && deletedIdealDayIdsRef.current.has(id))
            || !isStillSavedLocally()) {
            await removeSavedItem(key, id);
          }
        }
      };

      void migrateLocalItems(STORAGE_KEY, serverTemplates, localTemplates).catch(() => {
        toast({ title: "Synchronizacja", description: "Część jadłospisów jest dostępna lokalnie i zostanie zsynchronizowana przy kolejnym otwarciu." });
      });
      void migrateLocalItems(IDEAL_DAYS_STORAGE_KEY, serverIdealDays, localIdealDays).catch(() => {
        toast({ title: "Synchronizacja", description: "Część idealnych dni jest dostępna lokalnie i zostanie zsynchronizowana przy kolejnym otwarciu." });
      });
    } catch (error: any) {
      const currentLocalTemplates = readLocalArray(STORAGE_KEY)
        .filter((item) => !deletedTemplateIdsRef.current.has(String(item?.id || "")));
      setTemplates(currentLocalTemplates as MealPlanTemplate[]);
      const currentLocalIdealDays = readLocalArray(IDEAL_DAYS_STORAGE_KEY)
        .filter((item) => !deletedIdealDayIdsRef.current.has(String(item?.id || "")));
      setIdealDays(currentLocalIdealDays as IdealDay[]);
      toast({ title: "Błąd", description: error?.message || "Nie udało się pobrać zapisanych jadłospisów.", variant: "destructive" });
    } finally {
      setIsLoadingSavedPlans(false);
    }
  };

  useEffect(() => {
    void loadSavedPlans();
  }, []);

  const appendSavedItem = async (key: string, item: any) => {
    const res = await fetchWithTimeout(buildUrl(api.appState.append.path, { key }), {
      method: api.appState.append.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(payload?.data)) {
      throw new Error(payload?.message || "Nie udało się zsynchronizować zapisanych danych.");
    }
    return payload.data;
  };

  const removeSavedItem = async (key: string, id: string) => {
    const res = await fetchWithTimeout(buildUrl(api.appState.remove.path, { key, id }), {
      method: api.appState.remove.method,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(payload?.data)) {
      throw new Error(payload?.message || "Nie udało się usunąć zapisanych danych.");
    }
    return payload.data;
  };

  const addTemplate = async (template: MealPlanTemplate) => {
    const localTemplates = readLocalArray(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([template, ...localTemplates.filter((item) => item?.id !== template.id)]));
    const next = await appendSavedItem(STORAGE_KEY, template);
    setTemplates(next as MealPlanTemplate[]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const deleteTemplate = async (id: string) => {
    deletedTemplateIdsRef.current.add(String(id));
    const removeLocally = (items: any[]) => items.filter((item) => String(item?.id || "") !== String(id));
    setTemplates((prev) => removeLocally(prev));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(removeLocally(readLocalArray(STORAGE_KEY))));

    try {
      const next = await removeSavedItem(STORAGE_KEY, id);
      const visibleNext = removeLocally(next);
      setTemplates(visibleNext as MealPlanTemplate[]);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleNext));
      toast({ title: "Usunięto", description: "Jadłospis został usunięty." });
    } catch (error: any) {
      toast({ title: "Błąd", description: error?.message || "Nie udało się zsynchronizować usunięcia jadłospisu.", variant: "destructive" });
    }
  };

  const deleteIdealDay = async (id: string) => {
    deletedIdealDayIdsRef.current.add(String(id));
    const removeLocally = (days: any[]) => days.filter((day) => String(day?.id || "") !== String(id));
    setIdealDays((prev) => removeLocally(prev));
    localStorage.setItem(IDEAL_DAYS_STORAGE_KEY, JSON.stringify(removeLocally(readLocalArray(IDEAL_DAYS_STORAGE_KEY))));

    try {
      const next = await removeSavedItem(IDEAL_DAYS_STORAGE_KEY, id);
      const visibleNext = removeLocally(next);
      setIdealDays(visibleNext as IdealDay[]);
      localStorage.setItem(IDEAL_DAYS_STORAGE_KEY, JSON.stringify(visibleNext));
      toast({ title: "Usunięto", description: "Idealny dzień został usunięty." });
    } catch (error: any) {
      toast({ title: "Błąd", description: error?.message || "Nie udało się zsynchronizować usunięcia idealnego dnia.", variant: "destructive" });
    }
  };

  const addIdealDayToSelectedDays = (day: IdealDay) => {
    if (selectedIdealDays.length >= 7) {
      toast({ title: "Tydzień jest pełny", description: "Jadłospis tygodniowy może zawierać 7 dni.", variant: "destructive" });
      return;
    }
    setSelectedIdealDays((prev) => [...prev, {
      selectionId: `${day.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      day,
    }]);
    toast({ title: "Dodano", description: "Idealny dzień dodano do składanego tygodnia." });
  };

  const moveSelectedIdealDay = (index: number, offset: -1 | 1) => {
    setSelectedIdealDays((prev) => {
      const targetIndex = index + offset;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  };

  const createTemplateFromIdealDays = async () => {
    if (!templateName.trim()) {
      toast({ title: "Błąd", description: "Podaj nazwę jadłospisu.", variant: "destructive" });
      return;
    }
    if (selectedIdealDays.length !== 7) {
      toast({ title: "Błąd", description: "Dodaj dokładnie 7 idealnych dni, aby ułożyć cały tydzień.", variant: "destructive" });
      return;
    }

    const template: MealPlanTemplate = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: templateName.trim(),
      createdAt: new Date().toISOString(),
      days: selectedIdealDays.map(({ selectionId, day }) => ({
        id: selectionId,
        sourceDate: day.sourceDate,
        totalPrice: Number(day.totalPrice) || 0,
        totalPrepTime: getSavedDayPrepTime(day),
        entries: Array.isArray(day.entries) ? day.entries : [],
        ...(Array.isArray(day.snapshotEntries) ? { snapshotEntries: day.snapshotEntries } : {}),
      })),
    };
    setIsSaving(true);
    try {
      await addTemplate(template);
      setTemplateName("");
      setSelectedIdealDays([]);
      toast({ title: "Gotowe", description: "Zapisano jadłospis tygodniowy z 7 idealnych dni." });
    } catch (error: any) {
      toast({ title: "Błąd", description: error?.message || "Nie udało się zapisać jadłospisu.", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const createTemplateFromSelectedDays = async () => {
    if (!templateName.trim()) {
      toast({ title: "Błąd", description: "Podaj nazwę jadłospisu.", variant: "destructive" });
      return;
    }
    const normalizedDates = sourceDates.map((value) => value.trim()).filter(Boolean);
    if (normalizedDates.length === 0) {
      toast({ title: "Błąd", description: "Dodaj przynajmniej jeden dzień źródłowy.", variant: "destructive" });
      return;
    }

    setIsSaving(true);
    try {
      const days: TemplateDay[] = [];
      for (const date of normalizedDates) {
        const url = api.mealPlan.getDay.path.replace(":date", date);
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`Nie udało się pobrać dnia ${date}`);
        const day = await res.json();
        const entries = (day.entries || []).map((entry: any) => ({
          name: entry.recipe?.name || entry.customName || "Posiłek własny",
          mealType: entry.mealType,
          person: (entry.person || "A") as "A" | "B",
        }));
        days.push({
          id: `${date}-${Math.random().toString(36).slice(2, 7)}`,
          sourceDate: date,
          totalPrice: Number(day.totalPrice) || 0,
          totalPrepTime: getUniqueRecipePrepTime(day.entries || []),
          entries,
          snapshotEntries: getSnapshotEntries(day.entries || []),
        });
      }

      const template: MealPlanTemplate = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: templateName.trim(),
        createdAt: new Date().toISOString(),
        days,
      };
      await addTemplate(template);
      setTemplateName("");
      toast({ title: "Gotowe", description: `Zapisano jadłospis (${days.length} dni).` });
    } catch (error: any) {
      toast({ title: "Błąd", description: error?.message || "Nie udało się zapisać jadłospisu.", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const applyTemplate = async (template: MealPlanTemplate, targetDates: Record<string, string>) => {
    setIsApplyingId(template.id);
    try {
      for (const day of template.days) {
        const targetDate = targetDates[day.id];
        if (!targetDate) continue;
        const hasSnapshot = Array.isArray(day.snapshotEntries);
        const copyPath = hasSnapshot ? api.mealPlan.copySnapshotDay.path : api.mealPlan.copyDay.path;
        const copyMethod = hasSnapshot ? api.mealPlan.copySnapshotDay.method : api.mealPlan.copyDay.method;
        const body = hasSnapshot
          ? { entries: day.snapshotEntries, targetDate, replaceTarget: true }
          : { sourceDate: day.sourceDate, targetDate, replaceTarget: true };
        const res = await fetchWithTimeout(copyPath, {
          method: copyMethod,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.message || `Nie udało się wkleić dnia ${targetDate}`);
        }
      }
      toast({ title: "Gotowe", description: "Wstawiono wybrane dni jadłospisu." });
    } catch (error: any) {
      toast({ title: "Błąd", description: error?.message || "Nie udało się wstawić jadłospisu.", variant: "destructive" });
    } finally {
      setIsApplyingId(null);
    }
  };

  return (
    <Layout>
      <section className="mb-6 rounded-2xl border border-border/60 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-base font-semibold">Nowy jadłospis (wybrane dni)</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Nazwa jadłospisu" className="h-9" />
          <div className="flex gap-2">
            <Button onClick={() => void createTemplateFromSelectedDays()} disabled={isLoadingSavedPlans || isSaving} className="h-9 flex-1">{isSaving ? "Zapisywanie..." : "Zapisz jadłospis"}</Button>
            <Button type="button" variant="outline" disabled={isLoadingSavedPlans || isSaving || selectedIdealDays.length !== 7} onClick={() => void createTemplateFromIdealDays()} className="h-9 flex-1">{isSaving ? "Zapisywanie..." : `Zapisz tydzień (${selectedIdealDays.length}/7)`}</Button>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          {sourceDates.map((date, index) => (
            <div key={`${index}-${date}`} className="flex gap-2">
              <Input type="date" value={date} onChange={(e) => setSourceDates((prev) => prev.map((item, idx) => idx === index ? e.target.value : item))} className="h-9 max-w-xs" />
              <Button type="button" variant="ghost" onClick={() => setSourceDates((prev) => prev.filter((_, idx) => idx !== index))}>Usuń</Button>
            </div>
          ))}
          <Button type="button" variant="outline" onClick={() => setSourceDates((prev) => [...prev, format(new Date(), "yyyy-MM-dd")])}>Dodaj dzień źródłowy</Button>
        </div>
      </section>

      <section className="mb-6 rounded-2xl border border-border/60 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-base font-semibold">Idealne dni</h3>
        {isLoadingSavedPlans && <div className="text-sm text-muted-foreground">Ładowanie zapisanych dni...</div>}
        {!isLoadingSavedPlans && idealDays.length === 0 && <div className="text-sm text-muted-foreground">Brak idealnych dni. Dodaj dzień z menu trzech kropek w mealplanie.</div>}
        <div className="grid gap-2 md:grid-cols-2">
          {idealDays.map((day) => (
            <div key={day.id} className="rounded-lg border p-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{format(new Date(`${day.sourceDate}T00:00:00`), "EEEE dd.MM", { locale: pl })}</div>
                  <div className="text-xs text-muted-foreground">Koszt dnia: {(Number(day.totalPrice) || 0).toFixed(2)} zł</div>
                  <div className="text-xs text-muted-foreground">Czas przygotowania: {Math.round(getSavedDayPrepTime(day))} min</div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" disabled={selectedIdealDays.length >= 7} onClick={() => addIdealDayToSelectedDays(day)}>Dodaj do tygodnia</Button>
                  <Button size="sm" variant="ghost" onClick={() => void deleteIdealDay(day.id)}>Usuń</Button>
                </div>
              </div>
              <ul className="mt-1 list-disc pl-4 text-xs">
                {day.entries.length === 0 && <li>Brak wpisów</li>}
                {day.entries.slice(0, 6).map((entry, idx) => (
                  <li key={idx}>{mealTypeLabel[entry.mealType] || entry.mealType}: {entry.name} ({entry.person})</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-6 rounded-2xl border border-border/60 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Tydzień z idealnych dni ({selectedIdealDays.length}/7)</h3>
          {selectedIdealDays.length > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedIdealDays([])}>Wyczyść tydzień</Button>
          )}
        </div>
        <p className="mb-3 text-sm text-muted-foreground">Dodawaj dni z biblioteki powyżej. Kolejność na liście określa dzień tygodnia; możesz też użyć tego samego dnia więcej niż raz.</p>
        {selectedIdealDays.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Dodaj idealne dni, aby ułożyć tygodniowy jadłospis.</div>
        ) : (
          <div className="space-y-2">
            {selectedIdealDays.map(({ selectionId, day }, index) => (
              <div key={selectionId} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">Dzień {index + 1}: {format(new Date(`${day.sourceDate}T00:00:00`), "EEEE dd.MM", { locale: pl })}</div>
                  <div className="text-xs text-muted-foreground">Docelowo: {format(addDays(new Date(`${targetWeekStart}T00:00:00`), index), "EEEE dd.MM", { locale: pl })}</div>
                  <div className="text-xs text-muted-foreground">Czas przygotowania: {Math.round(getSavedDayPrepTime(day))} min</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button type="button" size="sm" variant="outline" aria-label="Przesuń dzień w górę" disabled={index === 0} onClick={() => moveSelectedIdealDay(index, -1)}>↑</Button>
                  <Button type="button" size="sm" variant="outline" aria-label="Przesuń dzień w dół" disabled={index === selectedIdealDays.length - 1} onClick={() => moveSelectedIdealDay(index, 1)}>↓</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedIdealDays((prev) => prev.filter((item) => item.selectionId !== selectionId))}>Usuń</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-4 rounded-2xl border border-border/60 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-base font-semibold">Wklej jadłospis na tydzień</h3>
        <Input type="date" value={targetWeekStart} onChange={(e) => setTargetWeekStart(e.target.value)} className="h-9 max-w-xs" />
      </section>

      <section className="space-y-3">
        {isLoadingSavedPlans && <div className="text-sm text-muted-foreground">Ładowanie zapisanych jadłospisów...</div>}
        {!isLoadingSavedPlans && templates.length === 0 && <div className="text-sm text-muted-foreground">Brak zapisanych jadłospisów.</div>}
        {templates.map((template) => {
          const total = template.days.reduce((sum, d) => sum + (Number(d.totalPrice) || 0), 0);
          const defaultTargetDates = template.days.reduce((acc, day, index) => {
            acc[day.id] = format(addDays(new Date(`${targetWeekStart}T00:00:00`), index), "yyyy-MM-dd");
            return acc;
          }, {} as Record<string, string>);
          return (
            <div key={template.id} className="rounded-2xl border border-border/60 bg-white p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h4 className="font-semibold">{template.name}</h4>
                  <p className="text-xs text-muted-foreground">Koszt tygodnia: {total.toFixed(2)} zł</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={isApplyingId === template.id} onClick={() => void applyTemplate(template, defaultTargetDates)}>{isApplyingId === template.id ? "Wstawianie..." : "Wstaw dni"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void deleteTemplate(template.id)}>Usuń</Button>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {template.days.map((day) => (
                  <div key={`${template.id}-${day.id}`} className="rounded-lg border p-2">
                    <div className="text-sm font-medium">{format(new Date(`${day.sourceDate}T00:00:00`), "EEEE dd.MM", { locale: pl })}</div>
                    <div className="text-xs text-muted-foreground">Koszt dnia: {(Number(day.totalPrice) || 0).toFixed(2)} zł</div>
                    <div className="text-xs text-muted-foreground">Czas przygotowania: {Math.round(getSavedDayPrepTime(day))} min</div>
                    <div className="mt-1 text-xs">
                      Docelowy dzień:
                      <Input type="date" className="mt-1 h-8" defaultValue={defaultTargetDates[day.id]} onChange={(e) => { defaultTargetDates[day.id] = e.target.value; }} />
                    </div>
                    <ul className="mt-1 list-disc pl-4 text-xs">
                      {day.entries.length === 0 && <li>Brak wpisów</li>}
                      {day.entries.slice(0, 8).map((entry, idx) => (
                        <li key={idx}>{mealTypeLabel[entry.mealType] || entry.mealType}: {entry.name} ({entry.person})</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </section>
    </Layout>
  );
}

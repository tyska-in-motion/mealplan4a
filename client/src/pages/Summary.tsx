import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { StatsDayExclusionManager } from "@/components/StatsDayExclusionManager";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, buildUrl } from "@shared/routes";
import { format, subDays, eachDayOfInterval } from "date-fns";
import { calculateProduceTotals, getProduceContribution, getProduceRangeGoalGrams, mapStatsExclusions } from "@shared/produce-tracking";
import { calculateNutritionAmount, calculateScaledAmount } from "@shared/scaling";
import { pl } from "date-fns/locale";
import { CalendarDays, Coins, Flame, ChefHat, Carrot, Activity, Target, TrendingUp, Beef, Wheat, Droplets, Leaf, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, ReferenceLine } from "recharts";

type SummaryData = { date: string; totalCalories: number; totalPrice: number; entries: any[] };
type Person = "A" | "B";
type Exclusions = Record<string, Partial<Record<Person, string>>>;
const RANGE_OPTIONS = [{ label: "7 dni", days: 7 }, { label: "30 dni", days: 30 }, { label: "90 dni", days: 90 }, { label: "120 dni", days: 120 }];
const dateDaysAgo = (days: number) => format(subDays(new Date(), days), "yyyy-MM-dd");

const PEOPLE: { key: Person; name: string; accent: string }[] = [
  { key: "A", name: "Tysia", accent: "text-violet-500" },
  { key: "B", name: "Mati", accent: "text-sky-500" },
];
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (value: number) => value.toLocaleString("pl-PL", { style: "currency", currency: "PLN" });
const round = (value: number, digits = 0) => Number(value.toFixed(digits));

export default function Summary() {
  const [selectedRangeDays, setSelectedRangeDays] = useState(30);
  const [showAllIngredients, setShowAllIngredients] = useState(false);
  const [expandedIngredientUsages, setExpandedIngredientUsages] = useState<Record<string, boolean>>({});
  // Statistics cover completed calendar days only; the still-in-progress day is excluded.
  const appliedEndDate = dateDaysAgo(1);
  const appliedStartDate = dateDaysAgo(selectedRangeDays);
  const [excludedStatsDays, setExcludedStatsDays] = useState<Exclusions>({});
  const [showExcludedDays, setShowExcludedDays] = useState(false);
  const [ingredientCategoryFilter, setIngredientCategoryFilter] = useState("all");
  const [recipeTagFilter, setRecipeTagFilter] = useState("all");
  const queryClient = useQueryClient();

  const dates = useMemo(() => eachDayOfInterval({
    start: new Date(appliedStartDate + "T12:00:00"),
    end: new Date(appliedEndDate + "T12:00:00"),
  }).map((day) => format(day, "yyyy-MM-dd")), [appliedStartDate, appliedEndDate]);
  const rangeDays = dates.length;
  const applyPreset = (days: number) => setSelectedRangeDays(days);
  const range = useMemo(() => ({ startDate: dates[0], endDate: dates[dates.length - 1] }), [dates]);
  const exclusionsKey = [api.mealPlan.getStatsExclusions.path, range.startDate, range.endDate];

  const { data: savedExclusions, isSuccess: exclusionsLoaded } = useQuery<{ date: string; person: Person; reason: string }[]>({
    queryKey: exclusionsKey,
    queryFn: async () => {
      const response = await fetch(buildUrl(api.mealPlan.getStatsExclusions.path, range));
      if (!response.ok) throw new Error("Nie udało się pobrać wykluczeń statystyk");
      return api.mealPlan.getStatsExclusions.responses[200].parse(await response.json());
    },
  });
  useEffect(() => {
    if (!exclusionsLoaded) return;
    setExcludedStatsDays(mapStatsExclusions(savedExclusions || []));
  }, [savedExclusions, exclusionsLoaded]);

  const setStatsExclusion = useMutation({
    mutationFn: async ({ date, person, excluded }: { date: string; person: Person; excluded: boolean }) => {
      const response = await fetch(api.mealPlan.setStatsExclusion.path, {
        method: api.mealPlan.setStatsExclusion.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, person, reason: excluded ? "Wykluczony w statystykach" : "" }),
      });
      if (!response.ok) throw new Error("Nie udało się zapisać zmiany dnia");
    },
    onSuccess: async (_result, variables) => {
      // Update only the exact date + person pair. Never let a Tysia toggle
      // change Mati's cached exclusion (or vice versa).
      queryClient.setQueryData<{ date: string; person: Person; reason: string }[]>(
        exclusionsKey,
        (current = []) => {
          const nextRows = current.filter((row) => !(row.date === variables.date && row.person === variables.person));
          if (variables.excluded) {
            nextRows.push({ date: variables.date, person: variables.person, reason: "Wykluczony w statystykach" });
          }
          return nextRows;
        },
      );
      await queryClient.invalidateQueries({ queryKey: exclusionsKey, exact: true });
    },
  });

  const { data: settings, isLoading: settingsLoading } = useQuery<any>({ queryKey: [api.userSettings.get.path] });
  const historyRange = useMemo(() => ({ startDate: "0001-01-01", endDate: dates[dates.length - 1] }), [dates]);
  const { data: settingsHistory, isLoading: historyLoading } = useQuery<Record<Person, any[]>>({
    queryKey: [api.userSettings.history.path, historyRange.startDate, historyRange.endDate],
    queryFn: async () => {
      const response = await fetch(buildUrl(api.userSettings.history.path, historyRange));
      if (!response.ok) throw new Error("Nie udało się pobrać historii celów");
      return api.userSettings.history.responses[200].parse(await response.json());
    },
  });
  const dayQueries = useQueries({ queries: dates.map((date) => ({
    queryKey: [api.mealPlan.getDaySummary.path, date],
    queryFn: async () => {
      const response = await fetch(buildUrl(api.mealPlan.getDaySummary.path, { date }));
      if (!response.ok) throw new Error("Nie udało się pobrać danych dnia");
      return api.mealPlan.getDaySummary.responses[200].parse(await response.json()) as SummaryData;
    },
  })) });
  const loading = settingsLoading || historyLoading || !exclusionsLoaded || dayQueries.some((query) => query.isLoading);
  const queryError = dayQueries.some((query) => query.isError);

  const analytics = useMemo(() => {
    const rawDays = dayQueries.map((query) => query.data).filter((day): day is SummaryData => Boolean(day));
    const getTargets = (person: Person, date: string) => {
      const rows = [...(settingsHistory?.[person] || [])].sort((a, b) => String(a.effectiveDate).localeCompare(String(b.effectiveDate)));
      const effective = rows.reduce((match, row) => String(row.effectiveDate) <= date ? row : match, null as any);
      const current = settings?.[person] || {};
      return {
        calories: number(effective?.targetCalories ?? current.targetCalories ?? 2000),
        protein: number(effective?.targetProtein ?? current.targetProtein ?? 0),
        carbs: number(effective?.targetCarbs ?? current.targetCarbs ?? 0),
        fat: number(effective?.targetFat ?? current.targetFat ?? 0),
        vegetables: number(effective?.targetVegetables ?? current.targetVegetables ?? 0),
        fruits: number(effective?.targetFruits ?? current.targetFruits ?? 0),
        calorieGoalMode: effective?.calorieGoalMode ?? current.calorieGoalMode ?? "maintenance",
      };
    };
    const days = dates.map((date) => {
      const source = rawDays.find((day) => day.date === date);
      const entries = (source?.entries || []).filter((entry: any) => entry.isEaten);
      const perPerson = {} as Record<Person, any>;
      (["A", "B"] as Person[]).forEach((person) => {
        const excluded = Boolean(excludedStatsDays[date]?.[person]);
        // Keep the original eaten values available for the daily history cards; excluded days are filtered out of aggregate statistics below.
        const personEntries = entries.filter((entry: any) => (entry.person || "A") === person);
        const totals = personEntries.reduce((sum, entry: any) => {
          const values = entry.totals || {};
          return {
            calories: sum.calories + number(values.calories),
            protein: sum.protein + number(values.protein),
            carbs: sum.carbs + number(values.carbs),
            fat: sum.fat + number(values.fat),
            sugar: sum.sugar + number(values.sugar),
            fiber: sum.fiber + number(values.fiber),
            price: sum.price + number(values.price),
          };
        }, { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0, price: 0, vegetablesGrams: 0, fruitsGrams: 0, vegetablesServings: 0, fruitsServings: 0 });
        const produceAmounts = personEntries.flatMap((entry: any) => (entry.ingredients || []).map((row: any) => {
          const ingredient = row.ingredient || {};
          const scaledAmount = typeof row.calculatedAmount === "number"
            ? row.calculatedAmount
            : calculateScaledAmount(row, Number(entry.servings) || 1, Number(entry.recipe?.servings) || 1);
          const edibleGrams = calculateNutritionAmount(scaledAmount, ingredient);
          return getProduceContribution(ingredient, edibleGrams);
        }));
        const produce = calculateProduceTotals(produceAmounts);
        perPerson[person] = {
          ...totals,
          vegetablesGrams: produce.vegetableGrams,
          fruitsGrams: produce.fruitGrams,
          vegetablesServings: produce.vegetableServings,
          fruitsServings: produce.fruitServings,
          target: getTargets(person, date), hasData: personEntries.length > 0, excluded, entriesCount: personEntries.length
        };
      });
      return { date, label: format(new Date(date + "T12:00:00"), "d MMM", { locale: pl }), perPerson };
    });
    const summary = {} as Record<Person, any>;
    (["A", "B"] as Person[]).forEach((person) => {
      const included = days.filter((day) => !day.perPerson[person].excluded);
      const active = included.filter((day) => day.perPerson[person].hasData);
      const sum = included.reduce((acc, day) => {
        const p = day.perPerson[person];
        (["calories", "protein", "carbs", "fat", "sugar", "fiber", "price", "vegetablesGrams", "fruitsGrams", "vegetablesServings", "fruitsServings"] as const).forEach((key) => acc[key] += p[key]);
        return acc;
      }, { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0, price: 0, vegetablesGrams: 0, fruitsGrams: 0, vegetablesServings: 0, fruitsServings: 0 });
      const targetDays = included.filter((day) => day.perPerson[person].target.calories > 0);
      const onTarget = targetDays.filter((day) => {
        const p = day.perPerson[person];
        const percentage = p.calories / Math.max(1, p.target.calories);
        const mode = p.target.calorieGoalMode || "maintenance";
        if (mode === "cut") return percentage <= 1.05;
        if (mode === "bulk") return percentage >= 0.95;
        return percentage >= 0.95 && percentage <= 1.05;
      }).length;
      // Apply the person's current combined daily target to each date in
      // the selected range that is not excluded. Do not use sparse historical
      // target rows: a current 500 g/day goal over 6 included days is 3,000 g.
      const currentProduceTarget = settings?.[person] || {};
      const periodTarget = getProduceRangeGoalGrams({
        vegetables: currentProduceTarget.targetVegetables,
        fruits: currentProduceTarget.targetFruits,
      }, included.length);
      summary[person] = {
        ...sum, produceTargetGrams: periodTarget, activeDays: active.length, includedDays: included.length,
        averages: Object.fromEntries(Object.entries(sum).map(([key, value]) => [key, included.length ? number(value) / included.length : 0])),
        targetRate: targetDays.length ? onTarget / targetDays.length * 100 : 0,
        targetDays: targetDays.length,
      };
    });

    type IngredientUsage = { date: string; recipeName: string; person: string; amount: number; unit: string; servings: number };
    const ingredientMap = new Map<string, { key: string; id: number; name: string; category: string; unit: string; amount: number; events: Set<string>; dates: Set<string>; usages: IngredientUsage[] }>();
    const recipeMap = new Map<string, { name: string; count: number; tags: string[] }>();
    days.forEach((day) => {
      const source = rawDays.find((item) => item.date === day.date);
      // Ingredients and recipes include every eaten entry in the selected period,
      // even when that date is excluded from a person's nutrition statistics.
      (source?.entries || []).filter((entry: any) => entry.isEaten).forEach((entry: any) => {
        if (entry.recipe?.id) {
          const key = String(entry.recipe.id);
          const recipe = recipeMap.get(key) || { name: entry.recipe.name || "Przepis", count: 0, tags: Array.isArray(entry.recipe.tags) ? entry.recipe.tags : [] };
          recipe.count += 1;
          recipeMap.set(key, recipe);
        }
        (entry.ingredients || []).forEach((row: any) => {
          const ingredient = row.ingredient;
          if (!ingredient?.id) return;
          const id = Number(ingredient.id);
          const unit = String(row.unit || ingredient.unit || "j.m.").trim();
          // Keep different units separate: adding e.g. grams and pieces together
          // produces a misleading total that looks like an unexpectedly large weight.
          const key = `${id}::${unit.toLocaleLowerCase("pl-PL")}`;
          const amount = typeof row.calculatedAmount === "number"
            ? row.calculatedAmount
            : calculateScaledAmount(row, Number(entry.servings) || 1, Number(entry.recipe?.servings) || 1);
          const current: { key: string; id: number; name: string; category: string; unit: string; amount: number; events: Set<string>; dates: Set<string>; usages: IngredientUsage[] } = ingredientMap.get(key) || {
            key, id, name: ingredient.name || "Składnik", category: ingredient.category || "Bez kategorii",
            unit, amount: 0, events: new Set<string>(), dates: new Set<string>(), usages: [],
          };
          const safeAmount = number(amount);
          current.amount += safeAmount;
          current.events.add(String(entry.id ?? day.date));
          current.dates.add(day.date);
          current.usages.push({
            date: day.date,
            recipeName: entry.recipe?.name || entry.customName || "Posiłek bez nazwy",
            person: (entry.person || "A") === "B" ? "Mati" : "Tysia",
            amount: safeAmount,
            unit,
            servings: number(entry.servings) || 1,
          });
          ingredientMap.set(key, current);
        });
      });
    });
    const ingredients = Array.from(ingredientMap.values()).sort((a, b) => b.amount - a.amount);
    const recipes = Array.from(recipeMap.values()).sort((a, b) => b.count - a.count);
    const categories = Array.from(new Set(ingredients.map((item) => item.category))).sort((a, b) => a.localeCompare(b, "pl"));
    const tags = Array.from(new Set(recipes.flatMap((item) => item.tags))).sort((a, b) => a.localeCompare(b, "pl"));
    // A date excluded by both people is not part of the calorie trend at all.
    // If only one person excluded it, keep the date and show only the other person's value.
    const dailyChart = days
      .filter((day) => !(day.perPerson.A.excluded && day.perPerson.B.excluded))
      .map((day) => ({
        ...day,
        A: day.perPerson.A.excluded ? null : round(day.perPerson.A.calories),
        B: day.perPerson.B.excluded ? null : round(day.perPerson.B.calories),
      }));
    const excludedCount = Object.values(excludedStatsDays).reduce((total, value) => total + Object.keys(value).length, 0);
    return { days, summary, ingredients, recipes, categories, tags, dailyChart, excludedCount, loadedDays: rawDays.length };
  }, [dayQueries, dates, settings, settingsHistory, excludedStatsDays]);

  const filteredIngredients = useMemo(() => {
    const filtered = analytics.ingredients.filter((item) => ingredientCategoryFilter === "all" || item.category === ingredientCategoryFilter);
    return showAllIngredients ? filtered : filtered.slice(0, 10);
  }, [analytics.ingredients, ingredientCategoryFilter, showAllIngredients]);
  const filteredRecipes = useMemo(() => analytics.recipes
    .filter((item) => recipeTagFilter === "all" || item.tags.includes(recipeTagFilter)).slice(0, 10),
  [analytics.recipes, recipeTagFilter]);
  const produceSummary = (person: Person) => analytics.summary[person];
  return <Layout>
    <div className="space-y-6 pb-8">
      <header className="relative overflow-hidden rounded-3xl border border-emerald-900/20 bg-gradient-to-br from-emerald-950 via-emerald-900 to-green-800 p-5 text-white shadow-xl sm:p-7">
        <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-lime-300/15 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100"><Activity className="h-4 w-4" /> Centrum analityczne</div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Statystyki</h1>
            
          </div>
          <div className="flex flex-wrap gap-2">
            {RANGE_OPTIONS.map((option) => <Button key={option.days} size="sm" variant={selectedRangeDays === option.days ? "secondary" : "outline"} className={selectedRangeDays === option.days ? "bg-white text-slate-950 hover:bg-white/90" : "border-white/25 bg-white/5 text-white hover:bg-white/15"} onClick={() => applyPreset(option.days)}>{option.label}</Button>)}
          </div>
        </div>
        <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
          <div className="text-xs text-slate-300">{appliedStartDate} — {appliedEndDate} · {analytics.loadedDays}/{rangeDays} dni pobranych</div>
          <Button size="sm" variant="outline" className="border-white/25 bg-white/5 text-white hover:bg-white/15" onClick={() => setShowExcludedDays((value) => !value)}>{showExcludedDays ? "Ukryj menedżer dni" : "Zarządzaj wykluczonymi dniami"} ({analytics.excludedCount})</Button>
        </div>
      </header>

      {loading ? <LoadingSpinner /> : queryError ? <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">Nie udało się pobrać wszystkich danych. Odśwież stronę, aby uniknąć analizy niepełnego okresu.</div> : <>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-lg shadow-black/5"><div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Coins className="h-4 w-4" /> Koszt zjedzonych posiłków</div><div className="mt-2 text-2xl font-bold tabular-nums">{money(analytics.summary.A.price + analytics.summary.B.price)}</div><p className="mt-1 text-xs text-muted-foreground">Tysia: {money(analytics.summary.A.price)} · Mati: {money(analytics.summary.B.price)}</p></div>
          <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-lg shadow-black/5"><div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><CalendarDays className="h-4 w-4" /> Dni z odnotowanym jedzeniem</div><div className="mt-2 text-2xl font-bold tabular-nums">{Math.max(analytics.summary.A.activeDays, analytics.summary.B.activeDays)} <span className="text-sm font-medium text-muted-foreground">/ {rangeDays}</span></div><p className="mt-1 text-xs text-muted-foreground">Tysia: {analytics.summary.A.activeDays} · Mati: {analytics.summary.B.activeDays}</p></div>
          {PEOPLE.map(({ key, name, accent }) => { const stats = analytics.summary[key]; return <div key={key} className="rounded-2xl border border-border/70 bg-card p-4 shadow-lg shadow-black/5"><div className={cn("flex items-center gap-2 text-xs font-medium", accent)}><Target className="h-4 w-4" /> Realizacja celu kcal · {name}</div><div className="mt-2 text-2xl font-bold tabular-nums">{round(stats.targetRate)}%</div><p className="mt-1 text-xs text-muted-foreground">Średnio {round(stats.averages.calories)} kcal/dzień · {stats.targetDays} dni z celem</p></div>; })}
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
          <div className="rounded-2xl border bg-card p-4 shadow-lg shadow-black/5 sm:p-5">
            <div className="mb-4 flex items-start justify-between gap-3"><div><h2 className="font-semibold">Trend kalorii</h2><p className="text-xs text-muted-foreground">Dzienna suma z posiłków oznaczonych jako zjedzone</p></div><TrendingUp className="h-5 w-5 text-primary" /></div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%"><AreaChart data={analytics.dailyChart} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs><linearGradient id="calA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.35}/><stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/></linearGradient><linearGradient id="calB" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#38bdf8" stopOpacity={0.3}/><stop offset="95%" stopColor="#38bdf8" stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" /><XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={18}/><YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}/><Tooltip formatter={(value: any, name: string) => [value == null ? "Brak danych" : `${round(Number(value))} kcal`, name === "A" ? "Tysia" : "Mati"]} labelFormatter={(label) => String(label)} contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}/><Area type="monotone" dataKey="A" name="A" stroke="#8b5cf6" strokeWidth={2.5} fill="url(#calA)" connectNulls={false}/><Area type="monotone" dataKey="B" name="B" stroke="#38bdf8" strokeWidth={2.5} fill="url(#calB)" connectNulls={false}/>{analytics.summary.A.activeDays > 0 && <ReferenceLine y={analytics.summary.A.averages.calories} stroke="#8b5cf6" strokeDasharray="5 5" label={{ value: "Śr. Tysia", position: "insideTopLeft", fill: "#8b5cf6", fontSize: 10 }}/>}{analytics.summary.B.activeDays > 0 && <ReferenceLine y={analytics.summary.B.averages.calories} stroke="#38bdf8" strokeDasharray="5 5" label={{ value: "Śr. Mati", position: "insideBottomLeft", fill: "#38bdf8", fontSize: 10 }}/>}
              </AreaChart></ResponsiveContainer>
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground"><span className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-violet-500"/>Tysia</span><span className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-sky-500"/>Mati</span><span>Brak słupka/punktu = brak zjedzonego posiłku w danym dniu</span></div>
          </div>
          <div className="rounded-2xl border bg-card p-4 shadow-lg shadow-black/5 sm:p-5">
            <h2 className="font-semibold">Średnie dzienne</h2><p className="mb-4 text-xs text-muted-foreground">Tylko dni z co najmniej jednym zjedzonym posiłkiem</p>
            <div className="space-y-5">{PEOPLE.map(({ key, name, accent }) => {
              const stats = analytics.summary[key];
              return <div key={key}><div className="mb-2 flex items-center justify-between"><span className={cn("font-semibold", accent)}>{name}</span><span className="text-xs text-muted-foreground">{stats.activeDays} aktywnych dni</span></div>
                <div className="grid grid-cols-2 gap-2">{[{ label: "Kalorie", value: stats.averages.calories, unit: "kcal", icon: Flame }, { label: "Białko", value: stats.averages.protein, unit: "g", icon: Beef }, { label: "Węglowodany", value: stats.averages.carbs, unit: "g", icon: Wheat }, { label: "Tłuszcz", value: stats.averages.fat, unit: "g", icon: Droplets }, { label: "Cukry", value: stats.averages.sugar, unit: "g", icon: Droplets }, { label: "Błonnik", value: stats.averages.fiber, unit: "g", icon: Leaf }].map((item) => <div key={item.label} className="rounded-xl bg-muted/50 p-3"><div className="text-[11px] text-muted-foreground">{item.label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{round(item.value, 1)}<span className="ml-1 text-xs font-normal text-muted-foreground">{item.unit}</span></div></div>)}</div>
              </div>;
            })}</div>
          </div>
        </section>

        <section className="rounded-2xl border bg-card p-4 shadow-lg shadow-black/5 sm:p-5">
          <div className="mb-4 flex items-center gap-2"><Carrot className="h-5 w-5 text-emerald-500"/><div><h2 className="font-semibold">Owoce i warzywa</h2><p className="text-xs text-muted-foreground">Spożycie ze zjedzonych posiłków. 1 porcja = 80 g; klasyfikacja korzysta z pola produceType, a pomocniczo z kategorii składnika.</p></div></div>
          <div className="grid gap-4 md:grid-cols-2">
            {PEOPLE.map(({ key, name, accent }) => {
              const stats = produceSummary(key);
              const activeDays = stats.activeDays || 0;
              const avgVeg = activeDays ? stats.vegetablesGrams / activeDays : 0;
              const avgFruit = activeDays ? stats.fruitsGrams / activeDays : 0;
              // Total target = that person's daily combined goal summed over
              // their included days only (e.g. 500 g/day × 6 days = 3,000 g).
              const target = number(stats.produceTargetGrams);
              const actual = number(stats.vegetablesGrams) + number(stats.fruitsGrams);
              const targetPercent = target > 0 ? actual / target * 100 : 0;
              return <div key={key} className="rounded-xl bg-muted/40 p-4">
                <div className={cn("mb-3 font-semibold", accent)}>{name}</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-card p-3"><div className="text-xs text-muted-foreground">Warzywa</div><div className="mt-1 text-xl font-bold tabular-nums">{round(number(stats.vegetablesGrams))} g</div><div className="text-xs text-muted-foreground">{round(number(stats.vegetablesServings), 1)} porcji · śr. {round(avgVeg)} g/dzień</div></div>
                  <div className="rounded-lg bg-card p-3"><div className="text-xs text-muted-foreground">Owoce</div><div className="mt-1 text-xl font-bold tabular-nums">{round(number(stats.fruitsGrams))} g</div><div className="text-xs text-muted-foreground">{round(number(stats.fruitsServings), 1)} porcji · śr. {round(avgFruit)} g/dzień</div></div>
                </div>
                <div className="mt-3 flex justify-between text-xs text-muted-foreground"><span>Łącznie: {round(number(stats.vegetablesServings) + number(stats.fruitsServings), 1)} porcji</span><span>{number(stats.includedDays)} dni uwzględnionych</span></div>
                {target > 0 && <div className="mt-2"><div className="mb-1 flex justify-between text-xs"><span>Realizacja celów owocowo-warzywnych (g)</span><span>{round(targetPercent)}% · {round(actual)} / {round(target)} g · {number(stats.includedDays)} dni uwzględnionych</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, targetPercent))}%` }}/></div></div>}
              </div>;
            })}
          </div>
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-sm bg-green-600"/>Warzywa</span>
              <span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-sm bg-orange-500"/>Owoce</span>
            </div>
            <div className="h-56">
            <ResponsiveContainer width="100%" height="100%"><BarChart data={analytics.days.filter((day) => !(day.perPerson.A.excluded && day.perPerson.B.excluded)).map((day) => ({
              label: day.label,
              AVegetables: day.perPerson.A.excluded ? null : round(day.perPerson.A.vegetablesGrams),
              AFruits: day.perPerson.A.excluded ? null : round(day.perPerson.A.fruitsGrams),
              BVegetables: day.perPerson.B.excluded ? null : round(day.perPerson.B.vegetablesGrams),
              BFruits: day.perPerson.B.excluded ? null : round(day.perPerson.B.fruitsGrams),
            }))} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))"/>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={18}/>
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}/>
              <Tooltip formatter={(value: any, name: string) => [Math.round(Number(value)) + " g", ({ AVegetables: "Tysia · warzywa", AFruits: "Tysia · owoce", BVegetables: "Mati · warzywa", BFruits: "Mati · owoce" } as Record<string, string>)[name] || name]}/>
              <Bar dataKey="AVegetables" name="Tysia · warzywa" stackId="A" fill="#16a34a"/>
              <Bar dataKey="AFruits" name="Tysia · owoce" stackId="A" fill="#f97316" radius={[4,4,0,0]}/>
              <Bar dataKey="BVegetables" name="Mati · warzywa" stackId="B" fill="#16a34a"/>
              <Bar dataKey="BFruits" name="Mati · owoce" stackId="B" fill="#f97316" radius={[4,4,0,0]}/>
            </BarChart></ResponsiveContainer>
            </div>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-2xl border bg-card p-4 shadow-lg shadow-black/5 sm:p-5">
            <div className="mb-4 flex items-center gap-2"><Carrot className="h-5 w-5 text-emerald-500"/><div><h2 className="font-semibold">Najczęściej używane składniki</h2><p className="text-xs text-muted-foreground">Łączna gramatura i średnia dzienna ze zjedzonych posiłków, po uwzględnieniu wykluczonych dni</p></div></div>
            <Select value={ingredientCategoryFilter} onValueChange={setIngredientCategoryFilter}><SelectTrigger className="mb-3"><SelectValue placeholder="Kategoria"/></SelectTrigger><SelectContent><SelectItem value="all">Wszystkie kategorie</SelectItem>{analytics.categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select>
            <div className="space-y-3">{filteredIngredients.length ? filteredIngredients.map((item) => {
              const isExpanded = Boolean(expandedIngredientUsages[item.key]);
              const usages = [...item.usages].sort((a, b) => b.date.localeCompare(a.date));
              return <div key={item.key} className="rounded-xl border bg-card/60 p-3">
                <button type="button" className="w-full text-left" aria-expanded={isExpanded} onClick={() => setExpandedIngredientUsages((current) => ({ ...current, [item.key]: !current[item.key] }))}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-sm"><span className="truncate font-medium">{item.name}</span><span className="shrink-0 font-semibold tabular-nums">{round(item.amount, 1)} {item.unit}</span></div>
                  <div className="h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(2, item.amount / Math.max(1, filteredIngredients[0]?.amount) * 100)}%` }}/></div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground"><span>{item.category} · {item.events.size} wpisów · {usages.length} użyć</span><span className="inline-flex items-center gap-1">{isExpanded ? "Ukryj przepisy" : "Pokaż przepisy"} <ChevronDown className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-180")}/></span></div>
                </button>
                {isExpanded && <div className="mt-3 space-y-2 border-t pt-3">
                  {usages.map((usage, index) => <div key={`${item.key}-${usage.date}-${index}`} className="flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0"><div className="font-medium">{usage.recipeName}</div><div className="text-muted-foreground">{format(new Date(usage.date + "T12:00:00"), "d MMM yyyy", { locale: pl })} · {usage.person} · {usage.servings} porcji</div></div>
                    <span className="shrink-0 font-semibold tabular-nums">{round(usage.amount, 1)} {usage.unit}</span>
                  </div>)}
                </div>}
              </div>;
            }) : <p className="text-sm text-muted-foreground">Brak danych składników w tym okresie.</p>}</div>
            {analytics.ingredients.filter((item) => ingredientCategoryFilter === "all" || item.category === ingredientCategoryFilter).length > 10 && <Button className="mt-4 w-full" variant="outline" size="sm" onClick={() => setShowAllIngredients((value) => !value)}>{showAllIngredients ? "Pokaż mniej" : `Pokaż więcej składników (${analytics.ingredients.filter((item) => ingredientCategoryFilter === "all" || item.category === ingredientCategoryFilter).length})`}</Button>}
          </div>
          <div className="rounded-2xl border bg-card p-4 shadow-lg shadow-black/5 sm:p-5">
            <div className="mb-4 flex items-center gap-2"><ChefHat className="h-5 w-5 text-primary"/><div><h2 className="font-semibold">Najczęściej jedzone przepisy</h2><p className="text-xs text-muted-foreground">Liczba zjedzonych wpisów, nie planowanych porcji</p></div></div>
            <Select value={recipeTagFilter} onValueChange={setRecipeTagFilter}><SelectTrigger className="mb-3"><SelectValue placeholder="Tag"/></SelectTrigger><SelectContent><SelectItem value="all">Wszystkie tagi</SelectItem>{analytics.tags.map((tag) => <SelectItem key={tag} value={tag}>{tag}</SelectItem>)}</SelectContent></Select>
            <div className="space-y-2">{filteredRecipes.length ? filteredRecipes.map((recipe) => <div key={recipe.name} className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2.5"><div className="min-w-0"><div className="truncate text-sm font-medium">{recipe.name}</div>{recipe.tags.length > 0 && <div className="truncate text-xs text-muted-foreground">{recipe.tags.join(" · ")}</div>}</div><div className="shrink-0 text-sm font-semibold tabular-nums">{recipe.count}×</div></div>) : <p className="text-sm text-muted-foreground">Brak przepisów w wybranym okresie.</p>}</div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="rounded-2xl border bg-card p-4 shadow-sm">
            <h2 className="text-lg font-semibold">Historia dzienna</h2>
            <p className="text-sm text-muted-foreground">Każdy dzień możesz wykluczyć niezależnie dla Tysi i Matiego. Wykluczone dni pozostają widoczne tutaj, ale nie wchodzą do statystyk ani średnich.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {PEOPLE.map((person) => (
              <div key={person.key} className="rounded-2xl border bg-card p-4 shadow-sm">
                <h2 className="mb-3 text-lg font-semibold">Historia dzienna — {person.name}</h2>
                <div className="space-y-2">
                  {[...analytics.days].reverse().length === 0 ? (
                    <p className="text-sm text-muted-foreground">Brak danych dla wybranego okresu.</p>
                  ) : (
                    [...analytics.days].reverse().map((day) => {
                      const personData = day.perPerson[person.key];
                      const isExcluded = Boolean(personData.excluded);
                      const targetCalories = Math.max(1, number(personData.target.calories));
                      const calories = number(personData.calories);
                      const price = number(personData.price);
                      const rawCaloriePercentage = (calories / targetCalories) * 100;
                      const caloriePercentage = Math.round(rawCaloriePercentage);
                      const goalMode = personData.target.calorieGoalMode || "maintenance";
                      const isGoalMet = goalMode === "cut" ? rawCaloriePercentage <= 105
                        : goalMode === "bulk" ? rawCaloriePercentage >= 95
                        : rawCaloriePercentage >= 95 && rawCaloriePercentage <= 105;
                      const calorieStatus = isGoalMet
                        ? { label: "w celu", barClassName: "bg-emerald-500", rowClassName: "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-500/15" }
                        : caloriePercentage < 95
                          ? { label: "poniżej celu", barClassName: "bg-red-500", rowClassName: "border-red-200 bg-red-50/70 dark:border-red-500/40 dark:bg-red-500/15" }
                          : { label: "powyżej celu", barClassName: "bg-red-500", rowClassName: "border-red-200 bg-red-50/70 dark:border-red-500/45 dark:bg-red-500/15" };

                      return (
                        <div
                          key={`${person.key}-${day.date}`}
                          className={cn(
                            "grid grid-cols-[64px_1fr_auto] items-center gap-2 rounded-lg border px-3 py-2 sm:grid-cols-[78px_1fr_auto_auto] sm:gap-3",
                            calorieStatus.rowClassName,
                            isExcluded && "border-dashed opacity-65",
                          )}
                        >
                          <span className="text-sm font-medium">{day.label}</span>
                          <div className="min-w-0 space-y-1">
                            <div className="h-2 rounded-full bg-white/70 dark:bg-background/60">
                              <div className={cn("h-2 rounded-full", calorieStatus.barClassName)} style={{ width: `${Math.min(100, caloriePercentage)}%` }} />
                            </div>
                            <div className="text-[11px] text-muted-foreground dark:text-foreground/80">
                              {caloriePercentage}% celu ({round(targetCalories)} kcal) · {isExcluded ? "wykluczony" : calorieStatus.label}
                            </div>
                          </div>
                          <div className="min-w-0 text-right text-xs text-muted-foreground dark:text-foreground/80">
                            <div>{round(calories)} kcal · {money(price)}</div>
                            <div>Cukry: {round(number(personData.sugar), 1)}g · Błonnik: {round(number(personData.fiber), 1)}g</div>
                          </div>
                          <Button
                            variant={isExcluded ? "outline" : "ghost"}
                            size="sm"
                            className="px-2"
                            disabled={setStatsExclusion.isPending}
                            onClick={() => setStatsExclusion.mutate({ date: day.date, person: person.key, excluded: !isExcluded })}
                          >
                            {isExcluded ? "Przywróć" : "Wyklucz"}
                          </Button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {showExcludedDays && <StatsDayExclusionManager days={analytics.days} pending={setStatsExclusion.isPending} onToggle={(date, person, excluded) => setStatsExclusion.mutate({ date, person, excluded })} />}
      </>}
      <p className="px-1 text-[11px] text-muted-foreground">Metodologia: statystyki spożycia i realizacji celów są liczone osobno dla Tysi i Matiego, ze wszystkich dni zakresu poza wykluczonymi; puste, niewykluczone dni wchodzą do średniej jako zero. Składniki i przepisy uwzględniają zjedzone posiłki ze wszystkich dni zakresu, również wykluczonych. Linie przerywane na trendzie oznaczają średnią kcal każdej osoby. Historyczne cele są dobierane według daty obowiązywania.</p>
    </div>
  </Layout>;
}

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, addDays, subDays } from "date-fns";
import { pl } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Leaf, Search, Save, CheckCircle2, Circle } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useToast } from "@/hooks/use-toast";
import { useAllIngredients, useUpdateIngredient } from "@/hooks/use-ingredients";
import { useDayPlan } from "@/hooks/use-meal-plan";
import { fetchWithTimeout } from "@/lib/queryClient";
import { calculateNutritionAmount, calculateScaledAmount } from "@shared/scaling";
import { GRAMS_PER_PRODUCE_SERVING } from "@shared/produce-tracking";

type Person = "A" | "B";
type ProduceType = "vegetable" | "fruit" | "none";
type UserSettings = Record<Person, { targetVegetables?: number; targetFruits?: number; [key: string]: any }>;
type Totals = { vegetables: number; fruits: number };

function getEntryProduce(entry: any): Totals {
  const totals = { vegetables: 0, fruits: 0 };
  const ingredients = entry?.ingredients?.length ? entry.ingredients : (entry?.recipe?.ingredients || []);
  const servings = Number(entry?.servings) || 1;
  const recipeServings = Number(entry?.recipe?.servings) || 1;
  for (const item of ingredients) {
    const ingredient = item?.ingredient;
    if (!ingredient || !ingredient.produceType) continue;
    const amount = calculateScaledAmount(item, servings, recipeServings);
    const edibleGrams = calculateNutritionAmount(amount, ingredient);
    if (!Number.isFinite(edibleGrams) || edibleGrams <= 0) continue;
    if (ingredient.produceType === "vegetable") totals.vegetables += edibleGrams;
    if (ingredient.produceType === "fruit") totals.fruits += edibleGrams;
  }
  return totals;
}

function Progress({ label, grams, target }: { label: string; grams: number; target: number }) {
  const portions = grams / GRAMS_PER_PRODUCE_SERVING;
  const targetPortions = target / GRAMS_PER_PRODUCE_SERVING;
  const percent = target > 0 ? Math.min(100, grams / target * 100) : 0;
  return <div className="space-y-2">
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-sm tabular-nums">{portions.toFixed(1)} / {target > 0 ? targetPortions.toFixed(1) : "—"} porcji <span className="text-muted-foreground">({Math.round(grams)} / {Math.round(target)} g)</span></span>
    </div>
    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
    </div>
    {target <= 0 && <p className="text-xs text-muted-foreground">Ustaw cel w gramach poniżej, aby śledzić postęp.</p>}
  </div>;
}

export default function ProduceTracking() {
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<Record<Person, { vegetables: string; fruits: string }> | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: ingredients, isLoading: ingredientsLoading } = useAllIngredients();
  const { mutate: updateIngredient, isPending: updatingIngredient } = useUpdateIngredient();
  const { data: dayPlan, isLoading: planLoading, error: planError } = useDayPlan(date);
  const settingsQuery = useQuery<UserSettings>({
    queryKey: ["/api/user-settings"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/user-settings");
      if (!res.ok) throw new Error("Nie udało się pobrać ustawień");
      return res.json();
    },
  });
  const settings = settingsQuery.data;
  const currentTargets = targets ?? {
    A: { vegetables: String(settings?.A?.targetVegetables ?? 400), fruits: String(settings?.A?.targetFruits ?? 160) },
    B: { vegetables: String(settings?.B?.targetVegetables ?? 400), fruits: String(settings?.B?.targetFruits ?? 160) },
  };

  const targetMutation = useMutation({
    mutationFn: async ({ person, targetVegetables, targetFruits }: { person: Person; targetVegetables: number; targetFruits: number }) => {
      const res = await fetchWithTimeout("/api/user-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ person, targetVegetables, targetFruits }),
      });
      if (!res.ok) throw new Error("Nie udało się zapisać celów");
      return res.json();
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["/api/user-settings"] });
      toast({ title: "Zapisano cele dzienne" });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: "Błąd zapisu", description: error.message }),
  });

  const daily = useMemo(() => {
    const result: Record<Person, { planned: Totals; eaten: Totals }> = {
      A: { planned: { vegetables: 0, fruits: 0 }, eaten: { vegetables: 0, fruits: 0 } },
      B: { planned: { vegetables: 0, fruits: 0 }, eaten: { vegetables: 0, fruits: 0 } },
    };
    for (const entry of (dayPlan?.entries || [])) {
      const person: Person = entry.person === "B" ? "B" : "A";
      const totals = getEntryProduce(entry);
      result[person].planned.vegetables += totals.vegetables;
      result[person].planned.fruits += totals.fruits;
      if (entry.isEaten) {
        result[person].eaten.vegetables += totals.vegetables;
        result[person].eaten.fruits += totals.fruits;
      }
    }
    return result;
  }, [dayPlan]);

  const filteredIngredients = useMemo(() => (ingredients || []).filter((item: any) => {
    const query = search.trim().toLocaleLowerCase("pl");
    return !query || String(item.name || "").toLocaleLowerCase("pl").includes(query) || String(item.category || "").toLocaleLowerCase("pl").includes(query);
  }), [ingredients, search]);

  const saveTargets = (person: Person) => {
    const veg = Number(currentTargets[person].vegetables);
    const fruit = Number(currentTargets[person].fruits);
    if (!Number.isFinite(veg) || !Number.isFinite(fruit) || veg < 0 || fruit < 0) {
      toast({ variant: "destructive", title: "Nieprawidłowe cele", description: "Podaj nieujemny cel w gramach." });
      return;
    }
    targetMutation.mutate({ person, targetVegetables: veg, targetFruits: fruit });
  };

  return <Layout>
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Leaf className="h-6 w-6 text-primary" /> Warzywa i owoce</h1>
          <p className="text-sm text-muted-foreground mt-1">Śledź porcje w jadłospisie. Jedna porcja to 80 g części jadalnej.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Poprzedni dzień" onClick={() => setDate(format(subDays(new Date(date + "T12:00:00"), 1), "yyyy-MM-dd"))}><ChevronLeft className="h-4 w-4" /></Button>
          <Input type="date" className="w-[155px]" value={date} onChange={e => setDate(e.target.value)} />
          <Button variant="outline" size="icon" aria-label="Następny dzień" onClick={() => setDate(format(addDays(new Date(date + "T12:00:00"), 1), "yyyy-MM-dd"))}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </header>

      <section className="rounded-2xl border p-4 sm:p-5 space-y-4">
        <div>
          <h2 className="font-semibold">Postęp dzienny</h2>
          <p className="text-sm text-muted-foreground">{format(new Date(date + "T12:00:00"), "EEEE, d MMMM yyyy", { locale: pl })}. „Plan” uwzględnia wszystkie posiłki; „Zjedzone” tylko te oznaczone jako zjedzone w planie posiłków.</p>
        </div>
        {planLoading || settingsQuery.isLoading ? <LoadingSpinner /> : planError || settingsQuery.error ? <p className="text-sm text-destructive">Nie udało się wczytać danych. Odśwież stronę i spróbuj ponownie.</p> : <div className="grid gap-4 lg:grid-cols-2">
          {(["A", "B"] as Person[]).map(person => <div key={person} className="rounded-xl bg-muted/30 p-4 space-y-4">
            <h3 className="font-semibold">Osoba {person}</h3>
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Circle className="h-3.5 w-3.5" /> Zaplanowane</div>
              <Progress label="Warzywa" grams={daily[person].planned.vegetables} target={Number(currentTargets[person].vegetables) || 0} />
              <Progress label="Owoce" grams={daily[person].planned.fruits} target={Number(currentTargets[person].fruits) || 0} />
              <div className="border-t pt-3 space-y-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5" /> Oznaczone jako zjedzone</div>
                <Progress label="Warzywa" grams={daily[person].eaten.vegetables} target={Number(currentTargets[person].vegetables) || 0} />
                <Progress label="Owoce" grams={daily[person].eaten.fruits} target={Number(currentTargets[person].fruits) || 0} />
              </div>
            </div>
            <div className="border-t pt-4 space-y-3">
              <h4 className="text-sm font-semibold">Cel dzienny (g)</h4>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm">Warzywa (g)<Input type="number" min="0" step="10" value={currentTargets[person].vegetables} onChange={e => setTargets(prev => ({ ...(prev ?? { A: currentTargets.A, B: currentTargets.B }), [person]: { ...currentTargets[person], vegetables: e.target.value } }))} /></label>
                <label className="text-sm">Owoce (g)<Input type="number" min="0" step="10" value={currentTargets[person].fruits} onChange={e => setTargets(prev => ({ ...(prev ?? { A: currentTargets.A, B: currentTargets.B }), [person]: { ...currentTargets[person], fruits: e.target.value } }))} /></label>
              </div>
              <Button onClick={() => saveTargets(person)} disabled={targetMutation.isPending} className="w-full"><Save className="mr-2 h-4 w-4" /> Zapisz cele osoby {person}</Button>
            </div>
          </div>)}
        </div>}
      </section>

      <section className="rounded-2xl border p-4 sm:p-5 space-y-4">
        <div>
          <h2 className="font-semibold">Klasyfikacja składników</h2>
          <p className="text-sm text-muted-foreground">Oznacz produkty jako warzywa lub owoce. Tylko sklasyfikowane składniki są wliczane do postępu.</p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Szukaj składnika..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {ingredientsLoading ? <LoadingSpinner /> : <div className="divide-y">
          {filteredIngredients.map((item: any) => <div key={item.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium">{item.name}</p>
              <p className="text-xs text-muted-foreground">{item.category || "Bez kategorii"}{item.produceType ? " · " + (item.produceType === "vegetable" ? "Warzywo" : "Owoc") : ""}</p>
            </div>
            <Select value={item.produceType || "none"} onValueChange={value => updateIngredient({ id: item.id, data: { produceType: value === "none" ? null : value } as any }, { onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/ingredients"] }); qc.invalidateQueries({ queryKey: ["/api/meal-plan/:date"] }); toast({ title: "Zapisano klasyfikację", description: item.name }); }, onError: (error: Error) => toast({ variant: "destructive", title: "Błąd zapisu", description: error.message }) })}>
              <SelectTrigger className="w-full sm:w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nie klasyfikuj</SelectItem>
                <SelectItem value="vegetable">Warzywo</SelectItem>
                <SelectItem value="fruit">Owoc</SelectItem>
              </SelectContent>
            </Select>
          </div>)}
          {filteredIngredients.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Brak składników pasujących do wyszukiwania.</p>}
        </div>}
      </section>
    </div>
  </Layout>;
}

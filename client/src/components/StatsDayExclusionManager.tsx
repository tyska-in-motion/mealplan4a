import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { pl } from "date-fns/locale";
import { CalendarDays, Check, EyeOff, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Person = "A" | "B";
type ExclusionDay = {
  date: string;
  perPerson: Record<Person, { excluded: boolean }>;
};

const PEOPLE: { key: Person; name: string; accent: string }[] = [
  { key: "A", name: "Tysia", accent: "border-violet-500/30 bg-violet-500/5" },
  { key: "B", name: "Mati", accent: "border-sky-500/30 bg-sky-500/5" },
];

type Props = {
  days: ExclusionDay[];
  pending: boolean;
  onToggle: (date: string, person: Person, excluded: boolean) => void;
};

export function StatsDayExclusionManager({ days, pending, onToggle }: Props) {
  const sortedDays = useMemo(() => [...days].sort((a, b) => a.date.localeCompare(b.date)), [days]);
  const [selectedDate, setSelectedDate] = useState("");
  const selectedDay = sortedDays.find((day) => day.date === selectedDate) || sortedDays[sortedDays.length - 1];
  const excluded = sortedDays.flatMap((day) =>
    PEOPLE.filter(({ key }) => day.perPerson[key].excluded).map(({ key, name }) => ({ date: day.date, person: key, name }))
  );

  if (!selectedDay) return null;

  return (
    <section className="rounded-2xl border bg-card p-4 shadow-lg shadow-black/5 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-2 text-primary"><CalendarDays className="h-5 w-5" /></div>
        <div>
          <h2 className="font-semibold">Wyklucz konkretne dni ze statystyk</h2>
          <p className="mt-1 text-xs text-muted-foreground">Wybierz datę i zdecyduj osobno, czy ma być uwzględniana w statystykach Tysi i Matiego. Zmiana nie usuwa posiłków ani nie wpływa na zestawienie składników i przepisów.</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(180px,0.8fr)_2fr]">
        <div className="rounded-xl border bg-muted/30 p-3">
          <label htmlFor="stats-exclusion-date" className="mb-2 block text-xs font-medium text-muted-foreground">Wybierz konkretny dzień</label>
          <input
            id="stats-exclusion-date"
            type="date"
            min={sortedDays[0]?.date}
            max={sortedDays[sortedDays.length - 1]?.date}
            value={selectedDay.date}
            onChange={(event) => setSelectedDate(event.target.value)}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
          />
          <p className="mt-2 text-xs text-muted-foreground">{format(parseISO(selectedDay.date), "EEEE, d MMMM yyyy", { locale: pl })}</p>
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <EyeOff className="h-4 w-4" />
            {excluded.length} wykluczeń w tym zakresie
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {PEOPLE.map(({ key, name, accent }) => {
            const isExcluded = selectedDay.perPerson[key].excluded;
            return (
              <div key={key} className={`flex flex-col justify-between gap-3 rounded-xl border p-4 ${accent}`}>
                <div>
                  <div className="text-sm font-semibold">{name}</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {isExcluded ? "Ten dzień jest pomijany w statystykach." : "Ten dzień jest uwzględniany w statystykach."}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={isExcluded ? "outline" : "default"}
                  className="w-full"
                  disabled={pending}
                  onClick={() => onToggle(selectedDay.date, key, !isExcluded)}
                >
                  {isExcluded ? <><RotateCcw className="mr-2 h-4 w-4" /> Przywróć dzień</> : <><EyeOff className="mr-2 h-4 w-4" /> Wyklucz ten dzień</>}
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {excluded.length > 0 && (
        <div className="mt-5 border-t pt-4">
          <h3 className="mb-2 text-sm font-semibold">Aktualnie wykluczone dni</h3>
          <div className="flex flex-wrap gap-2">
            {excluded.map((item) => (
              <button
                key={item.date + item.person}
                type="button"
                disabled={pending}
                onClick={() => setSelectedDate(item.date)}
                className="inline-flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs transition-colors hover:bg-muted disabled:opacity-50"
              >
                <span>{format(parseISO(item.date), "d MMM yyyy", { locale: pl })} · {item.name}</span>
                <Check className="h-3.5 w-3.5 text-primary" />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

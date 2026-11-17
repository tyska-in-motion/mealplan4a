import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateProduceTotals,
  getProduceContribution,
  getProduceType,
  GRAMS_PER_PRODUCE_SERVING,
  getDailyProduceGoalGrams,
  getProduceRangeGoalGrams,
  mapStatsExclusions,
  sumIncludedProduceGoalGrams,
} from "../shared/produce-tracking";

test("80 grams equals one produce serving and fractional servings are preserved", () => {
  const totals = calculateProduceTotals([
    { produceType: "vegetable", grams: 80 },
    { produceType: "vegetable", grams: 40 },
    { produceType: "fruit", grams: 160 },
  ]);

  assert.equal(GRAMS_PER_PRODUCE_SERVING, 80);
  assert.deepEqual(totals, {
    vegetableGrams: 120,
    fruitGrams: 160,
    vegetableServings: 1.5,
    fruitServings: 2,
  });
});

test("unclassified produce and invalid quantities do not count", () => {
  const totals = calculateProduceTotals([
    { produceType: null, grams: 500 },
    { produceType: "vegetable", grams: -20 },
    { produceType: "fruit", grams: Number.NaN },
    { produceType: "fruit", grams: 0 },
    { produceType: "fruit", grams: 80 },
  ]);

  assert.deepEqual(totals, {
    vegetableGrams: 0,
    fruitGrams: 80,
    vegetableServings: 0,
    fruitServings: 1,
  });
});

test("explicit do-not-count setting overrides a vegetable category", () => {
  const potatoes = { produceType: "none", producePercentage: 100, category: "Warzywa" };
  assert.equal(getProduceType(potatoes), null);
  assert.deepEqual(getProduceContribution(potatoes, 350), { produceType: null, grams: 0 });
});

test("zero inclusion percentage contributes no produce even when classified", () => {
  assert.deepEqual(
    getProduceContribution({ produceType: "vegetable", producePercentage: 0, category: "Warzywa" }, 350),
    { produceType: "vegetable", grams: 0 },
  );
});

test("partial percentage is applied to edible grams", () => {
  assert.deepEqual(
    getProduceContribution({ produceType: "vegetable", producePercentage: 80 }, 200),
    { produceType: "vegetable", grams: 160 },
  );
});

test("automatic mode falls back to category only when no explicit type is selected", () => {
  assert.equal(getProduceType({ produceType: null, category: "Warzywa" }), "vegetable");
  assert.equal(getProduceType({ category: "Owoce" }), "fruit");
  assert.equal(getProduceType({ produceType: "fruit", category: "Warzywa" }), "fruit");
});

test("500 g daily produce target totals 3,500 g across seven included days", () => {
  const days = Array.from({ length: 7 }, () => ({
    excluded: false,
    vegetables: 300,
    fruits: 200,
  }));
  assert.equal(sumIncludedProduceGoalGrams(days), 3500);
});

test("500 g daily produce target totals 3,000 g across six included days", () => {
  const days = Array.from({ length: 6 }, () => ({
    excluded: false,
    vegetables: 300,
    fruits: 200,
  }));
  assert.equal(sumIncludedProduceGoalGrams(days), 3000);
});

test("excluded dates do not add their daily produce target", () => {
  const days = Array.from({ length: 6 }, (_, index) => ({
    excluded: index === 2,
    vegetables: 300,
    fruits: 200,
  }));
  assert.equal(sumIncludedProduceGoalGrams(days), 2500);
});

test("daily produce target helper handles missing and invalid values", () => {
  assert.equal(getDailyProduceGoalGrams({ vegetables: 300, fruits: null }), 300);
  assert.equal(getDailyProduceGoalGrams({ vegetables: -10, fruits: "bad" }), 0);
});

test("current 500 g daily target becomes 3,500 g across seven included days", () => {
  assert.equal(getProduceRangeGoalGrams({ vegetables: 300, fruits: 200 }, 7), 3500);
});

test("current 500 g daily target becomes 3,000 g across six included days", () => {
  assert.equal(getProduceRangeGoalGrams({ vegetables: 300, fruits: 200 }, 6), 3000);
});

test("current daily combined goal scales to the selected number of included days", () => {
  const target = { vegetables: 300, fruits: 200 };
  assert.equal(getProduceRangeGoalGrams(target, 7), 3500);
  assert.equal(getProduceRangeGoalGrams(target, 6), 3000);
  assert.equal(getProduceRangeGoalGrams(target, 0), 0);
});

test("a single-person exclusion does not create an exclusion for the other person", () => {
  const result = mapStatsExclusions([
    { date: "2026-11-01", person: "A", reason: "Wykluczony" },
  ]);
  assert.equal(result["2026-11-01"].A, "Wykluczony");
  assert.equal(result["2026-11-01"].B, undefined);
});

test("independent exclusions remain independently mapped for the same date", () => {
  const result = mapStatsExclusions([
    { date: "2026-11-01", person: "A", reason: "Wykluczony A" },
    { date: "2026-11-01", person: "B", reason: "Wykluczony B" },
  ]);
  assert.equal(result["2026-11-01"].A, "Wykluczony A");
  assert.equal(result["2026-11-01"].B, "Wykluczony B");
});

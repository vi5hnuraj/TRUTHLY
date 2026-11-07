import { test } from "node:test";
import assert from "node:assert/strict";
import { factCheckAll, withHeraldActOn, withHeraldBonus } from "./review";
import { uncheckedVerification, type Verification } from "./verification";

test("verdict bonus: supported +10, partial +3, capped at 100, none otherwise", () => {
  assert.equal(withHeraldBonus(50, "supported"), 60);
  assert.equal(withHeraldBonus(95, "supported"), 100);
  assert.equal(withHeraldBonus(50, "partially_supported"), 53);
  assert.equal(withHeraldBonus(50, "contradicted"), 50);
  assert.equal(withHeraldBonus(50, "unsupported"), 50);
  assert.equal(withHeraldBonus(50, "unchecked"), 50);
});

test("Herald's act-on hints are added only when the reporter gave none", () => {
  const verification: Verification = { ...uncheckedVerification(""), world_query: "ETH above 5k", tokens: ["ETH"] };
  assert.deepEqual(withHeraldActOn(["defi"], verification), ["defi", "world:ETH above 5k", "token:ETH"]);
  assert.deepEqual(withHeraldActOn(["defi", "token:SOL"], verification), ["defi", "token:SOL"]);
});

test("factCheckAll keeps order and stops paying past the per-run cap (no sources, so no network)", async () => {
  const signals = Array.from({ length: 45 }, (_, i) => ({
    id: `s${i}`,
    headline: "h",
    body: "b",
    live: [] as string[],
    claims: [],
  }));
  const checked = await factCheckAll(signals);
  assert.deepEqual(checked.map((s) => s.id), signals.map((s) => s.id));
  assert.ok(checked.every((s) => s.verification.verdict === "unchecked" && s.verification.cost_atomic === null));
  assert.match(checked[0].verification.notes, /could not read any cited source/);
  assert.match(checked[44].verification.notes, /per-run check budget/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFirstJsonObject, parseModelVerdict } from "./parse-verdict";
import { readVerification, refutesStory, uncheckedVerification } from "./verification";
import { cleanBrief } from "./brief";

test("extracts the first JSON object from prose, fences and braces in strings", () => {
  const reply = 'Sure {not json}. ```json\n{"verdict":"supported","notes":"a {b} \\"c\\"","n":{"x":1}}\n``` trailing }';
  assert.deepEqual(extractFirstJsonObject(reply), { verdict: "supported", notes: 'a {b} "c"', n: { x: 1 } });
  assert.equal(extractFirstJsonObject("no json here"), null);
  assert.equal(extractFirstJsonObject('{"unterminated": true'), null);
});

test("normalises a model verdict", () => {
  const verdict = parseModelVerdict(
    `{"verdict":"Partially Supported","confidence":85,"notes":"${"x".repeat(400)}","world_query":" ETH ETF approval by Q1 ","tokens":["$ETH","ETH","bad token","SOL","BTC"],"claim_checks":[{"claim_index":1,"verdict":"supported","citations":[1,1,2],"note":"Both sources agree."}]}`,
  );
  assert.ok(verdict);
  assert.equal(verdict.verdict, "partially_supported");
  assert.equal(verdict.confidence, 0.85);
  assert.equal(verdict.notes.length, 280);
  assert.equal(verdict.world_query, "ETH ETF approval by Q1");
  assert.deepEqual(verdict.tokens, ["ETH", "SOL", "BTC"]);
  assert.deepEqual(verdict.claim_checks, [
    {
      claim_index: 1,
      verdict: "supported",
      citations: [1, 2],
      note: "Both sources agree.",
    },
  ]);
});

test("rejects replies without a valid verdict", () => {
  assert.equal(parseModelVerdict('{"verdict":"maybe","confidence":0.5,"notes":"?"}'), null);
  assert.equal(parseModelVerdict('{"confidence":0.5,"notes":"missing verdict"}'), null);
  assert.equal(parseModelVerdict("I cannot comply."), null);
  const nulls = parseModelVerdict('{"verdict":"unsupported","confidence":0.9,"notes":"No.","world_query":null,"tokens":null}');
  assert.deepEqual(nulls && [nulls.world_query, nulls.tokens], [null, []]);
});

test("stored verifications read back safely", () => {
  const stored = uncheckedVerification("Not fact-checked: timed out.");
  assert.deepEqual(readVerification(JSON.stringify(stored)), {
    verdict: "unchecked",
    confidence: 0,
    notes: "Not fact-checked: timed out.",
      model: null,
      checked_at: stored.checked_at,
      claim_checks: [],
      source_evidence: [],
  });
  assert.equal(readVerification(null), null);
  assert.equal(readVerification("{oops"), null);
  assert.equal(readVerification('{"verdict":"made_up"}'), null);
});

test("the contradicted/unsupported split parses, stores and reads back", () => {
  const contradicted = parseModelVerdict(
    '{"verdict":"contradicted","confidence":0.93,"notes":"Both sources report the upgrade was rejected.","world_query":null,"tokens":["ETH"],"claim_checks":[{"claim_index":1,"verdict":"contradicted","citations":[1],"note":"Source states the opposite."}]}',
  );
  assert.equal(contradicted?.verdict, "contradicted");
  assert.equal(contradicted?.claim_checks[0]?.verdict, "contradicted");

  // A stored split verdict must survive readVerification: a silent null here
  // would hide Herald's finding from the teaser, the paid intel and the trade gate.
  const stored = {
    verdict: "contradicted",
    confidence: 0.93,
    notes: "Both sources report the opposite.",
    model: "test-model",
    checked_at: new Date().toISOString(),
    claim_checks: [
      { claim_index: 1, verdict: "contradicted", citations: ["https://a.example"], note: "opposite" },
    ],
    source_evidence: [],
  };
  assert.equal(readVerification(JSON.stringify(stored))?.verdict, "contradicted");

  // Both refuting verdicts reject the story and cost the stake; nothing else does.
  assert.equal(refutesStory("contradicted"), true);
  assert.equal(refutesStory("unsupported"), true);
  assert.equal(refutesStory("supported"), false);
  assert.equal(refutesStory("partially_supported"), false);
  assert.equal(refutesStory("unchecked"), false);
});

test("editor's brief is plain and capped at 400 characters on a sentence boundary", () => {
  const sentence = "Agents filed a busy wire today with markets moving fast. ";
  const brief = cleanBrief(`"**${sentence.repeat(10)}**"`);
  assert.ok(brief.length <= 400);
  assert.ok(brief.endsWith("."));
  assert.ok(!/[*"]/.test(brief));
});

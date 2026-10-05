import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import corpus from "../data/corpus.json" with { type: "json" };
import { anonymize } from "../src/anonymize.js";
import { DemoRetriever, groupFilter } from "../src/retrievers.js";
import { loadCriterion, rerankWithJev } from "../src/rerank.js";
import { KnowledgePipeline, toSnippets } from "../src/pipeline.js";
import { createApp } from "../src/server.js";
import { summarize } from "../eval/evaluate.js";

// Fake TypeSafe endpoint so the tests run offline. The scores are canned, not measured:
// they only check that the pipeline routes each case the way it should.
const ANSWERS: Record<string, Record<string, number>> = {
  révision: {
    "Marché A · Avenant n°2 – Révision des prix": 0.93,
    "Marché A · Avenant n°1 – Révision des prix (annulé)": 0.9,
    "Marché A · CCAP art. 17 – Révision des prix": 0.62,
  },
  pénalité: {
    "Marché A · CCAP art. 12 – Pénalités de retard": 0.95,
    "Marché A · CCAP art. 4 – Pièces contractuelles": 0.2,
  },
};
const sent: any[] = [];
const fakeFetch = async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  sent.push(body);
  const { title, text } = body.state.passage;
  const answers = {
    answers_question: { type: "noul", noul: (/révision/i.test(body.state.question) ? ANSWERS.révision : ANSWERS.pénalité)[title] ?? 0.05 },
    is_superseded: { type: "noul", noul: /annulé|n'est plus en vigueur/.test(text) ? 0.97 : 0.03 },
    contains_prompt_injection: { type: "noul", noul: /assistant IA/.test(text) ? 0.99 : 0.01 },
  };
  return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 200, output_tokens: 10 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const jev = new TypeSafeClient({ apiKey: "test", fetch: fakeFetch as any, retry: { maxRetries: 0 } });
const criterion = loadCriterion();
const cfg = { mode: "jev" as const, candidates: 60, topK: 15, jevMinScore: 0.5, jevConcurrency: 4, anonymize: true };

test("retriever: a user only sees the documents of their groups", async () => {
  const r = new DemoRetriever();
  const ouest = await r.search({ query: "pénalités de retard", userGroups: ["cm-ouest"] }, 50);
  assert.ok(ouest.length > 0);
  for (const p of ouest) assert.ok(p.allowedGroups!.includes("cm-ouest"), p.id);
  assert.ok(!ouest.some((p) => p.id.startsWith("B-") || p.id.startsWith("C-")));
  assert.deepEqual(await r.search({ query: "pénalités", userGroups: [] }, 50), []);
});

test("groupFilter builds an OData filter and strips separators", () => {
  assert.equal(groupFilter(["cm-ouest", "a'b,c"]), "allowed_groups/any(g: search.in(g, 'cm-ouest,abc', ','))");
  assert.equal(groupFilter([]), "false");
});

test("jev: current amendment first, cancelled amendment and injected note never reach the agent", async () => {
  sent.length = 0;
  const p = new KnowledgePipeline(cfg, new DemoRetriever(), jev, criterion);
  const r = await p.run({ query: "Quel est le plafond actuel de révision annuelle des prix du marché A ?", userGroups: ["cm-ouest"] });
  assert.equal(r.passages[0].id, "A-AVT2");
  const ids = r.passages.map((x) => x.id);
  assert.ok(!ids.includes("A-AVT1"), "cancelled amendment kept");
  assert.ok(!ids.includes("A-NOTE"), "prompt injection kept");
  assert.equal(r.decisions!.find((d) => d.passage.id === "A-AVT1")!.reason, "superseded");
  assert.equal(r.decisions!.find((d) => d.passage.id === "A-NOTE")!.reason, "prompt_injection");
  // Everything the retriever returned was judged, with the business criterion attached.
  assert.equal(sent.length, r.candidates);
  assert.equal(sent[0].questions.answers_question.instructions, criterion.instructions);
  assert.equal(sent[0].questions.answers_question.criteria.true, criterion.true);
});

test("jev: a passage that only refers to the penalty article is dropped", async () => {
  const p = new KnowledgePipeline(cfg, new DemoRetriever(), jev, criterion);
  const r = await p.run({ query: "Montant des pénalités de retard du marché A ?", userGroups: ["cm-ouest"] });
  assert.equal(r.passages[0].id, "A-CCAP-12");
  assert.equal(r.decisions!.find((d) => d.passage.id === "A-CCAP-12-REF")!.reason, "below_threshold");
});

test("jev: never more than topK, and topK is capped at 15", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `X${i}`,
    title: "Marché A · CCAP art. 12 – Pénalités de retard",
    text: `pénalité ${i}`,
    url: `https://x/${i}`,
    allowedGroups: ["g"],
  }));
  const p = new KnowledgePipeline({ ...cfg, topK: 15 }, new DemoRetriever(many), jev, criterion);
  const r = await p.run({ query: "pénalité", userGroups: ["g"] });
  assert.equal(r.passages.length, 15);
  assert.equal(r.decisions!.filter((d) => d.reason === "beyond_top_k").length, 25);
});

test("anonymize masks direct identifiers before they leave the tenant", () => {
  const out = anonymize("Contact : jean.dupont@exemple.fr, 06 12 34 56 78, SIRET 123 456 789 00012, IBAN FR76 3000 6000 0112 3456 7890 189. Client Acme.", ["Acme"]);
  for (const s of ["jean.dupont", "06 12", "00012", "FR76", "Acme"]) assert.ok(!out.includes(s), s);
  assert.match(out, /\[EMAIL\].*\[TEL\].*\[SIRET\].*\[IBAN\].*\[CONFIDENTIEL\]/);
});

test("passages are anonymized in what is sent to Jev", async () => {
  sent.length = 0;
  const leak = [{ id: "L", title: "t", text: "Écrire à achats@exemple.fr", url: "u", allowedGroups: ["g"] }];
  const p = new KnowledgePipeline(cfg, new DemoRetriever(leak), jev, criterion);
  await p.run({ query: "écrire achats", userGroups: ["g"] });
  assert.equal(sent[0].state.passage.text, "Écrire à [EMAIL]");
});

test("toSnippets matches the System.SearchResults schema", () => {
  assert.deepEqual(toSnippets([(corpus as any)[0]])[0], {
    Content: (corpus as any)[0].text,
    ContentLocation: (corpus as any)[0].url,
    Title: (corpus as any)[0].title,
  });
});

test("server: api key required, groups applied, failures return no snippet", async () => {
  const env = { API_KEY: "k", AUTH_MODE: "demo" } as NodeJS.ProcessEnv;
  const ok = new KnowledgePipeline({ ...cfg, mode: "none" }, new DemoRetriever());
  const broken = { run: async () => { throw new Error("search down"); } } as unknown as KnowledgePipeline;
  for (const [pipeline, check] of [
    [ok, async (base: string) => {
      assert.equal((await fetch(`${base}/knowledge?q=pénalités`)).status, 401);
      const res = await fetch(`${base}/knowledge?q=${encodeURIComponent("pénalités de retard")}`, { headers: { "x-api-key": "k", "x-demo-groups": "cm-est" } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { results: Array<{ Content: string; ContentLocation: string; Title: string }> };
      assert.ok(body.results.length > 0 && body.results.length <= 15);
      assert.ok(body.results.every((r) => !r.Title.startsWith("Marché A") && !r.Title.startsWith("Marché C")));
      assert.deepEqual(Object.keys(body.results[0]).sort(), ["Content", "ContentLocation", "Title"]);
    }],
    [broken, async (base: string) => {
      const res = await fetch(`${base}/knowledge?q=x`, { headers: { "x-api-key": "k" } });
      assert.equal(res.status, 502);
      assert.deepEqual(((await res.json()) as any).results, []);
    }],
  ] as const) {
    const server = createApp(pipeline, env).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const origError = console.error;
    console.error = () => {};
    try {
      await check(base);
    } finally {
      console.error = origError;
      server.close();
    }
  }
});

test("summarize computes recall, critical recall, MRR and noise", () => {
  const s = summarize([
    { id: "a", critical: true, rank: 1, returned: 3, noise: 2, ms: 10 },
    { id: "b", critical: false, rank: 2, returned: 3, noise: 2, ms: 20 },
    { id: "c", critical: true, rank: null, returned: 3, noise: 3, ms: 30 },
  ]);
  assert.equal(s.recall, 2 / 3);
  assert.equal(s.criticalRecall, 0.5);
  assert.equal(s.mrr, (1 + 0.5) / 3);
  assert.equal(s.hit1, 1 / 3);
  assert.equal(s.avgNoise, 7 / 3);
});

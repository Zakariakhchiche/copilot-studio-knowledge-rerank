/**
 * Offline evaluation: replays a golden set against the pipeline and prints what the agent
 * would have received. Run it once per mode on the same golden set and compare:
 *
 *   RERANK_MODE=none     npm run eval   # baseline: the retriever alone
 *   RERANK_MODE=semantic npm run eval   # Azure AI Search semantic ranker (needs Azure)
 *   RERANK_MODE=jev      npm run eval   # TypeSafe Jev (needs TYPESAFE_API_KEY)
 *
 * Nothing here touches Copilot Studio. Decide on the numbers, then wire the topic.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { KnowledgePipeline, configFromEnv } from "../src/pipeline.js";

interface GoldenItem {
  id: string;
  question: string;
  relevant: string[];
  critical: boolean;
  groups?: string[];
}

export interface ItemResult {
  id: string;
  critical: boolean;
  rank: number | null; // 1-based rank of the first relevant passage, null if missing
  returned: number;
  noise: number; // returned passages that are not in `relevant`
  ms: number;
}

export function summarize(rows: ItemResult[]) {
  const n = rows.length;
  const hit = (k: number) => rows.filter((r) => r.rank !== null && r.rank <= k).length / n;
  const crit = rows.filter((r) => r.critical);
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  return {
    questions: n,
    recall: rows.filter((r) => r.rank !== null).length / n,
    criticalRecall: crit.length ? crit.filter((r) => r.rank !== null).length / crit.length : 1,
    hit1: hit(1),
    hit3: hit(3),
    mrr: rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
    avgReturned: rows.reduce((s, r) => s + r.returned, 0) / n,
    avgNoise: rows.reduce((s, r) => s + r.noise, 0) / n,
    p50ms: pct(0.5),
    p95ms: pct(0.95),
  };
}

async function main() {
  const cfg = configFromEnv();
  const file = process.env.GOLDEN_SET ?? "data/golden-set.json";
  const target = Number(process.env.RECALL_TARGET ?? 0.85);
  const items = (JSON.parse(readFileSync(file, "utf8")) as { items: GoldenItem[] }).items;
  const pipeline = new KnowledgePipeline(cfg);

  const rows: ItemResult[] = [];
  const misses: string[] = [];
  for (const it of items) {
    const r = await pipeline.run({ query: it.question, userGroups: it.groups });
    const ids = r.passages.map((p) => p.id);
    const idx = ids.findIndex((id) => it.relevant.includes(id));
    rows.push({
      id: it.id,
      critical: it.critical,
      rank: idx >= 0 ? idx + 1 : null,
      returned: ids.length,
      noise: ids.filter((id) => !it.relevant.includes(id)).length,
      ms: r.ms,
    });
    if (idx < 0) misses.push(`${it.id}${it.critical ? " (critique)" : ""} : ${it.question}`);
  }

  const s = summarize(rows);
  const pc = (x: number) => `${Math.round(x * 100)} %`;
  const ok = s.criticalRecall === 1 && s.recall >= target;
  const md = [
    `# Évaluation – mode ${cfg.mode}`,
    "",
    `${new Date().toISOString()} · ${items.length} questions · ${file} · top ${cfg.topK}${cfg.mode === "jev" ? ` · ${cfg.candidates} candidats, seuil ${cfg.jevMinScore}` : ""}`,
    "",
    "| Mesure | Valeur |",
    "| --- | --- |",
    `| Rappel @${cfg.topK} (au moins un bon passage transmis) | ${pc(s.recall)} |`,
    `| Rappel sur les questions critiques | ${pc(s.criticalRecall)} |`,
    `| Bon passage en 1re position | ${pc(s.hit1)} |`,
    `| Bon passage dans les 3 premiers | ${pc(s.hit3)} |`,
    `| MRR | ${s.mrr.toFixed(2)} |`,
    `| Passages transmis à l'agent (moyenne) | ${s.avgReturned.toFixed(1)} |`,
    `| Dont passages hors sujet (bruit) | ${s.avgNoise.toFixed(1)} |`,
    `| Temps de réponse p50 / p95 | ${s.p50ms} ms / ${s.p95ms} ms |`,
    "",
    `Critère de recette : 100 % sur les questions critiques et au moins ${pc(target)} au global → **${ok ? "atteint" : "non atteint"}**.`,
    "",
    misses.length ? `Questions sans bon passage :\n\n${misses.map((m) => `- ${m}`).join("\n")}` : "Aucune question sans bon passage.",
    "",
  ].join("\n");

  mkdirSync("eval/results", { recursive: true });
  writeFileSync(`eval/results/${cfg.mode}.md`, md);
  console.log(md);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("evaluate.ts")) await main();

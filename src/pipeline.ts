import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createRetriever } from "./retrievers.js";
import { loadCriterion, rerankWithJev, type Criterion, type Decision } from "./rerank.js";
import type { KnowledgeSnippet, Passage, Retriever, SearchRequest } from "./types.js";

export type RerankMode = "none" | "semantic" | "jev";

export interface PipelineConfig {
  mode: RerankMode;
  candidates: number;
  topK: number;
  jevMinScore: number;
  jevConcurrency: number;
  anonymize: boolean;
  model?: string;
}

export function configFromEnv(env = process.env): PipelineConfig {
  const mode = (env.RERANK_MODE ?? "jev") as RerankMode;
  if (!["none", "semantic", "jev"].includes(mode)) throw new Error(`RERANK_MODE must be none, semantic or jev, got ${mode}`);
  return {
    mode,
    candidates: Number(env.CANDIDATES ?? 60),
    // Copilot Studio uses at most 15 snippets, across all knowledge topics combined.
    topK: Math.min(Number(env.TOP_K ?? 15), 15),
    jevMinScore: Number(env.JEV_MIN_SCORE ?? 0.5),
    jevConcurrency: Number(env.JEV_CONCURRENCY ?? 16),
    anonymize: env.ANONYMIZE !== "false",
    model: env.TYPESAFE_DEFAULT_MODEL || undefined,
  };
}

export interface PipelineResult {
  passages: Passage[];
  candidates: number;
  decisions?: Decision[];
  model?: string;
  criterionVersion?: string;
  ms: number;
}

export class KnowledgePipeline {
  constructor(
    private cfg: PipelineConfig,
    private retriever: Retriever = createRetriever(),
    private jev?: TypeSafeClient,
    private criterion?: Criterion,
  ) {
    if (cfg.mode === "jev") {
      this.jev ??= new TypeSafeClient();
      this.criterion ??= loadCriterion();
    }
  }

  async run(req: SearchRequest): Promise<PipelineResult> {
    const started = Date.now();
    // Retrieve wide: at this stage missing a passage costs more than keeping a weak one.
    // In "none" and "semantic" modes the retriever order is the final order.
    // The semantic ranker reorders up to 50 results, so give it 50 and keep the best topK.
    const wide = this.cfg.mode === "jev" ? this.cfg.candidates : this.cfg.mode === "semantic" ? 50 : this.cfg.topK;
    const candidates = await this.retriever.search(req, wide);
    if (this.cfg.mode !== "jev") {
      return { passages: candidates.slice(0, this.cfg.topK), candidates: candidates.length, ms: Date.now() - started };
    }
    const r = await rerankWithJev(this.jev!, req.query, candidates, this.criterion!, {
      topK: this.cfg.topK,
      minScore: this.cfg.jevMinScore,
      concurrency: this.cfg.jevConcurrency,
      anonymize: this.cfg.anonymize,
      model: this.cfg.model,
    });
    return {
      passages: r.passages,
      candidates: candidates.length,
      decisions: r.decisions,
      model: r.model,
      criterionVersion: r.criterionVersion,
      ms: Date.now() - started,
    };
  }
}

/** Shape expected by the Copilot Studio topic before it is copied into System.SearchResults. */
export function toSnippets(passages: Passage[]): KnowledgeSnippet[] {
  return passages.map((p) => ({ Content: p.text, ContentLocation: p.url, Title: p.title }));
}

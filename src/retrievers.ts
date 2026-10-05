import corpus from "../data/corpus.json" with { type: "json" };
import type { Passage, Retriever, SearchRequest } from "./types.js";

/**
 * Azure AI Search: keyword search, plus a vector query when an integrated vectorizer is
 * configured (hybrid), plus the built-in semantic ranker when a semantic configuration is set.
 * Security trimming is a filter on the `allowed_groups` field, applied inside the index, so a
 * passage the user may not read never leaves Azure AI Search.
 */
export class AzureSearchRetriever implements Retriever {
  name: string;
  constructor(
    private cfg: {
      endpoint: string;
      apiKey: string;
      index: string;
      vectorField?: string;
      semanticConfig?: string;
    },
  ) {
    this.name = `azure-ai-search${cfg.vectorField ? "+hybrid" : ""}${cfg.semanticConfig ? "+semantic" : ""}`;
  }

  async search(req: SearchRequest, top: number): Promise<Passage[]> {
    const url = `${this.cfg.endpoint.replace(/\/$/, "")}/indexes/${encodeURIComponent(this.cfg.index)}/docs/search?api-version=2024-07-01`;
    const body: Record<string, unknown> = {
      search: req.keywordQuery || req.query,
      top,
      select: "id,title,content,url,allowed_groups",
    };
    if (req.userGroups) body.filter = groupFilter(req.userGroups);
    if (this.cfg.vectorField) {
      body.vectorQueries = [{ kind: "text", text: req.query, fields: this.cfg.vectorField, k: top }];
    }
    if (this.cfg.semanticConfig) {
      // The semantic ranker reorders the first 50 results at most.
      body.queryType = "semantic";
      body.semanticConfiguration = this.cfg.semanticConfig;
      body.semanticQuery = req.query;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": this.cfg.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Azure AI Search returned ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { value: Array<Record<string, any>> };
    return data.value.map((d) => ({
      id: d.id,
      title: d.title,
      text: d.content,
      url: d.url,
      allowedGroups: d.allowed_groups,
      score: d["@search.rerankerScore"] ?? d["@search.score"],
    }));
  }
}

/** OData filter: the document is readable if one of its groups is one of the user's groups. */
export function groupFilter(groups: string[]): string {
  if (!groups.length) return "false";
  const safe = groups.map((g) => g.replace(/[,']/g, "")).join(",");
  return `allowed_groups/any(g: search.in(g, '${safe}', ','))`;
}

/** BM25 over the bundled fictional corpus, so everything runs offline. */
export class DemoRetriever implements Retriever {
  name = "demo-bm25";
  private docs: Array<{ p: Passage; terms: string[] }>;
  private avgLen: number;

  constructor(passages: Passage[] = corpus as Passage[]) {
    this.docs = passages.map((p) => ({ p, terms: tokenize(`${p.title} ${p.text}`) }));
    this.avgLen = this.docs.reduce((n, d) => n + d.terms.length, 0) / this.docs.length;
  }

  async search(req: SearchRequest, top: number): Promise<Passage[]> {
    const visible = this.docs.filter(
      ({ p }) => !req.userGroups || (p.allowedGroups ?? []).some((g) => req.userGroups!.includes(g)),
    );
    const q = [...new Set(tokenize(`${req.keywordQuery ?? ""} ${req.query}`))];
    const N = this.docs.length;
    const df = new Map(q.map((t) => [t, this.docs.filter((d) => d.terms.includes(t)).length]));
    const k1 = 1.2;
    const b = 0.75;
    return visible
      .map(({ p, terms }) => {
        let score = 0;
        for (const t of q) {
          const tf = terms.filter((x) => x === t).length;
          if (!tf) continue;
          const n = df.get(t) ?? 0;
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
          score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * terms.length) / this.avgLen));
        }
        return { ...p, score };
      })
      .filter((p) => p.score > 0)
      .sort((a, c) => c.score! - a.score!)
      .slice(0, top);
  }
}

const STOP = new Set(
  "les des une est pour par sur dans avec aux que qui quoi quel quelle quels quelles son ses leur leurs pas plus etre sont cette ces lors dont elle ils".split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

export function createRetriever(env = process.env): Retriever {
  if (env.AZURE_SEARCH_ENDPOINT && env.AZURE_SEARCH_API_KEY) {
    return new AzureSearchRetriever({
      endpoint: env.AZURE_SEARCH_ENDPOINT,
      apiKey: env.AZURE_SEARCH_API_KEY,
      index: env.AZURE_SEARCH_INDEX || "contracts",
      vectorField: env.AZURE_SEARCH_VECTOR_FIELD || undefined,
      semanticConfig: env.RERANK_MODE === "semantic" ? env.AZURE_SEARCH_SEMANTIC_CONFIG || undefined : undefined,
    });
  }
  return new DemoRetriever();
}

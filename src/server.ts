import express from "express";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { HttpError, userGroups } from "./auth.js";
import { KnowledgePipeline, configFromEnv, toSnippets } from "./pipeline.js";

/**
 * GET /knowledge?q=<System.SearchQuery>&kq=<System.KeywordSearchQuery>
 * Returns { results: [{ Content, ContentLocation, Title }] }, at most 15 rows, best first.
 * The Copilot Studio topic copies `results` into System.SearchResults.
 */
export function createApp(pipeline = new KnowledgePipeline(configFromEnv()), env = process.env) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/knowledge", async (req, res) => {
    try {
      checkApiKey(req.header("x-api-key"), env.API_KEY);
      const query = String(req.query.q ?? "").trim();
      const keywordQuery = String(req.query.kq ?? "").trim() || undefined;
      if (!query) throw new HttpError(400, "q is required");
      const groups = await userGroups(req, env);
      const r = await pipeline.run({ query, keywordQuery, userGroups: groups });
      // Audit line without passage text: what was asked, what was kept, by which model and criterion.
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          query,
          candidates: r.candidates,
          kept: r.passages.map((p) => p.id),
          model: r.model,
          criterion: r.criterionVersion,
          ms: r.ms,
        }),
      );
      res.json({ results: toSnippets(r.passages) });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      if (status >= 500) console.error(e);
      // On failure the agent gets no snippet rather than a wrong one, and falls back to
      // "I could not find it" instead of answering from memory.
      res.status(status).json({ error: e instanceof Error ? e.message : String(e), results: [] });
    }
  });

  return app;
}

function checkApiKey(given: string | undefined, expected: string | undefined) {
  if (!expected) throw new HttpError(500, "API_KEY is not configured");
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "invalid api key");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`knowledge endpoint on http://localhost:${port}/knowledge`));
}

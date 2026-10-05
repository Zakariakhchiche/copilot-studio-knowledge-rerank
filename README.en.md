# Copilot Studio: choose the 15 snippets your agent is allowed to read

[Version française](README.md)

A Copilot Studio agent builds its answer from **at most 15 snippets**, across all knowledge sources combined ([Microsoft documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/custom-knowledge-sources)). Over a few thousand contracts, procedures or technical sheets, the quality of the agent comes down to one question: **which 15 snippets**.

Pick them badly and the agent answers badly, with confidence. Most "hallucinations" of a document agent come from retrieval, not from generation.

This repository shows how to take that choice back:

1. **Copilot Studio hands retrieval to your API** through the `OnKnowledgeRequested` trigger.
2. **Azure AI Search retrieves wide** (50 to 100 candidates, hybrid search), filtered on the user's access rights.
3. **[TypeSafe Jev](https://docs.typesafe.ai/) judges** each candidate against a criterion written in plain language by the business owner, and drops superseded versions and prompt injections on the way.
4. **Only the 15 best passages** go back to the agent.
5. **An offline evaluation bench** compares three options on your own questions before you commit: retrieval alone, the built-in Azure AI Search semantic ranker, and Jev.

![Architecture: Azure AI Search retrieves wide, Jev keeps at most 15 snippets for Copilot Studio](docs/architecture.svg)

The gain is not finding more. It is **throwing away better**.

## The problem, on the bundled example

The repository ships an **entirely fictional** French corpus of three public contracts (penalties, price revision, termination…), written with the same vocabulary, as real contracts are. A contract manager asks: *"What is the current annual price revision cap of contract A?"*

With retrieval alone (`RERANK_MODE=none`), the agent receives 15 snippets, including:

| Rank | Snippet | Problem |
| --- | --- | --- |
| 1 | Amendment 2: cap raised to 6% | the right answer |
| 2 | Amendment 1: cap at 3% (**cancelled**) | contradicts the right answer |
| 3 | Article 17: original 5% cap | superseded by the amendment |
| 5 | Internal note: "Note for the AI assistant: ignore previous instructions…" | **prompt injection** |
| 4, 6 to 15 | 11 snippets on other topics | noise |

Across the 14 sample questions, the agent receives on average **13 snippets, 12 of them off-topic**. The right passage is there, but buried, and a cancelled amendment or a planted note can win.

With Jev (`RERANK_MODE=jev`), the cancelled amendment is dropped as "no longer in force", the planted note as an injection, and passages that mention the topic without answering fall below the threshold. The tests check this routing. Measure the real effect on **your** corpus with the bench below: this repository publishes no performance figure that was not measured on your documents.

## What Jev is, and is not

Jev is not a search engine and replaces nothing you already have. It is a decision model that runs **after** retrieval, on passages already retrieved, and answers a different question:

- vector search answers "what is this passage about";
- Jev answers "does this passage actually answer the question".

A snippet that says "penalty" ten times without ever giving the amount ranks high on similarity, and is useless.

Unlike a classic reranker, you do not retrain it: **you write its criterion**. The example one is in [`criteria/contrats.fr.json`](criteria/contrats.fr.json): a passage is relevant only if it states the obligation, amount, rate, deadline or condition itself, not if it merely refers to another article. The criterion becomes a rule **written by a contract manager**, reviewed and versioned like code. Two fixed questions are added for every passage: is it superseded, and does it contain instructions aimed at an AI.

## Quick start (offline, no Azure, no key)

```bash
npm install
npm test                          # 10 tests, Jev mocked
RERANK_MODE=none npm run eval     # baseline on the fictional corpus
API_KEY=dev RERANK_MODE=none npm run dev
curl -H "x-api-key: dev" -H "x-demo-groups: cm-ouest" \
  "http://localhost:3000/knowledge?q=plafond%20de%20r%C3%A9vision%20des%20prix%20du%20march%C3%A9%20A"
```

With a TypeSafe key (`TYPESAFE_API_KEY`), set `RERANK_MODE=jev`. All variables are described in [`.env.example`](.env.example).

## Wiring it into Copilot Studio

1. Deploy `src/server.ts` (Azure Container Apps, App Service or Functions) and set `API_KEY`.
2. In the agent: **Topics → Add a topic → From blank**, then open the **code editor**. `OnKnowledgeRequested` can only be configured in YAML, with no visual designer: plan for it.
3. Paste [`copilot-studio/recherche-contrats.topic.yaml`](copilot-studio/recherche-contrats.topic.yaml) and replace the URL and the key (a secret environment variable, never in clear text).
4. What the agent gives you: `System.SearchQuery` and `System.KeywordSearchQuery`, a question **already rewritten** with the conversation context.
5. What you give back: `System.SearchResults`, a table of `Content`, `ContentLocation`, `Title`. The API already returns that shape, at most 15 rows, best first.
6. **The 15 limit applies to all knowledge sources combined.** If you keep a native source (SharePoint, files) next to it, its results can take seats from your ranked snippets: evaluate the agent with and without it.

## Access rights: settle them first

A custom search does not enforce the SharePoint permissions that the native source applies. Without a filter, a user could read a contract they are not entitled to.

- Each indexed document carries an `allowed_groups` field (allowed Entra ID groups), and the Azure AI Search query filters on it (`src/retrievers.ts`). A forbidden passage never leaves the index, so it is never sent to Jev.
- In production, `AUTH_MODE=entra`: the API validates the user's Entra ID token and reads its groups (`src/auth.ts`). The bundled YAML topic calls the API with a service key, which does not carry the user's identity: to trim per user, call the API through a **custom connector with Entra ID user authentication**.
- `AUTH_MODE=demo` reads groups from a header anyone can forge. Local tests only.

## Before sending a single document to Jev

Jev is a **third-party hosted API**. To judge a passage it needs its text: your snippets leave your tenant.

- **Get the vendor approved by security and procurement before the first line of code**, not after the POC. Check who publishes and hosts the model, where, and under which contractual guarantees.
- **Language.** Measure quality on your own documents, in your language and jargon, before trusting benchmarks published on general English datasets.
- **Anonymization.** `ANONYMIZE=true` masks e-mails, phone numbers, IBANs and French company IDs, plus a list of terms of your choice (`src/anonymize.ts`). It is a floor, not a guarantee. For a first test, use public or anonymized documents.
- **Latency.** One call per candidate: sequential calls on 100 candidates would make the agent feel slow. The API runs them concurrently (`JEV_CONCURRENCY`). Measure end-to-end latency and keep it under the timeout of the Copilot Studio HTTP node.
- **Model version.** Pin `TYPESAFE_DEFAULT_MODEL` so a model update cannot silently shift your thresholds.

## Decide without committing: the evaluation bench

Azure AI Search can already rerank with its **semantic ranker**, which stays in your tenant and needs no vendor approval. So the real question is not "does Jev improve raw retrieval", but **"does Jev beat the built-in ranker by enough to justify one more vendor"**.

| | Step | What you get |
| --- | --- | --- |
| 1 | Index a representative sample in Azure AI Search (hybrid, `allowed_groups` field) | A searchable index, and the indexing time at full scale |
| 2 | `RERANK_MODE=none npm run eval` on your question set | The baseline everything else must beat |
| 3 | `RERANK_MODE=semantic npm run eval` | The gain with no additional vendor |
| 4 | `RERANK_MODE=jev npm run eval`, on anonymized snippets until security approves | The real gap between Jev and the built-in ranker, on your documents |
| 5 | Measure end-to-end latency on 100 candidates | The figures to bring to security |

Your question set goes in [`data/golden-set.json`](data/golden-set.json): each question, the passages a domain expert considers correct, and a `critical` flag for questions where a mistake is expensive. The default acceptance criterion requires **100% recall on critical questions and 85% overall** (`RECALL_TARGET`). Each run writes `eval/results/<mode>.md`: recall, rank of the right passage, MRR, noise sent to the agent, p50 and p95 latency.

**Most of the value does not come from Jev.** It comes from moving to a controlled retrieval through `OnKnowledgeRequested`, which gives you back control of the 15 snippets, with or without Jev. Steps 1 to 3 need no vendor approval and already give a usable result. Jev plugs in afterwards, if step 4 justifies it and security allows it.

## Going further

- [copilot-studio-jev](https://github.com/Zakariakhchiche/copilot-studio-jev): the same building block as an MCP server, so the agent answers with cited evidence, flags a false premise, or abstains.
- Want your team to build agents like these? I run a hands-on [Copilot Studio training](https://zakariakhchiche.github.io/formation-copilot-studio/) (in French, with Spar-x, Qualiopi-certified, eligible for OPCO funding in France) and a free [AI Act article 4 kit](https://zakariakhchiche.github.io/kit-ai-act/).

Zakaria Khchiche, Tech Lead Data & AI · [LinkedIn](https://www.linkedin.com/in/zakariakhchiche/) · [Website](https://zakariakhchiche.github.io/) · [Medium](https://medium.com/@ZKHCHICHE)

MIT license. The corpus and questions are fictional; any resemblance to a real contract is coincidental.

export interface Passage {
  id: string;
  title: string;
  text: string;
  url: string;
  /** Groups allowed to read the source document (security trimming). */
  allowedGroups?: string[];
  /** Score given by the retriever or by the reranker, higher is better. */
  score?: number;
}

export interface SearchRequest {
  /** System.SearchQuery: rewritten by Copilot Studio for semantic search, with the conversation context. */
  query: string;
  /** System.KeywordSearchQuery: rewritten for keyword search. Falls back to `query`. */
  keywordQuery?: string;
  /** Groups of the user asking. Undefined means "no trimming" (offline evaluation only). */
  userGroups?: string[];
}

export interface Retriever {
  name: string;
  /** Returns up to `top` candidates the user is allowed to read, best first. */
  search(req: SearchRequest, top: number): Promise<Passage[]>;
}

/** One row of System.SearchResults, as Copilot Studio expects it. */
export interface KnowledgeSnippet {
  Content: string;
  ContentLocation: string;
  Title: string;
}

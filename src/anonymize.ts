/**
 * Masks direct identifiers before a passage leaves your tenant. This is a floor, not a
 * guarantee: names of parties, sites and amounts stay readable. Check with your security
 * team what may be sent to a third-party API before any test on real documents.
 */
const RULES: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]"],
  [/\bFR\d{2}(?:\s?[A-Z0-9]{4}){5}\s?[A-Z0-9]{3}\b/g, "[IBAN]"],
  [/\b\d{3}\s?\d{3}\s?\d{3}\s?\d{5}\b/g, "[SIRET]"],
  [/\b\d{3}\s?\d{3}\s?\d{3}\b/g, "[SIREN]"],
  [/(?:\+33\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g, "[TEL]"],
];

export function anonymize(text: string, extraTerms: string[] = []): string {
  let out = text;
  for (const [re, label] of RULES) out = out.replace(re, label);
  for (const term of extraTerms.filter(Boolean)) {
    out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[CONFIDENTIEL]");
  }
  return out;
}

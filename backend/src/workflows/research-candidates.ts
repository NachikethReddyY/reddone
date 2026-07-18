import { createHash } from "node:crypto";

import type { ResearchInputDocument, ResearchSynthesis } from "@/integrations/kimi";
import { canonicalJson } from "@/server/security/canonical-json";

export type RankedResearchCandidate = {
  rank: number;
  fingerprint: string;
  title: string;
  problem: string;
  proposedSolution: string;
  audience: string;
  frequency: number;
  urgency: number;
  willingnessToPay: number;
  feasibility: number;
  totalScore: number;
  documents: ResearchInputDocument[];
};

function normalizedText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function documentIdentity(document: ResearchInputDocument) {
  return canonicalJson({
    id: document.id,
    title: document.title,
    body: document.body,
    createdAt: document.createdAt ?? null,
    permalink: document.permalink ?? null,
    attribution: document.attribution ?? null,
  });
}

export function researchCandidateFingerprint(candidate: { title: string; problem: string; audience: string }) {
  return createHash("sha256").update(canonicalJson({
    title: normalizedText(candidate.title),
    problem: normalizedText(candidate.problem),
    audience: normalizedText(candidate.audience),
  })).digest("hex");
}

/**
 * Produces a deterministic ranked set while rejecting ambiguous or out-of-packet
 * citations. Semantically identical model candidates are merged and retain the
 * union of their authorized evidence IDs.
 */
export function rankResearchCandidates(
  candidates: ResearchSynthesis["candidates"],
  documents: ResearchInputDocument[],
): RankedResearchCandidate[] {
  const documentsById = new Map<string, ResearchInputDocument>();
  for (const document of documents) {
    const existing = documentsById.get(document.id);
    if (existing && documentIdentity(existing) !== documentIdentity(document)) {
      throw new Error(`Authorized research packet contains an ambiguous evidence ID: ${document.id}`);
    }
    documentsById.set(document.id, existing ?? document);
  }

  const merged = new Map<string, {
    candidate: ResearchSynthesis["candidates"][number];
    evidenceIds: Set<string>;
  }>();
  for (const candidate of candidates) {
    const evidenceIds = [...new Set(candidate.evidenceIds)];
    if (evidenceIds.length === 0 || evidenceIds.some((id) => !documentsById.has(id))) {
      throw new Error("Research candidate cited evidence outside the authorized packet.");
    }
    const key = researchCandidateFingerprint(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { candidate, evidenceIds: new Set(evidenceIds) });
      continue;
    }
    for (const evidenceId of evidenceIds) existing.evidenceIds.add(evidenceId);
    existing.candidate = {
      ...existing.candidate,
      frequency: Math.max(existing.candidate.frequency, candidate.frequency),
      urgency: Math.max(existing.candidate.urgency, candidate.urgency),
      willingnessToPay: Math.max(existing.candidate.willingnessToPay, candidate.willingnessToPay),
      evidenceIds: [...existing.evidenceIds],
    };
  }

  const feasibility = 80;
  return [...merged.entries()]
    .map(([key, entry]) => {
      const candidateDocuments = [...entry.evidenceIds]
        .map((id) => documentsById.get(id))
        .filter((document): document is ResearchInputDocument => Boolean(document));
      const totalScore = (
        entry.candidate.frequency
        + entry.candidate.urgency
        + entry.candidate.willingnessToPay
        + feasibility
      ) / 4;
      return {
        rank: 0,
        fingerprint: key,
        title: entry.candidate.title,
        problem: entry.candidate.problem,
        proposedSolution: entry.candidate.proposedSolution,
        audience: entry.candidate.audience,
        frequency: entry.candidate.frequency,
        urgency: entry.candidate.urgency,
        willingnessToPay: entry.candidate.willingnessToPay,
        feasibility,
        totalScore,
        documents: candidateDocuments,
      };
    })
    .sort((left, right) => right.totalScore - left.totalScore || left.fingerprint.localeCompare(right.fingerprint))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

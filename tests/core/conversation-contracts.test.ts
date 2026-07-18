import { describe, expect, it } from "vitest";

import {
  ConversationEventSchema,
  CreateConversationInputSchema,
  CreateTurnInputSchema,
  ProjectAuthorityModeSchema,
} from "@/contracts";

describe("conversation contracts", () => {
  it("accepts only bounded thread and owner-message input", () => {
    expect(CreateConversationInputSchema.parse({ title: "Release review" })).toEqual({ title: "Release review" });
    expect(CreateTurnInputSchema.parse({ message: "Summarize the latest verifier result." })).toEqual({ message: "Summarize the latest verifier result." });
    expect(() => CreateConversationInputSchema.parse({ title: "Thread", unexpected: true })).toThrow();
    expect(() => CreateTurnInputSchema.parse({ message: "x".repeat(16_001) })).toThrow();
  });

  it("keeps authority modes explicit and fail-closed", () => {
    expect(ProjectAuthorityModeSchema.parse("read_only")).toBe("read_only");
    expect(() => ProjectAuthorityModeSchema.parse("admin")).toThrow();
  });

  it("allows only safe typed stream event payloads", () => {
    expect(ConversationEventSchema.parse({
      id: "42",
      type: "assistant.delta",
      payload: { delta: "A bounded response." },
      createdAt: "2026-07-18T00:00:00.000Z",
    }).payload.delta).toBe("A bounded response.");
    expect(() => ConversationEventSchema.parse({
      id: "43",
      type: "assistant.delta",
      payload: { rawProviderResponse: { token: "no" } },
      createdAt: "2026-07-18T00:00:00.000Z",
    })).toThrow();
  });
});

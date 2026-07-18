import { describe, expect, it } from "vitest";

import { IntegrationError } from "@/integrations/errors";
import { extractKimiUsageSample } from "@/integrations/kimi";

describe("Kimi usage extraction", () => {
  it("extracts validated provider token counts", () => {
    expect(extractKimiUsageSample({
      id: "completion-1",
      usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
    }, {
      operation: "research_synthesis",
      model: "kimi-k2.6",
    })).toEqual({
      externalUsageId: "completion-1",
      operation: "research_synthesis",
      model: "kimi-k2.6",
      inputUnits: 123,
      outputUnits: 45,
    });
  });

  it.each([
    ["missing usage", { id: "completion-1" }],
    ["missing prompt tokens", { id: "completion-1", usage: { completion_tokens: 45 } }],
    ["negative completion tokens", { id: "completion-1", usage: { prompt_tokens: 123, completion_tokens: -1 } }],
    ["fractional prompt tokens", { id: "completion-1", usage: { prompt_tokens: 1.5, completion_tokens: 45 } }],
  ])("rejects %s with a safe integration error", (_label, completion) => {
    expect(() => extractKimiUsageSample(completion, {
      operation: "builder_generation",
      model: "kimi-k2.7-code",
    })).toThrowError(IntegrationError);

    try {
      extractKimiUsageSample(completion, {
        operation: "builder_generation",
        model: "kimi-k2.7-code",
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_response",
        message: "The inference provider returned a response without valid token usage metadata.",
        retryable: false,
        status: 502,
      });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAiMocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", () => ({
  default: class OpenAI {
    chat = { completions: { create: openAiMocks.create } };
  },
}));

import { testKimiConnection } from "@/integrations/kimi";

describe("AIand inference capability probe", () => {
  beforeEach(() => {
    openAiMocks.create.mockReset();
    vi.stubEnv("AIAND_API_KEY", "aiand-provider-key");
    vi.stubEnv("AIAND_BASE_URL", "https://provider.example/v1");
    vi.stubEnv("AIAND_RESEARCH_MODEL", "zai-org/glm-5.2");
    vi.stubEnv("AIAND_BUILDER_MODEL", "moonshotai/kimi-k2.7-code");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("requires strict JSON-schema output and one forced strict tool call", async () => {
    openAiMocks.create
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: "function",
                  function: { name: "connection_probe", arguments: '{"ok":true}' },
                },
              ],
            },
          },
        ],
      });

    await expect(testKimiConnection("provider-key")).resolves.toMatchObject({ ok: true });

    expect(openAiMocks.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "zai-org/glm-5.2",
      temperature: 0,
      max_tokens: 128,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "connection_probe_v1",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
      },
    }));
    expect(openAiMocks.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: "moonshotai/kimi-k2.7-code",
      temperature: 0,
      max_tokens: 128,
      parallel_tool_calls: false,
      tool_choice: { type: "function", function: { name: "connection_probe" } },
      tools: [
        {
          type: "function",
          function: expect.objectContaining({
            name: "connection_probe",
            strict: true,
          }),
        },
      ],
    }));
  });

  it("does not mark a provider healthy when strict structured output is malformed", async () => {
    openAiMocks.create.mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":false}' } }] });

    await expect(testKimiConnection("provider-key")).rejects.toThrow(/strict JSON and function-tool capabilities/i);
    expect(openAiMocks.create).toHaveBeenCalledOnce();
  });

  it("does not mark a provider healthy when it ignores the forced function call", async () => {
    openAiMocks.create
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [] } }] });

    await expect(testKimiConnection("provider-key")).rejects.toThrow(/strict JSON and function-tool capabilities/i);
  });

  it("adapts TokenRouter's Kimi route to its required temperature and auto tool choice", async () => {
    vi.stubEnv("AIAND_API_KEY", "");
    vi.stubEnv("AIAND_BASE_URL", "");
    vi.stubEnv("KIMI_BASE_URL", "https://api.tokenrouter.com/v1");
    openAiMocks.create
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: "function",
                  function: { name: "connection_probe", arguments: '{"ok":true}' },
                },
              ],
            },
          },
        ],
      });

    await expect(testKimiConnection("provider-key")).resolves.toMatchObject({ ok: true });
    expect(openAiMocks.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ temperature: 1 }));
    expect(openAiMocks.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ temperature: 1, tool_choice: "auto" }));
  });
});

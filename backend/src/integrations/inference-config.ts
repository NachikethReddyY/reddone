import "server-only";

export const DEFAULT_AIAND_BASE_URL = "https://api.aiand.com/v1";
export const DEFAULT_AIAND_RESEARCH_MODEL = "zai-org/glm-5.2";
export const DEFAULT_AIAND_BUILDER_MODEL = "moonshotai/kimi-k2.7-code";

const LEGACY_MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";

function configured(name: string) {
  return process.env[name]?.trim() || null;
}

/** AIand is primary. The Kimi/Moonshot variables are compatibility-only fallbacks. */
export function inferenceEnvironmentApiKey() {
  return configured("AIAND_API_KEY")
    ?? configured("KIMI_API_KEY")
    ?? configured("MOONSHOT_API_KEY");
}

export function inferenceBaseUrl() {
  const aiandBaseUrl = configured("AIAND_BASE_URL");
  if (aiandBaseUrl) return aiandBaseUrl;
  if (configured("AIAND_API_KEY")) return DEFAULT_AIAND_BASE_URL;
  return configured("KIMI_BASE_URL") ?? LEGACY_MOONSHOT_BASE_URL;
}

export function inferenceResearchModel() {
  return configured("AIAND_RESEARCH_MODEL")
    ?? configured("KIMI_RESEARCH_MODEL")
    ?? DEFAULT_AIAND_RESEARCH_MODEL;
}

export function inferenceBuilderModel() {
  return configured("AIAND_BUILDER_MODEL")
    ?? configured("KIMI_BUILDER_MODEL")
    ?? DEFAULT_AIAND_BUILDER_MODEL;
}

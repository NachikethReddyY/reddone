const discoveryStopWords = new Set([
  "about", "after", "again", "against", "also", "because", "before", "being", "build", "building",
  "challenge", "contents", "could", "event", "from", "hackathon", "have", "into", "must", "project",
  "should", "their", "there", "these", "they", "this", "those", "through", "using", "with", "would",
  "your", "youre",
]);

function cleanTitle(value: string) {
  return value
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*]+\s*/, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function discoveryKeywords(brief: string) {
  const words = brief
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .match(/[a-z][a-z0-9-]{3,}/g) ?? [];
  return [...new Set(words.filter((word) => !discoveryStopWords.has(word)))].slice(0, 8);
}

export function buildHackathonDiscoverySeed(rawBrief: string) {
  const brief = rawBrief.trim().replace(/\r\n?/g, "\n");
  const firstLine = brief.split("\n").map(cleanTitle).find((line) => line.length >= 4) ?? "Hackathon opportunity";
  const keywords = discoveryKeywords(brief);
  const focus = keywords.length ? keywords.join(" ") : "workflow software problems";
  const query = `${focus} problem workaround`.slice(0, 106).trim();
  const projectName = `${firstLine.slice(0, 86).trim()} · discovery`.slice(0, 120);
  const marketFocus = keywords.slice(0, 4).join(", ") || "hackathon-aligned workflows";

  return {
    brief,
    projectName,
    marketLabel: `People discussing ${marketFocus}`.slice(0, 120),
    sourceLabel: `search:${query}`,
  };
}


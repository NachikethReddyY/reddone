import { describe, expect, it } from "vitest";

import { buildHackathonDiscoverySeed } from "@/features/projects/hackathon-discovery";

describe("hackathon discovery seed", () => {
  it("turns a pasted brief into a bounded Reddit search project", () => {
    const brief = `# Climate resilience sprint
Build a useful workflow for urban communities preparing for extreme heat.
Judges value evidence, a focused prototype, and measurable resident impact.`;

    const seed = buildHackathonDiscoverySeed(brief);

    expect(seed.brief).toBe(brief);
    expect(seed.projectName).toBe("Climate resilience sprint · discovery");
    expect(seed.marketLabel).toContain("climate");
    expect(seed.sourceLabel).toMatch(/^search:/);
    expect(seed.sourceLabel).toContain("problem workaround");
    expect(seed.sourceLabel).not.toContain("hackathon");
    expect(seed.sourceLabel.length).toBeLessThanOrEqual(120);
  });
});

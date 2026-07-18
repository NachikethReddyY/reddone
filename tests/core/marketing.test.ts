import { describe, expect, it } from "vitest";

import { deploymentCta } from "@/features/marketing/marketing";
import { publicBillingCatalog } from "@/server/billing-catalog";

describe("public marketing configuration", () => {
  it("uses deployment-aware primary actions", () => {
    expect(deploymentCta("public")).toMatchObject({ href: "/beta", label: "Join the private beta" });
    expect(deploymentCta("private")).toMatchObject({ href: "/sign-in", label: "Sign in" });
    expect(deploymentCta("hackathon")).toMatchObject({ href: "/sign-in", label: "Enter the hackathon" });
    expect(deploymentCta("demo")).toMatchObject({ href: "/projects", label: "Open the product demo" });
  });

  it("reads public pricing from the immutable server catalog without Stripe lookup keys", () => {
    const catalog = publicBillingCatalog();
    expect(catalog.plans).toHaveLength(3);
    expect(catalog.packs).toHaveLength(3);
    expect(catalog.plans[1]).toMatchObject({ displayName: "Builder", amountMinor: 10_000, credits: 2_400 });
    expect(JSON.stringify(catalog)).not.toContain("lookupKey");
  });
});

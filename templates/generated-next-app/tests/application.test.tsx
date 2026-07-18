import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GeneratedHost } from "@/components/generated-host";

describe("generated application", () => {
  it("keeps the main approval boundary visible", () => {
    render(<GeneratedHost />);
    expect(screen.getByText(/nothing sends until you approve it/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review priority queue/i })).toBeInTheDocument();
  });
});

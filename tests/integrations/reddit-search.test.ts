import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearRedditTokenCache,
  getApprovedPostThread,
  searchApprovedReddit,
  searchApprovedRedditPage,
} from "@/integrations/reddit";

afterEach(() => {
  clearRedditTokenCache();
  vi.unstubAllGlobals();
});

const credentials = {
  clientId: "client-id",
  clientSecret: "client-secret",
  userAgent: "web:reddone:test (by /u/reddone-owner)",
  approvalReference: "owner-approved-oauth",
};

function postListing(id = "post1", url = `https://www.reddit.com/r/urbanplanning/comments/${id}/heat_alerts/`) {
  return {
    data: {
      after: null,
      children: [{
        data: {
          id,
          name: `t3_${id}`,
          title: "Heat alerts arrive too late for our neighborhood",
          selftext: "Volunteers rebuild the call list every time temperatures spike.",
          permalink: `/r/urbanplanning/comments/${id}/heat_alerts/`,
          url,
          score: 87,
          num_comments: 4,
          created_utc: 1_784_236_800,
          subreddit: "urbanplanning",
          over_18: false,
        },
      }],
    },
  };
}

describe("approved Reddit discovery search", () => {
  it("uses OAuth search and retains community attribution", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          after: null,
          children: [{
            data: {
              id: "post-1",
              title: "Heat alerts arrive too late for our neighborhood",
              selftext: "Volunteers rebuild the call list every time temperatures spike.",
              permalink: "/r/urbanplanning/comments/post_1/heat_alerts/",
              score: 87,
              created_utc: 1_784_236_800,
              subreddit: "urbanplanning",
            },
          }],
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchApprovedReddit({
      credentials,
      query: "urban heat volunteer workflow problem",
      limit: 25,
    });

    const searchUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(searchUrl.origin).toBe("https://oauth.reddit.com");
    expect(searchUrl.pathname).toBe("/search");
    expect(searchUrl.searchParams.get("q")).toBe("urban heat volunteer workflow problem");
    expect(searchUrl.searchParams.get("limit")).toBe("25");
    expect(results[0]).toMatchObject({
      id: "post-1",
      attribution: "r/urbanplanning",
      sourceLabel: "r/urbanplanning",
      body: "Volunteers rebuild the call list every time temperatures spike.",
    });
  });

  it("classifies only HTTPS Reddit hosts as internal URLs", async () => {
    const urls = [
      "https://www.reddit.com/r/urbanplanning/comments/post1/heat_alerts/",
      "https://old.reddit.com/r/urbanplanning/comments/post2/heat_alerts/",
      "https://www.reddit.com.evil.example/post3",
      "https://www.reddit.com@evil.example/post4",
      "https://evil.example/www.reddit.com/post5",
    ];
    const listing = {
      data: {
        after: null,
        children: urls.map((url, index) => ({
          data: {
            id: `post${index + 1}`,
            name: `t3_post${index + 1}`,
            title: "Heat alerts arrive too late for our neighborhood",
            selftext: "Volunteers rebuild the call list every time temperatures spike.",
            permalink: `/r/urbanplanning/comments/post${index + 1}/heat_alerts/`,
            url,
            score: 87,
            num_comments: 4,
            created_utc: 1_784_236_800,
            subreddit: "urbanplanning",
            over_18: false,
          },
        })),
      },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "url-token", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listing), { status: 200 })));

    const page = await searchApprovedRedditPage({ credentials, query: "heat workflow" });

    expect(page.items.map(({ externalUrl }) => externalUrl)).toEqual([
      null,
      null,
      urls[2],
      urls[3],
      urls[4],
    ]);
  });

  it("reuses the OAuth token and returns Reddit rate-limit metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "cached-token", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(postListing("post1")), {
        status: 200,
        headers: { "x-ratelimit-used": "2", "x-ratelimit-remaining": "98", "x-ratelimit-reset": "42" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(postListing("post2")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await searchApprovedRedditPage({ credentials, query: "heat workflow" });
    const second = await searchApprovedRedditPage({ credentials, query: "cooling center workflow" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(first.rateLimit).toEqual({ used: 2, remaining: 98, resetSeconds: 42 });
    expect(second.items[0]?.id).toBe("post2");
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("authorization")).toBe("Bearer cached-token");
  });

  it("keeps lookalike Reddit hostnames as external URLs", async () => {
    const externalUrl = "https://www.reddit.com.attacker.example/phishing";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "host-token", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(postListing("post1", externalUrl)), { status: 200 })));

    const result = await searchApprovedRedditPage({ credentials, query: "heat workflow" });

    expect(result.items[0]?.externalUrl).toBe(externalUrl);
  });

  it("normalizes a bounded post thread and omits deleted comments", async () => {
    const comments = {
      data: {
        children: [{
          kind: "t1",
          data: {
            id: "comment1",
            name: "t1_comment1",
            parent_id: "t3_post1",
            body: "We still coordinate cooling center shifts in a spreadsheet.",
            permalink: "/r/urbanplanning/comments/post1/heat_alerts/comment1/",
            score: 12,
            created_utc: 1_784_236_900,
            depth: 0,
            replies: "",
          },
        }, {
          kind: "t1",
          data: {
            id: "comment2",
            parent_id: "t3_post1",
            body: "[deleted]",
            score: 0,
            created_utc: 1_784_236_901,
            depth: 0,
          },
        }],
      },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "thread-token", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([postListing("post1"), comments]), { status: 200 })));

    const thread = await getApprovedPostThread({ credentials, postId: "t3_post1", commentLimit: 10, commentDepth: 3 });

    expect(thread.post.id).toBe("post1");
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({ id: "comment1", parentId: "t3_post1", depth: 0 });
  });

  it("returns a safe retryable error when Reddit rate-limits a request", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "rate-token", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("provider body must stay private", { status: 429 })));

    await expect(searchApprovedRedditPage({ credentials, query: "workflow problem" })).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      status: 429,
    });
  });

  it("rejects discovery without the recorded authorization boundary", async () => {
    await expect(searchApprovedReddit({
      credentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
        userAgent: "ReDDone test agent",
        approvalReference: "",
      },
      query: "workflow problem",
    })).rejects.toThrow(/written approval reference/i);
  });
});

import { tool } from "ai";
import { z } from "zod";

export const webSearch = tool({
  name: "web_search",
  description: "Search the web for up-to-date information",
  parameters: z
    .object({
      query: z.string().describe("Search query"),
    })
    .strict(), // ⭐ 非常重要

  execute: async ({ query }) => {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: 5,
        include_answer: false,
      }),
    });

    if (!res.ok) {
      throw new Error("Web search failed");
    }

    const data = await res.json();

    return {
      query,
      results: data.results.map((r: any) => ({
        title: r.title,
        url: r.url,
        content: r.content.slice(0, 500),
      })),
    };
  },
});

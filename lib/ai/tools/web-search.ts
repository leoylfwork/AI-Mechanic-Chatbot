import { z } from "zod";

export const webSearchTool = {
  web_search: {
    description: "Search the web for up-to-date information",
    inputSchema: z.object({
      query: z.string(),
    }),
    execute: async ({ query }: { query: string }) => {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query,
          search_depth: "advanced",
          max_results: 5,
        }),
      });

      const data = await res.json();
      return data;
    },
  },
};

import { tool } from "ai";
import { z } from "zod";

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
};

export const tavilySearch = tool({
  description:
    "Web search via Tavily. Use this to fetch evidence links before answering diagnostic/TSB/OBD/code/next-step questions.",
  parameters: z.object({
    query: z.string().min(2),
    maxResults: z.number().int().min(1).max(10).default(5),
    searchDepth: z.enum(["basic", "advanced"]).default("advanced"),
    includeAnswer: z.boolean().default(false),
    includeRawContent: z.boolean().default(false),
  }),
  execute: async ({
    query,
    maxResults,
    searchDepth,
    includeAnswer,
    includeRawContent,
  }) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error: "Missing TAVILY_API_KEY",
        query,
        results: [] as TavilyResult[],
      };
    }

    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: searchDepth,
        include_answer: includeAnswer,
        include_raw_content: includeRawContent,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `Tavily error: ${resp.status}`,
        detail: text,
        query,
        results: [] as TavilyResult[],
      };
    }

    const data = (await resp.json()) as {
      answer?: string;
      results?: TavilyResult[];
    };

    const results = Array.isArray(data.results) ? data.results : [];

    // ✅ 返回给模型：最好结构化 + 也给一个可读 summary
    const readable = results
      .map((r, i) => {
        const title = r.title || "Untitled";
        const url = r.url || "";
        const snippet = (r.content || "").slice(0, 240);
        return `${i + 1}) ${title}\n${url}\n${snippet}`;
      })
      .join("\n\n");

    return {
      ok: true,
      query,
      answer: data.answer,
      results,
      readable,
    };
  },
});

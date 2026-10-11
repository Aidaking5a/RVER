
export async function searchWeb(
    query: string,
    signal?: AbortSignal
) {
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
        throw new Error("TAVILY_API_KEY is missing from .env");
    }

    if (!query.trim()) {
        throw new Error("Search query cannot be empty.");
    }

    const response = await fetch(
        "https://api.tavily.com/search",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                query: query.trim().slice(0, 400),
                search_depth: "basic",
                max_results: 5,
                include_answer: false,
                include_raw_content: false,
            }),
            signal,
        }
    );

    if (!response.ok) {
        throw new Error(
            `Web search failed with status ${response.status}`
        );
    }

    const data = await response.json();

    const results = data.results ?? [];

    return JSON.stringify(
        results.map((result: {
            title?: string;
            url?: string;
            content?: string;
            published_date?: string | null;
            score?: number;
        }) => ({
            title: result.title ?? "Untitled source",
            url: result.url,
            published_date: result.published_date ?? null,
            relevance_score: result.score ?? null,
            snippet: result.content ?? "",
        }))
    );
}

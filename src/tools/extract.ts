export async function extractPages(urls: string[], signal?: AbortSignal) {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is missing from .env");
  }

  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("Provide at least one source URL.");
  }

  const selectedUrls = urls.slice(0, 2);

  const safeUrls: string[] = [];

  for (const value of selectedUrls) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("A source URL must be a non-empty string.");
    }

    let url: URL;

    try {
      // Accept a URL only if it explicitly includes its scheme.
      url = new URL(value.trim());
    } catch {
      throw new Error(
        `Invalid source URL: ${value.slice(0, 100)}. ` +
          "Provide a complete URL beginning with https:// or http://.",
      );
    }

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("Invalid source URL.");
    }

    const hostname = url.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.startsWith("127.") ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.endsWith(".local") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname === "[::1]" ||
      hostname.startsWith("169.254.") ||
      hostname.startsWith("[fc") ||
      hostname.startsWith("[fd") ||
      hostname.startsWith("[fe80:") ||
      hostname.startsWith("[::ffff:") ||
      hostname === "[::]"
    ) {
      throw new Error("Private URLs cannot be extracted.");
    }

    safeUrls.push(url.toString());
  }

  const response = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: safeUrls,
      extract_depth: "basic",
      format: "text",
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Page extraction failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    results?: {
      url: string;
      raw_content?: string;
    }[];
  };

  return JSON.stringify(
    (data.results ?? []).map((page) => ({
      url: page.url,
      content: (page.raw_content ?? "").slice(0, 1000),
    })),
  );
}

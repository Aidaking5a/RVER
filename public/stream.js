/** Own one response at a time. Invalidating before abort fences late callbacks. */
export class ConversationStream {
  active = null;
  navigating = false;
  navigation = 0;
  constructor({ onEvent, onState, onError, fetcher = fetch }) {
    Object.assign(this, { onEvent, onState, onError, fetcher });
  }
  stop() {
    const run = this.active;
    this.active = null;
    run?.controller.abort();
    this.onState(false);
  }
  beginNavigation() {
    this.stop();
    this.navigating = true;
    this.onState(true);
    return ++this.navigation;
  }
  endNavigation(version) {
    if (version !== this.navigation) return false;
    this.navigating = false;
    this.onState(false);
    return true;
  }
  async start(url, body) {
    if (this.active || this.navigating) return false;
    const run = { controller: new AbortController() };
    this.active = run;
    this.onState(true);
    try {
      // Calling native fetch as an object method gives it the wrong receiver in browsers.
      const request = this.fetcher;
      const response = await request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: run.controller.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error ?? "Could not start the response");
      }
      if (!response.body) throw new Error("No response stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      const consume = (frame) => {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) return;
        const event = JSON.parse(data);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done") completed = true;
        if (this.active === run) this.onEvent(event);
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.active !== run) {
          await reader.cancel();
          return false;
        }
        buffer += decoder
          .decode(value, { stream: true })
          .replaceAll("\r\n", "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          consume(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (!completed && this.active === run)
        throw new Error("The connection ended before the response completed");
      return completed;
    } catch (error) {
      if (this.active === run && !run.controller.signal.aborted)
        this.onError(error);
      return false;
    } finally {
      if (this.active === run) {
        this.active = null;
        this.onState(false);
      }
    }
  }
}

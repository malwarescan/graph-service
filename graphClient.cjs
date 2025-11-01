/* graphClient.cjs — lightweight SDK for https://graph.croutons.ai (CommonJS) */

class GraphClient {
  constructor(baseUrl, options = {}) {
    if (!baseUrl) throw new Error("baseUrl is required");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeout = options.timeout || 10000;
  }

  async _fetchRaw(path, init = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeout);

    const headers = Object.assign(
      { Accept: "application/json" },
      init.headers || {}
    );

    try {
      const res = await fetch(this.baseUrl + path, {
        ...init,
        signal: controller.signal,
        headers
      });
      clearTimeout(t);
      return res;
    } catch (err) {
      clearTimeout(t);
      if (err && err.name === "AbortError") {
        throw new Error(`Request timed out after ${this.timeout}ms`);
      }
      throw err;
    }
  }

  async _fetchJSON(path, init = {}) {
    const res = await this._fetchRaw(path, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    try {
      return JSON.parse(text || "{}");
    } catch (e) {
      throw new Error(`Expected JSON but got: ${text.slice(0, 200)}`);
    }
  }

  async _fetchText(path, init = {}) {
    const res = await this._fetchRaw(path, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    return text;
  }

  async health() {
    const txt = await this._fetchText("/healthz", { method: "GET" });
    return txt === "ok" || txt === "OK";
  }

  async stats() {
    return this._fetchJSON("/diag/stats", { method: "GET" });
  }

  async queryCroutons({ limit = 10, newest = "1" } = {}) {
    const txt = await this._fetchText(`/feeds/croutons.ndjson?nocache=${newest}`, {
      method: "GET",
      headers: { Accept: "application/x-ndjson" }
    });
    const items = txt
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return { items: items.slice(-limit) };
  }

  async queryCorpora({ limit = 5 } = {}) {
    const txt = await this._fetchText(`/feeds/corpora.ndjson?nocache=1`, {
      method: "GET",
      headers: { Accept: "application/x-ndjson" }
    });
    const items = txt
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return { items: items.slice(-limit) };
  }

  async queryTriples({ limit = 10 } = {}) {
    const data = await this._fetchJSON(`/feeds/graph.json?nocache=1`, { method: "GET" });
    const triples = Array.isArray(data.triples) ? data.triples : [];
    return { items: triples.slice(-limit) };
  }
}

module.exports = GraphClient;

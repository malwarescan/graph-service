import express from "express";
const app = express();
const PORT = process.env.PORT || 8080;

app.get("/healthz", (req, res) => res.send("ok"));

app.get("/feeds/croutons.ndjson", (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  const data = [
    { id: 1, text: "First crouton from graph-service" },
    { id: 2, text: "Truth Hose feed operational" }
  ];
  res.send(data.map(x => JSON.stringify(x)).join("\n") + "\n");
});

app.listen(PORT, () => console.log(`graph-service running on ${PORT}`));

// Runs Cortex's embedder as a service for rejects bot memory (rejects-embed.service).
// Usage: pnpm embed   (EMBED_HOST, EMBED_PORT, EMBED_MODEL_CACHE)
import { createEmbedder } from "./embedding.ts";
import { createEmbedServer } from "./embedServer.ts";

const host = process.env.EMBED_HOST ?? "127.0.0.1";
// Loopback, or a private IPv4 address on a shared tools host whose firewall names the callers.
const privateV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
if (!["127.0.0.1", "::1"].includes(host) && !privateV4.test(host))
  throw new Error("The embedder must listen on loopback or a private address");
const port = Number(process.env.EMBED_PORT ?? "3982");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid EMBED_PORT");
const embedder = await createEmbedder(process.env.EMBED_MODEL_CACHE);
const server = createEmbedServer(embedder);
server.listen(port, host, () => console.log(`Embedder ${embedder.id} http://${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createEmbedder } from "./embedding.ts";
import { createCortexHttpServer } from "./http.ts";
import { CortexIndex } from "./index.ts";
import { CortexService } from "./service.ts";
import { Vault } from "./vault.ts";

const queries = [
  {
    id: "q1",
    language: "en",
    query:
      "Why does Muon balance the directions of a weight matrix update instead of treating each weight independently?",
    source: "VAQHsKS9fxY",
    start: 308,
    end: 500,
    anchors: ["orthogonal", "normalizing these direction"],
  },
  {
    id: "q2",
    language: "en",
    query: "How can a tiny gradient survive rounding when training using four-bit floating point?",
    source: "mTd3tBpfYmw",
    start: 680,
    end: 750,
    anchors: ["30% probability", "stochastic rounding"],
  },
  {
    id: "q3",
    language: "en",
    query:
      "How does Xiaomi keep reinforcement learning GPUs busy when some agent trajectories take much longer than others?",
    source: "1BZB4c792-0",
    start: 500,
    end: 550,
    anchors: ["partial rollouts"],
  },
  {
    id: "q4",
    language: "en",
    query:
      "Why do Scion users no longer need to push commits and what work moves to the central server?",
    source: "hiI0Vk4NgeY",
    start: 830,
    end: 995,
    anchors: ["nothing to push", "performs merges and rebases"],
  },
  {
    id: "q5",
    language: "en",
    query:
      "Why might coding agents make native mobile development practical for a team without specialist platform engineers?",
    source: "oPZLPUtmROo",
    start: 3260,
    end: 3390,
    anchors: ["agents make the gap", "gap doesn't matter", "gap that made me feel"],
  },
  {
    id: "uk1",
    language: "uk",
    query:
      "Чому оптимізатор Муон вирівнює силу різних напрямків оновлення матриці ваг замість незалежної обробки кожної ваги?",
    source: "VAQHsKS9fxY",
    start: 308,
    end: 500,
    anchors: ["orthogonal", "normalizing these direction"],
  },
  {
    id: "uk2",
    language: "uk",
    query:
      "Як стохастичне округлення зберігає дуже малі градієнти під час навчання з чотирибітними числами з рухомою комою?",
    source: "mTd3tBpfYmw",
    start: 680,
    end: 750,
    anchors: ["30% probability", "stochastic rounding"],
  },
  {
    id: "uk3",
    language: "uk",
    query:
      "Як тримати графічні процесори зайнятими під час навчання з підкріпленням, коли деякі траєкторії агентів набагато довші за інші?",
    source: "1BZB4c792-0",
    start: 500,
    end: 550,
    anchors: ["partial rollouts"],
  },
];
const passageSchema = z.object({
  sourceId: z.string(),
  title: z.string(),
  revision: z.string(),
  from: z.number(),
  to: z.number(),
  timeFrom: z.number().nullable(),
  timeTo: z.number().nullable(),
  snippet: z.string(),
  rank: z.number(),
  score: z.number(),
});
const transcriptDirectory = process.argv[2];
if (!transcriptDirectory)
  throw new Error("Usage: node src/evaluate.ts <transcript-directory> [report.json]");
const reportPath = process.argv[3] ?? "/tmp/cortex-evaluation.json";
const started = performance.now();
const vault = new Vault(NodePath.resolve(process.env.CORTEX_VAULT ?? "/tmp/cortex-test-vault"));
const embedder = await createEmbedder(process.env.CORTEX_MODEL_CACHE);
const modelLoaded = performance.now();
const index = new CortexIndex(vault, embedder);
const service = new CortexService(vault, index);
const token = NodeCrypto.randomBytes(32).toString("hex");
const server = createCortexHttpServer(service, { readToken: `${token}-read`, writeToken: token });
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
NodeAssert.ok(address && typeof address === "object");
const client = new Client({ name: "cortex-evaluation", version: "1" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    NodeAssert.ok(!result.isError, `MCP tool ${name} failed`);
    const content = result.content;
    NodeAssert.ok(Array.isArray(content));
    const item = content[0];
    NodeAssert.ok(item && item.type === "text" && typeof item.text === "string");
    return JSON.parse(item.text) as unknown;
  }
  const ids = new Map<string, string>();
  const ingestionStarted = performance.now();
  for (const name of NodeFS.readdirSync(transcriptDirectory)
    .filter((name) => name.endsWith(".md"))
    .sort()) {
    const path = NodePath.join(transcriptDirectory, name);
    const text = NodeFS.readFileSync(path, "utf8");
    const title = text.split("\n")[0]!.replace(/^#\s*/, "");
    const originalId = name.slice(0, -3);
    const receipt = z.object({ sourceId: z.string(), indexed: z.literal(true) }).parse(
      await call("cortex_add_source", {
        path,
        kind: "video",
        title,
        url: `https://www.youtube.com/watch?v=${originalId}`,
        language: "en",
      }),
    );
    ids.set(receipt.sourceId, originalId);
  }
  const ingestionMs = performance.now() - ingestionStarted;
  NodeAssert.equal(vault.events.filter((event) => event.type === "observation").length, 0);
  async function evaluateQuery(query: (typeof queries)[number]) {
    const searchStarted = performance.now();
    const passages = z
      .array(passageSchema)
      .parse(await call("cortex_search", { query: query.query, k: 8 }));
    const latencyMs = performance.now() - searchStarted;
    const inspected = [];
    for (const passage of passages) {
      const excerpt = z.object({ excerpt: z.string() }).parse(
        await call("cortex_read", {
          sourceId: passage.sourceId,
          from: passage.from,
          to: passage.to,
        }),
      );
      const originalId = ids.get(passage.sourceId);
      const hit =
        originalId === query.source &&
        (passage.timeFrom ?? Infinity) <= query.end &&
        (passage.timeTo ?? Infinity) >= query.start &&
        query.anchors.some((anchor) => excerpt.excerpt.toLowerCase().includes(anchor));
      inspected.push({ ...passage, originalId, hit, excerpt: excerpt.excerpt });
    }
    const firstRank = inspected.find((passage) => passage.hit)?.rank ?? null;
    return {
      ...query,
      firstRank,
      hitAt3: firstRank !== null && firstRank <= 3,
      reciprocalRankAt8: firstRank === null ? 0 : 1 / firstRank,
      latencyMs,
      passages: inspected,
    };
  }
  const results: Awaited<ReturnType<typeof evaluateQuery>>[] = [];
  for (const query of queries) results.push(await evaluateQuery(query));
  const summary = ["en", "uk"].map((language) => {
    const subset = results.filter((result) => result.language === language);
    return {
      language,
      hitAt3: subset.filter((result) => result.hitAt3).length,
      count: subset.length,
      mrrAt8: subset.reduce((sum, result) => sum + result.reciprocalRankAt8, 0) / subset.length,
    };
  });
  const report = {
    model: embedder.id,
    stats: index.stats(),
    modelLoadMs: modelLoaded - started,
    ingestionMs,
    rssMiB: process.memoryUsage().rss / 1024 ** 2,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    summary,
    results,
  };
  NodeFS.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        ...report,
        results: results.map(({ id, query, firstRank, passages }) => ({
          id,
          query,
          firstRank,
          top3: passages.slice(0, 3).map(({ originalId, from, to, timeFrom, timeTo, snippet }) => ({
            originalId,
            from,
            to,
            timeFrom,
            timeTo,
            snippet,
          })),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  index.close();
  vault.close();
}

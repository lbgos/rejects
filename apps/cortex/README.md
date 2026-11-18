# Cortex

Independent, tool-only recall for any MCP client. Node 24.13.1 or newer in the Node 24 line. The app does not need to run.

`~/Cortex/sources/<id>.md` and `events.jsonl` are authoritative. Source artifacts have a flat YAML header with kind, title, optional URL, added time and language. IDs deduplicate identical content and metadata. Edits are new source imports. Do not edit accepted artifacts or old events. The service rejects changed artifacts on replay. Corrections append an observation with `supersedes`; old evidence remains readable.

Imports record source registration only. `belief`, `exposure`, `understanding`, `endorsement` and `confidence` observations remain distinct. `stance` is affirm, reject, uncertain or unspecified; confidence is explicitly supplied in [0, 1] or null. `sourceRef` accepts artifact line ranges and known timestamp ranges, with the revision filled in at append time. A separate confidence observation does not silently overwrite a belief. `cortex_beliefs` searches observations and returns supersession links, including history.

## Run

From the repository root, after installing workspace dependencies:

```sh
# Supply distinct CORTEX_READ_TOKEN and CORTEX_WRITE_TOKEN through your credential runner, each at least 24 characters.
pnpm --filter @lbgos/cortex start

# Stop the service before rebuilding. No token is required for this local command.
pnpm --filter @lbgos/cortex rebuild
pnpm --filter @lbgos/cortex test
```

| Environment variable | Default                      |
| -------------------- | ---------------------------- |
| `CORTEX_VAULT`       | `~/Cortex`                   |
| `CORTEX_HOST`        | `127.0.0.1`                  |
| `CORTEX_PORT`        | `3981`                       |
| `CORTEX_READ_TOKEN`  | Required, read tools only    |
| `CORTEX_WRITE_TOKEN` | Required, all tools          |
| `CORTEX_IMPORT_DIR`  | Unset, path imports disabled |
| `CORTEX_MODEL_CACHE` | `~/.cache/cortex/models`     |

The first embedding use downloads the pinned, quantized `Xenova/multilingual-e5-small` model. Inference runs locally on CPU, with two ONNX threads. No generation model or API credentials are used. Back up the Markdown and JSONL files; `index.sqlite` and its WAL files are disposable. Rebuild recreates the disposable SQLite files and replays both source files and events. Changing the embedding identity invalidates the index.

One process holds `.writer.lock` for the lifetime of the vault. After an unclean exit, verify that no cortex writer is running before manually removing that lock. A partial JSONL tail fails closed. Preserve the original log, repair a copy to its last complete event, and restore only after inspection. Rebuild never truncates the authoritative log. An artifact accepted before an indexing failure remains saved; `cortex_add_source` reports `indexed: false`, and rebuild retries it.

## Agent connections

The endpoint is MCP Streamable HTTP at `http://127.0.0.1:3981/mcp`, with `Authorization: Bearer <token>`. It supports stateless POST requests and JSON responses. One process shares the embedding model across clients. Browser Origin requests are rejected. The CLI rejects non-loopback bind addresses. Run it beside the app so both resolve the same loopback endpoint. The retired `CORTEX_TOKEN` is not accepted; replace it with distinct scoped tokens.

Claude Code `.mcp.json`, using its environment expansion:

```json
{
  "mcpServers": {
    "cortex": {
      "type": "http",
      "url": "http://127.0.0.1:3981/mcp",
      "headers": { "Authorization": "Bearer ${CORTEX_READ_TOKEN}" }
    }
  }
}
```

Codex `config.toml`, following the [official MCP configuration](https://developers.openai.com/codex/mcp):

```toml
[mcp_servers.cortex]
url = "http://127.0.0.1:3981/mcp"
bearer_token_env_var = "CORTEX_READ_TOKEN"
```

Gemini and other providers can use the same HTTP endpoint and bearer header. No model context is preloaded. Agents retrieve only when needed.

- `cortex_search({query, k?})`: at most eight passages, default five. Source ID, revision, title, artifact lines, timestamp anchors, short snippet and reciprocal rank fusion score. Scores are ranks, not confidence. FTS5 and sqlite-vec each supply 30 candidates; fusion uses constant 60.
- `cortex_read({sourceId, from?, to?})`: at most 80 artifact lines and 12 KB, with truncation and partial-line flags. Time ranges refer to supplied transcript anchors; an unknown final end stays null.
- `cortex_add_source({path|text, kind, title, url?, language?, channel?, durationSeconds?, concepts?})`: write token only. Copies at most 2 MB of UTF-8 text. Path imports are disabled unless `CORTEX_IMPORT_DIR` is set. On Linux the opened file must resolve inside that directory, including through symlinks; verification fails closed without `/proc/self/fd`. Keep this directory operator-owned and free of secrets, hard links and mounts from other directories. Prefer supplied text.
- `cortex_record({type, statement, stance?, confidence, sourceRef?, supersedes?, concepts?})`: append explicit evidence. Statements are at most 1,000 characters.
- `cortex_beliefs({query})`: at most eight matching typed observations. Lexical matching can miss paraphrases. Inspect supersession links before treating any event as current.

Queries are capped at 1,000 characters, tool results at 24 KB of JSON text and requests at 2.1 MB. At most 16 requests can be active or queued for the shared service. Transcript chunks target 220 whitespace words with one transcript-line overlap, preserving source revision and artifact line/time citations. Model tokenization can truncate unusually long lines; use paragraph-sized source lines.

## Seed evaluation

```sh
CORTEX_VAULT=/tmp/cortex-test-vault \
  pnpm --filter @lbgos/cortex exec node src/evaluate.ts \
  /path/to/the/seven/transcripts /tmp/cortex-evaluation.json
```

This imports all seven transcripts through the HTTP MCP SDK client, runs five fixed English questions and three Ukrainian translations against the English corpus, then reads the cited passages. It records top-eight results, answer-anchor judgments, hit@3, MRR@8, latency and process RAM. References and English queries match the earlier prototype. This is a small authored evaluation, not a general accuracy claim. The JSON report stays outside the repository. On the seven supplied transcripts, the pinned model indexed 245 passages in 17.0 seconds. Reference hit@3 was 4/5 English and 3/3 Ukrainian, with MRR@8 of 0.70 and 1.00. Peak process RSS was 754 MiB under a 3 GiB memory limit and 300% CPU quota on the laptop. The native-mobile-agent reference passage was the English miss. These are not LXC measurements.

## Advisor and graph

Both scopes can call `cortex_advise({text, concepts?})`. Pass a transcript or summary and preferably up to eight short concept labels. Without labels, the first eight nonempty lines or sentences become provisional labels. It returns one watch/skip line, three reasons, new concepts and cited source passages plus current explicit observations. "New" means no matching demonstrated understanding, even if exposure exists. The rule skips at 80% current affirmative understanding with confidence at least 0.7 and no rejected or uncertain matching belief. Matching uses at least 60% concept token overlap. Retrieval ranks do not establish mastery, relevance or entailment. The calling agent makes the semantic judgment; the tool runs no LLM.

`cortex_graph({after?, limit?})` returns nodes and edges as JSON, in event pages of at most five. Continue using `nextAfter` and merge nodes by id. Concepts are explicit tags on imports or observations, up to eight labels of 80 characters. Source-to-concept and observation-to-concept edges use those tags; source references supply evidence edges. Superseded observations remain marked in the graph. Existing sources without tags remain source nodes. No graph UI or automatic concept extraction is included.

These two tools are on the standalone Cortex endpoint. The app's existing Cortex bridge still exposes its original five tools; adding advisor/graph entries to that shared toolkit is separate from this change's owned files. Native MCP clients can connect directly using the examples above.

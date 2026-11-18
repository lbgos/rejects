// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
// @ts-expect-error -- scripts has no direct Playwright dependency; use the web package copy.
import { chromium } from "../apps/web/node_modules/playwright/index.mjs";

const root = process.cwd();
const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rejects-e2e-"));
let server: NodeChildProcess.ChildProcess | undefined;

const runPairOnce = async (): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "node",
      ["apps/server/src/bin.ts", "pair", "--base-dir", home],
      {
        cwd: root,
        env: { ...process.env, T3CODE_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      const url = stdout.match(/Pairing URL: (\S+)/)?.[1];
      if (code === 0 && url) resolve(url);
      else reject(new Error(`pair failed (${code}): ${stderr || stdout}`));
    });
  });

// The dev runner prints its banner before the server is listening, so pair until it is.
const runPair = async (): Promise<string> => {
  const attempts = 60;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await runPairOnce();
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw lastError;
};

const runCli = async (args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("node", ["apps/server/src/bin.ts", ...args], {
      cwd: root,
      env: { ...process.env, T3CODE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`t3 ${args.join(" ")} failed (${code}): ${stderr || stdout}`)),
    );
  });

try {
  server = NodeChildProcess.spawn("node", ["scripts/dev-runner.ts", "dev", "--home-dir", home], {
    cwd: root,
    env: { ...process.env, T3CODE_NO_BROWSER: "1", T3CODE_DEV_INSTANCE: `e2e-${process.pid}` },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  server.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  server.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`dev server did not start:\n${output.join("")}`)),
      120_000,
    );
    const onData = () => {
      if (output.join("").includes("[dev-runner] mode=dev")) {
        clearTimeout(timer);
        resolve();
      }
    };
    server?.stdout?.on("data", onData);
    server?.stderr?.on("data", onData);
    server?.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited (${code}):\n${output.join("")}`));
    });
  });

  const pair = await runPair();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pair, { waitUntil: "domcontentloaded" });
    // A fresh home redirects to the built-in Steward thread, which proves the client reached the server.
    await page.waitForURL(/\/[0-9a-f-]{36}\//, { timeout: 120_000 });
    const environmentId = new URL(page.url()).pathname.split("/")[1] ?? "";

    await runCli(["project", "add", "."]);
    const threadId = (
      await runCli(["thread", "start", "--provider", "devReplay", "--model", "showcase", ".", "go"])
    ).trim();
    if (!threadId) throw new Error("thread start printed no thread id");

    await page.goto(
      new URL(`/${environmentId}/${encodeURIComponent(threadId)}`, page.url()).toString(),
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByText("This turn is a replay. It costs nothing", { exact: false })
      .waitFor({ timeout: 120_000 });
  } finally {
    await browser.close();
  }
} finally {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  await NodeFSP.rm(home, { recursive: true, force: true });
}

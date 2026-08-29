import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(
  new URL(
    "../plugins/sssnack/skills/sssnack/scripts/sssnack.mjs",
    import.meta.url,
  ),
);

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function rpcSuccess(id, value) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  });
}

test("share registers once, stores both credentials, and publishes without exposing them", async (t) => {
  const store = await mkdtemp(join(tmpdir(), "sssnack-cli-"));
  t.after(() => rm(store, { recursive: true, force: true }));

  const agentToken = `ssn_${"1".repeat(64)}`;
  const recoveryToken = `ssr_${"2".repeat(64)}`;
  const calls = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const rpc = JSON.parse(body);
      const name = rpc.params?.name;
      calls.push({
        name,
        args: rpc.params?.arguments,
        authorization: request.headers.authorization,
        protocolVersion: request.headers["mcp-protocol-version"],
      });

      let value;
      if (name === "start_registration") {
        value = {
          handle: "paperghost",
          expires_at: "2026-08-22T12:10:00.000Z",
          challenge_token: "signed.challenge",
          first_snack: {
            prompt: "Sort the crumbs.",
            crumbs: [
              { mark: "zest", bites: 8 },
              { mark: "acid", bites: 2 },
              { mark: "nori", bites: 5 },
              { mark: "grid", bites: 3 },
            ],
          },
        };
      } else if (name === "register_agent") {
        assert.equal(rpc.params.arguments.answer, "acid-grid-nori-zest");
        assert.equal(rpc.params.arguments.discovered_via, "cli");
        assert.equal("nonce" in rpc.params.arguments, false);
        value = {
          agent: { handle: "paperghost" },
          agent_token: agentToken,
          recovery_token: recoveryToken,
        };
      } else if (name === "publish_snack") {
        assert.equal(request.headers.authorization, `Bearer ${agentToken}`);
        assert.equal(rpc.params.arguments.format, "text");
        assert.equal(rpc.params.arguments.title, "Perfect is suspicious");
        assert.deepEqual(rpc.params.arguments.tags, []);
        assert.equal(rpc.params.arguments.license, "ARR");
        value = { url: "https://sssnack.com/s/test-snack" };
      } else {
        throw new Error(`unexpected tool ${name}`);
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(rpcSuccess(rpc.id, value));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "request failed");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await runCli(
    [
      "share",
      "--handle",
      "paperghost",
      "--format",
      "text",
      "--title",
      "Perfect is suspicious",
      "--caption",
      "Every resolved edge is hiding a decision.",
    ],
    {
      SSSNACK_ENDPOINT: `http://127.0.0.1:${address.port}/api/mcp`,
      SSSNACK_STORE: store,
      SSSNACK_AGENT_TOKEN: "",
      SSSNACK_RECOVERY_TOKEN: "",
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /registered @paperghost/);
  assert.match(result.stdout, /https:\/\/sssnack\.com\/s\/test-snack/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(agentToken));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(recoveryToken));
  assert.equal(
    await readFile(join(store, "agent-token"), "utf8"),
    `${agentToken}\n`,
  );
  assert.equal(
    await readFile(join(store, "recovery-token"), "utf8"),
    `${recoveryToken}\n`,
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ["start_registration", "register_agent", "publish_snack"],
  );
  assert.equal(calls[0].authorization, undefined);
  assert.equal(calls[1].authorization, undefined);
  assert.ok(calls.every((call) => call.protocolVersion === "2025-06-18"));
});

test("share refuses a corrupt saved bearer instead of silently creating another identity", async (t) => {
  const store = await mkdtemp(join(tmpdir(), "sssnack-cli-corrupt-"));
  t.after(() => rm(store, { recursive: true, force: true }));
  await writeFile(join(store, "agent-token"), "not-a-token\n");

  const result = await runCli(
    ["share", "--handle", "paperghost", "--format", "text", "--title", "No post"],
    {
      SSSNACK_ENDPOINT: "http://127.0.0.1:1/api/mcp",
      SSSNACK_STORE: store,
      SSSNACK_AGENT_TOKEN: "",
    },
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /is not a valid SSSNACK agent token/);
  assert.doesNotMatch(result.stderr, /not-a-token/);
});

test("ROOT commands inspect, claim, and paint without printing the agent credential", async (t) => {
  const agentToken = `ssn_${"3".repeat(64)}`;
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    calls.push({
      name: rpc.params?.name,
      args: rpc.params?.arguments,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(rpcSuccess(rpc.id, { accepted: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () => new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    SSSNACK_ENDPOINT: `http://127.0.0.1:${address.port}/api/mcp`,
    SSSNACK_AGENT_TOKEN: agentToken,
  };

  const results = await Promise.all([
    runCli(["root", "--json"], env),
    runCli(["root-history", "--limit", "7", "--json"], env),
    runCli([
      "claim-root",
      "--challenge",
      "2026-08-29",
      "--answer",
      "grid-signal-paper-noise",
      "--json",
    ], env),
    runCli(["paint-root", "--id", "213764e3-5cd1-428c-9d8f-583fd6aaf9ae", "--json"], env),
  ]);
  assert.ok(results.every(({ code }) => code === 0));
  assert.doesNotMatch(
    results.map(({ stdout, stderr }) => stdout + stderr).join(""),
    new RegExp(agentToken),
  );
  assert.deepEqual(
    calls.map(({ name }) => name).sort(),
    ["claim_root", "get_root_history", "inspect_root", "set_root_artifact"],
  );
  const claim = calls.find(({ name }) => name === "claim_root");
  assert.deepEqual(claim.args, {
    challenge_id: "2026-08-29",
    answer: "grid-signal-paper-noise",
  });
  assert.equal(claim.authorization, `Bearer ${agentToken}`);
  assert.deepEqual(
    calls.find(({ name }) => name === "get_root_history").args,
    { limit: 7 },
  );
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
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

function rpcFailure(id, message) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
    },
  });
}

test("share registers once, stores both credentials, and publishes without exposing them", async (t) => {
  const store = await mkdtemp(join(tmpdir(), "sssnack-cli-"));
  t.after(() => rm(store, { recursive: true, force: true }));

  const agentToken = `ssn_${"1".repeat(64)}`;
  const recoveryToken = `ssr_${"2".repeat(64)}`;
  const calls = [];
  let signingPayload = "";
  let signingKeyId = "";
  let publicJwk;
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
      } else if (name === "start_agent_signing_key") {
        assert.equal(request.headers.authorization, `Bearer ${agentToken}`);
        assert.equal("d" in rpc.params.arguments.public_jwk, false);
        publicJwk = rpc.params.arguments.public_jwk;
        const thumbprint = JSON.stringify({
          crv: publicJwk.crv,
          kty: publicJwk.kty,
          x: publicJwk.x,
        });
        signingKeyId = `ssk_${createHash("sha256").update(thumbprint).digest("base64url")}`;
        signingPayload = JSON.stringify({ action: "register-test-key", key_id: signingKeyId });
        value = {
          status: "challenge",
          challenge_id: "00000000-0000-4000-8000-000000000401",
          key_id: signingKeyId,
          payload: signingPayload,
        };
      } else if (name === "confirm_agent_signing_key") {
        assert.equal(
          verify(
            null,
            Buffer.from(signingPayload),
            createPublicKey({ key: publicJwk, format: "jwk" }),
            Buffer.from(rpc.params.arguments.signature, "base64url"),
          ),
          true,
        );
        value = {
          created: true,
          key: { id: signingKeyId },
          ledger_event_id: "00000000-0000-4000-8000-000000000402",
        };
      } else if (name === "publish_snack") {
        assert.equal(request.headers.authorization, `Bearer ${agentToken}`);
        assert.equal(rpc.params.arguments.format, "text");
        assert.equal(rpc.params.arguments.title, "Perfect is suspicious");
        assert.deepEqual(rpc.params.arguments.tags, []);
        assert.equal(rpc.params.arguments.license, "ARR");
        value = {
          id: "00000000-0000-4000-8000-000000000403",
          url: "https://sssnack.com/s/test-snack",
          signing_request: {
            key_id: signingKeyId,
            payload: JSON.stringify({ action: "sign-test-snack" }),
          },
        };
      } else if (name === "sign_snack") {
        const payload = JSON.stringify({ action: "sign-test-snack" });
        assert.equal(
          verify(
            null,
            Buffer.from(payload),
            createPublicKey({ key: publicJwk, format: "jwk" }),
            Buffer.from(rpc.params.arguments.signature, "base64url"),
          ),
          true,
        );
        value = {
          created: true,
          agent_signature: {
            sigil: { mark: "◆◇", name: "ink-grid-signal", color: "hsl(20 92% 62%)" },
          },
        };
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
  const signingKey = JSON.parse(
    await readFile(join(store, "signing-key.json"), "utf8"),
  );
  assert.equal(signingKey.key_id, signingKeyId);
  assert.equal(typeof signingKey.private_jwk.d, "string");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(signingKey.private_jwk.d));
  assert.match(result.stdout, /signed\s+◆◇ ink-grid-signal/);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "start_registration",
      "register_agent",
      "start_agent_signing_key",
      "confirm_agent_signing_key",
      "publish_snack",
      "sign_snack",
    ],
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

test("optional signing failure never blocks an otherwise valid post", async (t) => {
  const store = await mkdtemp(join(tmpdir(), "sssnack-cli-unsigned-"));
  t.after(() => rm(store, { recursive: true, force: true }));
  const agentToken = `ssn_${"3".repeat(64)}`;
  await writeFile(join(store, "agent-token"), `${agentToken}\n`);
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    const name = rpc.params?.name;
    calls.push(name);
    response.writeHead(200, { "content-type": "application/json" });
    if (name === "start_agent_signing_key") {
      response.end(rpcFailure(rpc.id, "signing temporarily unavailable"));
      return;
    }
    assert.equal(name, "publish_snack");
    assert.equal(request.headers.authorization, `Bearer ${agentToken}`);
    response.end(rpcSuccess(rpc.id, {
      id: "00000000-0000-4000-8000-000000000404",
      url: "https://sssnack.com/s/unsigned-but-published",
      signing_request: null,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await runCli(
    ["post", "--format", "text", "--title", "Unsigned survives"],
    {
      SSSNACK_ENDPOINT: `http://127.0.0.1:${address.port}/api/mcp`,
      SSSNACK_STORE: store,
      SSSNACK_AGENT_TOKEN: "",
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /unsigned-but-published/);
  assert.match(result.stderr, /post will remain unsigned/);
  assert.deepEqual(calls, ["start_agent_signing_key", "publish_snack"]);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(agentToken));
});

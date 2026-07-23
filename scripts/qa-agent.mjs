const baseUrl = (process.argv[2] || process.env.QA_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

const expectedExecuteKeys = ["status", "error", "response", "steps"];
const expectedTeamKeys = ["group_batch_order_number", "team_name", "students"];
const expectedAgentKeys = ["description", "purpose", "prompt_template", "prompt_examples"];

const scenarios = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer();
  return { response, payload, contentType };
}

function keysExactly(value, keys) {
  return JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function validateExecuteShape(payload) {
  assert(keysExactly(payload, expectedExecuteKeys), `Execute top-level keys are not exact: ${Object.keys(payload).join(", ")}`);
  assert(payload.status === "ok" || payload.status === "error", "Execute status must be ok or error.");
  assert(payload.status === "ok" ? payload.error === null : typeof payload.error === "string", "Execute error field has invalid value.");
  assert(payload.status === "ok" ? typeof payload.response === "string" : payload.response === null, "Execute response field has invalid value.");
  assert(Array.isArray(payload.steps), "Execute steps must be an array.");
  for (const step of payload.steps) {
    assert(keysExactly(step, ["module", "prompt", "response"]), "Each step must contain only module, prompt, response.");
    assert(
      step.module === "Autonomous Listing Editor Agent" || step.module === "Supervisor / Control Agent",
      `Unexpected non-LLM step module: ${step.module}`
    );
    assert(keysExactly(step.prompt, ["system_prompt", "user_prompt"]), "Each step prompt must contain only system_prompt and user_prompt.");
    assert(typeof step.prompt.system_prompt === "string", "system_prompt must be a string.");
    assert(typeof step.prompt.user_prompt === "string", "user_prompt must be a string.");
  }
}

async function run(name, fn) {
  const started = Date.now();
  try {
    await fn();
    scenarios.push({ name, ok: true, elapsedMs: Date.now() - started, failure: null });
  } catch (error) {
    scenarios.push({
      name,
      ok: false,
      elapsedMs: Date.now() - started,
      failure: error instanceof Error ? error.message : String(error)
    });
  }
}

await run("team_info strict shape", async () => {
  const { response, payload } = await request("/api/team_info");
  assert(response.ok, "team_info did not return HTTP 200.");
  assert(keysExactly(payload, expectedTeamKeys), "team_info keys are not exact.");
  assert(payload.group_batch_order_number === "Batch3_08", "Batch number mismatch.");
  assert(Array.isArray(payload.students) && payload.students.length === 3, "Expected three students.");
  assert(payload.students.some((student) => student.name === "Shoval Zvieli"), "Missing Shoval Zvieli.");
  assert(payload.students.some((student) => student.name === "Daniel Elhadif-Kaminer"), "Missing Daniel Elhadif-Kaminer.");
  assert(payload.students.some((student) => student.name === "Opal Zvieli"), "Missing Opal Zvieli.");
});

await run("agent_info strict shape", async () => {
  const { response, payload } = await request("/api/agent_info");
  assert(response.ok, "agent_info did not return HTTP 200.");
  assert(keysExactly(payload, expectedAgentKeys), "agent_info keys are not exact.");
  assert(typeof payload.prompt_template?.template === "string", "Missing prompt_template.template.");
  assert(Array.isArray(payload.prompt_examples) && payload.prompt_examples.length > 0, "Missing prompt_examples.");
  for (const example of payload.prompt_examples) {
    assert(keysExactly(example, ["prompt", "full_response", "steps"]), "Prompt example keys are not exact.");
    assert(typeof example.prompt === "string", "Example prompt must be string.");
    assert(typeof example.full_response === "string", "Example full_response must be string.");
    assert(Array.isArray(example.steps), "Example steps must be array.");
    for (const step of example.steps) {
      assert(keysExactly(step, ["module", "prompt", "response"]), "Example step keys are not exact.");
      assert(step.module === "Autonomous Listing Editor Agent" || step.module === "Supervisor / Control Agent", "Example contains non-LLM step.");
      assert(keysExactly(step.prompt, ["system_prompt", "user_prompt"]), "Example prompt shape is not exact.");
    }
  }
});

await run("model_architecture png", async () => {
  const { response, payload, contentType } = await request("/api/model_architecture");
  assert(response.ok, "model_architecture did not return HTTP 200.");
  assert(contentType.includes("image/png"), `Expected image/png, got ${contentType}.`);
  const bytes = new Uint8Array(payload);
  assert(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, "Body is not a PNG.");
});

await run("execute out-of-scope prompt-only", async () => {
  const { response, payload } = await request("/api/execute", {
    method: "POST",
    body: JSON.stringify({ prompt: "Selected listing id: 45855270\nFind me car tires in Lisbon." })
  });
  assert(response.ok, "Out-of-scope execute should return HTTP 200 with safe response.");
  validateExecuteShape(payload);
  assert(payload.steps.length === 0, "Deterministic scope guard must not create LLM steps.");
  assert(/don't know|allowed tools|out-of-scope/i.test(payload.response), "Expected clear safe refusal.");
});

await run("execute error prompt-only strict", async () => {
  const { response, payload } = await request("/api/execute", {
    method: "POST",
    body: JSON.stringify({ prompt: "" })
  });
  assert(!response.ok, "Empty prompt should return HTTP error.");
  validateExecuteShape(payload);
  assert(payload.status === "error", "Expected status error.");
});

await run("execute success prompt-only strict", async () => {
  await request("/api/demo_reset", {
    method: "POST",
    body: JSON.stringify({ listing_id: "176153" })
  });
  const { response, payload } = await request("/api/execute", {
    method: "POST",
    body: JSON.stringify({
      prompt: "Selected listing id: 176153\nHandle this Lisbon Airbnb listing end to end and explain what changed."
    })
  });
  assert(response.ok, "Execute success should return HTTP 200.");
  validateExecuteShape(payload);
  assert(payload.status === "ok", "Expected status ok.");
  assert(typeof payload.response === "string" && payload.response.length > 40, "Expected final response text.");
});

await run("listing_page state endpoint", async () => {
  const { response, payload } = await request("/api/listing_page?id=176153");
  assert(response.ok && payload.status === "ok", "listing_page should return status ok.");
  assert(typeof payload.page?.currentDescription === "string", "listing_page missing currentDescription.");
});

await run("audit_logs endpoint", async () => {
  const { response, payload } = await request("/api/audit_logs?listing_id=176153");
  assert(response.ok && payload.status === "ok", "audit_logs should return status ok.");
  assert(Array.isArray(payload.audit_logs), "audit_logs must be an array.");
});

const failures = scenarios.filter((scenario) => !scenario.ok);
console.log(JSON.stringify({ ok: failures.length === 0, failures: failures.length, scenarios }, null, 2));

if (failures.length) {
  process.exit(1);
}

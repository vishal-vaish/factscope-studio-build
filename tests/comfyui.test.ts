import assert from "node:assert/strict";
import test from "node:test";
import { db, jobs, randomUUID } from "@/lib/db";
import { productionSchema, type Production } from "@/lib/production-schema";
import { comfyConfig } from "@/lib/comfyui/config";
import { applySceneBindings, buildWorkflow, WorkflowPreparationError } from "@/lib/comfyui/workflow-builder";
import { validateWorkflow, type ApiWorkflow } from "@/lib/comfyui/workflow-validator";
import { findMp4Output, isVerifiedMp4Response, submitWorkflow } from "@/lib/comfyui/client";
import { eq } from "drizzle-orm";

function makeProduction(sceneCount = 6): Production {
  const duration = 30 / sceneCount;
  return productionSchema.parse({
    schemaVersion: "1.0.0", documentType: "factscope.production", projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Test",
    video: { durationSeconds: 30, width: 1080, height: 1920, fps: 24, aspectRatio: "9:16", visualStyle: "test" },
    models: { imagePresetId: "", videoPresetId: "", workflowTemplateId: "" },
    narration: { language: "English", fullScript: "Complete narration", segments: [] },
    continuity: { mainObject: "", canonicalDescription: "stable object", fixedProperties: [], mechanicalConstraints: [], forbiddenChanges: [] },
    scenes: Array.from({ length: sceneCount }, (_, index) => ({ id: `scene-${index + 1}`, order: index + 1, title: `Scene ${index + 1}`, startSeconds: index * duration, durationSeconds: duration, narration: `Line ${index + 1}`, imagePrompt: `Image ${index + 1}`, imageNegativePrompt: `No image ${index + 1}`, videoPrompt: `Motion ${index + 1}`, videoNegativePrompt: `No motion ${index + 1}`, cameraMovement: "slow orbit", lighting: "soft", firstFrame: "start", lastFrame: "end", continuityRules: ["consistent"], scientificConstraints: ["accurate"] })),
    audio: { language: "English", voicePresetId: null, subtitlesEnabled: true, backgroundMusic: false },
  });
}

test("Production JSON schema accepts six contiguous scenes and rejects invalid plans", () => {
  const production = makeProduction();
  assert.equal(production.scenes.length, 6);
  assert.equal(production.video.fps, 24);
  assert.equal(productionSchema.safeParse({ ...production, scenes: [] }).success, false);
});

test("builder enforces the fixed six-scene, five-second, thirty-second configuration", async () => {
  const production = makeProduction(5);
  await assert.rejects(() => buildWorkflow(production), (error: unknown) => error instanceof WorkflowPreparationError && error.message.includes("exactly 6 scenes"));
  const wrongDuration = makeProduction();
  wrongDuration.video.durationSeconds = 60;
  wrongDuration.scenes.forEach((scene, index) => { scene.startSeconds = index * 10; scene.durationSeconds = 10; });
  await assert.rejects(() => buildWorkflow(wrongDuration), (error: unknown) => error instanceof WorkflowPreparationError && error.message.includes("30 seconds only"));
});

test("scene input mappings inject prompts, negatives, motion, narration, continuity and frame settings", () => {
  const production = makeProduction();
  const workflow: ApiWorkflow = {};
  const bindings = [] as typeof comfyConfig.bindings;
  for (let i = 0; i < 6; i++) {
    const nodeId = String(i + 1);
    workflow[nodeId] = { class_type: "FixtureNode", inputs: { image: "", negative: "", motion: "", narration: "", camera: "", frames: 0, width: 0, height: 0, fps: 0 } };
    for (const [value, inputName] of [["imagePrompt", "image"], ["imageNegativePrompt", "negative"], ["videoPrompt", "motion"], ["narration", "narration"], ["cameraAndContinuity", "camera"], ["frameCount", "frames"], ["width", "width"], ["height", "height"], ["fps", "fps"]] as const) bindings.push({ nodeId, inputName, value, sceneIndex: i });
  }
  applySceneBindings(workflow, production, bindings);
  assert.equal(workflow["3"].inputs.image, "Image 3");
  assert.equal(workflow["3"].inputs.negative, "No image 3");
  assert.equal(workflow["3"].inputs.motion, "Motion 3");
  assert.equal(workflow["3"].inputs.frames, 120);
  assert.match(String(workflow["3"].inputs.camera), /slow orbit/);
  assert.equal(workflow["3"].inputs.fps, 24);
});

test("workflow validation reports missing nodes and model mismatch from mocked object_info", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ModelLoader: { input: { required: { model_name: [["installed-model.safetensors"], {}] } } } }), { status: 200 });
  try {
    const workflow = { "1": { class_type: "MissingClass", inputs: { model_name: "wrong.safetensors" } } } as ApiWorkflow;
    const result = await validateWorkflow({ workflow, endpoint: "http://127.0.0.1:8188", bindings: [], modelBindings: [{ nodeId: "missing", inputName: "model_name", model: "image" }], sequentialDependencies: [], expectedMp4OutputNodeId: "missing-output", frameCounts: [120], selectedModels: [{ kind: "image", filename: "wrong.safetensors" }] });
    assert.equal(result.valid, false);
    assert.ok(result.failures.some(message => message.includes("MissingClass")));
    assert.ok(result.failures.some(message => message.includes("not listed as installed")));
    assert.ok(result.failures.some(message => message.includes("missing node")));
  } finally { globalThis.fetch = originalFetch; }
});

test("ComfyUI submission posts one prompt and persists the returned prompt ID", async () => {
  let calls = 0;
  const response = await submitWorkflow({ "1": { class_type: "AnyNode", inputs: {} } }, "http://127.0.0.1:8188", "secret", "factscope-test", async (input, init) => {
    calls++;
    assert.equal(String(input), "http://127.0.0.1:8188/prompt");
    const body = JSON.parse(String(init?.body));
    assert.ok(body.prompt["1"]);
    assert.equal(body.client_id, "factscope-test");
    return new Response(JSON.stringify({ prompt_id: "real-comfy-prompt-id" }), { status: 200 });
  });
  assert.equal(calls, 1);
  assert.equal(response.promptId, "real-comfy-prompt-id");

  const jobId = randomUUID();
  db.insert(jobs).values({ id: jobId, videoId: randomUUID(), status: "queued", promptId: response.promptId, error: null, output: null, createdAt: Date.now() }).run();
  assert.equal(db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.promptId, response.promptId);
  db.delete(jobs).where(eq(jobs.id, jobId)).run();
});

test("only an MP4 reference at the configured output node is accepted", () => {
  const history = { outputs: { "99": { videos: [{ filename: "final.mp4", subfolder: "factscope", type: "output" }] } } };
  const output = findMp4Output(history, "99");
  assert.deepEqual(output, { filename: "final.mp4", subfolder: "factscope", type: "output", nodeId: "99" });
  assert.equal(findMp4Output(history, "98"), null);
  assert.equal(isVerifiedMp4Response(output!, new Response(new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112]), { status: 200, headers: { "content-type": "video/mp4" } })), true);
  assert.equal(isVerifiedMp4Response(output!, new Response("not mp4", { status: 200, headers: { "content-type": "text/html" } })), false);
});

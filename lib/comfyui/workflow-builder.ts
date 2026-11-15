import "server-only";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { productionSchema, type Production } from "@/lib/production-schema";
import { comfyConfig, type InputBinding } from "@/lib/comfyui/config";
import { validateWorkflow, type ApiWorkflow, type WorkflowCheck } from "@/lib/comfyui/workflow-validator";

export class WorkflowPreparationError extends Error {
  constructor(message: string, readonly failures: string[] = [message]) { super(message); this.name = "WorkflowPreparationError"; }
}

export async function buildWorkflow(production: Production, config = comfyConfig): Promise<ApiWorkflow> {
  const parsed = productionSchema.safeParse(production);
  if (!parsed.success) throw new WorkflowPreparationError("Production JSON is invalid.", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`));
  const value = parsed.data;
  if (value.scenes.length !== config.sceneCount) throw new WorkflowPreparationError(`This master workflow supports exactly ${config.sceneCount} scenes; received ${value.scenes.length}.`);
  if (Math.abs(value.video.durationSeconds - config.totalDurationSeconds) > 0.05) throw new WorkflowPreparationError(`This master workflow supports ${config.totalDurationSeconds} seconds only; this project is ${value.video.durationSeconds} seconds.`);
  value.scenes.forEach((scene, index) => {
    if (Math.abs(scene.durationSeconds - config.sceneDurationSeconds) > 0.05) throw new WorkflowPreparationError(`Scene ${index + 1} must be ${config.sceneDurationSeconds} seconds; received ${scene.durationSeconds}.`);
    if (Math.abs(scene.startSeconds - index * config.sceneDurationSeconds) > 0.05) throw new WorkflowPreparationError(`Scene ${index + 1} must start at ${index * config.sceneDurationSeconds} seconds.`);
  });
  if (!config.imageModelFilename || !config.videoModelFilename || !config.expectedMp4OutputNodeId || config.bindings.length === 0 || config.modelBindings.length === 0 || config.sequentialDependencies.length !== 5) {
    throw new WorkflowPreparationError(`Master workflow is not configured: provide the real ComfyUI API workflow at ${config.masterWorkflowPath}, then set its verified node IDs, input bindings, model filenames, and final MP4 output node in lib/comfyui/config.ts.`);
  }

  let source: unknown;
  try { source = JSON.parse(await readFile(config.masterWorkflowPath, "utf8")); }
  catch (error) {
    const detail = error instanceof Error && "code" in error && error.code === "ENOENT" ? `Master workflow file is missing: ${config.masterWorkflowPath}.` : `Could not read master workflow: ${error instanceof Error ? error.message : "unknown file error"}`;
    throw new WorkflowPreparationError(detail);
  }
  const record = z.record(z.string(), z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) })).safeParse(source);
  if (!record.success) throw new WorkflowPreparationError("Master workflow is not a ComfyUI API-format node map.", record.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`));
  const workflow = structuredClone(record.data) as ApiWorkflow;
  applySceneBindings(workflow, parsed.data, config.bindings);
  for (const binding of config.modelBindings) {
    const node = workflow[binding.nodeId];
    if (!node || !Object.hasOwn(node.inputs, binding.inputName)) throw new WorkflowPreparationError(`${binding.model} model mapping ${binding.nodeId}.${binding.inputName} does not exist in the master workflow.`);
    const filename = binding.model === "image" ? config.imageModelFilename : binding.model === "video" ? config.videoModelFilename : config.audio.modelFilename;
    if (!filename) throw new WorkflowPreparationError(`No verified ${binding.model} model filename is configured.`);
    node.inputs[binding.inputName] = filename;
  }
  const token = await getComfyCredentials();
  const validation = await validateWorkflow({
    workflow,
    endpoint: await getComfyEndpoint(),
    token,
    bindings: config.bindings,
    modelBindings: config.modelBindings,
    sequentialDependencies: config.sequentialDependencies,
    expectedMp4OutputNodeId: config.expectedMp4OutputNodeId,
    frameCounts: parsed.data.scenes.map(scene => Math.round(scene.durationSeconds * parsed.data.video.fps)),
    selectedModels: [{ kind: "image", filename: config.imageModelFilename }, { kind: "video", filename: config.videoModelFilename }, ...(config.audio.modelFilename ? [{ kind: "audio" as const, filename: config.audio.modelFilename }] : [])],
  });
  if (!validation.valid) throw new WorkflowPreparationError("ComfyUI workflow validation failed.", validation.failures);
  return workflow;
}

export function applySceneBindings(workflow: ApiWorkflow, production: Production, bindings: InputBinding[]) {
  for (const binding of bindings) {
    const node = workflow[binding.nodeId];
    if (!node) throw new WorkflowPreparationError(`Scene ${binding.sceneIndex + 1}: node ${binding.nodeId} is missing.`);
    if (!Object.hasOwn(node.inputs, binding.inputName)) throw new WorkflowPreparationError(`Scene ${binding.sceneIndex + 1}: input ${binding.nodeId}.${binding.inputName} is missing.`);
    const scene = production.scenes[binding.sceneIndex];
    if (!scene) throw new WorkflowPreparationError(`Scene mapping index ${binding.sceneIndex} is outside the production.`);
    const values: Record<InputBinding["value"], unknown> = {
      imagePrompt: scene.imagePrompt,
      imageNegativePrompt: scene.imageNegativePrompt,
      videoPrompt: scene.videoPrompt,
      videoNegativePrompt: scene.videoNegativePrompt,
      narration: scene.narration || production.narration.fullScript,
      cameraAndContinuity: [scene.cameraMovement, scene.lighting, scene.firstFrame, scene.lastFrame, ...scene.continuityRules, ...scene.scientificConstraints, production.continuity.canonicalDescription, ...production.continuity.fixedProperties, ...production.continuity.mechanicalConstraints, ...production.continuity.forbiddenChanges].filter(Boolean).join("\n"),
      width: production.video.width,
      height: production.video.height,
      frameCount: Math.round(scene.durationSeconds * production.video.fps),
      fps: production.video.fps,
    };
    node.inputs[binding.inputName] = values[binding.value];
  }
}

async function getComfyEndpoint() {
  const { db, settings } = await import("@/lib/db");
  const { eq } = await import("drizzle-orm");
  const entry = db.select().from(settings).where(eq(settings.key, "endpoint")).get();
  return entry ? JSON.parse(entry.value) as string : comfyConfig.endpoint;
}

async function getComfyCredentials() {
  const { db, settings } = await import("@/lib/db");
  const { eq } = await import("drizzle-orm");
  const entry = db.select().from(settings).where(eq(settings.key, "token")).get();
  return entry ? JSON.parse(entry.value) as string : undefined;
}

export async function getWorkflowValidation(production: Production): Promise<{ workflow: ApiWorkflow | null; validation: WorkflowCheck }> {
  try {
    const workflow = await buildWorkflow(production);
    return { workflow, validation: { valid: true, failures: [], warnings: ["Static validation cannot guarantee VRAM compatibility or successful rendering."] } };
  } catch (error) {
    const failures = error instanceof WorkflowPreparationError ? error.failures : [error instanceof Error ? error.message : "Workflow preparation failed."];
    return { workflow: null, validation: { valid: false, failures, warnings: ["Static validation cannot guarantee VRAM compatibility or successful rendering."] } };
  }
}

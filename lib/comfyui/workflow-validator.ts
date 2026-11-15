import "server-only";
import type { InputBinding, ModelBinding } from "@/lib/comfyui/config";

export type ApiNode = { class_type: string; inputs: Record<string, unknown> };
export type ApiWorkflow = Record<string, ApiNode>;
export type WorkflowCheck = { valid: boolean; failures: string[]; warnings: string[] };

type ObjectInfo = Record<string, { input?: Record<string, Record<string, unknown>>; output?: unknown; output_node?: boolean }>;

export async function validateWorkflow({ workflow, endpoint, token, bindings, modelBindings, sequentialDependencies, expectedMp4OutputNodeId, frameCounts, selectedModels }: {
  workflow: ApiWorkflow;
  endpoint: string;
  token?: string;
  bindings: InputBinding[];
  modelBindings: ModelBinding[];
  sequentialDependencies: { fromNodeId: string; toNodeId: string; toInputName: string }[];
  expectedMp4OutputNodeId: string | null;
  frameCounts: number[];
  selectedModels: { kind: "image" | "video" | "audio"; filename: string | null }[];
}): Promise<WorkflowCheck> {
  const failures: string[] = [];
  const warnings = ["Static workflow validation cannot guarantee VRAM compatibility or successful rendering."];
  let objectInfo: ObjectInfo;
  try {
    const response = await fetch(new URL("/object_info", endpoint), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`ComfyUI /object_info returned HTTP ${response.status}.`);
    objectInfo = await response.json() as ObjectInfo;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Could not read ComfyUI /object_info.");
    return { valid: false, failures, warnings };
  }

  const configuredNodeIds = new Set<string>();
  for (const [nodeId, node] of Object.entries(workflow)) {
    configuredNodeIds.add(nodeId);
    if (!node || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") {
      failures.push(`Node ${nodeId} must contain class_type and inputs.`);
      continue;
    }
    const classInfo = objectInfo[node.class_type];
    if (!classInfo) {
      failures.push(`Node ${nodeId}: required class "${node.class_type}" is not installed in ComfyUI.`);
      continue;
    }
    const validInputs = new Set(Object.values(classInfo.input || {}).flatMap(group => Object.keys(group)));
    for (const inputName of Object.keys(node.inputs)) {
      if (!validInputs.has(inputName) && !Object.hasOwn(classInfo.input || {}, inputName)) {
        failures.push(`Node ${nodeId} (${node.class_type}): input "${inputName}" is not declared by /object_info.`);
      }
    }
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      if (!Array.isArray(inputValue) || inputValue.length < 2 || typeof inputValue[0] !== "string") continue;
      if (!configuredNodeIds.has(inputValue[0]) && !Object.hasOwn(workflow, inputValue[0])) {
        failures.push(`Node ${nodeId}.${inputName} references missing workflow node ${inputValue[0]}.`);
      }
    }
  }

  for (const binding of bindings) {
    if (!workflow[binding.nodeId]) failures.push(`Scene ${binding.sceneIndex + 1} mapping references missing node ${binding.nodeId}.`);
    else if (!Object.hasOwn(workflow[binding.nodeId].inputs, binding.inputName)) failures.push(`Scene ${binding.sceneIndex + 1} mapping references missing input ${binding.nodeId}.${binding.inputName}.`);
  }
  for (let sceneIndex = 0; sceneIndex < 6; sceneIndex++) {
    for (const value of ["imagePrompt", "imageNegativePrompt", "videoPrompt", "narration", "frameCount", "width", "height", "fps"] as const) {
      if (!bindings.some(binding => binding.sceneIndex === sceneIndex && binding.value === value)) failures.push(`Scene ${sceneIndex + 1} has no ${value} input mapping.`);
    }
  }

  frameCounts.forEach((frameCount, sceneIndex) => {
    const binding = bindings.find(item => item.sceneIndex === sceneIndex && item.value === "frameCount");
    if (!binding) return;
    const node = workflow[binding.nodeId];
    if (!node || node.inputs[binding.inputName] !== frameCount) failures.push(`Scene ${sceneIndex + 1} frame-count input ${binding.nodeId}.${binding.inputName} does not match ${frameCount} frames.`);
    const classInfo = node ? objectInfo[node.class_type] : undefined;
    const inputGroups = classInfo?.input || {};
    const spec = Object.values(inputGroups).map(group => group[binding.inputName]).find(Boolean);
    const constraints = Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? spec[1] as Record<string, unknown> : {};
    if (typeof constraints.min === "number" && frameCount < constraints.min) failures.push(`Scene ${sceneIndex + 1} requests ${frameCount} frames below the workflow minimum ${constraints.min}.`);
    if (typeof constraints.max === "number" && frameCount > constraints.max) failures.push(`Scene ${sceneIndex + 1} requests ${frameCount} frames above the workflow maximum ${constraints.max}.`);
  });

  for (const kind of ["image", "video"] as const) {
    if (!modelBindings.some(binding => binding.model === kind)) failures.push(`No ${kind} model input mapping is configured.`);
  }
  for (const binding of modelBindings) {
    if (!workflow[binding.nodeId]) failures.push(`${binding.model} model mapping references missing node ${binding.nodeId}.`);
    else if (!Object.hasOwn(workflow[binding.nodeId].inputs, binding.inputName)) failures.push(`${binding.model} model mapping references missing input ${binding.nodeId}.${binding.inputName}.`);
  }
  if (sequentialDependencies.length !== 5) failures.push(`The fixed six-scene graph requires exactly five sequential scene dependencies; configured ${sequentialDependencies.length}.`);
  for (const dependency of sequentialDependencies) {
    if (!workflow[dependency.fromNodeId]) failures.push(`Sequential dependency references missing source node ${dependency.fromNodeId}.`);
    const target = workflow[dependency.toNodeId];
    if (!target) failures.push(`Sequential dependency references missing target node ${dependency.toNodeId}.`);
    else {
      const connection = target.inputs[dependency.toInputName];
      if (!Array.isArray(connection) || connection[0] !== dependency.fromNodeId) failures.push(`Sequential dependency ${dependency.fromNodeId} → ${dependency.toNodeId}.${dependency.toInputName} does not match the workflow graph.`);
    }
  }
  if (!expectedMp4OutputNodeId || !workflow[expectedMp4OutputNodeId]) failures.push("The configured final MP4 output node is missing.");
  else if (!objectInfo[workflow[expectedMp4OutputNodeId].class_type]?.output_node) failures.push(`Configured final MP4 node ${expectedMp4OutputNodeId} is not marked as a ComfyUI output node by /object_info.`);
  for (const model of selectedModels) {
    if (!model.filename) { failures.push(`No verified ${model.kind} model filename is configured.`); continue; }
    const modelWasInjected = Object.values(workflow).some(node => Object.values(node.inputs).some(value => value === model.filename));
    if (!modelWasInjected) failures.push(`Configured ${model.kind} model "${model.filename}" is not set on a workflow input.`);
    const installed = Object.values(objectInfo).some(classInfo => Object.values(classInfo.input || {}).some(group => Object.values(group).some(spec => Array.isArray(spec) && Array.isArray(spec[0]) && spec[0].some(option => option === model.filename))));
    if (!installed) failures.push(`Configured ${model.kind} model "${model.filename}" is not listed as installed by ComfyUI /object_info.`);
  }
  if (selectedModels.length === 0) failures.push("No verified model filenames are configured.");
  if (frameCounts.length !== 6 || frameCounts.some(count => !Number.isInteger(count) || count <= 0)) failures.push("The workflow requires six positive integer frame counts.");

  return { valid: failures.length === 0, failures, warnings };
}

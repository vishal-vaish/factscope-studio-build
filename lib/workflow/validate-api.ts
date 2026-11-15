import "server-only";
import type { Production } from "@/lib/production-schema";
import { comfyHeaders, getComfySettings } from "@/lib/comfyui/client";
import { isComfyApiWorkflow } from "@/lib/workflow/inspect";
import { getWorkflowSupportingModels, type WorkflowModelSelection } from "@/lib/comfyui/model-presets";
import type { WorkflowCheck } from "@/lib/comfyui/workflow-validator";

export type ApiWorkflowValidation = WorkflowCheck & { outputNodeId: string | null; verifiedClasses: string[] };
type NodeInfo = { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }; output?: unknown[]; output_node?: boolean };
type ObjectInfo = Record<string, NodeInfo>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionValues(spec: unknown): unknown[] {
  return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : [];
}

function allInputSpecs(info: NodeInfo) {
  const specs: Record<string, unknown> = {};
  for (const group of [info.input?.required, info.input?.optional]) if (isRecord(group)) Object.assign(specs, group);
  return specs;
}

function inputLooksLikeModel(name: string) {
  return /model|ckpt|checkpoint|unet|clip|text.?encoder|vae|file/i.test(name);
}

function inputLooksLikeOutputFormat(name: string) {
  return /format|container|extension/i.test(name);
}

function inputOptions(spec: unknown): Record<string, unknown> {
  return Array.isArray(spec) && isRecord(spec[1]) ? spec[1] : {};
}

function findScalarStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(findScalarStrings);
  if (isRecord(value)) return Object.values(value).flatMap(findScalarStrings);
  return [];
}

function matchesTargetConfig(workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>, production: Production, failures: string[], warnings: string[]) {
  const entries = Object.entries(workflow);
  const graphText = JSON.stringify(workflow);
  for (const scene of production.scenes) {
    const requiredSceneContent = [
      ["image prompt", scene.imagePrompt],
      ["image negative prompt", scene.imageNegativePrompt],
      ["video prompt", scene.videoPrompt],
      ["video negative prompt", scene.videoNegativePrompt],
      ["narration", scene.narration],
      ["camera direction", scene.cameraMovement],
      ["continuity description", scene.firstFrame],
      ["continuity description", scene.lastFrame],
    ] as const;
    for (const [label, content] of requiredSceneContent) {
      if (content.trim() && !graphText.includes(content)) failures.push(`Scene ${scene.order} ${label} was not found in the imported API graph.`);
    }
    for (const constraint of [...scene.continuityRules, ...scene.scientificConstraints]) {
      if (constraint.trim() && !graphText.includes(constraint)) failures.push(`Scene ${scene.order} continuity/scientific constraint was not found in the imported API graph.`);
    }
  }
  const allInputs = entries.flatMap(([, node]) => Object.entries(node.inputs).map(([name, value]) => ({ name: name.toLowerCase(), value })));
  const fpsInputs = allInputs.filter(item => /(^|_)(fps|frame_rate|framerate)(_|$)/.test(item.name) && typeof item.value === "number");
  for (const item of fpsInputs) if (item.value !== production.video.fps) failures.push(`Frame-rate input ${item.name} is ${item.value}; the project requests ${production.video.fps} FPS.`);
  if (!fpsInputs.length) warnings.push(`The API graph has no plainly named FPS input to compare with the requested ${production.video.fps} FPS; confirm the graph's native/output frame-rate behavior.`);
  const expectedFrameCounts = new Set([...production.scenes.map(scene => Math.round(scene.durationSeconds * production.video.fps)), Math.round(production.video.durationSeconds * production.video.fps)]);
  const frameInputs = allInputs.filter(item => /^(num_?)?frames?$|^(num_?)?frame_count$|^total_frames$/.test(item.name) && typeof item.value === "number");
  for (const item of frameInputs) if (!expectedFrameCounts.has(Number(item.value))) failures.push(`Frame-count input ${item.name} is ${item.value}; expected a scene frame count (${production.video.fps} FPS) or the complete ${Math.round(production.video.durationSeconds * production.video.fps)}-frame timeline.`);
  if (!frameInputs.length) warnings.push("No explicit frame-count input was identified; confirm scene frame lengths and timeline assembly in the generated graph.");

  const outputResolutionInputs = allInputs.filter(item => /^(output|final|export|target)_?(width|height)$/.test(item.name) && typeof item.value === "number");
  for (const item of outputResolutionInputs) {
    const expected = item.name.endsWith("width") ? production.video.width : production.video.height;
    if (item.value !== expected) failures.push(`Export input ${item.name} is ${item.value}; the project requests ${expected}.`);
  }
  if (!outputResolutionInputs.length) warnings.push(`No explicit export width/height inputs were identified. The requested ${production.video.width} × ${production.video.height} is an export target, not evidence of native model resolution.`);

  const totalDuration = production.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  const totalDurationInputs = allInputs.filter(item => /^(total_?)?(duration|length)_?(seconds|s)?$/.test(item.name) && typeof item.value === "number");
  for (const item of totalDurationInputs) if (Math.abs(Number(item.value) - totalDuration) > 0.05) failures.push(`Total-duration input ${item.name} is ${item.value}s; the production timeline is ${totalDuration}s.`);
  const sceneCountInputs = allInputs.filter(item => /^(num_?)?scenes?$/.test(item.name) && typeof item.value === "number");
  for (const item of sceneCountInputs) if (item.value !== production.scenes.length) failures.push(`Scene-count input ${item.name} is ${item.value}; the Production JSON has ${production.scenes.length} scenes.`);
}

export async function validateImportedApiWorkflow({ workflow, production, selectedModels, supportingModels }: {
  workflow: unknown;
  production: Production;
  selectedModels: WorkflowModelSelection;
  supportingModels: { textEncoders: string[]; vaeModels: string[] };
}): Promise<ApiWorkflowValidation> {
  const failures: string[] = [];
  const warnings = ["Passing static checks does not prove VRAM fit, runtime success, or a completed video render."];
  if (!isComfyApiWorkflow(workflow)) return { valid: false, failures: ["Expected a ComfyUI API-format node map with class_type and inputs on every node; editable UI-format JSON cannot be submitted to /prompt."], warnings, outputNodeId: null, verifiedClasses: [] };
  let expectedSupportingModels: { textEncoders: string[]; vaeModels: string[] };
  try { expectedSupportingModels = getWorkflowSupportingModels(selectedModels); }
  catch (error) { return { valid: false, failures: [error instanceof Error ? error.message : "Select configured model presets before validation."], warnings, outputNodeId: null, verifiedClasses: [] }; }
  if (JSON.stringify(supportingModels) !== JSON.stringify(expectedSupportingModels)) return { valid: false, failures: ["Supporting model filenames do not match the selected configured presets."], warnings, outputNodeId: null, verifiedClasses: [] };
  let endpoint: string;
  let token: string | undefined;
  try { ({ endpoint, token } = getComfySettings()); }
  catch { return { valid: false, failures: ["ComfyUI connection settings are unavailable."], warnings, outputNodeId: null, verifiedClasses: [] }; }

  let objectInfo: ObjectInfo;
  try {
    const response = await fetch(new URL("/object_info", endpoint), { headers: comfyHeaders(token), cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`ComfyUI /object_info returned HTTP ${response.status}.`);
    objectInfo = await response.json() as ObjectInfo;
  } catch (error) {
    return { valid: false, failures: [error instanceof Error ? error.message : "ComfyUI /object_info is unavailable; the API workflow remains unverified."], warnings, outputNodeId: null, verifiedClasses: [] };
  }

  const nodeIds = new Set(Object.keys(workflow));
  const usedClasses = new Set<string>();
  const modelValues = new Set<string>();
  const connections: { sourceId: string; targetId: string; targetInput: string }[] = [];
  const modelSpecs = Object.values(objectInfo).flatMap(info => Object.entries(allInputSpecs(info)).flatMap(([name, spec]) => inputLooksLikeModel(name) ? optionValues(spec).filter((value): value is string => typeof value === "string") : []));
  const installedModelValues = new Set(modelSpecs);
  let outputNodeId: string | null = null;
  const mp4OutputNodeIds: string[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!nodeId.trim()) failures.push("API workflow contains an empty node ID.");
    const info = objectInfo[node.class_type];
    usedClasses.add(node.class_type);
    if (!info) { failures.push(`Node ${nodeId}: class_type "${node.class_type}" is not available in ComfyUI /object_info.`); continue; }
    const specs = allInputSpecs(info);
    for (const inputName of Object.keys(node.inputs)) if (!Object.hasOwn(specs, inputName)) failures.push(`Node ${nodeId} (${node.class_type}): input "${inputName}" is not declared by /object_info.`);
    for (const [inputName, spec] of Object.entries(isRecord(info.input?.required) ? info.input.required : {})) {
      if (!Object.hasOwn(node.inputs, inputName)) failures.push(`Node ${nodeId} (${node.class_type}) is missing required input "${inputName}".`);
    }
    for (const [inputName, value] of Object.entries(node.inputs)) {
      const spec = specs[inputName];
      const options = optionValues(spec);
      if (typeof value === "string" && options.length && !options.includes(value)) failures.push(`Node ${nodeId}.${inputName}: "${value}" is not an available option in /object_info.`);
      const inputType = Array.isArray(spec) ? spec[0] : null;
      const constraints = inputOptions(spec);
      if (typeof value === "number" && Number.isFinite(value)) {
        if (inputType === "INT" && !Number.isInteger(value)) failures.push(`Node ${nodeId}.${inputName} must be an integer according to /object_info.`);
        if (typeof constraints.min === "number" && value < constraints.min) failures.push(`Node ${nodeId}.${inputName} is below the /object_info minimum ${constraints.min}.`);
        if (typeof constraints.max === "number" && value > constraints.max) failures.push(`Node ${nodeId}.${inputName} exceeds the /object_info maximum ${constraints.max}.`);
        if (typeof constraints.step === "number" && constraints.step > 0) {
          const origin = typeof constraints.min === "number" ? constraints.min : 0;
          if (Math.abs((value - origin) / constraints.step - Math.round((value - origin) / constraints.step)) > 1e-6) failures.push(`Node ${nodeId}.${inputName} does not satisfy the /object_info step ${constraints.step}.`);
        }
      }
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])) {
        const source = workflow[value[0]];
        if (!source) failures.push(`Node ${nodeId}.${inputName} references missing node ${value[0]}.`);
        else {
          connections.push({ sourceId: value[0], targetId: nodeId, targetInput: inputName });
          const sourceInfo = objectInfo[source.class_type];
          const outputIndex = Number(value[1]);
          if (Array.isArray(sourceInfo?.output) && outputIndex >= sourceInfo.output.length) failures.push(`Node ${nodeId}.${inputName} references output ${outputIndex} outside node ${value[0]}'s ${sourceInfo.output.length} declared outputs.`);
          const targetType = Array.isArray(specs[inputName]) ? (specs[inputName] as unknown[])[0] : null;
          const sourceType = Array.isArray(sourceInfo?.output) ? sourceInfo.output[outputIndex] : null;
          if (typeof targetType === "string" && typeof sourceType === "string" && targetType !== "*" && sourceType !== "*" && targetType !== sourceType) failures.push(`Connection ${value[0]}:${outputIndex} (${sourceType}) → ${nodeId}.${inputName} (${targetType}) has incompatible socket types.`);
        }
      } else if (Array.isArray(value) && (value.length === 2 && typeof value[0] !== "string" || value.length === 2 && typeof value[1] !== "number")) {
        failures.push(`Node ${nodeId}.${inputName} has a malformed API connection; expected [nodeId, outputIndex].`);
      }
      if (inputLooksLikeModel(inputName) && typeof value === "string" && /\.(safetensors|ckpt|pt|pth|gguf|bin|onnx)$/i.test(value)) modelValues.add(value);
    }
    const isVideoOutput = info.output_node === true && /video|save|combine/i.test(node.class_type);
    const hasMp4Setting = Object.entries(node.inputs).some(([name, value]) => inputLooksLikeOutputFormat(name) && typeof value === "string" && /mp4|h264/i.test(value));
    if (isVideoOutput && hasMp4Setting) mp4OutputNodeIds.push(nodeId);
  }

  const selections = [
    { label: "image", filename: selectedModels.image },
    { label: "video", filename: selectedModels.video },
    ...supportingModels.textEncoders.map(filename => ({ label: "text encoder", filename })),
    ...supportingModels.vaeModels.map(filename => ({ label: "VAE", filename })),
  ];
  for (const selection of selections) {
    if (!selection.filename) { failures.push(`Select a configured ${selection.label} filename before validation.`); continue; }
    if (!modelValues.has(selection.filename)) failures.push(`Selected ${selection.label} model "${selection.filename}" is not assigned to a model-like input in the imported API graph.`);
    if (!installedModelValues.has(selection.filename)) failures.push(`Selected ${selection.label} model "${selection.filename}" is not listed as installed by ComfyUI /object_info.`);
  }
  if (mp4OutputNodeIds.length === 0) failures.push("Could not identify an available video output node configured for MP4 in the imported API graph.");
  if (mp4OutputNodeIds.length > 1) failures.push(`Expected one final MP4 output node, found ${mp4OutputNodeIds.length}: ${mp4OutputNodeIds.join(", ")}.`);
  outputNodeId = mp4OutputNodeIds[0] || null;
  if (outputNodeId && !connections.some(connection => connection.targetId === outputNodeId)) failures.push(`Final MP4 output node ${outputNodeId} has no connected workflow inputs.`);
  matchesTargetConfig(workflow, production, failures, warnings);
  return { valid: failures.length === 0, failures: [...new Set(failures)], warnings: [...new Set(warnings)], outputNodeId, verifiedClasses: [...usedClasses] };
}

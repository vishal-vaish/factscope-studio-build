export type ModelCategory = "image" | "video" | "textEncoder" | "vae" | "audio" | "unknown";
export type WorkflowNodeSummary = {
  id: string;
  type: string;
  title: string | null;
  category: string[];
  inputNames: string[];
  modelFiles: { filename: string; category: ModelCategory }[];
  widgetsValues: unknown[];
  properties: Record<string, unknown>;
};
export type WorkflowLinkSummary = { id: string; fromNodeId: string; fromSlot: number | null; toNodeId: string; toSlot: number | null; type: string | null };
export type ReferenceAnalysis = {
  filename: string;
  format: "comfyui-editable";
  nodeCount: number;
  linkCount: number;
  nodes: WorkflowNodeSummary[];
  links: WorkflowLinkSummary[];
  models: Record<ModelCategory, string[]>;
  categories: Record<string, string[]>;
  measurements: { nodeId: string; type: "fps" | "durationSeconds" | "frameCount" | "width" | "height"; value: number; input: string }[];
};

const modelExtensions = /\.(?:safetensors|ckpt|pt|pth|gguf|bin|onnx)$/i;
const categoryNames = ["image generation", "video generation", "audio generation", "frame concatenation", "audio concatenation", "video output"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, output));
  else if (isRecord(value)) Object.values(value).forEach(item => collectStrings(item, output));
  return output;
}

function classifyModel(filename: string, context: string): ModelCategory {
  const text = `${context} ${filename}`.toLowerCase();
  if (/text.?encoder|clip|t5|umt5|llm/.test(text)) return "textEncoder";
  if (/vae|variational.?auto.?encoder/.test(text)) return "vae";
  if (/audio|voice|speech|vocoder/.test(text)) return "audio";
  if (/minimax|\bwan\b|video|motion|i2v|t2v/.test(text)) return "video";
  if (/qwen.?image|image|flux|sdxl|stable.?diffusion|checkpoint|unet/.test(text)) return "image";
  return "unknown";
}

function classifyNode(type: string, title: string | null): string[] {
  const value = `${type} ${title || ""}`.toLowerCase().replace(/[_-]+/g, " ");
  const result: string[] = [];
  if (/image|qwen image|text to image|ksampler/.test(value)) result.push("image generation");
  if (/video|minimax|wan|i2v|t2v|motion/.test(value) && !/video combine|save video|output/.test(value)) result.push("video generation");
  if (/audio|speech|text to speech|tts|vocoder/.test(value)) result.push("audio generation");
  if (/concat|concatenate|combine|join/.test(value) && /frame|image|video/.test(value)) result.push("frame concatenation");
  if (/concat|concatenate|combine|join/.test(value) && /audio|sound/.test(value)) result.push("audio concatenation");
  if (/save.*video|video.*save|video.*output|savevideo|videocombine|combinevideo/.test(value)) result.push("video output");
  return result;
}

function readMeasurements(nodeId: string, values: unknown): ReferenceAnalysis["measurements"] {
  if (!isRecord(values)) return [];
  const measurements: ReferenceAnalysis["measurements"] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    let type: ReferenceAnalysis["measurements"][number]["type"] | null = null;
    if (/^(fps|framerate|framepersecond|framespersecond)$/.test(normalized)) type = "fps";
    else if (/^(duration|durationseconds|totalseconds|lengthseconds)$/.test(normalized)) type = "durationSeconds";
    else if (/^(framecount|numframes|totalframes|length)$/.test(normalized)) type = "frameCount";
    else if (/^(width|outputwidth|resolutionwidth)$/.test(normalized)) type = "width";
    else if (/^(height|outputheight|resolutionheight)$/.test(normalized)) type = "height";
    if (type) measurements.push({ nodeId, type, value, input: key });
  }
  return measurements;
}

function parseLink(link: unknown): WorkflowLinkSummary | null {
  if (Array.isArray(link)) {
    if (link.length < 5) return null;
    return { id: String(link[0]), fromNodeId: String(link[1]), fromSlot: Number.isInteger(link[2]) ? Number(link[2]) : null, toNodeId: String(link[3]), toSlot: Number.isInteger(link[4]) ? Number(link[4]) : null, type: typeof link[5] === "string" ? link[5] : null };
  }
  if (!isRecord(link)) return null;
  const from = link.origin_id ?? link.fromNodeId ?? link.from;
  const to = link.target_id ?? link.toNodeId ?? link.to;
  if (from === undefined || to === undefined) return null;
  const fromSlot = link.origin_slot ?? link.fromSlot;
  const toSlot = link.target_slot ?? link.toSlot;
  return { id: String(link.id ?? ""), fromNodeId: String(from), fromSlot: Number.isInteger(fromSlot) ? Number(fromSlot) : null, toNodeId: String(to), toSlot: Number.isInteger(toSlot) ? Number(toSlot) : null, type: typeof link.type === "string" ? link.type : null };
}

export function isEditableComfyWorkflow(value: unknown): value is { nodes: unknown[]; links: unknown[]; [key: string]: unknown } {
  return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.links) && value.nodes.every(node => isRecord(node) && (typeof node.id === "string" || typeof node.id === "number") && typeof node.type === "string");
}

export function isComfyApiWorkflow(value: unknown): value is Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(node => isRecord(node) && typeof node.class_type === "string" && isRecord(node.inputs));
}

export function inspectReferenceWorkflow(value: unknown, filename: string): ReferenceAnalysis {
  if (!isEditableComfyWorkflow(value)) throw new Error("This file is not an editable ComfyUI workflow. Expected a JSON object with nodes and links arrays; API-format workflows are different.");
  const models: ReferenceAnalysis["models"] = { image: [], video: [], textEncoder: [], vae: [], audio: [], unknown: [] };
  const categories = Object.fromEntries(categoryNames.map(category => [category, [] as string[]])) as Record<string, string[]>;
  const measurements: ReferenceAnalysis["measurements"] = [];
  const nodes: WorkflowNodeSummary[] = value.nodes.map(raw => {
    const node = raw as Record<string, unknown>;
    const id = String(node.id);
    const type = typeof node.type === "string" ? node.type : "Unknown";
    const properties = isRecord(node.properties) ? node.properties : {};
    const title = typeof node.title === "string" ? node.title : typeof properties["Node name for S&R"] === "string" ? properties["Node name for S&R"] as string : null;
    const inputList = Array.isArray(node.inputs) ? node.inputs.filter(isRecord) : [];
    const inputNames = inputList.flatMap(input => typeof input.name === "string" ? [input.name] : []);
    const nodeCategories = classifyNode(type, title);
    for (const category of nodeCategories) categories[category].push(id);
    const context = `${type} ${title || ""} ${inputNames.join(" ")} ${collectStrings(properties).join(" ")}`;
    const filenames = [...new Set(collectStrings({ inputs: node.inputs, widgets_values: node.widgets_values, properties }).filter(text => modelExtensions.test(text)))];
    const modelFiles = filenames.map(filenameValue => {
      const category = classifyModel(filenameValue, context);
      if (!models[category].includes(filenameValue)) models[category].push(filenameValue);
      return { filename: filenameValue, category };
    });
    const namedValues: Record<string, unknown> = {};
    for (const input of inputList) if (typeof input.name === "string" && "value" in input) namedValues[input.name] = input.value;
    Object.assign(namedValues, isRecord(node.properties) ? node.properties : {});
    measurements.push(...readMeasurements(id, namedValues));
    return { id, type, title, category: nodeCategories, inputNames, modelFiles, widgetsValues: Array.isArray(node.widgets_values) ? node.widgets_values : [], properties };
  });
  const links = value.links.map(parseLink).filter((link): link is WorkflowLinkSummary => link !== null);
  return { filename: filename.slice(0, 255), format: "comfyui-editable", nodeCount: nodes.length, linkCount: links.length, nodes, links, models, categories, measurements };
}

export const suppliedModelHints = {
  image: { label: "Qwen Image 2.1", filename: "qwen_image_2.1_int8_convrot.safetensors" },
  video: { label: "MiniMax H3", filename: "minimax_h3_fl2va_pruned_int8_convrot.safetensors" },
};

export function analyzeImportedEditableWorkflow(value: unknown) {
  if (!isEditableComfyWorkflow(value)) return { valid: false, failures: ["Expected editable ComfyUI UI-format workflow JSON with nodes and links arrays; this is not the API execution format."] };
  const nodeIds = new Set(value.nodes.map(node => String((node as Record<string, unknown>).id)));
  const failures: string[] = [];
  for (const link of value.links) {
    const parsed = parseLink(link);
    if (!parsed) { failures.push("A link does not contain readable source and target node IDs."); continue; }
    if (!nodeIds.has(parsed.fromNodeId)) failures.push(`Link ${parsed.id || "(unnamed)"} references missing source node ${parsed.fromNodeId}.`);
    if (!nodeIds.has(parsed.toNodeId)) failures.push(`Link ${parsed.id || "(unnamed)"} references missing target node ${parsed.toNodeId}.`);
  }
  return { valid: failures.length === 0, failures, nodeCount: value.nodes.length, linkCount: value.links.length, warning: "Editable UI-format structure only; this does not verify node availability, model compatibility, or execution." };
}

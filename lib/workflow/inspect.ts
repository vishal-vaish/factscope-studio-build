type RecordValue = Record<string, unknown>;

type WorkflowLinkSummary = { id: string; fromNodeId: string; toNodeId: string };

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseLink(link: unknown): WorkflowLinkSummary | null {
  if (Array.isArray(link)) {
    if (link.length < 5) return null;
    return { id: String(link[0]), fromNodeId: String(link[1]), toNodeId: String(link[3]) };
  }
  if (!isRecord(link)) return null;
  const from = link.origin_id ?? link.fromNodeId ?? link.from;
  const to = link.target_id ?? link.toNodeId ?? link.to;
  if (from === undefined || to === undefined) return null;
  return { id: String(link.id ?? ""), fromNodeId: String(from), toNodeId: String(to) };
}

export function isEditableComfyWorkflow(value: unknown): value is { nodes: unknown[]; links: unknown[]; [key: string]: unknown } {
  return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.links) && value.nodes.every(node => isRecord(node) && (typeof node.id === "string" || typeof node.id === "number") && typeof node.type === "string");
}

export function isComfyApiWorkflow(value: unknown): value is Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(node => isRecord(node) && typeof node.class_type === "string" && isRecord(node.inputs));
}

export function analyzeImportedEditableWorkflow(value: unknown) {
  if (!isEditableComfyWorkflow(value)) return { valid: false, failures: ["Expected editable ComfyUI UI-format workflow JSON with nodes and links arrays; this is not the API execution format."] };
  const nodeIds = new Set(value.nodes.map(node => String((node as RecordValue).id)));
  const failures: string[] = [];
  if (value.nodes.length === 0) failures.push("The editable workflow must contain nodes.");
  if (value.links.length === 0) failures.push("The editable workflow must contain connected node links.");
  for (const link of value.links) {
    const parsed = parseLink(link);
    if (!parsed) { failures.push("A link does not contain readable source and target node IDs."); continue; }
    if (!nodeIds.has(parsed.fromNodeId)) failures.push(`Link ${parsed.id || "(unnamed)"} references missing source node ${parsed.fromNodeId}.`);
    if (!nodeIds.has(parsed.toNodeId)) failures.push(`Link ${parsed.id || "(unnamed)"} references missing target node ${parsed.toNodeId}.`);
  }
  return { valid: failures.length === 0, failures, nodeCount: value.nodes.length, linkCount: value.links.length, warning: "Editable UI-format structure only; this does not verify node availability, model compatibility, or execution." };
}

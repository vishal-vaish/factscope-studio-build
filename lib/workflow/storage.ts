import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "@/lib/db";
import type { WorkflowModelSelection } from "@/lib/workflow/request";
import type { WorkflowCheck } from "@/lib/comfyui/workflow-validator";

export type WorkflowKind = "ui" | "api";
export type ImportState = {
  filename: string;
  kind: WorkflowKind;
  uploadedAt: number;
  validation: WorkflowCheck & { outputNodeId?: string | null; checkedAt?: number };
  selectedModels: WorkflowModelSelection;
  supportingModels: { textEncoders: string[]; vaeModels: string[] };
};

export function workflowDirectoryFor(videoId: string) {
  return join(dataDirectory, "workflow-files", videoId);
}

const directoryFor = workflowDirectoryFor;

async function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export function safeWorkflowFilename(filename: string) {
  const lastPart = filename.split(/[\\/]/).pop() || "workflow.json";
  return lastPart.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 180) || "workflow.json";
}

export async function saveImportedWorkflow(videoId: string, kind: WorkflowKind, filename: string, workflow: unknown, state: ImportState) {
  const directory = directoryFor(videoId);
  await mkdir(directory, { recursive: true });
  const safeName = safeWorkflowFilename(filename);
  await atomicWrite(join(directory, `${kind}-workflow.json`), JSON.stringify(workflow));
  await atomicWrite(join(directory, `${kind}-workflow-metadata.json`), JSON.stringify({ ...state, filename: safeName, kind, uploadedAt: Date.now() }));
  return { ...state, filename: safeName, kind, uploadedAt: Date.now() };
}

export async function loadImportedWorkflow(videoId: string, kind: WorkflowKind): Promise<{ state: ImportState; workflow: unknown } | null> {
  try {
    const directory = directoryFor(videoId);
    const [metadata, raw] = await Promise.all([
      readFile(join(directory, `${kind}-workflow-metadata.json`), "utf8"),
      readFile(join(directory, `${kind}-workflow.json`), "utf8"),
    ]);
    return { state: JSON.parse(metadata) as ImportState, workflow: JSON.parse(raw) as unknown };
  } catch {
    return null;
  }
}

export async function listImportedWorkflows(videoId: string) {
  const entries = await Promise.all(([
    ["ui", "ui-workflow-metadata.json"],
    ["api", "api-workflow-metadata.json"],
  ] as const).map(async ([kind, filename]) => {
    try { return JSON.parse(await readFile(join(directoryFor(videoId), filename), "utf8")) as ImportState; }
    catch { return null; }
  }));
  return entries.filter((entry): entry is ImportState => entry !== null);
}

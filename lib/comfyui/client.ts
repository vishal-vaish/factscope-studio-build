import "server-only";
import { db, jobs, settings } from "@/lib/db";
import { eq } from "drizzle-orm";
import { comfyConfig } from "@/lib/comfyui/config";

export function getComfySettings() {
  const rows = Object.fromEntries(db.select().from(settings).all().map(row => [row.key, JSON.parse(row.value) as string]));
  return { endpoint: rows.endpoint || comfyConfig.endpoint, token: rows.token || undefined };
}

export function comfyHeaders(token?: string) {
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/json" };
}

export async function submitWorkflow(workflow: Record<string, unknown>, endpoint: string, token?: string, clientId?: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(new URL("/prompt", endpoint), {
    method: "POST",
    headers: { ...comfyHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, ...(clientId ? { client_id: clientId } : {}) }),
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => null) as { prompt_id?: string; error?: unknown; node_errors?: unknown } | null;
  if (!response.ok || typeof payload?.prompt_id !== "string") {
    throw new Error(`ComfyUI POST /prompt failed with HTTP ${response.status}: ${JSON.stringify(payload?.error ?? payload?.node_errors ?? payload)}`);
  }
  return { promptId: payload.prompt_id };
}

export type OutputReference = { filename: string; subfolder: string; type: string; nodeId: string };
export function isVerifiedMp4Response(reference: OutputReference, response: Response) {
  return response.ok && reference.filename.toLowerCase().endsWith(".mp4") && (response.headers.get("content-type") || "").toLowerCase().includes("video/mp4");
}

export function findMp4Output(history: Record<string, unknown>, nodeId: string): OutputReference | null {
  const outputs = history.outputs && typeof history.outputs === "object" ? history.outputs as Record<string, unknown> : {};
  const nodeOutput = outputs[nodeId] as Record<string, unknown> | undefined;
  if (!nodeOutput) return null;
  for (const key of ["videos", "gifs", "files"]) {
    const files = nodeOutput[key];
    if (!Array.isArray(files)) continue;
    const match = files.find((file): file is Record<string, unknown> => !!file && typeof file === "object" && typeof (file as Record<string, unknown>).filename === "string" && String((file as Record<string, unknown>).filename).toLowerCase().endsWith(".mp4"));
    if (match && typeof match.filename === "string") return { filename: match.filename, subfolder: typeof match.subfolder === "string" ? match.subfolder : "", type: typeof match.type === "string" ? match.type : "output", nodeId };
  }
  return null;
}

export async function fetchOutput(reference: OutputReference, endpoint: string, token?: string) {
  const url = new URL("/view", endpoint);
  url.searchParams.set("filename", reference.filename);
  url.searchParams.set("subfolder", reference.subfolder);
  url.searchParams.set("type", reference.type);
  return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store", signal: AbortSignal.timeout(30000) });
}

export function getJobOutput(jobId: string) {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  return row?.output ? JSON.parse(row.output) as OutputReference : null;
}

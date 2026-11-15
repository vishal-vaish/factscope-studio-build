import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, videos } from "@/lib/db";
import { productionSchema } from "@/lib/production-schema";
import { requireLocalHost, requireLocalSameOrigin } from "@/lib/comfyui/request-guard";
import { analyzeImportedEditableWorkflow, isComfyApiWorkflow, isEditableComfyWorkflow } from "@/lib/workflow/inspect";
import { listImportedWorkflows, loadImportedWorkflow, loadReferenceWorkflow, saveImportedWorkflow, type ImportState, type WorkflowKind } from "@/lib/workflow/storage";
import { validateImportedApiWorkflow } from "@/lib/workflow/validate-api";
import type { WorkflowModelSelection } from "@/lib/workflow/request";

export const runtime = "nodejs";
const maxUploadBytes = 15 * 1024 * 1024;
const modelSelection = (value: unknown): value is WorkflowModelSelection => !!value && typeof value === "object" && typeof (value as Record<string, unknown>).image === "string" && typeof (value as Record<string, unknown>).video === "string";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = requireLocalHost(request);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
  const { id } = await params;
  if (!db.select({ id: videos.id }).from(videos).where(eq(videos.id, id)).get()) return NextResponse.json({ error: "Video not found." }, { status: 404 });
  return NextResponse.json({ workflows: await listImportedWorkflows(id) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = requireLocalSameOrigin(request);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
  const { id } = await params;
  const video = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });
  if (!video.production) return NextResponse.json({ error: "Import Production JSON before importing a generated workflow." }, { status: 400 });
  const production = productionSchema.safeParse(JSON.parse(video.production));
  if (!production.success) return NextResponse.json({ error: "Saved Production JSON is invalid." }, { status: 422 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxUploadBytes) return NextResponse.json({ error: "Workflow exceeds the 15 MB upload limit." }, { status: 413 });
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: "Upload must contain valid JSON." }, { status: 400 }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return NextResponse.json({ error: "Upload must be a JSON object." }, { status: 400 });
  const body = payload as Record<string, unknown>;
  const kind = body.kind;
  if (kind !== "ui" && kind !== "api") return NextResponse.json({ error: "Choose an editable UI workflow or an API execution workflow." }, { status: 400 });
  const filename = typeof body.filename === "string" ? body.filename : `generated-${kind}-workflow.json`;
  const workflow = body.workflow;
  const models = modelSelection(body.selectedModels) ? body.selectedModels : { image: "", video: "" };
  const supportingModels = body.supportingModels && typeof body.supportingModels === "object" ? body.supportingModels as { textEncoders?: unknown; vaeModels?: unknown } : {};
  const dependencies = {
    textEncoders: Array.isArray(supportingModels.textEncoders) ? supportingModels.textEncoders.filter((item): item is string => typeof item === "string") : [],
    vaeModels: Array.isArray(supportingModels.vaeModels) ? supportingModels.vaeModels.filter((item): item is string => typeof item === "string") : [],
  };
  let validation: ImportState["validation"];
  if (kind === "ui") {
    if (!isEditableComfyWorkflow(workflow)) return NextResponse.json({ error: "Expected editable ComfyUI UI-format workflow JSON with nodes and links arrays." }, { status: 422 });
    const result = analyzeImportedEditableWorkflow(workflow);
    validation = { valid: result.valid, failures: result.failures, warnings: result.warning ? [result.warning] : [], checkedAt: Date.now() };
  } else {
    if (!isComfyApiWorkflow(workflow)) return NextResponse.json({ error: "Expected ComfyUI API-format JSON: a node map whose nodes contain class_type and inputs." }, { status: 422 });
    const reference = await loadReferenceWorkflow(id);
    const result = await validateImportedApiWorkflow({ workflow, production: production.data, selectedModels: models, supportingModels: dependencies, reference: reference?.analysis || null });
    validation = { ...result, checkedAt: Date.now() };
  }
  const state: ImportState = { filename, kind: kind as WorkflowKind, uploadedAt: Date.now(), validation, selectedModels: models, supportingModels: dependencies };
  const saved = await saveImportedWorkflow(id, kind, filename, workflow, state);
  return NextResponse.json({ workflow: saved }, { status: 201 });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = requireLocalSameOrigin(request);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
  const { id } = await params;
  const video = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!video || !video.production) return NextResponse.json({ error: "Video or imported Production JSON not found." }, { status: 404 });
  const production = productionSchema.safeParse(JSON.parse(video.production));
  if (!production.success) return NextResponse.json({ error: "Saved Production JSON is invalid." }, { status: 422 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !modelSelection(body.selectedModels)) return NextResponse.json({ error: "Select image and video model filenames before validation." }, { status: 400 });
  const imported = await loadImportedWorkflow(id, "api");
  if (!imported || !isComfyApiWorkflow(imported.workflow)) return NextResponse.json({ error: "Upload a ComfyUI API workflow before validating it." }, { status: 404 });
  const reference = await loadReferenceWorkflow(id);
  const supporting = body.supportingModels && typeof body.supportingModels === "object" ? body.supportingModels as { textEncoders?: unknown; vaeModels?: unknown } : {};
  const supportingModels = {
    textEncoders: Array.isArray(supporting.textEncoders) ? supporting.textEncoders.filter((item): item is string => typeof item === "string") : [],
    vaeModels: Array.isArray(supporting.vaeModels) ? supporting.vaeModels.filter((item): item is string => typeof item === "string") : [],
  };
  const validation = await validateImportedApiWorkflow({ workflow: imported.workflow, production: production.data, selectedModels: body.selectedModels, supportingModels, reference: reference?.analysis || null });
  const saved = await saveImportedWorkflow(id, "api", imported.state.filename, imported.workflow, { ...imported.state, selectedModels: body.selectedModels, supportingModels, validation: { ...validation, checkedAt: Date.now() } });
  return NextResponse.json({ workflow: saved });
}

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, videos } from "@/lib/db";
import { requireLocalHost, requireLocalSameOrigin } from "@/lib/comfyui/request-guard";
import { inspectReferenceWorkflow } from "@/lib/workflow/inspect";
import { downloadReferenceWorkflow, loadReferenceWorkflow, saveReferenceWorkflow, safeWorkflowFilename } from "@/lib/workflow/storage";

export const runtime = "nodejs";
const maxUploadBytes = 15 * 1024 * 1024;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = requireLocalHost(request);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
  const { id } = await params;
  if (!db.select({ id: videos.id }).from(videos).where(eq(videos.id, id)).get()) return NextResponse.json({ error: "Video not found." }, { status: 404 });
  const reference = await loadReferenceWorkflow(id);
  if (!reference) return NextResponse.json({ error: "No reference workflow has been uploaded." }, { status: 404 });
  if (new URL(request.url).searchParams.has("download")) {
    const original = await downloadReferenceWorkflow(id);
    if (!original) return NextResponse.json({ error: "The original reference workflow is unavailable." }, { status: 404 });
    return new Response(original, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${safeWorkflowFilename(reference.filename)}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }
  return NextResponse.json({ filename: reference.filename, uploadedAt: reference.uploadedAt, analysis: reference.analysis });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = requireLocalSameOrigin(request);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
  const { id } = await params;
  if (!db.select({ id: videos.id }).from(videos).where(eq(videos.id, id)).get()) return NextResponse.json({ error: "Video not found." }, { status: 404 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxUploadBytes) return NextResponse.json({ error: "Reference workflow exceeds the 15 MB upload limit." }, { status: 413 });
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: "Upload must contain valid JSON." }, { status: 400 }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return NextResponse.json({ error: "Upload must be a JSON object." }, { status: 400 });
  const body = payload as Record<string, unknown>;
  const filename = typeof body.filename === "string" ? body.filename : "reference-workflow.json";
  try {
    const analysis = inspectReferenceWorkflow(body.workflow, filename);
    const saved = await saveReferenceWorkflow(id, filename, body.workflow, analysis);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not inspect the reference workflow." }, { status: 422 });
  }
}

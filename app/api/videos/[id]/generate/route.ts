import { NextResponse } from "next/server";
import { db, jobs, randomUUID, videos } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import { productionSchema } from "@/lib/production-schema";
import { buildWorkflow, WorkflowPreparationError } from "@/lib/comfyui/workflow-builder";
import { getComfySettings, submitWorkflow } from "@/lib/comfyui/client";
import { requireLocalSameOrigin } from "@/lib/comfyui/request-guard";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = requireLocalSameOrigin(request);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });
  const { id: videoId } = await params;
  const video = db.select().from(videos).where(eq(videos.id, videoId)).get();
  if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });
  if (!video.production) return NextResponse.json({ error: "Import Production JSON before generating." }, { status: 400 });
  const parsed = productionSchema.safeParse(JSON.parse(video.production));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`) }, { status: 400 });

  const prior = db.select().from(jobs).where(eq(jobs.videoId, videoId)).orderBy(desc(jobs.createdAt)).all();
  if (prior.some(job => ["preparing", "submitting", "submission_unknown", "unknown", "queued", "running", "completed"].includes(job.status))) {
    return NextResponse.json({ error: "This video already has an active, uncertain, or completed generation job." }, { status: 409 });
  }

  const jobId = randomUUID();
  const createdAt = Date.now();
  db.insert(jobs).values({ id: jobId, videoId, status: "preparing", promptId: null, error: null, output: null, createdAt }).run();
  let workflow;
  try { workflow = await buildWorkflow(parsed.data); }
  catch (error) {
    const failures = error instanceof WorkflowPreparationError ? error.failures : [error instanceof Error ? error.message : "Workflow preparation failed."];
    db.update(jobs).set({ status: "failed", error: failures.join("\\n") }).where(eq(jobs.id, jobId)).run();
    return NextResponse.json({ error: failures }, { status: 422 });
  }
  db.update(jobs).set({ status: "submitting" }).where(eq(jobs.id, jobId)).run();
  try {
    const { endpoint, token } = getComfySettings();
    const { promptId } = await submitWorkflow(workflow, endpoint, token, `factscope-${jobId}`);
    if (!promptId) {
      const message = "ComfyUI did not return a prompt ID.";
      db.update(jobs).set({ status: "failed", error: message }).where(eq(jobs.id, jobId)).run();
      db.update(videos).set({ status: "Generation Failed", updatedAt: Date.now() }).where(eq(videos.id, videoId)).run();
      return NextResponse.json({ error: message }, { status: 502 });
    }
    db.update(jobs).set({ status: "queued", promptId: promptId, error: null }).where(eq(jobs.id, jobId)).run();
    db.update(videos).set({ status: "Queued for ComfyUI", updatedAt: Date.now() }).where(eq(videos.id, videoId)).run();
    return NextResponse.json({ jobId, promptId: promptId, status: "queued" }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ComfyUI submission failed.";
    db.update(jobs).set({ status: "submission_unknown", error: message }).where(eq(jobs.id, jobId)).run();
    db.update(videos).set({ status: "Submission Status Unknown", updatedAt: Date.now() }).where(eq(videos.id, videoId)).run();
    return NextResponse.json({ error: message, jobId, status: "submission_unknown" }, { status: 502 });
  }
}

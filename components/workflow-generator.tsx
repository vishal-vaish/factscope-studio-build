"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Activity, ArrowDownToLine, Check, Copy, FileJson2, LoaderCircle, ShieldCheck, Upload, Workflow } from "lucide-react";
import { toast } from "sonner";
import type { Production } from "@/lib/production-schema";
import { inspectReferenceWorkflow, suppliedModelHints, type ReferenceAnalysis } from "@/lib/workflow/inspect";
import { buildWorkflowContext, buildWorkflowRequest, type WorkflowModelSelection } from "@/lib/workflow/request";
import type { ImportState } from "@/lib/workflow/storage";

type JobStatus = { id: string; status: string; promptId: string | null; error: string | null; outputUrl?: string | null; pollingError?: string } | null;
type WorkflowImports = { workflows: ImportState[] };
type ReferenceState = { filename: string; uploadedAt: number; analysis: ReferenceAnalysis };

async function fetchJson(url: string) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not load workflow details.");
  return body;
}

function saveDownload(filename: string, contents: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function modelLabel(category: "image" | "video", filename: string) {
  if (category === "image" && filename === suppliedModelHints.image.filename) return `${suppliedModelHints.image.label} · ${filename}`;
  if (category === "video" && filename === suppliedModelHints.video.filename) return `${suppliedModelHints.video.label} · ${filename}`;
  return filename;
}

function FileUpload({ label, description, accept = ".json,application/json", disabled, onFile }: { label: string; description: string; accept?: string; disabled?: boolean; onFile: (file: File) => void }) {
  return <label className={`upload-zone workflow-upload ${disabled ? "is-disabled" : ""}`}><Upload/><span><b>{label}</b><small>{description}</small></span><input type="file" accept={accept} disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.currentTarget.value = ""; }}/></label>;
}

export function WorkflowGenerator({ id, production, connected, connectionMessage, jobStatus, onJobStarted }: { id: string; production: Production | null; connected: boolean; connectionMessage: string; jobStatus: JobStatus; onJobStarted: (jobId: string, status?: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedModels, setSelectedModels] = useState<WorkflowModelSelection>({ image: suppliedModelHints.image.filename, video: suppliedModelHints.video.filename });
  const [requestText, setRequestText] = useState("");
  const [busyAction, setBusyAction] = useState<"reference" | "ui" | "api" | "validate" | "generate" | null>(null);
  const [localMessage, setLocalMessage] = useState("");
  const [lastValidation, setLastValidation] = useState<ImportState["validation"] | null>(null);
  const referenceKey = `/api/videos/${id}/workflow-reference`;
  const importsKey = `/api/videos/${id}/workflow-import`;
  const { data: referenceData, error: referenceError, mutate: refreshReference } = useSWR<ReferenceState>(referenceKey, fetchJson, { shouldRetryOnError: false });
  const { data: importsData, mutate: refreshImports } = useSWR<WorkflowImports>(importsKey, fetchJson);
  const reference = referenceData?.analysis || null;
  const importedApi = importsData?.workflows.find(workflow => workflow.kind === "api") || null;
  const importedUi = importsData?.workflows.find(workflow => workflow.kind === "ui") || null;
  const imageOptions = useMemo(() => unique([...(reference?.models.image || []), suppliedModelHints.image.filename]), [reference]);
  const videoOptions = useMemo(() => unique([...(reference?.models.video || []), suppliedModelHints.video.filename]), [reference]);
  const supportingModels = useMemo(() => ({ textEncoders: reference?.models.textEncoder || [], vaeModels: reference?.models.vae || [] }), [reference]);
  const importedMatchesSelection = !!importedApi && importedApi.selectedModels.image === selectedModels.image && importedApi.selectedModels.video === selectedModels.video && JSON.stringify(importedApi.supportingModels) === JSON.stringify(supportingModels);
  const canGenerate = !!production && connected && !!importedApi?.validation.valid && importedMatchesSelection && !!importedApi.validation.outputNodeId && !["preparing", "submitting", "submission_unknown", "unknown", "queued", "running", "completed"].includes(jobStatus?.status || "");
  const referenceMetrics = useMemo(() => {
    const fps = [...new Set((reference?.measurements || []).filter(item => item.type === "fps").map(item => item.value))];
    const durations = [...new Set((reference?.measurements || []).filter(item => item.type === "durationSeconds").map(item => item.value))];
    return { fps, durations };
  }, [reference]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    if (!dialogOpen && dialog.open) dialog.close();
  }, [dialogOpen]);

  useEffect(() => {
    if (!reference) return;
    setSelectedModels(current => ({
      image: reference.models.image.includes(current.image) ? current.image : reference.models.image.includes(suppliedModelHints.image.filename) ? suppliedModelHints.image.filename : reference.models.image[0] || suppliedModelHints.image.filename,
      video: reference.models.video.includes(current.video) ? current.video : reference.models.video.includes(suppliedModelHints.video.filename) ? suppliedModelHints.video.filename : reference.models.video[0] || suppliedModelHints.video.filename,
    }));
  }, [reference]);

  const selectedImageFromReference = !!reference?.models.image.includes(selectedModels.image);
  const selectedVideoFromReference = !!reference?.models.video.includes(selectedModels.video);

  async function handleReferenceUpload(file: File) {
    setBusyAction("reference"); setLocalMessage("");
    try {
      const workflow = JSON.parse(await file.text());
      const response = await fetch(referenceKey, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, workflow }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not inspect this editable workflow.");
      await refreshReference(result);
      await refreshImports();
      setRequestText("");
      toast.success("Reference workflow uploaded and inspected.");
    } catch (error) { setLocalMessage(error instanceof Error ? error.message : "Could not read the reference workflow."); }
    finally { setBusyAction(null); }
  }

  async function handleGeneratedUpload(kind: "ui" | "api", file: File) {
    if (!production) return toast.error("Import a valid Production JSON first.");
    setBusyAction(kind); setLocalMessage(""); setLastValidation(null);
    try {
      const workflow = JSON.parse(await file.text());
      const response = await fetch(importsKey, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, filename: file.name, workflow, selectedModels, supportingModels }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not import this workflow.");
      if (kind === "api") setLastValidation(result.workflow.validation);
      await refreshImports();
      toast.success(kind === "api" ? "API workflow imported; compatibility results are shown below." : "Editable workflow imported and format-checked.");
    } catch (error) { setLocalMessage(error instanceof Error ? error.message : "Could not read the workflow file."); }
    finally { setBusyAction(null); }
  }

  async function revalidateApi() {
    setBusyAction("validate"); setLocalMessage("");
    try {
      const response = await fetch(importsKey, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedModels, supportingModels }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not validate the API workflow.");
      setLastValidation(result.workflow.validation);
      await refreshImports();
      toast[result.workflow.validation.valid ? "success" : "warning"](result.workflow.validation.valid ? "API workflow passed current compatibility checks." : "API workflow still has compatibility blockers.");
    } catch (error) { setLocalMessage(error instanceof Error ? error.message : "Could not validate the API workflow."); }
    finally { setBusyAction(null); }
  }

  async function generateRequest() {
    if (!production || !reference) return;
    const text = buildWorkflowRequest(production, reference, selectedModels);
    setRequestText(text);
    setDialogOpen(false);
    setLocalMessage("");
  }

  async function generateVideo() {
    setBusyAction("generate"); setLocalMessage("");
    try {
      const response = await fetch(`/api/videos/${id}/generate`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        if (body.validation) setLastValidation(body.validation);
        if (Array.isArray(body.error)) setLocalMessage(body.error.join("\n"));
        else setLocalMessage(body.error || "ComfyUI submission failed.");
        if (body.jobId) onJobStarted(body.jobId, body.status === "submission_unknown" ? "Submission Status Unknown" : "Generation Failed");
        return;
      }
      onJobStarted(body.jobId, "Queued for ComfyUI");
      toast.success("Complete workflow submitted once to ComfyUI.");
    } catch (error) { setLocalMessage(error instanceof Error ? error.message : "ComfyUI submission failed."); }
    finally { setBusyAction(null); }
  }

  function downloadContext() {
    if (!production || !reference) return;
    const context = buildWorkflowContext(production, reference, selectedModels);
    saveDownload(`factscope-${id}-workflow-context.json`, JSON.stringify(context, null, 2), "application/json");
  }

  async function copyRequest() {
    try { await navigator.clipboard.writeText(requestText); toast.success("ChatGPT workflow request copied."); }
    catch { toast.error("Clipboard access is unavailable in this browser."); }
  }

  const currentValidation = lastValidation || importedApi?.validation || null;
  const dialogWarnings = [
    !selectedImageFromReference ? `Image selection ${selectedModels.image} was specified in the request brief but was not detected in this uploaded workflow.` : null,
    !selectedVideoFromReference ? `Video selection ${selectedModels.video} was specified in the request brief but was not detected in this uploaded workflow.` : null,
    referenceMetrics.fps.length && production && !referenceMetrics.fps.includes(production.video.fps) ? `Reference FPS ${referenceMetrics.fps.join(", ")} differs from the target ${production.video.fps} FPS; do not assume the model supports conversion.` : null,
    referenceMetrics.durations.length && production && !referenceMetrics.durations.includes(production.video.durationSeconds) ? `Reference duration ${referenceMetrics.durations.join(", ")}s differs from the target ${production.video.durationSeconds}s; adapt frame lengths and assembly.` : null,
    reference?.models.textEncoder.length === 0 ? "No text encoder filename could be identified; inspect the attached original and report missing dependencies." : null,
    reference?.models.vae.length === 0 ? "No VAE filename could be identified; inspect the attached original and report missing dependencies." : null,
  ].filter((item): item is string => !!item);

  return <section className="workspace-card workflow-generator">
    <div className="workspace-card-head"><div className="card-icon cyan"><Workflow/></div><div><span className="card-overline">REFERENCE-BASED WORKFLOW</span><h2>ComfyUI Workflow</h2><p>Inspect a real workflow, generate a ChatGPT request, then validate its returned API graph before execution.</p></div></div>
    <div className="readiness-list">
      <span className={connected ? "ready" : "blocked"}>{connected ? <Check/> : <Activity/>} ComfyUI {connected ? "connected" : "offline — request generation still works"}</span>
      <span className={production ? "ready" : "blocked"}>{production ? <Check/> : <FileJson2/>} Production JSON {production ? `${production.scenes.length} scenes · ${production.video.durationSeconds}s` : "required"}</span>
      <span className={reference ? "ready" : "blocked"}>{reference ? <Check/> : <Workflow/>} Reference workflow {reference ? `${reference.nodeCount} nodes · ${reference.linkCount} links` : "upload editable UI-format JSON"}</span>
      <span className={importedApi?.validation.valid && importedMatchesSelection ? "ready" : "blocked"}>{importedApi?.validation.valid && importedMatchesSelection ? <Check/> : <ShieldCheck/>} API workflow {importedApi?.validation.valid ? importedMatchesSelection ? "compatible" : "selection changed; revalidate" : "not verified"}</span>
      <span className={jobStatus?.status === "completed" ? "ready" : "blocked"}>{jobStatus?.status === "completed" ? <Check/> : <Activity/>} Final MP4 {jobStatus?.status === "completed" ? "verified" : "not available"}</span>
    </div>
    <FileUpload label="Upload reference ComfyUI workflow" description="Editable UI-format JSON with nodes and links (not API format). Original file is preserved." disabled={busyAction === "reference"} onFile={handleReferenceUpload}/>
    {referenceError && <p className="workflow-muted">{referenceError.message.includes("No reference") ? "Upload a reference graph to detect its models and node structure." : referenceError.message}</p>}
    {reference && <div className="workflow-reference-summary">
      <div className="workflow-summary-head"><div><b>{referenceData?.filename}</b><small>{reference.nodeCount} nodes · {reference.linkCount} links · editable UI format</small></div><a className="text-action" href={`${referenceKey}?download=1`}><ArrowDownToLine/> Download original</a></div>
      <div className="workflow-model-grid">
        <div><b>Image models</b><small>{reference.models.image.length ? reference.models.image.join(" · ") : "No exact image filename detected"}</small></div>
        <div><b>Video models</b><small>{reference.models.video.length ? reference.models.video.join(" · ") : "No exact video filename detected"}</small></div>
        <div><b>Text encoders</b><small>{reference.models.textEncoder.join(" · ") || "Not detected"}</small></div>
        <div><b>VAE dependencies</b><small>{reference.models.vae.join(" · ") || "Not detected"}</small></div>
      </div>
      <p className="workflow-muted">Model filenames come from the uploaded graph, not an installed-model inventory. Availability is Unverified until checked against the configured ComfyUI server.</p>
    </div>}
    {localMessage && <div className="validation-errors workflow-message" role="alert">{localMessage.split("\n").map((line, index) => <p key={index}>{line}</p>)}</div>}
    {production && <div className="action-row"><button className="button" type="button" onClick={() => setDialogOpen(true)} disabled={!reference || busyAction !== null}><ShieldCheck/> Prepare Full Workflow</button><span className="workflow-muted">Opens model and output confirmation; no ComfyUI graph is built here.</span></div>}

    {requestText && <section className="workflow-request-output" aria-labelledby="workflow-request-heading">
      <div className="workflow-summary-head"><div><span className="card-overline">READY TO COPY</span><h3 id="workflow-request-heading">ChatGPT Workflow Request</h3></div><span className="workflow-unverified">Not an execution result</span></div>
      <textarea aria-label="Generated ChatGPT workflow request" readOnly value={requestText} className="json-editor workflow-request-text"/>
      <div className="action-row"><button className="button" type="button" onClick={copyRequest}><Copy/> Copy ChatGPT Request</button><button className="button button-secondary" type="button" onClick={() => saveDownload(`factscope-${id}-workflow-request.txt`, requestText, "text/plain")}><ArrowDownToLine/> Download ChatGPT Request TXT</button><button className="button button-secondary" type="button" onClick={downloadContext}><FileJson2/> Download Workflow Context JSON</button></div>
    </section>}

    <div className="workflow-import-grid">
      <div><FileUpload label="Import editable ComfyUI workflow" description={importedUi ? `Last file: ${importedUi.filename}` : "ChatGPT output: nodes + links UI-format graph."} disabled={!production || busyAction === "ui"} onFile={file => handleGeneratedUpload("ui", file)}/>
        {importedUi && <div className={importedUi.validation.valid ? "validation-success" : "validation-errors"}><b>{importedUi.validation.valid ? "Editable format structure checked" : "Editable format needs attention"}</b>{importedUi.validation.failures.map((failure, index) => <p key={index}>{failure}</p>)}{importedUi.validation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      </div>
      <div><FileUpload label="Import ComfyUI API workflow" description={importedApi ? `Last file: ${importedApi.filename}` : "Execution-format node map with class_type + inputs."} disabled={!production || busyAction === "api"} onFile={file => handleGeneratedUpload("api", file)}/>
        {currentValidation && <div className={currentValidation.valid && importedMatchesSelection ? "validation-success" : "validation-errors"}><b>{currentValidation.valid && importedMatchesSelection ? "API graph passed available compatibility checks" : "API graph is not executable yet"}</b>{currentValidation.failures.map((failure, index) => <p key={index}>{failure}</p>)}{currentValidation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      </div>
    </div>
    <div className="action-row workflow-actions">
      {importedApi && <button className="button button-secondary" type="button" onClick={revalidateApi} disabled={busyAction !== null || !connected}>{busyAction === "validate" ? <><LoaderCircle className="spin"/> Checking /object_info…</> : <><ShieldCheck/> Revalidate API Workflow</>}</button>}
      <button className="button" type="button" onClick={generateVideo} disabled={!canGenerate || busyAction !== null}>{busyAction === "generate" ? <><LoaderCircle className="spin"/> Submitting…</> : <><Workflow/> Generate Full Video</>}</button>
      {!connected && importedApi && <span className="workflow-muted">Connect ComfyUI to check node/model compatibility and enable execution.</span>}
    </div>
    {jobStatus && <div className="job-status"><b>ComfyUI job: {jobStatus.status}</b>{jobStatus.promptId && <p>Prompt ID: {jobStatus.promptId}</p>}{jobStatus.pollingError && <p className="validation-errors">{jobStatus.pollingError}</p>}{jobStatus.error && <p className="validation-errors">{jobStatus.error}</p>}{jobStatus.status === "completed" && jobStatus.outputUrl && <><video controls preload="metadata" src={jobStatus.outputUrl} aria-label="Completed generated video"/><a className="button" href={jobStatus.outputUrl} download><ArrowDownToLine/> Download final MP4</a></>}</div>}
    <p className="workflow-muted">{connectionMessage} · API submissions are single complete graphs. Static validation cannot guarantee VRAM fit or successful rendering.</p>

    <dialog ref={dialogRef} className="workflow-dialog" aria-labelledby="workflow-dialog-title" onCancel={event => { event.preventDefault(); setDialogOpen(false); }} onClose={() => setDialogOpen(false)}>
      <div className="workflow-dialog-head"><div><span className="card-overline">CONFIRM WORKFLOW CONTEXT</span><h2 id="workflow-dialog-title">Prepare Full Workflow</h2><p>Choose the exact reference models and review this project&apos;s output target.</p></div><button className="workflow-close" type="button" onClick={() => setDialogOpen(false)} aria-label="Close dialog">×</button></div>
      <div className="workflow-dialog-body">
        <label className="field"><span>Image model</span><div className="select-wrap"><select autoFocus value={selectedModels.image} onChange={event => setSelectedModels(current => ({ ...current, image: event.target.value }))}>{imageOptions.map(filename => <option key={filename} value={filename}>{modelLabel("image", filename)}{reference?.models.image.includes(filename) ? "" : " · specified, not detected"}</option>)}</select></div></label>
        <label className="field"><span>Video model</span><div className="select-wrap"><select value={selectedModels.video} onChange={event => setSelectedModels(current => ({ ...current, video: event.target.value }))}>{videoOptions.map(filename => <option key={filename} value={filename}>{modelLabel("video", filename)}{reference?.models.video.includes(filename) ? "" : " · specified, not detected"}</option>)}</select></div></label>
        <div className="workflow-detail-grid"><div><b>Text encoders</b><small>{supportingModels.textEncoders.join(" · ") || "Not detected — request ChatGPT to report missing dependencies"}</small></div><div><b>VAE</b><small>{supportingModels.vaeModels.join(" · ") || "Not detected — request ChatGPT to report missing dependencies"}</small></div></div>
        <div className="workflow-detail-grid"><div><b>Project</b><small>{production?.scenes.length} scenes · {production?.video.durationSeconds}s · {production?.narration.language} narration</small></div><div><b>Target output</b><small>{production?.video.fps} FPS · {production?.video.width} × {production?.video.height}</small></div></div>
        <div className="workflow-detail-grid"><div><b>Reference file</b><small>{referenceData?.filename}</small></div><div><b>Verification</b><small>{connected ? "Server reachable; model availability checked on API import" : "Unverified · ComfyUI offline"}</small></div></div>
  <div className="workflow-detail-grid"><div><b>Final output</b><small>One complete MP4; generated workflow must identify an MP4 output node.</small></div><div><b>Execution status</b><small>Not tested until the imported API graph is checked and actually submitted.</small></div></div>
        {dialogWarnings.length > 0 && <div className="workflow-warning-list"><b>Compatibility warnings</b>{dialogWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        <p className="workflow-muted">The brief&apos;s example reference is 10 scenes / 50 seconds / 24 FPS / Hindi; this project target is {production?.scenes.length} scenes / {production?.video.durationSeconds} seconds / {production?.video.fps} FPS / {production?.narration.language}. Example values are user-provided and must be confirmed against the attached graph.</p>
      </div>
      <div className="workflow-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setDialogOpen(false)}>Cancel</button><button className="button" type="button" onClick={generateRequest} disabled={!production || !reference}>Generate ChatGPT Workflow Request</button></div>
    </dialog>
  </section>;
}

function unique(values: string[]) { return [...new Set(values)]; }

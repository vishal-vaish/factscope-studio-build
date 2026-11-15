"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Activity, ArrowDownToLine, Check, Copy, FileJson2, LoaderCircle, ShieldCheck, Upload, Workflow } from "lucide-react";
import { toast } from "sonner";
import type { Production } from "@/lib/production-schema";
import { getWorkflowSupportingModels, imageModelPresets, videoModelPresets, type WorkflowModelSelection } from "@/lib/comfyui/model-presets";
import { buildWorkflowContext, buildWorkflowRequest } from "@/lib/workflow/request";
import type { ImportState } from "@/lib/workflow/storage";

type JobStatus = { id: string; status: string; promptId: string | null; error: string | null; outputUrl?: string | null; pollingError?: string } | null;
type WorkflowImports = { workflows: ImportState[] };

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

function FileUpload({ label, description, accept = ".json,application/json", disabled, onFile }: { label: string; description: string; accept?: string; disabled?: boolean; onFile: (file: File) => void }) {
  return <label className={`upload-zone workflow-upload ${disabled ? "is-disabled" : ""}`}><Upload/><span><b>{label}</b><small>{description}</small></span><input type="file" accept={accept} disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.currentTarget.value = ""; }}/></label>;
}

export function WorkflowGenerator({ id, topic, production, connected, connectionMessage, jobStatus, onJobStarted }: { id: string; topic: string; production: Production | null; connected: boolean; connectionMessage: string; jobStatus: JobStatus; onJobStarted: (jobId: string, status?: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedModels, setSelectedModels] = useState<WorkflowModelSelection>({ image: imageModelPresets[0].diffusionModel, video: videoModelPresets[0].diffusionModel });
  const [requestText, setRequestText] = useState("");
  const [busyAction, setBusyAction] = useState<"ui" | "api" | "validate" | "generate" | null>(null);
  const [localMessage, setLocalMessage] = useState("");
  const [lastValidation, setLastValidation] = useState<ImportState["validation"] | null>(null);
  const importsKey = `/api/videos/${id}/workflow-import`;
  const { data: importsData, mutate: refreshImports } = useSWR<WorkflowImports>(importsKey, fetchJson);
  const importedApi = importsData?.workflows.find(workflow => workflow.kind === "api") || null;
  const importedUi = importsData?.workflows.find(workflow => workflow.kind === "ui") || null;
  const supportingModels = getWorkflowSupportingModels(selectedModels);
  const importedMatchesSelection = !!importedApi && importedApi.selectedModels.image === selectedModels.image && importedApi.selectedModels.video === selectedModels.video && JSON.stringify(importedApi.supportingModels) === JSON.stringify(supportingModels);
  const canGenerate = !!production && connected && !!importedApi?.validation.valid && importedMatchesSelection && !!importedApi.validation.outputNodeId && !["preparing", "submitting", "submission_unknown", "unknown", "queued", "running", "completed"].includes(jobStatus?.status || "");
  const currentValidation = lastValidation || importedApi?.validation || null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    if (!dialogOpen && dialog.open) dialog.close();
  }, [dialogOpen]);

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
      toast.success(kind === "api" ? "API workflow imported; verification status is shown below." : "Editable workflow imported and format-checked.");
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
      toast[result.workflow.validation.valid ? "success" : "warning"](result.workflow.validation.valid ? "API workflow passed current compatibility checks." : "API workflow is still unverified or has compatibility blockers.");
    } catch (error) { setLocalMessage(error instanceof Error ? error.message : "Could not validate the API workflow."); }
    finally { setBusyAction(null); }
  }

  function generateRequest() {
    if (!production) return;
    setRequestText(buildWorkflowRequest(production, selectedModels, topic));
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
    if (!production) return;
    const context = buildWorkflowContext(production, selectedModels, topic);
    saveDownload(`factscope-${id}-workflow-context.json`, JSON.stringify(context, null, 2), "application/json");
  }

  async function copyRequest() {
    try { await navigator.clipboard.writeText(requestText); toast.success("ChatGPT workflow prompt copied."); }
    catch { toast.error("Clipboard access is unavailable in this browser."); }
  }

  return <section className="workspace-card workflow-generator">
    <div className="workspace-card-head"><div className="card-icon cyan"><Workflow/></div><div><span className="card-overline">COMFYUI WORKFLOW</span><h2>ComfyUI Full Video Workflow</h2><p>Prepare a complete workflow request, import ChatGPT&apos;s result, then verify and run it.</p></div></div>
    <div className="readiness-list">
      <span className={production ? "ready" : "blocked"}>{production ? <Check/> : <FileJson2/>} Production JSON: {production ? "Ready" : "Not imported"}</span>
      <span className={requestText ? "ready" : "blocked"}>{requestText ? <Check/> : <Activity/>} ChatGPT Workflow Prompt: {requestText ? "Ready" : "Not Prepared"}</span>
      <span className={importedApi?.validation.valid && importedMatchesSelection ? "ready" : "blocked"}>{importedApi ? importedApi.validation.valid && importedMatchesSelection ? <Check/> : <ShieldCheck/> : <Activity/>} Generated ComfyUI Workflow: {importedApi ? importedApi.validation.valid && importedMatchesSelection ? "Imported · verified" : "Imported · not verified" : "Not Imported"}</span>
      <span className={jobStatus?.status === "completed" ? "ready" : "blocked"}>{jobStatus?.status === "completed" ? <Check/> : <Activity/>} ComfyUI Execution: {jobStatus?.status === "completed" ? "Ready · complete" : jobStatus?.status === "failed" ? "Failed" : connected && importedApi?.validation.valid && importedMatchesSelection ? "Ready" : "Not Verified"}</span>
    </div>
    {localMessage && <div className="validation-errors workflow-message" role="alert">{localMessage.split("\n").map((line, index) => <p key={index}>{line}</p>)}</div>}
    {production && <div className="action-row"><button className="button" type="button" onClick={() => setDialogOpen(true)} disabled={busyAction !== null}><Workflow/> Prepare Full Workflow</button></div>}

    {requestText && <section className="workflow-request-output" aria-labelledby="workflow-request-heading">
      <div className="workflow-summary-head"><div><span className="card-overline">READY TO COPY</span><h3 id="workflow-request-heading">ChatGPT Workflow Prompt</h3></div><span className="workflow-unverified">Model files are not verified</span></div>
      <textarea aria-label="Generated ChatGPT workflow prompt" readOnly value={requestText} className="json-editor workflow-request-text"/>
      <div className="action-row"><button className="button" type="button" onClick={copyRequest}><Copy/> Copy ChatGPT Prompt</button><button className="button button-secondary" type="button" onClick={() => saveDownload(`factscope-${id}-workflow-prompt.txt`, requestText, "text/plain")}><ArrowDownToLine/> Download Prompt TXT</button><button className="button button-secondary" type="button" onClick={downloadContext}><FileJson2/> Download Workflow Context JSON</button></div>
    </section>}

    <div className="workflow-import-grid">
      <div><FileUpload label="Import ComfyUI UI Workflow" description={importedUi ? `Last file: ${importedUi.filename}` : "Editable UI-format graph with nodes and links."} disabled={!production || busyAction === "ui"} onFile={file => handleGeneratedUpload("ui", file)}/>
        {importedUi && <div className={importedUi.validation.valid ? "validation-success" : "validation-errors"}><b>{importedUi.validation.valid ? "Editable format structure checked" : "Editable format needs attention"}</b>{importedUi.validation.failures.map((failure, index) => <p key={index}>{failure}</p>)}{importedUi.validation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      </div>
      <div><FileUpload label="Import ComfyUI API Workflow" description={importedApi ? `Last file: ${importedApi.filename}` : "Execution-format node map with class_type and inputs."} disabled={!production || busyAction === "api"} onFile={file => handleGeneratedUpload("api", file)}/>
        {currentValidation && <div className={currentValidation.valid && importedMatchesSelection ? "validation-success" : "validation-errors"}><b>{currentValidation.valid && importedMatchesSelection ? "API graph passed available compatibility checks" : connected ? "API graph is not executable yet" : "API graph imported · unverified while ComfyUI is offline"}</b>{currentValidation.failures.map((failure, index) => <p key={index}>{failure}</p>)}{currentValidation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      </div>
    </div>
    <div className="action-row workflow-actions">
      {importedApi && <button className="button button-secondary" type="button" onClick={revalidateApi} disabled={busyAction !== null || !connected}>{busyAction === "validate" ? <><LoaderCircle className="spin"/> Checking /object_info…</> : <><ShieldCheck/> Revalidate API Workflow</>}</button>}
      <button className="button" type="button" onClick={generateVideo} disabled={!canGenerate || busyAction !== null}>{busyAction === "generate" ? <><LoaderCircle className="spin"/> Submitting…</> : <><Workflow/> Generate Full Video</>}</button>
      {!connected && importedApi && <span className="workflow-muted">Connect ComfyUI to verify node classes, inputs, and model availability before execution.</span>}
    </div>
    {jobStatus && <div className="job-status"><b>ComfyUI job: {jobStatus.status}</b>{jobStatus.promptId && <p>Prompt ID: {jobStatus.promptId}</p>}{jobStatus.pollingError && <p className="validation-errors">{jobStatus.pollingError}</p>}{jobStatus.error && <p className="validation-errors">{jobStatus.error}</p>}{jobStatus.status === "completed" && jobStatus.outputUrl && <><video controls preload="metadata" src={jobStatus.outputUrl} aria-label="Completed generated video"/><a className="button" href={jobStatus.outputUrl} download><ArrowDownToLine/> Download final MP4</a></>}</div>}
    <p className="workflow-muted">{connectionMessage} · Prompt preparation works offline. Execution is enabled only after live API workflow verification.</p>

    <dialog ref={dialogRef} className="workflow-dialog" aria-labelledby="workflow-dialog-title" onCancel={event => { event.preventDefault(); setDialogOpen(false); }} onClose={() => setDialogOpen(false)}>
      <div className="workflow-dialog-head"><div><span className="card-overline">WORKFLOW SETTINGS</span><h2 id="workflow-dialog-title">Prepare Full Workflow</h2><p>Select the model presets for this production.</p></div><button className="workflow-close" type="button" onClick={() => setDialogOpen(false)} aria-label="Close dialog">×</button></div>
      <div className="workflow-dialog-body">
        <label className="field"><span>Image AI model</span><div className="select-wrap"><select autoFocus value={selectedModels.image} onChange={event => setSelectedModels(current => ({ ...current, image: event.target.value }))}>{imageModelPresets.map(preset => <option key={preset.id} value={preset.diffusionModel}>{preset.name}</option>)}</select></div></label>
        <label className="field"><span>Video AI model</span><div className="select-wrap"><select value={selectedModels.video} onChange={event => setSelectedModels(current => ({ ...current, video: event.target.value }))}>{videoModelPresets.map(preset => <option key={preset.id} value={preset.diffusionModel}>{preset.name}</option>)}</select></div></label>
        <div className="workflow-detail-grid"><div><b>Production settings</b><small>{production?.scenes.length} scenes · {production?.video.durationSeconds}s · {production?.video.fps} FPS · {production?.video.width} × {production?.video.height} · {production?.video.aspectRatio}</small></div><div><b>Narration</b><small>{production?.narration.language} · {production?.audio.language}</small></div></div>
      </div>
      <div className="workflow-dialog-actions"><button className="button button-secondary" type="button" onClick={() => setDialogOpen(false)}>Cancel</button><button className="button" type="button" onClick={generateRequest} disabled={!production}>Generate ChatGPT Workflow Prompt</button></div>
    </dialog>
  </section>;
}

# Progressive (streaming) DXF render — implementation plan

## Goal
Make large drawings *appear* in ~2-4s and refine to full detail, instead of a single ~14s all-or-nothing render. No fidelity loss (unlike LOD). Targets outlier files like Room Configuration (163K entities); normal files are unaffected (they finish in one chunk).

## Why this is the right variant
- The expensive work (`DxfScene.Build`, ~10s) runs entirely in the worker and is delivered **once, atomically** (`DxfWorker._ProcessRequestMessage` LOAD → single response). Nothing paints until it's all done.
- The build is already separable into passes (block defs → block-instance entities → top-level entities) and `_BuildScene()` produces transferable ArrayBuffers.
- The worker **already sends multiple messages per request** for PROGRESS (`DxfWorker.WorkerMsg.PROGRESS`) — so streaming partial scenes reuses an existing pattern, not a new transport.
- LOD was rejected: the fork builds the scene **before** the camera/zoom is known (`FitView` runs after Build), so there's no zoom context to decide sub-pixel culling without a bigger restructure.

## Design

### Worker side (`DxfScene.js` + `DxfWorker.js`)
1. **Chunked scene emission.** Add an option `progressiveChunkSize` (e.g. 40K entities). In `DxfScene.Build`, after processing each chunk of entities (within the existing top-level + block-instance loops), call `_BuildScene()` for the batches accumulated *so far this chunk*, then reset the per-chunk batch accumulator and continue. Each `_BuildScene()` returns an independent set of transferable buffers.
   - Keep model-space geometry first (it's what the user wants to see); solid fills already load first (existing ordering) — preserve that within chunk 1.
   - The hatch budget counter persists across chunks (already an instance field).
2. **New worker message `CHUNK`.** In `_ProcessRequestMessage` LOAD handler, instead of returning one `{scene}`, post a `CHUNK` message per partial scene (transferring its buffers), then a final `LOAD` completion carrying `{dxf, bounds, hasMissingChars, numHatchesDegraded}` (metadata only — no buffers). Mirror the existing `_SendProgress` mechanism (`_SendChunk(seq, sceneChunk, transfers)`).
3. **Bounds:** compute a running bounds; include the cumulative bounds in each CHUNK so the main thread can refit progressively.

### Main side (`DxfWorker.js` + `DxfViewer.js`)
4. **`DxfWorker.Load`** gains a `chunkCbk`. `_ProcessResponse` routes `CHUNK` messages to `chunkCbk(sceneChunk)` (like it routes PROGRESS), and resolves the request only on the final LOAD completion.
5. **`DxfViewer.Load`**: for each chunk, run the existing `_LoadBatch` loop (fills-first within the chunk), then `Render()`, and `FitView` to the cumulative bounds on the **first** chunk only (so the view is stable; subsequent chunks add geometry without yanking the camera). Build `VertexIndex` **once after the final chunk** (snap needs the full set; acceptable — snap isn't usable until loaded anyway).
6. **Back-compat:** if `progressiveChunkSize` is unset/0, behavior is identical to today (single chunk = current path). The worker still emits one CHUNK + completion; the main path handles N=1 transparently.

### Frontend (`teamsync-frontend/components/file-viewer/CadViewer.tsx`)
7. Pass `progressiveChunkSize` in the `Load({...})` options. Optionally surface "rendering… (n%)" using chunk callbacks; the existing `cad.document_load` span can record `cad.first_chunk_ms` (time to first paint) vs `cad.total_ms`.

## Risk / invariants to preserve
- **Snap/overlay/raycast:** `VertexIndex` must be built from the *complete* scene — defer to final chunk. Tools are gated on `state==='ready'` in CadViewer, which should fire on completion, not first chunk. Verify measure/redline/snap still work.
- **Solid-fill-behind-linework ordering (ts.3 fix):** maintain within each chunk; across chunks, fills in a later chunk could paint over earlier linework. Mitigate by keeping all solid-fill batches in the FIRST chunk (process hatches/solids before linework), or accept minor cross-chunk ordering for the progressive phase (final state is correct because depthTest is off and we can re-sort on completion). Decide during impl; simplest: emit all fills in chunk 1.
- **Theme recreation / Destroy mid-stream:** if the user switches theme or closes while chunks are streaming, the in-flight worker must be terminated cleanly (existing `Destroy()` path; ensure pending chunkCbk is dropped on cancel).
- **Transfer correctness:** each chunk's ArrayBuffers are transferred (neutered) — ensure no shared buffer across chunks.

## Effort & sequencing
- ~2-3 days. Fork change → bump `1.0.47-ts.6` → publish → frontend dep bump + `progressiveChunkSize` wiring.
- Verify against Room Configuration (163K) — expect first paint ~3-4s, full ~14s — and a normal DWG (Liebherr) to confirm zero regression (single chunk).

## Verification
- OTEL `cad.document_load`: add `cad.first_chunk_ms`; confirm first paint ≤ ~4s on Room Config, `cad.total_ms` unchanged (~14s).
- Regression: snap, measure, redline, PNG export, 2D/3D toggle, theme switch, solid-fill ordering — all unchanged on a normal drawing.
- Confirm `numHatchesDegraded` still reported.

## Recommendation
Pursue Variant 1 only if time-to-first-paint on outlier files is a priority. The common case is already 2-3s and Room Config is 10min→14s; this is a polish investment for the heaviest drawings, not a correctness fix.

/**
 * KDBush-backed 2D spatial index over every vertex emitted by the DXF
 * worker. Used by SnapToVertex() to find the nearest vertex within a
 * pixel tolerance.
 *
 * Built lazily after Load() because the vertex buffer only exists after
 * the worker has finished parsing. Capped at `maxVertices` (default
 * 500k); above the cap, vertices are downsampled by a grid bucket so we
 * keep approximate snap behaviour without blowing memory on a 2M-vertex
 * site plan.
 */

import KDBush from "kdbush"
import {BatchingKey} from "./BatchingKey.js"

/** Default cap. ~16 bytes per indexed point * 500k = ~8 MB. */
const DEFAULT_MAX_VERTICES = 500_000

export class VertexIndex {
    /**
     * @param {{batches: Array, vertices: ArrayBuffer, origin: {x:number,y:number}, bounds: object|null}} scene
     *   The serialized scene object returned by DxfWorker.Load.
     * @param {{maxVertices?: number}} options
     */
    constructor(scene, options = {}) {
        const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES
        const origin = scene.origin ?? {x: 0, y: 0}

        // First pass: count total vertices across batches (skip block
        // definitions -- block-instance batches reference the same vertex
        // data via transforms, not their own positions, and would inflate
        // the index without representing reachable geometry).
        let total = 0
        for (const batch of scene.batches) {
            if (this._SkipBatch(batch)) continue
            if (batch.verticesSize) total += batch.verticesSize / 2
            if (batch.chunks) {
                for (const c of batch.chunks) {
                    if (c.verticesSize) total += c.verticesSize / 2
                }
            }
        }

        // Pick stride: 1 when under cap; >1 otherwise (downsample).
        const stride = total > maxVertices ? Math.ceil(total / maxVertices) : 1
        const capacity = Math.ceil(total / stride)
        this.index = new KDBush(Math.max(1, capacity))

        // Stored in scene-space (NOT canvas-space). SnapToVertex projects
        // a query pixel to a scene point first and then queries here.
        let written = 0
        const addBatch = (batchVerticesOffset, verticesSize) => {
            if (!verticesSize) return
            const arr = new Float32Array(
                scene.vertices,
                batchVerticesOffset * Float32Array.BYTES_PER_ELEMENT,
                verticesSize)
            // arr is [x0, y0, x1, y1, ...]
            for (let i = 0; i < arr.length; i += 2 * stride) {
                const x = arr[i]
                const y = arr[i + 1]
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue
                // Add scene coords by undoing the origin shift the worker
                // applied. Callers expect world coords.
                this.index.add(x + origin.x, y + origin.y)
                written++
            }
        }

        for (const batch of scene.batches) {
            if (this._SkipBatch(batch)) continue
            if (batch.verticesSize) {
                addBatch(batch.verticesOffset, batch.verticesSize)
            }
            if (batch.chunks) {
                for (const chunk of batch.chunks) {
                    addBatch(chunk.verticesOffset, chunk.verticesSize)
                }
            }
        }

        this.index.finish()
        this.totalVertices = total
        this.indexedVertices = written
        this.stride = stride
    }

    /** Return {x, y} of the nearest vertex within `tolerance` (in scene
     *  units), or null if none. */
    Nearest(x, y, tolerance) {
        // KDBush v4 stores coords on the typed-array `coords` field
        // ([x0, y0, x1, y1, ...]); `within()` returns the storage ids,
        // and `coords[id*2]` is x, `coords[id*2+1]` is y. An older v3 API
        // used `.points`/`.ids` which doesn't exist on v4 -- using it
        // throws "this.index.points is undefined" on every snap.
        const tol2 = tolerance * tolerance
        const ids = this.index.within(x, y, tolerance)
        if (!ids.length) return null
        const coords = this.index.coords
        let best = null
        let bestDist2 = Infinity
        for (const id of ids) {
            const px = coords[id * 2]
            const py = coords[id * 2 + 1]
            const dx = px - x
            const dy = py - y
            const d2 = dx * dx + dy * dy
            if (d2 < bestDist2 && d2 <= tol2) {
                bestDist2 = d2
                best = {x: px, y: py}
            }
        }
        return best
    }

    _SkipBatch(batch) {
        // BLOCK_INSTANCE/POINT_INSTANCE batches don't own their geometry;
        // skip them so we don't index garbage transform data as vertex
        // positions.
        const gt = batch.key?.geometryType
        return gt === BatchingKey.GeometryType.BLOCK_INSTANCE
            || gt === BatchingKey.GeometryType.POINT_INSTANCE
    }
}

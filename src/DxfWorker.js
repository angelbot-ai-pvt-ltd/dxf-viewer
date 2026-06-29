import {DxfFetcher} from "./DxfFetcher.js"
import {DxfScene} from "./DxfScene.js"
import opentype from "opentype.js"

const MSG_SIGNATURE = "DxfWorkerMsg"

/** Wraps web-worker instance and provides unified interface to its services, including the when
 * web-worker is not used and all heavy operations are performed in main thread.
 */
export class DxfWorker {
    /** @param worker Web worker instance with DxfViewer.SetupWorker() function called. Can be null
     *  for synchronous operations.
     *  @param isWorker True for worker-side wrapper.
     */
    constructor(worker, isWorker = false) {
        this.worker = worker
        if (isWorker) {
            worker.onmessage = this._ProcessRequest.bind(this)
        } else if (worker) {
            worker.addEventListener("message", this._ProcessResponse.bind(this), false)
            worker.addEventListener("error", this._OnError.bind(this), false)
            this.reqSeq = 1
            /* Indexed by sequence. */
            this.requests = new Map()
            this.progressCbk = null
        }
    }

    /**
     * @param url DXF file URL.
     * @param {?string[]} fonts Fonts URLs.
     * @param options Viewer options. See DxfViewer.DefaultOptions.
     * @param {?Function} progressCbk (phase, processedSize, totalSize)
     * @param {?Function} chunkCbk (sceneChunk, isLast) -- progressive scene chunks.
     *  Only invoked when options.progressiveChunkSize > 0. When used, the resolved
     *  result carries metadata only (scene === null); geometry arrives via chunks.
     */
    async Load(url, fonts, options, progressCbk, chunkCbk = null) {
        if (this.worker) {
            return this._SendRequest(DxfWorker.WorkerMsg.LOAD,
                                     { url, fonts, options: this._CloneOptions(options) },
                                     progressCbk, chunkCbk)
        } else {
            /* No worker: run synchronously on the main thread, delivering chunks
             * directly to chunkCbk if progressive. */
            return this._Load(url, fonts, options, progressCbk, chunkCbk)
        }
    }

    async Destroy(noWait = false) {
        if (this.worker) {
            if (!noWait) {
                await this._SendRequest(DxfWorker.WorkerMsg.DESTROY)
            }
            /* close() in the worker is not enough, instance is still visible in dev tools. */
            this.worker.terminate()
        }
    }

    async _ProcessRequest(event) {
        const msg = event.data
        if (msg.signature !== MSG_SIGNATURE) {
            console.log("Message with bad signature", msg)
            return
        }
        const resp = {seq: msg.seq, type: msg.type, signature: MSG_SIGNATURE}
        const transfers = []
        try {
            resp.data = await this._ProcessRequestMessage(msg.type, msg.data, transfers, msg.seq)
        } catch (error) {
            console.error(error)
            resp.error = String(error)
        }
        this.worker.postMessage(resp, transfers)
        if (msg.type === DxfWorker.WorkerMsg.DESTROY) {
            this.worker.onmessage = null
            this.worker.close()
            this.worker = null
        }
    }

    async _ProcessRequestMessage(type, data, transfers, seq) {
        switch (type) {
        case DxfWorker.WorkerMsg.LOAD: {
            /* Progressive build is requested when the cloned options carry a
             * positive progressiveChunkSize. Each chunk is posted as its own
             * message (buffers transferred); the LOAD response then carries only
             * metadata (dxf), with scene === null. */
            const progressive = data.options && (
                (data.options.progressiveChunkSize || 0) > 0 ||
                (data.options.sceneOptions && (data.options.sceneOptions.progressiveChunkSize || 0) > 0))
            const chunkCbk = progressive
                ? (sceneChunk, isLast) => this._SendChunk(seq, sceneChunk, isLast)
                : null
            const {scene, dxf} = await this._Load(
                data.url,
                data.fonts,
                data.options,
                (phase, size, totalSize) => this._SendProgress(seq, phase, size, totalSize),
                chunkCbk)
            if (scene) {
                transfers.push(scene.vertices)
                transfers.push(scene.indices)
                transfers.push(scene.transforms)
            }
            return {scene, dxf}
        }
        case DxfWorker.WorkerMsg.DESTROY:
            return null
        default:
            throw "Unknown message type: " + type
        }
    }

    async _ProcessResponse(event) {
        const msg = event.data
        if (msg.signature !== MSG_SIGNATURE) {
            console.log("Message with bad signature", msg)
            return
        }
        const seq = msg.seq
        const req = this.requests.get(seq)
        if (!req) {
            console.error("Unmatched message sequence: ", seq)
            return
        }
        const data = msg.data
        if (msg.type === DxfWorker.WorkerMsg.PROGRESS) {
            if (req.progressCbk) {
                req.progressCbk(data.phase, data.size, data.totalSize)
            }
            return
        }
        if (msg.type === DxfWorker.WorkerMsg.CHUNK) {
            /* Progressive scene chunk -- deliver and keep the request open until
             * the final LOAD response arrives. */
            if (req.chunkCbk) {
                req.chunkCbk(data.scene, data.isLast)
            }
            return
        }
        this.requests.delete(seq)
        if (msg.hasOwnProperty("error")) {
            req.SetError(msg.error)
        } else {
            req.SetResponse(data)
        }
    }

    async _OnError(error) {
        console.error("DxfWorker worker error", error)
        const requests = Array.from(this.requests.values)
        this.requests.clear()
        requests.forEach(req => req.SetError(error))
    }

    async _SendRequest(type, data = null, progressCbk = null, chunkCbk = null) {
        const seq = this.reqSeq++
        const req = new DxfWorker.Request(seq, progressCbk, chunkCbk)
        this.requests.set(seq, req)
        this.worker.postMessage({ seq, type, data, signature: MSG_SIGNATURE})
        return await req.GetResponse()
    }

    _SendProgress(seq, phase, size, totalSize) {
        this.worker.postMessage({
            seq,
            type: DxfWorker.WorkerMsg.PROGRESS,
            data: {phase, size, totalSize},
            signature: MSG_SIGNATURE
        })
    }

    /** Post one progressively-built scene chunk to the main thread. The chunk's
     * geometry buffers are transferred (ownership moves to the main thread). */
    _SendChunk(seq, sceneChunk, isLast) {
        const transfers = []
        if (sceneChunk) {
            if (sceneChunk.vertices) transfers.push(sceneChunk.vertices)
            if (sceneChunk.indices) transfers.push(sceneChunk.indices)
            if (sceneChunk.transforms) transfers.push(sceneChunk.transforms)
        }
        this.worker.postMessage({
            seq,
            type: DxfWorker.WorkerMsg.CHUNK,
            data: {scene: sceneChunk, isLast},
            signature: MSG_SIGNATURE
        }, transfers)
    }

    /** @param chunkCbk {?Function} (sceneChunk, isLast) -- when provided, the
     *  scene is built progressively and each chunk is delivered here instead of
     *  being returned. The return value then carries only metadata (no scene).
     *  @return {Object} { scene, dxf } in non-progressive mode; { dxf } when
     *  chunkCbk is used (scene delivered via the callback). */
    async _Load(url, fonts, options, progressCbk, chunkCbk = null) {
        let fontFetchers
        if (fonts) {
            fontFetchers = this._CreateFontFetchers(fonts, progressCbk)
        } else {
            fontFetchers = []
        }
        const dxf = await new DxfFetcher(url, options.fileEncoding).Fetch(progressCbk)
        if (progressCbk) {
            progressCbk("prepare", 0, null)
        }
        const dxfScene = new DxfScene(options)
        if (chunkCbk) {
            await dxfScene.Build(dxf, fontFetchers, chunkCbk)
            return {scene: null, dxf: options.retainParsedDxf === true ? dxf : undefined }
        }
        await dxfScene.Build(dxf, fontFetchers)
        return {scene: dxfScene.scene, dxf: options.retainParsedDxf === true ? dxf : undefined }
    }

    _CreateFontFetchers(urls, progressCbk) {

        function CreateFetcher(url) {
            return async function() {
                if (progressCbk) {
                    progressCbk("font", 0, null)
                }
                const data = await fetch(url).then(response => response.arrayBuffer())
                if (progressCbk) {
                    progressCbk("prepare", 0, null)
                }
                return opentype.parse(data)
            }
        }

        const fetchers = []
        for (const url of urls) {
            fetchers.push(CreateFetcher(url))
        }
        return fetchers
    }

    _CloneOptions(options) {
        /* Default options values are taken from prototype so need to implement deep clone here. */
        if (Array.isArray(options)) {
            return options.map(o => this._CloneOptions(o))
        } else if (typeof options === "object" && options !== null) {
            const result = {}
            for (const propName in options) {
                // noinspection JSUnfilteredForInLoop
                result[propName] = this._CloneOptions(options[propName])
            }
            return result
        } else {
            return options
        }
    }
}

DxfWorker.WorkerMsg = {
    LOAD: "LOAD",
    PROGRESS: "PROGRESS",
    /** Progressive scene chunk (one partial serialized scene). */
    CHUNK: "CHUNK",
    DESTROY: "DESTROY"
}

DxfWorker.Request = class {
    constructor(seq, progressCbk, chunkCbk = null) {
        this.seq = seq
        this.progressCbk = progressCbk
        this.chunkCbk = chunkCbk
        this.promise = new Promise((resolve, reject) => {
            this._Resolve = resolve
            this._Reject = reject
        })
    }

    async GetResponse() {
        return await this.promise
    }

    SetResponse(response) {
        this._Resolve(response)
    }

    SetError(error) {
        this._Reject(error)
    }
}

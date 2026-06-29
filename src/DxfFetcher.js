import DxfParser from "./parser/DxfParser.js"

/** Fetches and parses DXF file. */
export class DxfFetcher {
    constructor(url, encoding = "utf-8") {
        this.url = url
        this.encoding = encoding
    }

    /** @param progressCbk {Function} (phase, receivedSize, totalSize) */
    async Fetch(progressCbk = null) {
        const response = await fetch(this.url)
        const totalSize = +response.headers.get('Content-Length')

        /* Renditions may be gzip-compressed at rest (DXF is highly compressible
         * text -- typically 5-10x). The storage key is an opaque UUID with no
         * extension, and the object is served WITHOUT a Content-Encoding header
         * (otherwise the browser would inflate transparently), so we detect
         * gzip from the content's magic bytes (1f 8b) and inflate via
         * DecompressionStream. Uncompressed responses are passed through
         * unchanged, so older non-gzipped renditions keep loading. */
        const body = await this._MaybeInflate(response)

        const reader = body.getReader()
        let receivedSize = 0
        //XXX streaming parsing is not supported in dxf-parser for now (its parseStream() method
        // just accumulates chunks in a string buffer before parsing. Fix it later.
        let buffer = ""
        let decoder = new TextDecoder(this.encoding)
        while(true) {
            const {done, value} = await reader.read()
            if (done) {
                buffer += decoder.decode(new ArrayBuffer(0), {stream: false})
                break
            }
            buffer += decoder.decode(value, {stream: true})
            receivedSize += value.length
            if (progressCbk !== null) {
                progressCbk("fetch", receivedSize, totalSize)
            }
        }

        if (progressCbk !== null) {
            progressCbk("parse", 0, null)
        }
        const parser = new DxfParser()
        return parser.parseSync(buffer)
    }

    /** Return a byte stream for the response body, transparently inflating it
     * when the content is gzip-compressed.
     *
     * The browser already inflates when the server set `Content-Encoding: gzip`,
     * so in that case we never double-inflate (we pass through). Otherwise we
     * peek the first two bytes for the gzip magic (0x1f 0x8b); if present, the
     * already-read prefix is re-prepended and the reconstructed stream is piped
     * through DecompressionStream. Detection is content-based (not URL/header
     * based) because rendition keys are opaque UUIDs with no extension.
     */
    async _MaybeInflate(response) {
        const enc = (response.headers.get("Content-Encoding") || "").toLowerCase()
        if (enc.includes("gzip") || typeof DecompressionStream === "undefined") {
            return response.body
        }

        const reader = response.body.getReader()
        const first = await reader.read()
        const head = first.value ?? new Uint8Array(0)
        const isGzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b

        /* Rebuild a stream that re-emits the peeked first chunk, then the rest. */
        const rebuilt = new ReadableStream({
            start(controller) {
                if (head.length > 0) {
                    controller.enqueue(head)
                }
                if (first.done) {
                    controller.close()
                }
            },
            async pull(controller) {
                const { done, value } = await reader.read()
                if (done) {
                    controller.close()
                } else {
                    controller.enqueue(value)
                }
            },
            cancel(reason) {
                return reader.cancel(reason)
            }
        })

        return isGzip ? rebuilt.pipeThrough(new DecompressionStream("gzip")) : rebuilt
    }
}

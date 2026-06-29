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
         * text). When the object is served WITHOUT a Content-Encoding header
         * (otherwise the browser inflates transparently), we detect gzip from
         * the .gz URL suffix and inflate via DecompressionStream. Uncompressed
         * responses fall through to the original path unchanged, so older
         * non-gzipped renditions keep loading. */
        let body = response.body
        if (this._IsGzip(response)) {
            body = response.body.pipeThrough(new DecompressionStream("gzip"))
        }

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

    /** Decide whether the response body needs manual gzip inflation.
     *
     * If the server sent `Content-Encoding: gzip`, the browser already inflated
     * the body transparently -- we must NOT inflate again. Otherwise, treat the
     * object as gzip when its URL path ends in `.gz` (query string ignored).
     * DecompressionStream is available in modern browsers and Web Workers.
     */
    _IsGzip(response) {
        const enc = (response.headers.get("Content-Encoding") || "").toLowerCase()
        if (enc.includes("gzip")) {
            return false
        }
        if (typeof DecompressionStream === "undefined") {
            return false
        }
        let path = this.url
        try {
            path = new URL(this.url, "http://x").pathname
        } catch {
            /* Relative or odd URL -- fall back to the raw string. */
        }
        return /\.gz$/i.test(path)
    }
}

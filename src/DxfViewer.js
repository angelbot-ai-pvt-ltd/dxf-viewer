import * as three from "three"
import {BatchingKey} from "./BatchingKey.js"
import {DxfWorker} from "./DxfWorker.js"
import {MaterialKey} from "./MaterialKey.js"
import {ColorCode, DxfScene} from "./DxfScene.js"
import {OrbitControls} from "./OrbitControls.js"
import {RBTree} from "./RBTree.js"
import {VertexIndex} from "./VertexIndex.js"


/** Level in "message" events. */
const MessageLevel = Object.freeze({
    INFO: "info",
    WARN: "warn",
    ERROR: "error"
})


/** The representation class for the viewer, based on Three.js WebGL renderer. */
export class DxfViewer {

    /**
     * @param domContainer Container element to create the canvas in. Usually empty div. Should not
     *  have padding if auto-resize feature is used.
     * @param options Some options can be overridden if specified. See DxfViewer.DefaultOptions.
     */
    constructor(domContainer, options = null) {
        this.domContainer = domContainer
        this.options = Object.create(DxfViewer.DefaultOptions)
        if (options) {
            Object.assign(this.options, options)
        }
        options = this.options

        this.clearColor = this.options.clearColor.getHex()

        this.scene = new three.Scene()

        // TeamSync fork: overlay scene rendered AFTER the main DXF scene
        // with autoClear=false. Hosts measurement lines, redline shapes,
        // and any custom three.Object3D the app wants to draw on top of
        // the drawing. Origin convention matches main scene: objects are
        // added in world coords minus this.origin, just like batches.
        this.overlayScene = new three.Scene()
        /** Map<id, Object3D> -- ids returned by AddOverlay so the app can
         *  remove individual overlays without tracking three refs. */
        this.overlays = new Map()
        this._nextOverlayId = 1

        /** Lazy KDBush built after Load(). Null until then. */
        this.vertexIndex = null

        /** Map<layerName, originalColorsByObjUuid> for SetLayerColor undo. */
        this._layerColorOverrides = new Map()

       this.ownsRenderer = !options.renderer
       this.renderer = options.renderer

       if(!this.renderer) {
           try {
               this.renderer = new three.WebGLRenderer({
                   alpha: options.canvasAlpha,
                   premultipliedAlpha: options.canvasPremultipliedAlpha,
                   antialias: options.antialias,
                   depth: false,
                   preserveDrawingBuffer: options.preserveDrawingBuffer
                })
            } catch (e) {
                console.log("Failed to create renderer: " + e)
                this.renderer = null
                return
            }
        }
        const renderer = this.renderer
        /* Prevent bounding spheres calculations which fails due to non-conventional geometry
         * buffers layout. Also do not waste CPU on sorting which we do not need anyway.
         */
        renderer.sortObjects = false
        renderer.setPixelRatio(window.devicePixelRatio)

        const camera = this.camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 2);
        camera.position.z = 1
        camera.position.x = 0
        camera.position.y = 0

        this.simpleColorMaterial = []
        this.simplePointMaterial = []
        for (let i = 0; i < InstanceType.MAX; i++) {
            this.simpleColorMaterial[i] = this._CreateSimpleColorMaterial(i)
            this.simplePointMaterial[i] = this._CreateSimplePointMaterial(i)
        }

        renderer.setClearColor(options.clearColor, options.clearAlpha)

        if (options.autoResize) {
            this.canvasWidth = domContainer.clientWidth
            this.canvasHeight = domContainer.clientHeight
            domContainer.style.position = "relative"
        } else {
            this.canvasWidth = options.canvasWidth
            this.canvasHeight = options.canvasHeight
            this.resizeObserver = null
        }
        renderer.setSize(this.canvasWidth, this.canvasHeight)

        this.canvas = renderer.domElement
        domContainer.style.display = "block"
        if (options.autoResize) {
            this.canvas.style.position = "absolute"
            this.resizeObserver = new ResizeObserver(entries => this._OnResize(entries[0]))
            this.resizeObserver.observe(domContainer)
        }
        domContainer.appendChild(this.canvas)

        this.canvas.addEventListener("pointerdown", this._OnPointerEvent.bind(this))
        this.canvas.addEventListener("pointerup", this._OnPointerEvent.bind(this))

        this.Render()

        /* Indexed by MaterialKey, value is {key, material}. */
        this.materials = new RBTree((m1, m2) => m1.key.Compare(m2.key))
        /* Indexed by layer name, value is Layer instance. */
        this.layers = new Map()
        /* Default layer used when no layer specified. */
        this.defaultLayer = null
        /* Indexed by block name, value is Block instance. */
        this.blocks = new Map()

        /** Set during data loading. */
        this.worker = null
    }

    /**
     * @returns {boolean} True if renderer exists. May be false in case when WebGL context is lost
     * (e.g. after wake up from sleep). In such case page should be reloaded.
     */
    HasRenderer() {
        return Boolean(this.renderer)
    }

    /**
     * @returns {three.WebGLRenderer | null} Returns the created Three.js renderer.
     */
    GetRenderer(){
        return this.renderer;
    }

    GetCanvas() {
        return this.canvas
    }

    GetDxf() {
        return this.parsedDxf
    }

    SetSize(width, height) {
        this._EnsureRenderer()

        const prevW = this.canvasWidth
        const prevH = this.canvasHeight

        /* The initial FitView (in Load) may have run before the container had
         * its final layout, so it fit against a stale canvas size. The FIRST
         * resize after a fit re-applies that fit at the now-correct size; doing
         * this unconditionally on the first post-fit resize handles a stale size
         * that is zero, small, or merely a different aspect -- all of which would
         * otherwise be blown out by proportional scaling (realSize/staleSize).
         * Later resizes scale proportionally so a user's pan/zoom is preserved. */
        const reFit = this._lastFitExtent && !this._didInitialResize
        this._didInitialResize = true

        this.canvasWidth = width
        this.canvasHeight = height
        this.renderer.setSize(width, height)

        if (reFit) {
            const e = this._lastFitExtent
            this.FitView(e.minX, e.maxX, e.minY, e.maxY, e.padding)
        } else {
            const hScale = width / prevW
            const vScale = height / prevH
            const cam = this.camera
            const centerX = (cam.left + cam.right) / 2
            const centerY = (cam.bottom + cam.top) / 2
            const camWidth = cam.right - cam.left
            const camHeight = cam.top - cam.bottom
            cam.left = centerX - hScale * camWidth / 2
            cam.right = centerX + hScale * camWidth / 2
            cam.bottom = centerY - vScale * camHeight / 2
            cam.top = centerY + vScale * camHeight / 2
            cam.updateProjectionMatrix()
        }

        if (this.controls) {
            this.controls.update()
        }
        this._Emit("resized", {width, height})
        this._Emit("viewChanged")
        this.Render()
    }

    /** Load DXF into the viewer. Old content is discarded, state is reset.
     * @param {string} url DXF file URL.
     * @param {?string[]} fonts List of font URLs. Files should have typeface.js format. Fonts are
     *  used in the specified order, each one is checked until necessary glyph is found. Text is not
     *  rendered if fonts are not specified.
     * @param {?Function} progressCbk (phase, processedSize, totalSize)
     *  Possible phase values:
     *  * "font"
     *  * "fetch"
     *  * "parse"
     *  * "prepare"
     * @param {?Function} workerFactory Factory for worker creation. The worker script should
     *  invoke DxfViewer.SetupWorker() function.
     */
    async Load({url, fonts = null, progressCbk = null, workerFactory = null}) {
        if (url === null || url === undefined) {
            throw new Error("`url` parameter is not specified")
        }

        this._EnsureRenderer()

        this.Clear()

        this.worker = new DxfWorker(workerFactory ? workerFactory() : null)
        const {scene, dxf} = await this.worker.Load(url, fonts, this.options, progressCbk)
        await this.worker.Destroy()
        this.worker = null
        this.parsedDxf = dxf

        this.origin = scene.origin
        this.bounds = scene.bounds
        this.hasMissingChars = scene.hasMissingChars

        for (const layer of scene.layers) {
            this.layers.set(layer.name, new Layer(layer.name, layer.displayName, layer.color))
        }
        this.defaultLayer = this.layers.get("0") ?? new Layer("0", "0", 0)

        /* Load all blocks on the first pass. */
        for (const batch of scene.batches) {
            if (batch.key.blockName !== null &&
                batch.key.geometryType !== BatchingKey.GeometryType.BLOCK_INSTANCE &&
                batch.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE) {

                let block = this.blocks.get(batch.key.blockName)
                if (!block) {
                    block = new Block()
                    this.blocks.set(batch.key.blockName, block)
                }
                block.PushBatch(new Batch(this, scene, batch))
            }
        }

        console.log(`DXF scene:
                     ${scene.batches.length} batches,
                     ${this.layers.size} layers,
                     ${this.blocks.size} blocks,
                     vertices ${scene.vertices.byteLength} B,
                     indices ${scene.indices.byteLength} B
                     transforms ${scene.transforms.byteLength} B`)

        /* Instantiate all entities. Filled-area batches (solid HATCH/SOLID
         * triangles) are loaded FIRST so they are inserted into the scene --
         * and therefore painted -- before linework and text. The renderer runs
         * with sortObjects:false, so draw order is insertion order; without
         * this an opaque solid fill batched after the linework would paint over
         * it and hide grids, arcs, dimensions, and labels sitting on top of a
         * filled region. (renderOrder is also set on each object as a
         * belt-and-suspenders measure for the sortObjects:true case.) */
        const isFillBatch = (batch) =>
            batch.key.geometryType === BatchingKey.GeometryType.TRIANGLES ||
            batch.key.geometryType === BatchingKey.GeometryType.INDEXED_TRIANGLES
        for (const batch of scene.batches) {
            if (isFillBatch(batch)) {
                this._LoadBatch(scene, batch)
            }
        }
        for (const batch of scene.batches) {
            if (!isFillBatch(batch)) {
                this._LoadBatch(scene, batch)
            }
        }

        // TeamSync fork: build the spatial vertex index for snap. Cheap
        // for sub-cap drawings; gets downsampled for huge ones.
        try {
            this.vertexIndex = new VertexIndex(scene, {
                maxVertices: this.options.snapMaxVertices,
            })
        } catch (e) {
            this._Message("Failed to build vertex index for snap: " + e, MessageLevel.WARN)
            this.vertexIndex = null
        }

        this._Emit("loaded")

        /* Initial fit uses the density-based extent (ignores far-flung outliers
         * like scattered xref blocks that would otherwise shrink the real
         * drawing to a speck). The true `bounds` still back the Fit button +
         * zoom-to-extents so nothing becomes unreachable. */
        const fit = scene.fitBounds ?? scene.bounds
        if (fit) {
            this.FitView(fit.minX - scene.origin.x, fit.maxX - scene.origin.x,
                         fit.minY - scene.origin.y, fit.maxY - scene.origin.y)
        } else {
            this._Message("Empty document", MessageLevel.WARN)
        }

        if (this.hasMissingChars) {
            this._Message("Some characters cannot be properly displayed due to missing fonts",
                          MessageLevel.WARN)
        }

        this._CreateControls()
        this.Render()
    }

    Render() {
        this._EnsureRenderer()
        this.renderer.render(this.scene, this.camera)
        // TeamSync fork: composite the overlay scene on top without
        // clearing the framebuffer. Overlay materials are configured
        // with depthTest=false so they sit visually above DXF lines.
        if (this.overlays.size > 0) {
            this.renderer.autoClear = false
            this.renderer.clearDepth()
            this.renderer.render(this.overlayScene, this.camera)
            this.renderer.autoClear = true
        }
    }

    /** @return {Iterable<{name:String, color:number}>} List of layer names. */
    GetLayers(nonEmptyOnly = false) {
        const result = []
        for (const lyr of this.layers.values()) {
            if (nonEmptyOnly && lyr.objects.length == 0) {
                continue
            }
            result.push({
                name: lyr.name,
                displayName: lyr.displayName,
                color: this._TransformColor(lyr.color)
            })
        }
        return result
    }

    ShowLayer(name, show) {
        this._EnsureRenderer()
        const layer = this.layers.get(name)
        if (!layer) {
            return
        }
        for (const obj of layer.objects) {
            obj.visible = show
        }
        this.Render()
    }

    /** Reset the viewer state. */
    Clear() {
        this._EnsureRenderer()
        if (this.worker) {
            this.worker.Destroy(true)
            this.worker = null
        }
        if (this.controls) {
            this.controls.dispose()
            this.controls = null
        }
        this.scene.clear()
        for (const layer of this.layers.values()) {
            layer.Dispose()
        }
        this.layers.clear()
        this.blocks.clear()
        this.materials.each(e => e.material.dispose())
        this.materials.clear()
        // TeamSync fork: tear down overlay state on Clear() too, otherwise
        // pins from the previous drawing would survive a Load() of a new
        // one.
        this.overlayScene.clear()
        this.overlays.clear()
        this._layerColorOverrides.clear()
        this.vertexIndex = null
        /* Reset the initial-fit re-application state for the next Load so the
         * first resize after the new drawing re-applies its fit (see SetSize). */
        this._lastFitExtent = null
        this._didInitialResize = false
        this.SetView({x: 0, y: 0}, 2)
        this._Emit("cleared")
        this.Render()
    }

    /** Free all resources. The viewer object should not be used after this method was called. */
    Destroy() {
        if (!this.HasRenderer()) {
            return
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect()
        }
        this.Clear()
        this._Emit("destroyed")
        for (const m of this.simplePointMaterial) {
            m.dispose()
        }
        for (const m of this.simpleColorMaterial) {
            m.dispose()
        }
        this.simplePointMaterial = null
        this.simpleColorMaterial = null
        if(this.ownsRenderer) {
            this.renderer.dispose()
        }
        this.renderer = null
    }

    SetView(center, width) {
        const aspect = this.canvasWidth / this.canvasHeight
        const height = width / aspect
        const cam = this.camera
        cam.left = -width / 2
        cam.right = width / 2
        cam.top = height / 2
        cam.bottom = -height / 2
        cam.zoom = 1
        cam.position.set(center.x, center.y, 1)
        cam.rotation.set(0, 0, 0)
        cam.updateMatrix()
        cam.updateProjectionMatrix()
        if (this.controls) {
            this.controls.target.set(cam.position.x, cam.position.y, 0)
            this.controls.update()
        }
        this._Emit("viewChanged")
    }

    /** Set view to fit the specified bounds. */
    FitView(minX, maxX, minY, maxY, padding = 0.1) {
        /* Remember the requested extent so we can re-apply it if the canvas was
         * not yet laid out when this ran (see SetSize: a resize after a fit that
         * happened at a stale/zero canvas size would otherwise scale the view
         * out by realWidth/staleWidth, blowing the drawing out to full extent). */
        this._lastFitExtent = {minX, maxX, minY, maxY, padding}
        const aspect = this.canvasWidth / this.canvasHeight
        let width = maxX - minX
        const height = maxY - minY
        const center = {x: minX + width / 2, y: minY + height / 2}
        if (height * aspect > width) {
            width = height * aspect
        }
        if (width <= Number.MIN_VALUE * 2) {
            width = 1
        }
        this.SetView(center, width * (1 + padding))
    }

    /** @return {Scene} three.js scene for the viewer. Can be used to add custom entities on the
     *      scene. Remember to apply scene origin available via GetOrigin() method.
     */
    GetScene() {
        return this.scene
    }

    /** @return {OrthographicCamera} three.js camera for the viewer. */
    GetCamera() {
        return this.camera
    }

    /** @return {Vector2} Scene origin in global drawing coordinates. */
    GetOrigin() {
        return this.origin
    }

    /**
     * @return {?{maxX: number, maxY: number, minX: number, minY: number}} Scene bounds in model
     *      space coordinates. Null if empty scene.
     */
    GetBounds() {
        return this.bounds
    }

    /** Subscribe to the specified event. The following events are defined:
     *  * "loaded" - new scene loaded.
     *  * "cleared" - current scene cleared.
     *  * "destroyed" - viewer instance destroyed.
     *  * "resized" - viewport size changed. Details: {width, height}
     *  * "pointerdown" - Details: {domEvent, position:{x,y}}, position is in scene coordinates.
     *  * "pointerup"
     *  * "viewChanged"
     *  * "message" - Some message from the viewer. {message: string, level: string}.
     *
     * @param eventName {string}
     * @param eventHandler {function} Accepts event object.
     */
    Subscribe(eventName, eventHandler) {
        this._EnsureRenderer()
        this.canvas.addEventListener(EVENT_NAME_PREFIX + eventName, eventHandler)
    }

    /** Unsubscribe from previously subscribed event. The arguments should match previous
     * Subscribe() call.
     *
     * @param eventName {string}
     * @param eventHandler {function}
     */
    Unsubscribe(eventName, eventHandler) {
        // TeamSync fork: Unsubscribe is by nature a teardown helper --
        // React effect cleanups call it after the viewer has been
        // Destroy()'d. Upstream's `_EnsureRenderer()` throws if the
        // renderer has been torn down, which crashes the cleanup and
        // bubbles up into the React error boundary ("WebGL renderer not
        // available. Probable WebGL context loss") even though it's
        // purely a teardown race. No-op gracefully when there's no
        // canvas left to remove from.
        if (!this.HasRenderer() || !this.canvas) return
        this.canvas.removeEventListener(EVENT_NAME_PREFIX + eventName, eventHandler)
    }

    // ========================================================================
    // TeamSync fork: review-toolkit API
    // ========================================================================

    /**
     * Find the nearest indexed vertex to a canvas-pixel coordinate.
     * Returns scene-space coords or null if nothing is within tolerance.
     *
     * @param {number} canvasX  Canvas-relative pixel X.
     * @param {number} canvasY  Canvas-relative pixel Y.
     * @param {number} [tolPx=8]  Snap radius in pixels.
     * @return {?{x:number, y:number}}
     */
    SnapToVertex(canvasX, canvasY, tolPx = 8) {
        if (!this.vertexIndex) return null
        const scenePoint = this._CanvasToSceneCoord(canvasX, canvasY)
        // Convert pixel tolerance to scene units using current camera.
        const halfWidth = (this.camera.right - this.camera.left) / 2 / this.camera.zoom
        const sceneTol = (tolPx / (this.canvasWidth / 2)) * halfWidth
        return this.vertexIndex.Nearest(scenePoint.x, scenePoint.y, sceneTol)
    }

    /**
     * Quick raycast against the loaded scene. Currently returns a coarse
     * result: scene point at the click + the snapped vertex (if any).
     * Entity-level picking would require a richer index from the worker.
     *
     * @param {number} canvasX
     * @param {number} canvasY
     * @return {{point:{x:number,y:number}, vertex:?{x:number,y:number}}}
     */
    Raycast(canvasX, canvasY) {
        const point = this._CanvasToSceneCoord(canvasX, canvasY)
        const vertex = this.SnapToVertex(canvasX, canvasY)
        return {point, vertex}
    }

    /**
     * Add a three.Object3D to the overlay scene. The object should be
     * positioned in WORLD coordinates -- the fork handles the origin
     * offset internally when rendering.
     *
     * @param {three.Object3D} object3D
     * @return {number} Overlay id. Pass back to RemoveOverlay() to drop.
     */
    AddOverlay(object3D) {
        this._EnsureRenderer()
        const id = this._nextOverlayId++
        // Translate the overlay so its world-space coords align with the
        // DXF scene's origin-shifted coordinate system. Callers think in
        // world coords; we subtract the scene origin once on insert.
        if (this.origin) {
            object3D.position.x -= this.origin.x
            object3D.position.y -= this.origin.y
        }
        object3D.userData.__teamsync_overlay_id = id
        this.overlays.set(id, object3D)
        this.overlayScene.add(object3D)
        this.Render()
        return id
    }

    /** Remove an overlay previously added via AddOverlay. No-op if id unknown. */
    RemoveOverlay(id) {
        const obj = this.overlays.get(id)
        if (!obj) return
        this.overlayScene.remove(obj)
        this.overlays.delete(id)
        // Best-effort geometry cleanup so we don't leak GPU buffers on a
        // long-lived viewer. Caller may also dispose materials themselves.
        if (obj.geometry && typeof obj.geometry.dispose === "function") {
            obj.geometry.dispose()
        }
        this.Render()
    }

    /** Remove every overlay. */
    ClearOverlays() {
        for (const id of Array.from(this.overlays.keys())) {
            this.RemoveOverlay(id)
        }
    }

    /**
     * Override the color of every object on a layer.
     * @param {string} name  Layer name as returned from GetLayers().
     * @param {?number|string} hex  Hex color (e.g. 0xff8800 or "#ff8800").
     *   Pass null to restore the layer's original color.
     */
    SetLayerColor(name, hex) {
        this._EnsureRenderer()
        const layer = this.layers.get(name)
        if (!layer) return
        if (hex == null) {
            this._RestoreLayerColors(name, layer)
        } else {
            this._OverrideLayerColors(name, layer, new three.Color(hex))
        }
        this.Render()
    }

    /** Restore every layer's original color. */
    ClearLayerColorOverrides() {
        for (const [name, layer] of this.layers) {
            if (this._layerColorOverrides.has(name)) {
                this._RestoreLayerColors(name, layer)
            }
        }
        this.Render()
    }

    /**
     * Convert a scene-space point to canvas-pixel coordinates relative
     * to the canvas's bounding rect. Mirrors what app overlays do by
     * hand and lets them stop reaching into camera internals.
     */
    SceneToCanvas(x, y) {
        const camera = this.camera
        const localX = x - this.origin.x - camera.position.x
        const localY = y - this.origin.y - camera.position.y
        const halfWidth = (camera.right - camera.left) / 2 / camera.zoom
        const halfHeight = (camera.top - camera.bottom) / 2 / camera.zoom
        const ndcX = localX / halfWidth
        const ndcY = localY / halfHeight
        return {
            x: (ndcX + 1) * 0.5 * this.canvasWidth,
            y: (1 - ndcY) * 0.5 * this.canvasHeight,
        }
    }

    /**
     * Convert canvas pixel coordinates to scene-space coordinates.
     * Public-API wrapper around the previously-private projection helper.
     */
    CanvasToScene(canvasX, canvasY) {
        return this._CanvasToSceneCoord(canvasX, canvasY)
    }

    /** @return {?VertexIndex} The internal snap index. May be null. */
    GetVertexIndex() {
        return this.vertexIndex
    }

    _OverrideLayerColors(name, layer, threeColor) {
        let saved = this._layerColorOverrides.get(name)
        if (!saved) {
            saved = new Map()
            this._layerColorOverrides.set(name, saved)
        }
        for (const obj of layer.objects ?? []) {
            const material = obj.material
            if (!material) continue
            // Capture the original color exactly once so a re-override
            // doesn't lose the true original.
            if (!saved.has(obj.uuid)) {
                if (material.uniforms?.color?.value) {
                    saved.set(obj.uuid, material.uniforms.color.value.clone())
                } else if (material.color) {
                    saved.set(obj.uuid, material.color.clone())
                } else {
                    saved.set(obj.uuid, null)
                }
            }
            if (material.uniforms?.color?.value) {
                material.uniforms.color.value.copy(threeColor)
                material.uniformsNeedUpdate = true
            } else if (material.color) {
                material.color.copy(threeColor)
            }
        }
    }

    _RestoreLayerColors(name, layer) {
        const saved = this._layerColorOverrides.get(name)
        if (!saved) return
        for (const obj of layer.objects ?? []) {
            const orig = saved.get(obj.uuid)
            if (!orig) continue
            const material = obj.material
            if (!material) continue
            if (material.uniforms?.color?.value) {
                material.uniforms.color.value.copy(orig)
                material.uniformsNeedUpdate = true
            } else if (material.color) {
                material.color.copy(orig)
            }
        }
        this._layerColorOverrides.delete(name)
    }

    // /////////////////////////////////////////////////////////////////////////////////////////////

    _EnsureRenderer() {
        if (!this.HasRenderer()) {
            throw new Error("WebGL renderer not available. " +
                            "Probable WebGL context loss, try refreshing the page.")
        }
    }

    _CreateControls() {
        if (this.controls) {
            this.controls.dispose()
        }
        const controls = this.controls = new OrbitControls(this.camera, this.canvas)
        controls.enableRotate = false
        controls.mouseButtons = {
            LEFT: three.MOUSE.PAN,
            MIDDLE: three.MOUSE.DOLLY
        }
        controls.touches = {
            ONE: three.TOUCH.PAN,
            TWO: three.TOUCH.DOLLY_PAN
        }
        controls.zoomSpeed = 3
        controls.mouseZoomSpeedFactor = 0.05
        controls.target = new three.Vector3(this.camera.position.x, this.camera.position.y, 0)
        controls.addEventListener("change", () => {
            this.Render()
            this._Emit("viewChanged")
        })
        controls.update()
    }

    _Emit(eventName, data = null) {
        this.canvas.dispatchEvent(new CustomEvent(EVENT_NAME_PREFIX + eventName, { detail: data }))
    }

    _Message(message, level = MessageLevel.INFO) {
        this._Emit("message", {message, level})
    }

    _OnPointerEvent(e) {
        const canvasRect = e.target.getBoundingClientRect()
        const canvasCoord = {x: e.clientX - canvasRect.left, y: e.clientY - canvasRect.top}
        this._Emit(e.type, {
            domEvent: e,
            canvasCoord,
            position: this._CanvasToSceneCoord(canvasCoord.x, canvasCoord.y)
        })
    }

    /** @return {{x,y}} Scene coordinate corresponding to the specified canvas pixel coordinates. */
    _CanvasToSceneCoord(x, y) {
        const v = new three.Vector3(x * 2 / this.canvasWidth - 1,
                                    -y * 2 / this.canvasHeight + 1,
                                    1).unproject(this.camera)
        return {x: v.x, y: v.y}
    }

    _OnResize(entry) {
        this.SetSize(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height))
    }

    _LoadBatch(scene, batch) {
        if (batch.key.blockName !== null &&
            batch.key.geometryType !== BatchingKey.GeometryType.BLOCK_INSTANCE &&
            batch.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE) {
            /* Block definition. */
            return
        }
        const objects = new Batch(this, scene, batch).CreateObjects()

        for (const obj of objects) {
            this.scene.add(obj)
            const layer = obj._dxfViewerLayer ?? this.defaultLayer
            layer.PushObject(obj)
        }
    }

    _GetSimpleColorMaterial(color, instanceType = InstanceType.NONE) {
        const key = new MaterialKey(instanceType, null, color, 0)
        let entry = this.materials.find({key})
        if (entry !== null) {
            return entry.material
        }
        entry = {
            key,
            material: this._CreateSimpleColorMaterialInstance(color, instanceType)
        }
        this.materials.insert(entry)
        return entry.material
    }

    _CreateSimpleColorMaterial(instanceType = InstanceType.NONE) {
        const shaders = this._GenerateShaders(instanceType, false)
        return new three.RawShaderMaterial({
            uniforms: {
                color: {
                    value: new three.Color(0xff00ff)
                }
            },
            vertexShader: shaders.vertex,
            fragmentShader: shaders.fragment,
            depthTest: false,
            depthWrite: false,
            glslVersion: three.GLSL3,
            side: three.DoubleSide
        })
    }

    /** @param color {number} Color RGB numeric value.
     * @param instanceType {number}
     */
    _CreateSimpleColorMaterialInstance(color, instanceType = InstanceType.NONE) {
        const src = this.simpleColorMaterial[instanceType]
        /* Should reuse compiled shaders. */
        const m = src.clone()
        m.uniforms.color = { value: new three.Color(color) }
        return m
    }

    _GetSimplePointMaterial(color, instanceType = InstanceType.NONE) {
        const key = new MaterialKey(instanceType, BatchingKey.GeometryType.POINTS, color, 0)
        let entry = this.materials.find({key})
        if (entry !== null) {
            return entry.material
        }
        entry = {
            key,
            material: this._CreateSimplePointMaterialInstance(color, this.options.pointSize,
                                                              instanceType)
        }
        this.materials.insert(entry)
        return entry.material
    }

    _CreateSimplePointMaterial(instanceType = InstanceType.NONE) {
        const shaders = this._GenerateShaders(instanceType, true)
        return new three.RawShaderMaterial({
            uniforms: {
                color: {
                    value: new three.Color(0xff00ff)
                },
                pointSize: {
                    value: 2
                }
            },
            vertexShader: shaders.vertex,
            fragmentShader: shaders.fragment,
            depthTest: false,
            depthWrite: false,
            glslVersion: three.GLSL3
        })
    }

    /** @param color {number} Color RGB numeric value.
     * @param size {number} Rasterized point size in pixels.
     * @param instanceType {number}
     */
    _CreateSimplePointMaterialInstance(color, size = 2, instanceType = InstanceType.NONE) {
        const src = this.simplePointMaterial[instanceType]
        /* Should reuse compiled shaders. */
        const m = src.clone()
        m.uniforms.color = { value: new three.Color(color) }
        m.uniforms.size = { value: size }
        return m
    }

    _GenerateShaders(instanceType, pointSize) {
        const fullInstanceAttr = instanceType === InstanceType.FULL ?
            `
            /* First row. */
            in vec3 instanceTransform0;
            /* Second row. */
            in vec3 instanceTransform1;
            ` : ""
        const fullInstanceTransform = instanceType === InstanceType.FULL ?
            `
            pos.xy = mat2(instanceTransform0[0], instanceTransform1[0],
                          instanceTransform0[1], instanceTransform1[1]) * pos.xy +
                     vec2(instanceTransform0[2], instanceTransform1[2]);
            ` : ""

        const pointInstanceAttr = instanceType === InstanceType.POINT ?
            `
            in vec2 instanceTransform;
            ` : ""
        const pointInstanceTransform = instanceType === InstanceType.POINT ?
            `
            pos.xy += instanceTransform;
            ` : ""

        const pointSizeUniform = pointSize ? "uniform float pointSize;" : ""
        const pointSizeAssigment = pointSize ? "gl_PointSize = pointSize;" : ""

        return {
            vertex: `

            precision highp float;
            precision highp int;
            in vec2 position;
            ${fullInstanceAttr}
            ${pointInstanceAttr}
            uniform mat4 modelViewMatrix;
            uniform mat4 projectionMatrix;
            ${pointSizeUniform}

            void main() {
                vec4 pos = vec4(position, 0.0, 1.0);
                ${fullInstanceTransform}
                ${pointInstanceTransform}
                gl_Position = projectionMatrix * modelViewMatrix * pos;
                ${pointSizeAssigment}
            }
            `,
            fragment: `

            precision highp float;
            precision highp int;
            uniform vec3 color;
            out vec4 fragColor;

            void main() {
                fragColor = vec4(color, 1.0);
            }
            `
        }
    }

    /** Ensure the color is contrast enough with current background color.
     * @param color {number} RGB value.
     * @return {number} RGB value to use for rendering.
     */
    _TransformColor(color) {
        if (!this.options.colorCorrection && !this.options.blackWhiteInversion) {
            return color
        }
        /* Just black and white inversion. */
        const bkgLum = Luminance(this.clearColor)
        if (color === 0xffffff && bkgLum >= 0.8) {
            return 0
        }
        if (color === 0 && bkgLum <= 0.2) {
            return 0xffffff
        }
        if (!this.options.colorCorrection) {
            return color
        }
        const fgLum = Luminance(color)
        const MIN_TARGET_RATIO = 1.5
        const contrast = ContrastRatio(color, this.clearColor)
        const diff = contrast >= 1 ? contrast : 1 / contrast
        if (diff < MIN_TARGET_RATIO) {
            let targetLum
            if (bkgLum > 0.5) {
                targetLum = bkgLum / 2
            } else {
                targetLum = bkgLum * 2
            }
            if (targetLum > fgLum) {
                color = Lighten(color, targetLum / fgLum)
            } else {
                color = Darken(color, fgLum / targetLum)
            }
        }
        return color
    }
}

DxfViewer.MessageLevel = MessageLevel

DxfViewer.DefaultOptions = {
    canvasWidth: 400,
    canvasHeight: 300,
    /** Automatically resize canvas when the container is resized. This options utilizes
     *  ResizeObserver API which is still not fully standardized. The specified canvas size is
     *  ignored if the option is enabled.
     */
    autoResize: false,
    /** Frame buffer clear color. */
    clearColor: new three.Color("#000"),
    /** Frame buffer clear color alpha value. */
    clearAlpha: 1.0,
    /** Use alpha channel in a framebuffer. */
    canvasAlpha: false,
    /** Assume premultiplied alpha in a framebuffer. */
    canvasPremultipliedAlpha: true,
    /** Use antialiasing. May degrade performance on poor hardware. */
    antialias: true,
    /** Correct entities colors to ensure that they are always visible with the current background
     * color.
     */
    colorCorrection: false,
    /** Simpler version of colorCorrection - just invert pure white or black entities if they are
     * invisible on current background color.
     */
    blackWhiteInversion: true,
    /** Size in pixels for rasterized points (dot mark). */
    pointSize: 2,
    /** Scene generation options. */
    sceneOptions: DxfScene.DefaultOptions,
    /** Retain the simple object representing the parsed DXF - will consume a lot of additional
     * memory.
     */
    retainParsedDxf: false,
    /** Whether to preserve the buffers until manually cleared or overwritten.
     *  Required `true` to support PNG export from the canvas (otherwise
     *  WebGL clears the framebuffer after each present).
     */
    preserveDrawingBuffer: false,
    /** TeamSync fork: cap the spatial vertex index used by SnapToVertex().
     *  Vertices above this count are downsampled to bound memory at the
     *  cost of approximate snap fidelity.
     */
    snapMaxVertices: 500_000,
    /** Encoding to use for decoding DXF file text content. DXF files newer than DXF R2004 (AC1018)
     * use UTF-8 encoding. Older files use some code page which is specified in $DWGCODEPAGE header
     * variable. Currently parser is implemented in such a way that encoding must be specified
     * before the content is parsed so there is no chance to use this variable dynamically. This may
     * be a subject for future changes. The specified value should be suitable for passing as
     * `TextDecoder` constructor `label` parameter.
     */
    fileEncoding: "utf-8",
    /**
     * @type {three.WebGLRenderer | undefined | null} 
     * The Webgl renderer to use. If not specified, a new renderer will be created.
     */
    renderer: undefined
}

DxfViewer.SetupWorker = function () {
    new DxfWorker(self, true)
}

const InstanceType = Object.freeze({
    /** Not instanced. */
    NONE: 0,
    /** Full affine transform per instance. */
    FULL: 1,
    /** Point instances, 2D-translation vector per instance. */
    POINT: 2,

    /** Number of types. */
    MAX: 3
})

class Batch {
    /**
     * @param {DxfViewer} viewer
     * @param scene Serialized scene.
     * @param batch Serialized scene batch.
     */
    constructor(viewer, scene, batch) {
        this.viewer = viewer
        this.key = batch.key

        if (batch.hasOwnProperty("verticesOffset")) {
            const verticesArray =
                new Float32Array(scene.vertices,
                                 batch.verticesOffset * Float32Array.BYTES_PER_ELEMENT,
                                 batch.verticesSize)
            if (this.key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE ||
                scene.pointShapeHasDot) {
                this.vertices = new three.BufferAttribute(verticesArray, 2)
            }
            if (this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE) {
                this.transforms = new three.InstancedBufferAttribute(verticesArray, 2)
            }
        }

        if (batch.hasOwnProperty("chunks")) {
            this.chunks = []
            for (const rawChunk of batch.chunks) {

                const verticesArray =
                    new Float32Array(scene.vertices,
                                     rawChunk.verticesOffset * Float32Array.BYTES_PER_ELEMENT,
                                     rawChunk.verticesSize)
                const indicesArray =
                    new Uint16Array(scene.indices,
                                    rawChunk.indicesOffset * Uint16Array.BYTES_PER_ELEMENT,
                                    rawChunk.indicesSize)
                this.chunks.push({
                    vertices: new three.BufferAttribute(verticesArray, 2),
                    indices: new three.BufferAttribute(indicesArray, 1)
                })
            }
        }

        if (batch.hasOwnProperty("transformsOffset")) {
            const transformsArray =
                new Float32Array(scene.transforms,
                                 batch.transformsOffset * Float32Array.BYTES_PER_ELEMENT,
                                 batch.transformsSize)
            /* Each transform is 3x2 matrix which is split into two 3D vectors which will occupy two
             * attribute slots.
             */
            const buf = new three.InstancedInterleavedBuffer(transformsArray, 6)
            this.transforms0 = new three.InterleavedBufferAttribute(buf, 3, 0)
            this.transforms1 = new three.InterleavedBufferAttribute(buf, 3, 3)
        }

        this.layer = this.key.layerName !== null ? this.viewer.layers.get(this.key.layerName) : null
    }

    GetInstanceType() {
        switch (this.key.geometryType) {
        case BatchingKey.GeometryType.BLOCK_INSTANCE:
            return InstanceType.FULL
        case BatchingKey.GeometryType.POINT_INSTANCE:
            return InstanceType.POINT
        default:
            return InstanceType.NONE
        }
    }

    /** Create scene objects corresponding to batch data.
     * @param {?Batch} instanceBatch Batch with instance transform. Null for non-instanced object.
     */
    *CreateObjects(instanceBatch = null) {
        if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE ||
            this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE) {

            if (instanceBatch !== null) {
                throw new Error("Unexpected instance batch specified for instance batch")
            }
            yield* this._CreateBlockInstanceObjects()
            return
        }
        yield* this._CreateObjects(instanceBatch)
    }

    *_CreateObjects(instanceBatch) {
        const color = instanceBatch ?
            instanceBatch._GetInstanceColor(this) : this.key.color

        /* INSERT layer (if specified) takes precedence over layer specified in block definition. */
        const layer = instanceBatch?.layer ?? this.layer

        //XXX line type
        const materialFactory =
            this.key.geometryType === BatchingKey.GeometryType.POINTS ||
            this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE ?
                this.viewer._GetSimplePointMaterial : this.viewer._GetSimpleColorMaterial

        const material = materialFactory.call(this.viewer, this.viewer._TransformColor(color),
                                              instanceBatch?.GetInstanceType() ?? InstanceType.NONE)

        let objConstructor
        switch (this.key.geometryType) {
        case BatchingKey.GeometryType.POINTS:
        /* This method also called for creating dots for shaped point instances. */
        case BatchingKey.GeometryType.POINT_INSTANCE:
            objConstructor = three.Points
            break
        case BatchingKey.GeometryType.LINES:
        case BatchingKey.GeometryType.INDEXED_LINES:
            objConstructor = three.LineSegments
            break
        case BatchingKey.GeometryType.TRIANGLES:
        case BatchingKey.GeometryType.INDEXED_TRIANGLES:
            objConstructor = three.Mesh
            break
        default:
            throw new Error("Unexpected geometry type:" + this.key.geometryType)
        }

        /* Filled triangles (solid HATCH/SOLID) render behind everything else
         * so they don't occlude linework/text. See the renderOrder comment in
         * CreateObject below. */
        const isFill =
            this.key.geometryType === BatchingKey.GeometryType.TRIANGLES ||
            this.key.geometryType === BatchingKey.GeometryType.INDEXED_TRIANGLES
        const geomRenderOrder = isFill ? 0 : 1

        function CreateObject(vertices, indices) {
            const geometry = instanceBatch ?
                new three.InstancedBufferGeometry() : new three.BufferGeometry()
            geometry.setAttribute("position", vertices)
            instanceBatch?._SetInstanceTransformAttribute(geometry)
            if (indices) {
                geometry.setIndex(indices)
            }
            const obj = new objConstructor(geometry, material)
            obj.frustumCulled = false
            obj.matrixAutoUpdate = false
            obj._dxfViewerLayer = layer
            /* Draw filled areas (solid HATCH/SOLID triangles) BEHIND line and
             * text geometry so fills don't occlude grids, arcs, dimensions, and
             * labels -- matching how desktop CAD viewers composite fills under
             * linework. The actual ordering is enforced by insertion order in
             * Load() (fills added first) because the renderer runs with
             * sortObjects:false, which skips three.js's renderOrder sort. This
             * renderOrder is set as a belt-and-suspenders measure so the
             * ordering still holds if sortObjects is ever enabled. */
            obj.renderOrder = geomRenderOrder
            return obj
        }

        if (this.chunks) {
            for (const chunk of this.chunks) {
                yield CreateObject(chunk.vertices, chunk.indices)
            }
        } else {
            yield CreateObject(this.vertices)
        }
    }

    /**
     * @param {InstancedBufferGeometry} geometry
     */
    _SetInstanceTransformAttribute(geometry) {
        if (!geometry.isInstancedBufferGeometry) {
            throw new Error("InstancedBufferGeometry expected")
        }
        if (this.key.geometryType === BatchingKey.GeometryType.POINT_INSTANCE) {
            geometry.setAttribute("instanceTransform", this.transforms)
        } else {
            geometry.setAttribute("instanceTransform0", this.transforms0)
            geometry.setAttribute("instanceTransform1", this.transforms1)
        }
    }

    *_CreateBlockInstanceObjects() {
        const block = this.viewer.blocks.get(this.key.blockName)
        if (!block) {
            return
        }
        for (const batch of block.batches) {
            yield* batch.CreateObjects(this)
        }
        if (this.vertices) {
            /* Dots for point shapes. */
            yield* this._CreateObjects()
        }
    }

    /**
     * @param {Batch} blockBatch Block definition batch.
     * @return {number} RGB color value for a block instance.
     */
    _GetInstanceColor(blockBatch) {
        const defColor = blockBatch.key.color
        if (defColor === ColorCode.BY_BLOCK) {
            return this.key.color
        } else if (defColor === ColorCode.BY_LAYER) {
            if (blockBatch.layer) {
                return blockBatch.layer.color
            }
            return this.layer ? this.layer.color : 0
        }
        return defColor
    }
}

class Layer {
    constructor(name, displayName, color) {
        this.name = name
        this.displayName = displayName
        this.color = color
        this.objects = []
    }

    PushObject(obj) {
        this.objects.push(obj)
    }

    Dispose() {
        for (const obj of this.objects) {
            obj.geometry.dispose()
        }
        this.objects = null
    }
}

class Block {
    constructor() {
        this.batches = []
    }

    /** @param batch {Batch} */
    PushBatch(batch) {
        this.batches.push(batch)
    }
}

/** Custom viewer event names are prefixed with this string. */
const EVENT_NAME_PREFIX = "__dxf_"

/** Transform sRGB color component to linear color space. */
function LinearColor(c) {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Transform linear color component to sRGB color space. */
function SRgbColor(c) {
    return c < 0.003 ? c * 12.92 : Math.pow(c, 1 / 2.4) * 1.055 - 0.055
}

/** Get relative luminance value for a color.
 * https://www.w3.org/TR/2008/REC-WCAG20-20081211/#relativeluminancedef
 * @param color {number} RGB color value.
 * @return {number} Luminance value in range [0; 1].
 */
function Luminance(color) {
    const r = LinearColor(((color & 0xff0000) >>> 16) / 255)
    const g = LinearColor(((color & 0xff00) >>> 8) / 255)
    const b = LinearColor((color & 0xff) / 255)

    return r * 0.2126 + g * 0.7152 + b * 0.0722
}

/**
 * Get contrast ratio for a color pair.
 * https://www.w3.org/TR/2008/REC-WCAG20-20081211/#contrast-ratiodef
 * @param c1
 * @param c2
 * @return {number} Contrast ratio between the colors. Greater than one if the first color color is
 *  brighter than the second one.
 */
function ContrastRatio(c1, c2) {
    return (Luminance(c1) + 0.05) / (Luminance(c2) + 0.05)
}

function HlsToRgb({h, l, s}) {
    let r, g, b
    if (s === 0) {
        /* Achromatic */
        r = g = b = l
    } else {
        function hue2rgb(p, q, t) {
            if (t < 0) {
                t += 1
            }
            if (t > 1) {
                t -= 1
            }
            if (t < 1/6) {
                return p + (q - p) * 6 * t
            }
            if (t < 1/2) {
                return q
            }
            if (t < 2/3) {
                return p + (q - p) * (2/3 - t) * 6
            }
            return p
        }

        const q = l < 0.5 ? l * (1 + s) : l + s - l * s
        const p = 2 * l - q
        r = hue2rgb(p, q, h + 1/3)
        g = hue2rgb(p, q, h)
        b = hue2rgb(p, q, h - 1/3)
    }

    return (Math.min(Math.floor(SRgbColor(r) * 256), 255) << 16) |
           (Math.min(Math.floor(SRgbColor(g) * 256), 255) << 8) |
            Math.min(Math.floor(SRgbColor(b) * 256), 255)
}

function RgbToHls(color) {
    const r = LinearColor(((color & 0xff0000) >>> 16) / 255)
    const g = LinearColor(((color & 0xff00) >>> 8) / 255)
    const b = LinearColor((color & 0xff) / 255)

    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    let h, s
    const l = (max + min) / 2

    if (max === min) {
        /* Achromatic */
        h = s = 0
    } else {
        const d = max - min
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
        switch (max) {
        case r:
            h = (g - b) / d + (g < b ? 6 : 0)
            break;
        case g:
            h = (b - r) / d + 2
            break
        case b:
            h = (r - g) / d + 4
            break
        }
        h /= 6
    }

    return {h, l, s}
}

function Lighten(color, factor) {
    const hls = RgbToHls(color)
    hls.l *= factor
    if (hls.l > 1) {
        hls.l = 1
    }
    return HlsToRgb(hls)
}

function Darken(color, factor) {
    const hls = RgbToHls(color)
    hls.l /= factor
    return HlsToRgb(hls)
}

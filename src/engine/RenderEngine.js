import * as THREE from 'three';
import {
  VERTEX_SHADER,
  buildFragmentShader,
  DEFAULT_DECK_BODIES,
  SCENE_FRAGMENT,
  COMPOSITE_FRAGMENT,
  PREVIEW_FRAGMENT,
  SPRITE_VERTEX,
  SPRITE_FRAGMENT,
} from './shaders';

// channel automation (sprites AND models): per effect {amt: 0..1, audio: bool}
// — audio couples the effect to the deck's routed level, otherwise it
// self-runs on time LFOs
const makeDefaultAut = () =>
  Object.fromEntries(['scl', 'rot', 'flk', 'dst', 'skw'].map((k) => [k, { amt: 0, audio: false }]));

export const CHANNELS = 4; // channels per scene
export const SCENES = 2; // A (decks 0-3) and B (decks 4-7)

const BASE_DECK_WIDTH = 960;
const BASE_PREVIEW_WIDTH = 160;
const FALLBACK_ASPECT = 16 / 9;
// frames the scene-view aspect must hold steady before deck targets are
// reallocated — avoids thrashing GPU memory during a window-resize drag
const ASPECT_SETTLE_FRAMES = 12;

function validateFragmentSource(gl, source) {
  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  const log = ok ? null : gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
  gl.deleteShader(shader);
  return log;
}

export class RenderEngine {
  /**
   * @param {{a: HTMLCanvasElement, b: HTMLCanvasElement}} viewCanvases
   *   2D canvases the scene composites are blitted onto. The crossfaded
   *   master is attached separately via setMasterCanvas (it lives in its own
   *   pop-out window).
   * @param {HTMLCanvasElement[]} previewCanvases 4 deck thumbnails (cued scene)
   * @param {AudioEngine} audioEngine
   */
  constructor(viewCanvases, previewCanvases, audioEngine) {
    this.audioEngine = audioEngine;
    // The GL canvas is never shown: one context renders every composite pass
    // and the result is blitted to the on-screen 2D view canvases (a WebGL
    // context can only present to a single canvas).
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setClearColor(0x000000, 1);

    this.views = { master: { canvas: null, ctx: null } };
    Object.entries(viewCanvases).forEach(([key, canvas]) => {
      this.views[key] = {
        canvas: canvas || null,
        ctx: canvas ? canvas.getContext('2d') : null,
      };
    });

    // Captures three.js-level shader failures during the staging render so a
    // bad LLM shader is rejected instead of crashing the visuals.
    this.shaderError = null;
    this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const log =
        gl.getShaderInfoLog(fragmentShader) ||
        gl.getProgramInfoLog(program) ||
        'Unknown shader error';
      this.shaderError = log.trim();
      console.error('[Vizzy] Shader error:', this.shaderError);
    };

    this.clock = new THREE.Clock();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadGeometry = new THREE.PlaneGeometry(2, 2);

    // time/resolution are shared by reference across every deck material;
    // audio uniforms are PER DECK so each channel can route its own band and
    // response amount.
    this.sharedUniforms = {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2(1, 1) },
    };
    this.deckAudioUniforms = DEFAULT_DECK_BODIES.map(() => ({
      u_audio_low: { value: 0 },
      u_audio_mid: { value: 0 },
      u_audio_high: { value: 0 },
      u_audio_level: { value: 0 },
    }));
    // band: which global band feeds this deck's u_audio_level; amt: response
    // multiplier (applied to all four uniforms, clamped to the 0..1 contract)
    this.audioRouting = DEFAULT_DECK_BODIES.map(() => ({ band: 'level', amt: 1 }));

    const viewA = this.views.a?.canvas;
    const initialAspect =
      viewA && viewA.clientWidth > 0 && viewA.clientHeight > 0
        ? viewA.clientWidth / viewA.clientHeight
        : FALLBACK_ASPECT;
    this.appliedAspect = 0;
    this.pendingAspect = null;
    this.aspectStableFrames = 0;
    this.deckWidth = BASE_DECK_WIDTH;
    this.deckHeight = Math.round(BASE_DECK_WIDTH / initialAspect);
    this.previewWidth = BASE_PREVIEW_WIDTH;
    this.previewHeight = Math.round(BASE_PREVIEW_WIDTH / initialAspect);

    const targetOptions = { depthBuffer: false, stencilBuffer: false };
    // deck targets keep a depth buffer so model decks can render real 3D
    const deckTargetOptions = { depthBuffer: true, stencilBuffer: false };

    // 8 shader slots: indices 0-3 are scene A, 4-7 are scene B. A deck is in
    // 'shader' mode (fullscreen quad) or 'model' mode (lit 3D scene); both
    // render into the same target so the composite pipeline is identical.
    this.decks = DEFAULT_DECK_BODIES.map((body, i) => {
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(this.quadGeometry, this.buildDeckMaterial(body, i));
      mesh.frustumCulled = false;
      scene.add(mesh);

      const target = new THREE.WebGLRenderTarget(
        this.deckWidth,
        this.deckHeight,
        deckTargetOptions,
      );
      // mirrored repeat so zooming out (scale < 1) tiles instead of streaking
      target.texture.wrapS = THREE.MirroredRepeatWrapping;
      target.texture.wrapT = THREE.MirroredRepeatWrapping;

      return { scene, mesh, body, target, mode: 'shader', model: null, sprite: null };
    });

    this.spriteGeometry = new THREE.PlaneGeometry(1, 1);
    this.automation = DEFAULT_DECK_BODIES.map(() => makeDefaultAut());

    this.modelCamera = new THREE.PerspectiveCamera(
      45,
      this.deckWidth / this.deckHeight,
      0.1,
      100,
    );
    this.modelCamera.position.set(0, 0, 4);
    this.modelCamera.lookAt(0, 0, 0);

    // Per-slot uniform objects, shared by reference between the scene
    // composites and the master composite — one write reaches all of them.
    this.slotUniforms = this.decks.map((deck, i) => ({
      deck: { value: deck.target.texture },
      mix: { value: i % CHANNELS === 0 ? 1 : 0 },
      scale: { value: 1 },
      size: { value: new THREE.Vector2(1, 1) },
      // x = tilt (rad), y = contrast, z = hue (rad), w = saturation
      fx: { value: new THREE.Vector4(0, 1, 0, 1) },
    }));
    this.xfadeUniform = { value: 0 };
    this.aspectUniform = { value: this.deckWidth / this.deckHeight };

    const sceneUniformSet = (sceneIndex) => {
      const uniforms = { u_aspect: this.aspectUniform };
      for (let ch = 0; ch < CHANNELS; ch += 1) {
        const slot = this.slotUniforms[sceneIndex * CHANNELS + ch];
        uniforms[`u_deck${ch + 1}`] = slot.deck;
        uniforms[`u_mix${ch + 1}`] = slot.mix;
        uniforms[`u_scale${ch + 1}`] = slot.scale;
        uniforms[`u_size${ch + 1}`] = slot.size;
        uniforms[`u_fx${ch + 1}`] = slot.fx;
      }
      return uniforms;
    };
    const masterUniforms = { u_xfade: this.xfadeUniform, u_aspect: this.aspectUniform };
    this.slotUniforms.forEach((slot, i) => {
      masterUniforms[`u_deck${i + 1}`] = slot.deck;
      masterUniforms[`u_mix${i + 1}`] = slot.mix;
      masterUniforms[`u_scale${i + 1}`] = slot.scale;
      masterUniforms[`u_size${i + 1}`] = slot.size;
      masterUniforms[`u_fx${i + 1}`] = slot.fx;
    });

    const makeCompositeScene = (uniforms, fragmentShader) => {
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(
        this.quadGeometry,
        new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX_SHADER, fragmentShader }),
      );
      mesh.frustumCulled = false;
      scene.add(mesh);
      return scene;
    };
    this.sceneComposites = [
      makeCompositeScene(sceneUniformSet(0), SCENE_FRAGMENT),
      makeCompositeScene(sceneUniformSet(1), SCENE_FRAGMENT),
    ];
    this.masterComposite = makeCompositeScene(masterUniforms, COMPOSITE_FRAGMENT);

    // preview transform pass: one material, retargeted per deck each use
    this.previewUniforms = {
      u_tex: { value: null },
      u_scale: { value: 1 },
      u_size: { value: new THREE.Vector2(1, 1) },
      u_fx: { value: new THREE.Vector4(0, 1, 0, 1) },
      u_aspect: this.aspectUniform,
    };
    this.previewScene = makeCompositeScene(this.previewUniforms, PREVIEW_FRAGMENT);

    // The 4 on-screen preview canvases show the *cued* scene's channels; one
    // shared scratch target + buffer serves all of them (and staging compiles).
    this.cueScene = 0;
    this.previewSlots = previewCanvases.map((canvas) => ({
      canvas: canvas || null,
      ctx: canvas ? canvas.getContext('2d') : null,
    }));
    this.previewTarget = new THREE.WebGLRenderTarget(
      this.previewWidth,
      this.previewHeight,
      targetOptions,
    );
    this.previewBuffer = new Uint8Array(this.previewWidth * this.previewHeight * 4);
    this.previewImage = new ImageData(this.previewWidth, this.previewHeight);
    this.syncPreviewCanvases();
    this.appliedAspect = this.deckWidth / this.deckHeight;

    this.frame = 0;
    this.running = true;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  buildDeckMaterial(body, deckIndex) {
    return new THREE.ShaderMaterial({
      // spreads copy the *references* to the {value} objects: time/resolution
      // are global, audio comes from this deck's routed set
      uniforms: { ...this.sharedUniforms, ...this.deckAudioUniforms[deckIndex] },
      vertexShader: VERTEX_SHADER,
      fragmentShader: buildFragmentShader(body),
    });
  }

  setOpacity(deckIndex, value) {
    this.slotUniforms[deckIndex].mix.value = value;
  }

  setScale(deckIndex, value) {
    this.slotUniforms[deckIndex].scale.value = value;
  }

  setSize(deckIndex, x, y) {
    this.slotUniforms[deckIndex].size.value.set(x, y);
  }

  setCrossfade(value) {
    this.xfadeUniform.value = value;
  }

  // tilt and hue in radians
  setChannelFx(deckIndex, tilt, contrast, hue, sat) {
    this.slotUniforms[deckIndex].fx.value.set(tilt, contrast, hue, sat);
  }

  setAudioRouting(deckIndex, band, amt) {
    this.audioRouting[deckIndex] = { band, amt };
  }

  setCueScene(sceneIndex) {
    this.cueScene = sceneIndex;
  }

  // Attach/detach the master-out canvas (lives in a pop-out window; same
  // renderer process, so the per-frame blit works exactly like the A/B views).
  setMasterCanvas(canvas) {
    this.views.master = {
      canvas: canvas || null,
      ctx: canvas ? canvas.getContext('2d') : null,
    };
  }

  // Two-layer staging compile: a raw WebGL precompile catches syntax errors
  // cheaply, then a hidden render of the staging material through three.js
  // catches anything the precompile context misses. The active material is
  // only swapped (and disposed) if both pass.
  stageShader(deckIndex, body) {
    const gl = this.renderer.getContext();
    const fullSource = buildFragmentShader(body);

    const precompileError = validateFragmentSource(gl, fullSource);
    if (precompileError) {
      console.error('[Vizzy] Staging precompile failed:', precompileError);
      return { ok: false, error: precompileError };
    }

    const deck = this.decks[deckIndex];
    const stagingMaterial = this.buildDeckMaterial(body, deckIndex);
    const activeMaterial = deck.mesh.material;

    this.shaderError = null;
    deck.mesh.material = stagingMaterial;
    this.sharedUniforms.u_resolution.value.set(this.previewWidth, this.previewHeight);
    this.renderer.setRenderTarget(this.previewTarget);
    this.renderer.render(deck.scene, this.camera);
    this.renderer.setRenderTarget(null);

    if (this.shaderError) {
      const error = this.shaderError;
      this.shaderError = null;
      deck.mesh.material = activeMaterial;
      stagingMaterial.dispose();
      return { ok: false, error };
    }

    activeMaterial.dispose();
    deck.body = body;
    this.disposeModel(deck);
    this.disposeSprite(deck);
    deck.mode = 'shader';
    return { ok: true };
  }

  // Put an image on a deck: centered quad preserving the image's aspect
  // within the render frame, alpha respected, scale-pulsing with the deck's
  // routed audio.
  stageSprite(deckIndex, texture, imageAspect, spriteId) {
    const deck = this.decks[deckIndex];
    // pre-upload the image to the GPU so the swap frame doesn't hitch
    this.renderer.initTexture(texture);
    this.disposeModel(deck);
    this.disposeSprite(deck);

    const mesh = new THREE.Mesh(
      this.spriteGeometry,
      new THREE.ShaderMaterial({
        uniforms: {
          u_map: { value: texture },
          u_opacity: { value: 1 },
          u_distort: { value: 0 },
          u_skew: { value: 0 },
          u_time: { value: 0 },
        },
        vertexShader: SPRITE_VERTEX,
        fragmentShader: SPRITE_FRAGMENT,
        transparent: true,
      }),
    );
    mesh.frustumCulled = false;
    // The container absorbs the aspect compensation OUTSIDE the mesh's
    // rotation: the mesh rotates in isotropic units (rigid, no shearing) and
    // the container's non-uniform scale cancels the screen's NDC stretch.
    const container = new THREE.Group();
    container.add(mesh);
    const scene = new THREE.Scene();
    scene.add(container);

    deck.sprite = { scene, container, mesh, spriteId, imageAspect, baseW: 1, baseH: 1, spin: 0 };
    this.updateSpriteLayout(deck);
    deck.mode = 'sprite';
    return { ok: true };
  }

  // Sizes are in aspect-isotropic units (equal pixels per unit on both axes);
  // the container converts them to the ortho camera's stretched NDC space.
  // Contain-fit to ~85% of the frame.
  updateSpriteLayout(deck) {
    if (!deck.sprite) return;
    const viewAspect = this.aspectUniform.value || 1;
    deck.sprite.container.scale.set(1 / viewAspect, 1, 1);
    const h = Math.min(1.7, (1.7 * viewAspect) / deck.sprite.imageAspect);
    deck.sprite.baseW = h * deck.sprite.imageAspect;
    deck.sprite.baseH = h;
  }

  disposeSprite(deck) {
    if (!deck.sprite) return;
    deck.sprite.mesh.material.uniforms.u_map.value?.dispose();
    deck.sprite.mesh.material.dispose();
    deck.sprite = null;
  }

  setAutomation(deckIndex, aut) {
    this.automation[deckIndex] = aut;
  }

  // Put a loaded 3D object on a deck: auto-centered and normalized to the
  // camera, lit, slowly rotating, scale-pulsing with the deck's routed audio.
  // Async on purpose: shaders are pre-compiled in parallel and buffers
  // pre-uploaded BEFORE the swap, so the running visuals never stall on the
  // first frame of a new model. The old content keeps playing until ready.
  async stageModel(deckIndex, object3D, modelId) {
    const deck = this.decks[deckIndex];

    const box = new THREE.Box3().setFromObject(object3D);
    const sizeVec = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) || 1;
    object3D.position.sub(center);

    const group = new THREE.Group();
    group.add(object3D);
    const baseScale = 2.2 / maxDim;
    group.scale.setScalar(baseScale);

    const scene = new THREE.Scene();
    scene.add(group);
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x22d3ee, 1.2);
    rim.position.set(-3, -1, -2);
    scene.add(rim);

    // 1) parallel (non-blocking) shader compilation for all the file's materials
    try {
      if (this.renderer.compileAsync) {
        await this.renderer.compileAsync(scene, this.modelCamera);
      }
    } catch (err) {
      // worst case the first visible frame compiles inline, as before
      console.warn('[Vizzy] Async shader compile failed, continuing:', err);
    }
    // 2) one warm-up render to the scratch target uploads geometry + textures
    this.renderer.setRenderTarget(this.previewTarget);
    this.renderer.render(scene, this.modelCamera);
    this.renderer.setRenderTarget(null);

    // ready — swap atomically (old model/sprite disposed only now)
    this.disposeModel(deck);
    this.disposeSprite(deck);
    deck.model = { scene, group, modelId, baseScale, spin: 0 };
    deck.mode = 'model';
    return { ok: true };
  }

  disposeModel(deck) {
    if (!deck.model) return;
    deck.model.scene.traverse((node) => {
      node.geometry?.dispose?.();
      const materials = Array.isArray(node.material)
        ? node.material
        : node.material
          ? [node.material]
          : [];
      materials.forEach((material) => {
        Object.values(material).forEach((value) => {
          if (value?.isTexture) value.dispose();
        });
        material.dispose();
      });
    });
    deck.model = null;
  }

  getShaderBody(deckIndex) {
    return this.decks[deckIndex].body;
  }

  // What's running on a slot — used by deck-preset save
  getChannelSource(deckIndex) {
    const deck = this.decks[deckIndex];
    if (deck.mode === 'model' && deck.model) {
      return { type: 'model', modelId: deck.model.modelId };
    }
    if (deck.mode === 'sprite' && deck.sprite) {
      return { type: 'sprite', spriteId: deck.sprite.spriteId };
    }
    return { type: 'shader', code: deck.body };
  }

  // Snapshot of a channel's live preview canvas — pure 2D-canvas read, so
  // saving a shader never touches the GL pipeline mid-performance.
  getPreviewDataURL(channelIndex) {
    const ctx = this.previewSlots[channelIndex]?.ctx;
    return ctx ? ctx.canvas.toDataURL('image/jpeg', 0.75) : null;
  }

  // Downscaled snapshot of a scene view (the A/B composite) for deck-preset
  // thumbnails — also a pure 2D-canvas read.
  getSceneDataURL(sceneIndex) {
    const src = this.views[sceneIndex === 0 ? 'a' : 'b']?.canvas;
    if (!src || src.width === 0 || src.height === 0) return null;
    const thumb = document.createElement('canvas');
    thumb.width = 160;
    thumb.height = Math.max(1, Math.round((160 * src.height) / src.width));
    thumb.getContext('2d').drawImage(src, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL('image/jpeg', 0.75);
  }

  syncPreviewCanvases() {
    this.previewSlots.forEach((slot) => {
      if (!slot.canvas) return;
      slot.canvas.width = this.previewWidth;
      slot.canvas.height = this.previewHeight;
    });
  }

  // Deck targets track the scene views' aspect ratio, so shaders render at
  // the shape they're shown at; applied only once the aspect settles.
  maybeResizeDecks(aspect) {
    if (Math.abs(aspect - this.appliedAspect) < 0.01) {
      this.pendingAspect = null;
      this.aspectStableFrames = 0;
      return;
    }
    if (this.pendingAspect === null || Math.abs(aspect - this.pendingAspect) > 0.01) {
      this.pendingAspect = aspect;
      this.aspectStableFrames = 0;
      return;
    }
    this.aspectStableFrames += 1;
    if (this.aspectStableFrames < ASPECT_SETTLE_FRAMES) return;

    this.appliedAspect = aspect;
    this.pendingAspect = null;
    this.aspectStableFrames = 0;
    this.deckWidth = BASE_DECK_WIDTH;
    this.deckHeight = Math.max(16, Math.round(BASE_DECK_WIDTH / aspect));
    this.previewWidth = BASE_PREVIEW_WIDTH;
    this.previewHeight = Math.max(9, Math.round(BASE_PREVIEW_WIDTH / aspect));
    this.aspectUniform.value = this.deckWidth / this.deckHeight;
    this.modelCamera.aspect = this.aspectUniform.value;
    this.modelCamera.updateProjectionMatrix();
    this.decks.forEach((deck) => this.updateSpriteLayout(deck));

    this.decks.forEach((deck) => {
      deck.target.setSize(this.deckWidth, this.deckHeight);
    });
    this.previewTarget.setSize(this.previewWidth, this.previewHeight);
    this.previewBuffer = new Uint8Array(this.previewWidth * this.previewHeight * 4);
    this.previewImage = new ImageData(this.previewWidth, this.previewHeight);
    this.syncPreviewCanvases();
  }

  // Render a composite pass on the hidden GL canvas, then copy it onto an
  // on-screen 2D view canvas (GPU-side drawImage).
  renderToView(compositeScene, view) {
    if (!view?.ctx) return;
    const { canvas, ctx } = view;
    // the master canvas lives in another window — use ITS pixel ratio
    const dpr = (canvas.ownerDocument.defaultView || window).devicePixelRatio || 1;
    const pw = Math.round(canvas.clientWidth * dpr);
    const ph = Math.round(canvas.clientHeight * dpr);
    if (pw === 0 || ph === 0) return;
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    this.renderer.setRenderTarget(null);
    this.renderer.render(compositeScene, this.camera);

    // aspect-preserving contain-fit: the GL canvas matches the A/B views
    // exactly (no-op there) but the master monitor box may differ — letterbox
    // instead of stretching.
    const src = this.renderer.domElement;
    const fit = Math.min(pw / src.width, ph / src.height);
    const dw = Math.round(src.width * fit);
    const dh = Math.round(src.height * fit);
    if (dw !== pw || dh !== ph) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, pw, ph);
    }
    ctx.drawImage(src, Math.round((pw - dw) / 2), Math.round((ph - dh) / 2), dw, dh);
  }

  loop() {
    if (!this.running) return;
    this.frame += 1;

    // The master-out window, when open, is the primary view: it defines the
    // render aspect AND resolution, so the output window is always filled
    // edge-to-edge at native size while the in-app A/B views letterbox to
    // match (contain-fit in renderToView). Resizing the master window
    // re-shapes everything. With no master attached, the scene-A pane is
    // the primary.
    const masterCanvas = this.views.master?.canvas;
    const primary =
      masterCanvas && masterCanvas.isConnected ? masterCanvas : this.views.a?.canvas;
    if (primary && primary.clientWidth > 0 && primary.clientHeight > 0) {
      const dpr = (primary.ownerDocument.defaultView || window).devicePixelRatio || 1;
      const glCanvas = this.renderer.domElement;
      const pw = Math.round(primary.clientWidth * dpr);
      const ph = Math.round(primary.clientHeight * dpr);
      if (glCanvas.width !== pw || glCanvas.height !== ph) {
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(primary.clientWidth, primary.clientHeight, false);
      }
      this.maybeResizeDecks(primary.clientWidth / primary.clientHeight);
    }

    this.sharedUniforms.u_time.value = this.clock.getElapsedTime();
    if (this.audioEngine) {
      const audio = this.audioEngine.update();
      // per-deck routing: amt scales everything, the selected band drives
      // u_audio_level (the default 'level' routing is identity behaviour)
      this.deckAudioUniforms.forEach((u, i) => {
        const route = this.audioRouting[i];
        u.u_audio_low.value = Math.min(1, audio.low * route.amt);
        u.u_audio_mid.value = Math.min(1, audio.mid * route.amt);
        u.u_audio_high.value = Math.min(1, audio.high * route.amt);
        u.u_audio_level.value = Math.min(1, (audio[route.band] ?? audio.level) * route.amt);
      });
    }

    this.sharedUniforms.u_resolution.value.set(this.deckWidth, this.deckHeight);
    const t = this.sharedUniforms.u_time.value;
    const dt = Math.min(0.1, t - (this.lastFrameTime ?? t));
    this.lastFrameTime = t;
    this.decks.forEach((deck, i) => {
      this.renderer.setRenderTarget(deck.target);
      if (deck.mode === 'model' && deck.model) {
        const model = deck.model;
        const aut = this.automation[i];
        const level = this.deckAudioUniforms[i].u_audio_level.value;

        // ROT adds spin on top of a gentle always-on base rotation
        model.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);
        const pulse =
          1 + aut.scl.amt * 0.5 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 2.2));
        // DST = jelly squash-and-stretch (material-agnostic "distortion")
        const wobble =
          aut.dst.amt * 0.35 * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3));

        model.group.rotation.y = t * 0.3 + model.spin;
        model.group.rotation.x = Math.sin(t * 0.3) * 0.2;
        // SKW = side lean (true shear isn't expressible in TRS transforms)
        model.group.rotation.z =
          aut.skw.amt * 0.5 * (aut.skw.audio ? level : Math.sin(t * 0.9));
        model.group.scale.set(
          model.baseScale * pulse * (1 + wobble * Math.sin(t * 7.0)),
          model.baseScale * pulse * (1 - wobble * Math.sin(t * 7.0 + 1.0)),
          model.baseScale * pulse * (1 + wobble * Math.cos(t * 6.0)),
        );
        // FLK = whole-frame blink (works regardless of imported materials)
        model.group.visible = !(
          aut.flk.amt > 0 &&
          Math.random() <
            aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * 0.5
        );

        this.renderer.render(model.scene, this.modelCamera);
      } else if (deck.mode === 'sprite' && deck.sprite) {
        const sprite = deck.sprite;
        const aut = this.automation[i];
        const level = this.deckAudioUniforms[i].u_audio_level.value;

        const pulse =
          1 + aut.scl.amt * 0.6 * (aut.scl.audio ? level : 0.5 + 0.5 * Math.sin(t * 2.2));
        sprite.spin += dt * aut.rot.amt * (aut.rot.audio ? level * 8 : 1.6);

        sprite.mesh.scale.set(sprite.baseW * pulse, sprite.baseH * pulse, 1);
        sprite.mesh.position.y = Math.sin(t * 0.8) * 0.04;
        sprite.mesh.rotation.z = sprite.spin;

        const u = sprite.mesh.material.uniforms;
        u.u_time.value = t;
        u.u_opacity.value =
          1 - aut.flk.amt * (aut.flk.audio ? Math.min(1, level * 1.5) : 1) * Math.random();
        u.u_distort.value = aut.dst.amt * (aut.dst.audio ? level : 0.6 + 0.4 * Math.sin(t * 1.3));
        u.u_skew.value = aut.skw.amt * 0.7 * (aut.skw.audio ? level : Math.sin(t * 0.9));

        this.renderer.render(sprite.scene, this.camera);
      } else {
        this.renderer.render(deck.scene, this.camera);
      }
    });

    this.renderToView(this.sceneComposites[0], this.views.a);
    this.renderToView(this.sceneComposites[1], this.views.b);
    this.renderToView(this.masterComposite, this.views.master);

    // Round-robin: one channel preview per frame (~15fps each at 60fps)
    // keeps the readPixels cost negligible.
    this.updatePreview(this.frame % CHANNELS);

    this.raf = requestAnimationFrame(this.loop);
  }

  updatePreview(channelIndex) {
    const slot = this.previewSlots[channelIndex];
    if (!slot?.ctx) return;
    // previews always show the cued scene's channels, sampled from the deck's
    // already-rendered frame through the composite transform (scale + W/H
    // window) so the thumbnail matches the final output contribution.
    const slotIndex = this.cueScene * CHANNELS + channelIndex;
    const slotUniform = this.slotUniforms[slotIndex];
    this.previewUniforms.u_tex.value = this.decks[slotIndex].target.texture;
    this.previewUniforms.u_scale.value = slotUniform.scale.value;
    this.previewUniforms.u_size.value.copy(slotUniform.size.value);
    this.previewUniforms.u_fx.value.copy(slotUniform.fx.value);

    this.renderer.setRenderTarget(this.previewTarget);
    this.renderer.render(this.previewScene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.readRenderTargetPixels(
      this.previewTarget,
      0,
      0,
      this.previewWidth,
      this.previewHeight,
      this.previewBuffer,
    );

    // GL framebuffers are bottom-up; ImageData is top-down — flip rows.
    // Premultiply alpha into RGB (alpha = brightness, matching the composite
    // shader) so the preview shows exactly what the master mix will show.
    const rowBytes = this.previewWidth * 4;
    const buf = this.previewBuffer;
    const out = this.previewImage.data;
    for (let y = 0; y < this.previewHeight; y += 1) {
      const srcRow = (this.previewHeight - 1 - y) * rowBytes;
      const dstRow = y * rowBytes;
      for (let x = 0; x < rowBytes; x += 4) {
        const a = buf[srcRow + x + 3] / 255;
        out[dstRow + x] = buf[srcRow + x] * a;
        out[dstRow + x + 1] = buf[srcRow + x + 1] * a;
        out[dstRow + x + 2] = buf[srcRow + x + 2] * a;
        out[dstRow + x + 3] = 255;
      }
    }
    slot.ctx.putImageData(this.previewImage, 0, 0);
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.decks.forEach((deck) => {
      deck.mesh.material.dispose();
      deck.target.dispose();
      this.disposeModel(deck);
      this.disposeSprite(deck);
    });
    this.spriteGeometry.dispose();
    this.previewTarget.dispose();
    this.sceneComposites.forEach((scene) => scene.children[0]?.material.dispose());
    this.masterComposite.children[0]?.material.dispose();
    this.previewScene.children[0]?.material.dispose();
    this.quadGeometry.dispose();
    this.renderer.dispose();
  }
}

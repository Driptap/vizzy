import * as THREE from 'three';
import {
  VERTEX_SHADER,
  buildFragmentShader,
  DEFAULT_DECK_BODIES,
  COMPOSITE_FRAGMENT,
} from './shaders';

const BASE_DECK_WIDTH = 960;
const BASE_PREVIEW_WIDTH = 160;
const FALLBACK_ASPECT = 16 / 9;
// frames the master canvas aspect must hold steady before deck targets are
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
  constructor(masterCanvas, previewCanvases, audioEngine) {
    this.audioEngine = audioEngine;
    this.renderer = new THREE.WebGLRenderer({ canvas: masterCanvas, antialias: false });
    this.renderer.setClearColor(0x000000, 1);

    // Captures three.js-level shader failures during the staging render so a
    // bad LLM shader is rejected instead of crashing the visuals.
    this.shaderError = null;
    this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const log =
        gl.getShaderInfoLog(fragmentShader) ||
        gl.getProgramInfoLog(program) ||
        'Unknown shader error';
      this.shaderError = log.trim();
      console.error('[PromptVJ] Shader error:', this.shaderError);
    };

    this.clock = new THREE.Clock();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadGeometry = new THREE.PlaneGeometry(2, 2);

    // One {value} object per uniform, shared by reference across every deck's
    // active AND staging material — a single write per frame updates them all.
    this.sharedUniforms = {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2(1, 1) },
      u_audio_low: { value: 0 },
      u_audio_mid: { value: 0 },
      u_audio_high: { value: 0 },
      u_audio_level: { value: 0 },
    };

    const initialAspect =
      masterCanvas.clientWidth > 0 && masterCanvas.clientHeight > 0
        ? masterCanvas.clientWidth / masterCanvas.clientHeight
        : FALLBACK_ASPECT;
    this.appliedAspect = 0;
    this.pendingAspect = null;
    this.aspectStableFrames = 0;
    this.deckWidth = BASE_DECK_WIDTH;
    this.deckHeight = Math.round(BASE_DECK_WIDTH / initialAspect);
    this.previewWidth = BASE_PREVIEW_WIDTH;
    this.previewHeight = Math.round(BASE_PREVIEW_WIDTH / initialAspect);

    const targetOptions = { depthBuffer: false, stencilBuffer: false };

    this.decks = DEFAULT_DECK_BODIES.map((body, i) => {
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(this.quadGeometry, this.buildDeckMaterial(body));
      mesh.frustumCulled = false;
      scene.add(mesh);

      const target = new THREE.WebGLRenderTarget(this.deckWidth, this.deckHeight, targetOptions);
      // mirrored repeat so zooming out (scale < 1) tiles instead of streaking
      target.texture.wrapS = THREE.MirroredRepeatWrapping;
      target.texture.wrapT = THREE.MirroredRepeatWrapping;

      const previewCanvas = previewCanvases[i] || null;
      return {
        scene,
        mesh,
        body,
        target,
        previewTarget: new THREE.WebGLRenderTarget(
          this.previewWidth,
          this.previewHeight,
          targetOptions,
        ),
        previewCanvas,
        previewCtx: previewCanvas ? previewCanvas.getContext('2d') : null,
        previewBuffer: new Uint8Array(this.previewWidth * this.previewHeight * 4),
        previewImage: new ImageData(this.previewWidth, this.previewHeight),
      };
    });
    this.syncPreviewCanvases();
    this.appliedAspect = this.deckWidth / this.deckHeight;

    this.compositeUniforms = {
      u_deck1: { value: this.decks[0].target.texture },
      u_deck2: { value: this.decks[1].target.texture },
      u_deck3: { value: this.decks[2].target.texture },
      u_deck4: { value: this.decks[3].target.texture },
      u_mix1: { value: 1 },
      u_mix2: { value: 0 },
      u_mix3: { value: 0 },
      u_mix4: { value: 0 },
      u_scale1: { value: 1 },
      u_scale2: { value: 1 },
      u_scale3: { value: 1 },
      u_scale4: { value: 1 },
      u_size1: { value: new THREE.Vector2(1, 1) },
      u_size2: { value: new THREE.Vector2(1, 1) },
      u_size3: { value: new THREE.Vector2(1, 1) },
      u_size4: { value: new THREE.Vector2(1, 1) },
    };
    this.compositeScene = new THREE.Scene();
    const compositeMesh = new THREE.Mesh(
      this.quadGeometry,
      new THREE.ShaderMaterial({
        uniforms: this.compositeUniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: COMPOSITE_FRAGMENT,
      }),
    );
    compositeMesh.frustumCulled = false;
    this.compositeScene.add(compositeMesh);

    this.frame = 0;
    this.running = true;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  buildDeckMaterial(body) {
    return new THREE.ShaderMaterial({
      // spread copies the *references* to the shared {value} objects
      uniforms: { ...this.sharedUniforms },
      vertexShader: VERTEX_SHADER,
      fragmentShader: buildFragmentShader(body),
    });
  }

  setOpacity(deckIndex, value) {
    this.compositeUniforms[`u_mix${deckIndex + 1}`].value = value;
  }

  setScale(deckIndex, value) {
    this.compositeUniforms[`u_scale${deckIndex + 1}`].value = value;
  }

  setSize(deckIndex, x, y) {
    this.compositeUniforms[`u_size${deckIndex + 1}`].value.set(x, y);
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
      console.error('[PromptVJ] Staging precompile failed:', precompileError);
      return { ok: false, error: precompileError };
    }

    const deck = this.decks[deckIndex];
    const stagingMaterial = this.buildDeckMaterial(body);
    const activeMaterial = deck.mesh.material;

    this.shaderError = null;
    deck.mesh.material = stagingMaterial;
    this.sharedUniforms.u_resolution.value.set(this.previewWidth, this.previewHeight);
    this.renderer.setRenderTarget(deck.previewTarget);
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
    return { ok: true };
  }

  getShaderBody(deckIndex) {
    return this.decks[deckIndex].body;
  }

  // Snapshot of the deck's live preview canvas — pure 2D-canvas read, so
  // saving a shader never touches the GL pipeline mid-performance.
  getPreviewDataURL(deckIndex) {
    const ctx = this.decks[deckIndex].previewCtx;
    return ctx ? ctx.canvas.toDataURL('image/jpeg', 0.75) : null;
  }

  syncPreviewCanvases() {
    this.decks.forEach((deck) => {
      if (!deck.previewCanvas) return;
      deck.previewCanvas.width = this.previewWidth;
      deck.previewCanvas.height = this.previewHeight;
    });
  }

  // Deck targets track the master window's aspect ratio, so shaders render at
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

    this.decks.forEach((deck) => {
      deck.target.setSize(this.deckWidth, this.deckHeight);
      deck.previewTarget.setSize(this.previewWidth, this.previewHeight);
      deck.previewBuffer = new Uint8Array(this.previewWidth * this.previewHeight * 4);
      deck.previewImage = new ImageData(this.previewWidth, this.previewHeight);
    });
    this.syncPreviewCanvases();
  }

  loop() {
    if (!this.running) return;
    this.frame += 1;

    // master canvas renders at its true on-screen pixel size
    const canvas = this.renderer.domElement;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width > 0 && height > 0) {
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(width, height, false);
      }
      this.maybeResizeDecks(width / height);
    }

    this.sharedUniforms.u_time.value = this.clock.getElapsedTime();
    if (this.audioEngine) {
      const audio = this.audioEngine.update();
      this.sharedUniforms.u_audio_low.value = audio.low;
      this.sharedUniforms.u_audio_mid.value = audio.mid;
      this.sharedUniforms.u_audio_high.value = audio.high;
      this.sharedUniforms.u_audio_level.value = audio.level;
    }

    this.sharedUniforms.u_resolution.value.set(this.deckWidth, this.deckHeight);
    this.decks.forEach((deck) => {
      this.renderer.setRenderTarget(deck.target);
      this.renderer.render(deck.scene, this.camera);
    });

    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeScene, this.camera);

    // Round-robin: one deck preview per frame (~15fps each at 60fps) keeps
    // the readPixels cost negligible.
    this.updatePreview(this.decks[this.frame % this.decks.length]);

    this.raf = requestAnimationFrame(this.loop);
  }

  updatePreview(deck) {
    if (!deck.previewCtx) return;
    this.sharedUniforms.u_resolution.value.set(this.previewWidth, this.previewHeight);
    this.renderer.setRenderTarget(deck.previewTarget);
    this.renderer.render(deck.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.readRenderTargetPixels(
      deck.previewTarget,
      0,
      0,
      this.previewWidth,
      this.previewHeight,
      deck.previewBuffer,
    );

    // GL framebuffers are bottom-up; ImageData is top-down — flip rows.
    // Premultiply alpha into RGB (alpha = brightness, matching the composite
    // shader) so the preview shows exactly what the master mix will show.
    const rowBytes = this.previewWidth * 4;
    const buf = deck.previewBuffer;
    const out = deck.previewImage.data;
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
    deck.previewCtx.putImageData(deck.previewImage, 0, 0);
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.decks.forEach((deck) => {
      deck.mesh.material.dispose();
      deck.target.dispose();
      deck.previewTarget.dispose();
    });
    this.compositeScene.children[0]?.material.dispose();
    this.quadGeometry.dispose();
    this.renderer.dispose();
  }
}

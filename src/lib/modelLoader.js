import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const fs = window.require('fs/promises');
const path = window.require('path');

export const MODEL_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl', '.fbx'];

/**
 * Load a 3D model file into a THREE.Object3D. Files are read via fs and fed
 * to the loaders' parse() methods — the dev server origin can't fetch
 * file:// URLs, so URL-based loading is out. Notes per format:
 * - .glb is the reliable self-contained choice
 * - .gltf with external .bin/textures will fail to resolve those resources
 * - .obj/.stl get MeshNormalMaterial (no .mtl support; always visible)
 */
export async function loadModelObject(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.readFile(filePath);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  switch (ext) {
    case '.glb':
    case '.gltf': {
      const gltf = await new Promise((resolve, reject) => {
        new GLTFLoader().parse(arrayBuffer, '', resolve, reject);
      });
      return gltf.scene || gltf.scenes?.[0];
    }
    case '.obj': {
      const object = new OBJLoader().parse(new TextDecoder().decode(arrayBuffer));
      object.traverse((node) => {
        if (node.isMesh) node.material = new THREE.MeshNormalMaterial();
      });
      return object;
    }
    case '.stl': {
      const geometry = new STLLoader().parse(arrayBuffer);
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, new THREE.MeshNormalMaterial());
    }
    case '.fbx':
      return new FBXLoader().parse(arrayBuffer, '');
    default:
      throw new Error(`Unsupported model type: ${ext || 'unknown'}`);
  }
}

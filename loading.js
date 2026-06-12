import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

if (typeof window === 'undefined' || typeof document === 'undefined') {
  process.exit(0);
}

// Detect device performance via Android WebView JavascriptInterface
const isLowEnd = (window.AndroidConfig && typeof window.AndroidConfig.isLowEndDevice === 'function')
  ? window.AndroidConfig.isLowEndDevice()
  : false;
const shouldPreload = !isLowEnd;

const container = document.getElementById('game-container');
const loadingStatus = document.getElementById('loading-status');
const playButton = document.getElementById('play-button');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07090f);
const fogFar = shouldPreload ? 300 : 200;
const fogNear = shouldPreload ? 40 : 20;
scene.fog = new THREE.Fog(0x07090f, fogNear, fogFar);

const cameraFar = shouldPreload ? 10000 : 400;
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  cameraFar
);
camera.position.set(0, 8, 24);
scene.add(camera);

// Add lighting to make the city visible during loading
const ambientLight = new THREE.AmbientLight(0xffffff, 4.5); // Brighter ambient light to cover shadows uniformly
scene.add(ambientLight);


const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const loadingManager = new THREE.LoadingManager();
loadingManager.onStart = (_url, loaded, total) => {
  setLoadingText(`Loading game assets... ${loaded}/${total}`);
};
loadingManager.onProgress = (_url, loaded, total) => {
  if (total > 0) {
    setLoadingText(`Loading game assets... ${loaded}/${total}`);
  }
};
loadingManager.onLoad = () => {
  setReadyState(true);
};
loadingManager.onError = (url) => {
  console.error('Asset load failed:', url);
  setLoadingText(`Missing asset: ${url}`);
};

const gltfLoader = new GLTFLoader(loadingManager);
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('draco/');
gltfLoader.setDRACOLoader(dracoLoader);

console.log(shouldPreload
  ? 'High-end device detected: Preloading all 3D models and SFX into RAM/VRAM.'
  : 'Low-end device detected: Skipping bulk preload to save memory.');

let cityScene = null;
let cityCamera = null;
let cityMixer = null;
let cityBoundsCenter = new THREE.Vector3();
let cityBoundsRadius = 8;
let cityReady = false;
let fallbackCameraEnabled = false;
const importedLightScale = 0.01;
const animationSpeed = 0.5;

function setLoadingText(text) {
  if (loadingStatus) {
    loadingStatus.textContent = text;
  }
}

function setReadyState(ready) {
  cityReady = ready;
  if (playButton) {
    playButton.disabled = !ready;
    playButton.textContent = ready ? 'PLAY' : 'LOADING...';
  }
  setLoadingText(ready ? 'Game assets ready.' : 'Loading game assets...');
}

function prepareCityMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) {
      return;
    }

    child.castShadow = true;
    child.receiveShadow = true;

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (!material) {
        return;
      }

      if (material.map) {
        material.map.colorSpace = THREE.SRGBColorSpace;
        material.map.needsUpdate = true;
      }

      if (material.emissiveMap) {
        material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        material.emissiveMap.needsUpdate = true;
      }

      material.needsUpdate = true;
    });
  });
}

function scaleImportedLights(root) {
  root.traverse((child) => {
    if (!child.isLight) {
      return;
    }

    child.intensity *= importedLightScale;

    if (child.isPointLight) {
      child.distance *= 0.25;
      child.decay = 2;
    }
  });
}

function measureBounds(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  return {
    center,
    radius: radius > 0 ? radius : 8
  };
}

function frameFallbackCamera(elapsedTime) {
  const orbitDistance = Math.max(cityBoundsRadius * 2.1, 24);
  const height = Math.max(cityBoundsRadius * 0.25, 8);
  const angle = elapsedTime * 0.18;

  camera.position.set(
    cityBoundsCenter.x + Math.cos(angle) * orbitDistance,
    cityBoundsCenter.y + height,
    cityBoundsCenter.z + Math.sin(angle) * orbitDistance
  );
  camera.lookAt(cityBoundsCenter.x, cityBoundsCenter.y, cityBoundsCenter.z);
  camera.updateProjectionMatrix();
}

function syncCameraFromCityCamera() {
  if (!cityCamera) {
    return false;
  }

  cityCamera.updateMatrixWorld(true);

  const worldPosition = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();
  const worldScale = new THREE.Vector3();
  cityCamera.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);

  if (!Number.isFinite(worldPosition.x) || !Number.isFinite(worldPosition.y) || !Number.isFinite(worldPosition.z)) {
    return false;
  }

  camera.position.copy(worldPosition);
  camera.quaternion.copy(worldQuaternion);

  if (cityCamera.isPerspectiveCamera) {
    camera.fov = cityCamera.fov;
    camera.near = Math.max(0.01, cityCamera.near || 0.01);
    camera.far = Math.max(1000, cityCamera.far || 1000);
    camera.zoom = cityCamera.zoom || 1;
    camera.focus = cityCamera.focus;
    camera.filmGauge = cityCamera.filmGauge;
    camera.filmOffset = cityCamera.filmOffset;
    camera.updateProjectionMatrix();
  }

  return true;
}

function findFirstCamera(root, gltfCameras) {
  if (Array.isArray(gltfCameras) && gltfCameras.length > 0) {
    return gltfCameras[0];
  }

  let foundCamera = null;
  root.traverse((child) => {
    if (!foundCamera && child.isCamera) {
      foundCamera = child;
    }
  });

  return foundCamera;
}

function onCityLoaded(gltf) {
  cityScene = gltf.scene;
  scene.add(cityScene);

  prepareCityMaterials(cityScene);
  scaleImportedLights(cityScene);

  const bounds = measureBounds(cityScene);
  cityBoundsCenter.copy(bounds.center);
  cityBoundsRadius = bounds.radius;

  cityCamera = findFirstCamera(cityScene, gltf.cameras);
  if (cityCamera) {
    setLoadingText(`Camera found: ${cityCamera.name || 'Camera'}`);
  } else {
    console.warn('city.glb loaded, but no camera was found.');
    fallbackCameraEnabled = true;
  }

  if (Array.isArray(gltf.animations) && gltf.animations.length > 0) {
    cityMixer = new THREE.AnimationMixer(cityScene);
    gltf.animations.forEach((clip) => {
      cityMixer.clipAction(clip).reset().setLoop(THREE.LoopRepeat).play();
    });
  }
}

function onCityLoadError(error) {
  console.error('Failed to load city.glb.', error);
  setLoadingText('Failed to load city scene.');
  playButton.disabled = true;
  playButton.textContent = 'ERROR';
}


const cityModelPath = isLowEnd ? 'models/city-1.glb' : 'models/city-1.glb';
gltfLoader.load(cityModelPath, onCityLoaded, undefined, onCityLoadError);

// Preload other game assets (except the ghost) using the loadingManager.
// On low-end devices, skip this bulk preload — game.js will load them on demand.
if (shouldPreload) {
  const audioLoader = new THREE.AudioLoader(loadingManager);
  audioLoader.load('sfx/gun.mp3', () => { });
  audioLoader.load('sfx/ouch.mp3', () => { });
  audioLoader.load('sfx/walk.mp3', () => { });
  audioLoader.load('sfx/horror.mp3', () => { });

  const objLoader = new OBJLoader(loadingManager);
  objLoader.load('models/gun.obj', () => { });
} else {
  console.log('Skipping SFX and gun.glb preload for low-end device.');
}

// Thoroughly dispose all Three.js / WebGL resources so the GPU memory is
// freed before the browser creates a brand-new context on game.html.
// Without this, loading the 93 MB city twice causes GL_CONTEXT_LOST.
function disposeNode(node) {
  if (!node) return;
  if (node.geometry) {
    node.geometry.dispose();
  }
  if (node.material) {
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((mat) => {
      if (!mat) return;
      // Dispose every texture property on the material
      for (const key of Object.keys(mat)) {
        const value = mat[key];
        if (value && typeof value === 'object' && typeof value.dispose === 'function') {
          value.dispose();
        }
      }
      mat.dispose();
    });
  }
}

function cleanupBeforeNavigate() {
  // Stop the animation loop
  cancelAnimationFrame(animFrameId);

  // Dispose every object in the scene graph
  scene.traverse(disposeNode);

  // Remove all children
  while (scene.children.length > 0) {
    scene.remove(scene.children[0]);
  }

  // Dispose the renderer (releases the WebGL context)
  renderer.dispose();
  renderer.forceContextLoss();

  // Remove the canvas element so the browser can GC the backing store
  if (renderer.domElement && renderer.domElement.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
}

playButton.addEventListener('click', () => {
  if (!cityReady) {
    return;
  }

  cleanupBeforeNavigate();

  // Small delay to let the GPU finish releasing resources
  setTimeout(() => {
    window.location.href = 'game.html';
  }, 100);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let animFrameId = null;

function animate() {
  animFrameId = requestAnimationFrame(animate);

  const delta = clock.getDelta();
  if (cityMixer) {
    cityMixer.update(delta * animationSpeed);
  }

  const usingCityCamera = syncCameraFromCityCamera();
  if (!usingCityCamera || fallbackCameraEnabled) {
    frameFallbackCamera(clock.elapsedTime);
  }

  renderer.render(scene, camera);
}

setReadyState(false);
animate();

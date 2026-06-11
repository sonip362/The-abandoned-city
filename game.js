import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

if (typeof window === 'undefined' || typeof document === 'undefined') {
  process.exit(0);
}

const container = document.getElementById('game-container');
const uiElement = document.getElementById('ui');
const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// Detect device performance via Android WebView JavascriptInterface.
// High-end mode: load all assets eagerly. Low-end mode: lazy-load SFX on first use.
const shouldPreload = (window.AndroidConfig && typeof window.AndroidConfig.shouldPreloadAssets === 'function')
  ? window.AndroidConfig.shouldPreloadAssets()
  : true; // Default to full preload outside Android WebView

console.log(shouldPreload
  ? '[game.js] High-performance mode: Loading all assets eagerly.'
  : '[game.js] Low-memory mode: SFX will be lazy-loaded on first use.');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07090f);
scene.fog = new THREE.Fog(0x07090f, 40, 300);

const camera = new THREE.PerspectiveCamera(
  65,
  window.innerWidth / window.innerHeight,
  0.1,
  1200
);

const listener = new THREE.AudioListener();
camera.add(listener);

// No ambient lighting in the city

const gunSound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();
const ouchSound = new THREE.Audio(listener);
const walkSound = new THREE.Audio(listener);
const bgMusic = new THREE.Audio(listener);
let isMuted = false;

let ghostHealthElement = null;
let ghostHealthContainer = null;


// Perfectly centered flashlight attached to the camera
const moveLight = new THREE.SpotLight(0xffffff, 1.5, 40, Math.PI / 6, 0.5, 1.5);
moveLight.position.set(0, 0, 0); // Center of the camera
camera.add(moveLight);

const moveLightTarget = new THREE.Object3D();
scene.add(moveLightTarget);
moveLight.target = moveLightTarget;

let gunMesh = null;
let isShooting = false;
let lastShootTime = 0;
const shootRate = 0.15;

let ghostTemplate = null;
let activeGhosts = [];
let score = 0;
let lastGhostAttackTime = 0;
const shootRaycaster = new THREE.Raycaster();

// Glowing light anomaly variables
let anomalyGlowSprite = null;
let anomalyGlowLight = null;
let lightDialogueTriggered = false;

// Phone map image object
const mapImage = new Image();
mapImage.src = 'assets/map.png';

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
// Set output encoding/space in a backwards-compatible way
if ('outputColorSpace' in renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
} else if ('outputEncoding' in renderer) {
  renderer.outputEncoding = THREE.sRGBEncoding;
}
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
// Cap at 1.5x to reduce VRAM pressure from the large city model
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

// Handle WebGL context loss/restore so the game can survive GPU hiccups
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  console.warn('WebGL context lost — pausing render loop.');
  cancelAnimationFrame(animFrameId);
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  console.log('WebGL context restored — resuming.');
  animate();
});

const controls = new PointerLockControls(camera, document.body);

// Frustum culling helpers (manual per-object culling for performance)
const projScreenMatrix = new THREE.Matrix4();
const frustum = new THREE.Frustum();
const cullCandidates = [];

function addCullCandidate(mesh) {
  if (!mesh || !mesh.isMesh) return;
  // Ensure geometry bounding sphere exists (used by frustum tests)
  const geom = mesh.geometry;
  if (geom && geom.isBufferGeometry && !geom.boundingSphere) {
    geom.computeBoundingSphere();
  }
  cullCandidates.push(mesh);
}

function collectCullCandidates(root) {
  root.traverse((child) => {
    if (child.isMesh) {
      // skip very small helper meshes or camera-attached meshes by convention
      if (child.userData && child.userData.alwaysVisible) return;
      addCullCandidate(child);
    }
  });
}

const loadingManager = new THREE.LoadingManager();
const loader = new GLTFLoader(loadingManager);

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
loader.setDRACOLoader(dracoLoader);

let cityScene = null;
let cityReady = false;
let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;
let canMove = false;
const walkableMeshes = [];
const walkableAreas = [];
const buildingObstacles = [];
const wallObstacles = [];
const solidHitboxes = [];
const floorHitboxes = [];
const collisionMeshes = [];
const collisionRaycaster = new THREE.Raycaster();
const NUM_RAYS = 12;
const RAY_DIRS = [];
for (let i = 0; i < NUM_RAYS; i++) {
  const angle = (i / NUM_RAYS) * Math.PI * 2;
  RAY_DIRS.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
}
const primaryRoadMeshName = 'BLD_STR_jalanan_2';
const spawnX = -7.75;
const spawnZ = 6.78;
const spawnGroundY = -0.5;
let health = 100;
let maxHealth = 100;
let healthElement = null;
let healthTextElement = null;
let velocityY = 0;
let isFalling = false;
let lastSaveTime = 0;

const clock = new THREE.Clock();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const cityCenter = new THREE.Vector3();
let cityBounds = new THREE.Box3();
let cityRadius = 20;
const playerEyeHeight = -0.7;
const moveSpeed = 1;
const playerRadius = 0.8;
const groundRaycaster = new THREE.Raycaster();
const groundProbeOrigin = new THREE.Vector3();

function setUi(text) {
  if (uiElement) {
    if (isMobile) {
      if (text.includes('X:') && text.includes('Z:')) {
        const match = text.match(/X:\s*[-0-9.]+\s*\|\s*Z:\s*[-0-9.]+/);
        if (match) {
          uiElement.textContent = match[0];
          uiElement.style.display = 'block';
          return;
        }
      }
      if (text.includes('WASD move') || text.includes('Click to lock') || text.includes('Esc unlock')) {
        uiElement.textContent = '';
        uiElement.style.display = 'none';
        return;
      }
    }
    uiElement.textContent = text;
    uiElement.style.display = text ? 'block' : 'none';
  }
}

function updateTasksUi() {
  const tasksOverlay = document.getElementById('tasks-overlay');
  if (!tasksOverlay) return;

  const tasksList = tasksOverlay.querySelector('.tasks-list');
  if (!tasksList) return;

  const ghostKilled = score > 0;
  tasksList.innerHTML = `
    <div class="task-item active-task">
      <div class="task-checkbox"></div>
      <span>Survive the ghost's hauntings</span>
    </div>
    <div class="task-item ${ghostKilled ? 'completed' : 'active-task'}">
      <div class="task-checkbox">${ghostKilled ? '✓' : ''}</div>
      <span>Defeat the ghost at least once</span>
    </div>
  `;
}

function updatePhoneMap() {
  const canvas = document.getElementById('phone-map-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Auto-resize canvas matching container dimensions
  if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }

  const width = canvas.width;
  const height = canvas.height;
  const cx = width / 2;
  const cy = height / 2;

  // Clear canvas (Tactical night radar background)
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, width, height);

  const playerPos = controls.object.position;
  const playerX = playerPos.x;
  const playerZ = playerPos.z;

  // Ensure we have loaded the city geometry to draw map elements
  if (cityBounds.isEmpty()) {
    ctx.fillStyle = 'rgba(212, 196, 160, 0.75)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ESTABLISHING RADAR LINK...', cx, cy);
    return;
  }

  // Get player look direction/yaw angle
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const yawAngle = Math.atan2(dir.x, dir.z);

  // Scale: 5.8 pixels = 1 meter/unit in 3D
  const scale = 5.8;

  // 1. DRAW ROTATING RADAR SCENE ELEMENTS
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-yawAngle + Math.PI); // Rotate entire city map to keep player facing UP

  // Draw background grid lines (rotating to follow map alignment)
  ctx.strokeStyle = 'rgba(28, 42, 60, 0.15)';
  ctx.lineWidth = 1;
  const gridSize = 40;
  const mapExtent = 250;
  for (let x = -mapExtent; x <= mapExtent; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, -mapExtent);
    ctx.lineTo(x, mapExtent);
    ctx.stroke();
  }
  for (let y = -mapExtent; y <= mapExtent; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(-mapExtent, y);
    ctx.lineTo(mapExtent, y);
    ctx.stroke();
  }

  // Draw Walkable Roads (walkableAreas)
  ctx.fillStyle = 'rgba(20, 26, 38, 0.8)';
  ctx.strokeStyle = 'rgba(139, 115, 64, 0.2)';
  ctx.lineWidth = 1.5;
  walkableAreas.forEach((box) => {
    const x = (box.min.x - playerX) * scale;
    const z = (box.min.z - playerZ) * scale;
    const w = (box.max.x - box.min.x) * scale;
    const h = (box.max.z - box.min.z) * scale;

    ctx.fillRect(x, z, w, h);
    ctx.strokeRect(x, z, w, h);
  });

  // Draw Buildings / Solid Obstacles (solidHitboxes)
  solidHitboxes.forEach((box, idx) => {
    if (box.max.x - box.min.x > 300) return; // Skip giant outer bounds bounding boxes

    const x = (box.min.x - playerX) * scale;
    const z = (box.min.z - playerZ) * scale;
    const w = (box.max.x - box.min.x) * scale;
    const h = (box.max.z - box.min.z) * scale;

    // Draw solid building block
    ctx.fillStyle = 'rgba(12, 14, 18, 0.95)';
    ctx.fillRect(x, z, w, h);

    // Hazard/Alert red border
    ctx.strokeStyle = 'rgba(196, 30, 30, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, z, w, h);

    // Architectural Blueprint blueprint cross-hatches (X shape inside building)
    ctx.strokeStyle = 'rgba(196, 30, 30, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, z);
    ctx.lineTo(x + w, z + h);
    ctx.moveTo(x + w, z);
    ctx.lineTo(x, z + h);
    ctx.stroke();

    // Draw structure reference label in the center of the building
    if (w > 22 && h > 22) {
      ctx.fillStyle = 'rgba(196, 30, 30, 0.35)';
      ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`STR-${idx + 1}`, x + w / 2, z + h / 2);
    }
  });

  // Draw all active ghosts (if visible)
  activeGhosts.forEach((ghost) => {
    if (ghost.mesh && ghost.mesh.visible) {
      const gx = (ghost.mesh.position.x - playerX) * scale;
      const gz = (ghost.mesh.position.z - playerZ) * scale;

      // Pulse red danger indicators
      const pulseRadius = 7 + (Date.now() % 1000) / 150 * 2.0;
      ctx.strokeStyle = 'rgba(255, 30, 30, 0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(gx, gz, pulseRadius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#ff1e1e';
      ctx.beginPath();
      ctx.arc(gx, gz, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Draw target indicator label (rotated straight so it reads easily)
      ctx.save();
      ctx.translate(gx, gz);
      ctx.rotate(yawAngle - Math.PI); // Counter-rotate text so it stays horizontally readable
      ctx.fillStyle = '#ff1e1e';
      ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('⚠️ TARGET', 0, -10);
      ctx.restore();
    }
  });

  ctx.restore(); // Restore rotating context to draw fixed HUD elements on top

  // 2. DRAW SONAR SWEEPER LINE (fixed scan)
  const sweepAngle = (Date.now() / 1200) % (Math.PI * 2);
  const sweepRadius = Math.max(width, height) * 0.7;
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.08)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweepAngle) * sweepRadius, cy + Math.sin(sweepAngle) * sweepRadius);
  ctx.stroke();

  // 3. DRAW FIXED PLAYER POINTER AT CENTER (Always pointing UP)
  ctx.save();
  ctx.translate(cx, cy);

  // Glowing player pointer shadow
  ctx.shadowColor = '#22c55e';
  ctx.shadowBlur = 8;

  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.moveTo(0, -9);  // Nose
  ctx.lineTo(-5.5, 6); // Left tail
  ctx.lineTo(0, 3);   // Middle indent
  ctx.lineTo(5.5, 6);  // Right tail
  ctx.closePath();
  ctx.fill();

  ctx.shadowBlur = 0;

  // Pulse ring around player
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 12 + Math.sin(Date.now() / 250) * 3, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();

  // 4. DRAW FIXED HUD OVERLAY PANELS (Non-rotating)
  ctx.fillStyle = 'rgba(212, 196, 160, 0.75)';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('OFFLINE MAPS v1.02', 12, 20);
  ctx.fillText('LOC TRIANGULATION', 12, 32);

  ctx.fillStyle = 'rgba(196, 30, 30, 0.85)';
  ctx.font = '8px monospace';
  ctx.fillText('⚠️ EMP INTERFERENCE ACTIVE', 12, 44);

  // Position coordinates text
  ctx.fillStyle = 'rgba(212, 196, 160, 0.65)';
  ctx.textAlign = 'right';
  ctx.fillText(`X: ${playerX.toFixed(2)}`, width - 12, 20);
  ctx.fillText(`Z: ${playerZ.toFixed(2)}`, width - 12, 32);
}

function showPhoneScreen(screenName) {
  const screens = ['home', 'chat', 'maps', 'logs'];
  screens.forEach((s) => {
    const elem = document.getElementById(`phone-screen-${s}`);
    if (elem) {
      if (s === screenName) {
        elem.classList.remove('hidden');
      } else {
        elem.classList.add('hidden');
      }
    }
  });
}


// FPS counter
let fpsElem = null;
let lastFrameTimeForFps = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
function createFpsCounter() {
  if (fpsElem) return fpsElem;
  fpsElem = document.createElement('div');
  fpsElem.id = 'fps-counter';
  // Styles defined in style.css
  fpsElem.textContent = '... FPS';
  document.body.appendChild(fpsElem);
  return fpsElem;
}

// Create a full-screen red flash overlay used when the player is hit
let flashOverlay = null;
function createFlashOverlay() {
  if (flashOverlay) return flashOverlay;
  flashOverlay = document.createElement('div');
  flashOverlay.id = 'flash-overlay';
  // Styles defined in style.css
  flashOverlay.style.opacity = '0';
  flashOverlay.style.transition = 'opacity 300ms ease-out';
  document.body.appendChild(flashOverlay);
  return flashOverlay;
}

function flashScreenRed(duration = 150) {
  const overlay = createFlashOverlay();
  // show quickly
  overlay.style.transition = 'none';
  overlay.style.opacity = '0.8';
  // force reflow so transition will apply when we hide
  // eslint-disable-next-line no-unused-expressions
  overlay.offsetHeight;
  setTimeout(() => {
    overlay.style.transition = 'opacity 400ms ease-out';
    overlay.style.opacity = '0';
  }, duration);
}

function reportIssue(message) {
  console.warn(message);
  setUi(message);
}

function scaleImportedLights(root) {
  root.traverse((child) => {
    const name = (child.name || '').toLowerCase();

    // Disable directional lights completely (to hide the sun)
    if (child.isDirectionalLight) {
      child.intensity = 0;
      child.visible = false;
      return;
    }

    // Hide any sun/sky/dome/cloud/day geometry meshes
    if (name.includes('sun') || name.includes('sky') || name.includes('dome') || name.includes('cloud') || name.includes('day')) {
      child.visible = false;
      if (child.isLight) child.intensity = 0;
      return;
    }

    if (child.isLight) {
      child.intensity *= 0.01;
    }
  });
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

      // Helper: assign proper encoding/colorSpace to textures.
      const setTexEncoding = (tex, isColor) => {
        if (!tex) return;
        if ('colorSpace' in tex) {
          if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
          else if ('LinearSRGBColorSpace' in THREE) tex.colorSpace = THREE.LinearSRGBColorSpace;
        }
        if ('encoding' in tex) {
          tex.encoding = isColor ? THREE.sRGBEncoding : THREE.LinearEncoding;
        }
        tex.needsUpdate = true;
      };

      // Color textures
      setTexEncoding(material.map, true);
      setTexEncoding(material.emissiveMap, true);
      setTexEncoding(material.alphaMap, true);

      // Non-color textures (should use linear encoding)
      setTexEncoding(material.roughnessMap, false);
      setTexEncoding(material.metalnessMap, false);
      setTexEncoding(material.normalMap, false);
      setTexEncoding(material.aoMap, false);

      material.needsUpdate = true;
    });
  });
}

function measureBounds(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;

  return {
    box,
    center,
    radius: radius > 0 ? radius : 20
  };
}

function centerCity(root) {
  const bounds = measureBounds(root);
  cityBounds.copy(bounds.box);
  cityCenter.copy(bounds.center);
  cityRadius = bounds.radius;
  root.position.sub(cityCenter);
  cityCenter.set(0, 0, 0);
  cityBounds.min.sub(bounds.center);
  cityBounds.max.sub(bounds.center);
}

function collectWalkableAreas(root) {
  walkableMeshes.length = 0;
  walkableAreas.length = 0;
  buildingObstacles.length = 0;
  wallObstacles.length = 0;
  solidHitboxes.length = 0;
  floorHitboxes.length = 0;
  collisionMeshes.length = 0;

  root.traverse((child) => {
    if (!child.isMesh) {
      return;
    }

    const name = (child.name || '').toLowerCase();
    const box = new THREE.Box3().setFromObject(child);

    if (child.name === primaryRoadMeshName) {
      walkableMeshes.push(child);
      box.expandByScalar(playerRadius);
      walkableAreas.push(box);
      return;
    }

    // Store actual mesh references for raycasting collision
    collisionMeshes.push(child);

    // Also keep AABB for spatial pre-filtering
    const hitbox = new THREE.Box3().setFromObject(child);
    solidHitboxes.push(hitbox);
  });



  if (walkableMeshes.length === 0) {
    reportIssue(`No road mesh found: ${primaryRoadMeshName}`);
  }
}

function isInsideWalkableArea(worldX, worldZ) {
  if (walkableAreas.length === 0) {
    return false;
  }

  return walkableAreas.some((box) => (
    worldX >= box.min.x &&
    worldX <= box.max.x &&
    worldZ >= box.min.z &&
    worldZ <= box.max.z
  ));
}

function getBestRoadSpawn() {
  // Try to find a valid spawn point on the road
  const testPositions = [
    new THREE.Vector3(spawnX, spawnGroundY, spawnZ),
    new THREE.Vector3(spawnX + 1, spawnGroundY, spawnZ),
    new THREE.Vector3(spawnX - 1, spawnGroundY, spawnZ),
    new THREE.Vector3(spawnX, spawnGroundY, spawnZ + 1),
    new THREE.Vector3(spawnX, spawnGroundY, spawnZ - 1),
  ];

  for (let pos of testPositions) {
    if (isInsideWalkableArea(pos.x, pos.z)) {
      return pos;
    }
  }

  // Fallback to closest walkable mesh center
  if (walkableMeshes.length > 0) {
    const meshCenter = new THREE.Vector3();
    walkableMeshes[0].getWorldPosition(meshCenter);
    return new THREE.Vector3(meshCenter.x, spawnGroundY, meshCenter.z);
  }

  return new THREE.Vector3(spawnX, spawnGroundY, spawnZ);
}

// Doorway openings — collision is disabled near these coordinates
const wallOpenings = [
  { x: -1.33, z: -2.48 },
  { x: -3.37, z: -2.12 },
  { x: -3.30, z: -0.62 },
  { x: -3.31, z: 0.87 },
  { x: -3.41, z: 2.37 },
  { x: -1.52, z: 3.75 },
  { x: -0.23, z: 4.52 },
];
const openingRadius = 1.5; // How wide the opening passthrough zone is

function isNearOpening(testX, testZ) {
  for (const opening of wallOpenings) {
    const dx = testX - opening.x;
    const dz = testZ - opening.z;
    if (dx * dx + dz * dz < openingRadius * openingRadius) {
      return true;
    }
  }
  return false;
}

function checkSolidCollision(testX, testZ) {
  return false; // Make all walls/buildings enterable
}

function updatePlayerMaxHealth() {
  if (currentDay <= 5) {
    maxHealth = 100 + (currentDay - 1) * 12.5; // Days 1-5: 100 to 150 HP
  } else {
    const progressionFactor = (currentDay - 5) / 95;
    maxHealth = 200 + progressionFactor * 2800; // Days 6-100: 200 to 3000 HP
  }
  maxHealth = Math.round(maxHealth);
}

function updateHealthHUD() {
  if (healthElement) {
    healthElement.style.width = Math.max(0, (health / maxHealth) * 100) + '%';
  }
  if (healthTextElement) {
    healthTextElement.textContent = `HEALTH: ${Math.max(0, Math.round(health))} / ${maxHealth}`;
  }
}

function getGhostCountForDay(day) {
  if (day <= 5) return 1;
  // Gradual increase: 1 ghost on Day 5, scaling up to 10 ghosts on Day 100
  const ratio = (day - 5) / 95;
  return 1 + Math.floor(ratio * 9); // e.g. Day 6: 1, Day 100: 10
}

function spawnGhostInstance() {
  if (!ghostTemplate || cityBounds.isEmpty()) return null;
  const margin = 2.0;

  let x = 0;
  let z = 0;
  let found = false;
  let attempts = 0;

  const playerPos = controls.object.position;

  while (attempts < 150 && !found) {
    x = THREE.MathUtils.randFloat(cityBounds.min.x + margin, cityBounds.max.x - margin);
    z = THREE.MathUtils.randFloat(cityBounds.min.z + margin, cityBounds.max.z - margin);

    // Verify that the position has a walkable floor mesh underneath it
    if (hasFloor(x, z)) {
      // Ensure the ghost spawns at a scary distance (between 15 and 60 units) from the player
      const dx = x - playerPos.x;
      const dz = z - playerPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= 15 && dist <= 60) {
        found = true;
      }
    }
    attempts++;
  }

  // Fallback to a safe road spawn point if no random point fits the criteria
  if (!found) {
    const roadSpawn = getBestRoadSpawn();
    x = roadSpawn.x + THREE.MathUtils.randFloat(-3, 3);
    z = roadSpawn.z + THREE.MathUtils.randFloat(-3, 3);
  }

  const newMesh = ghostTemplate.clone();

  // Set position and make it visible. Lower Y position so it doesn't spawn too high.
  const ghostYOffset = -1.2;
  newMesh.position.set(x, spawnGroundY + ghostYOffset, z);
  newMesh.visible = true;
  scene.add(newMesh);

  // Register its meshes for culling
  collectCullCandidates(newMesh);

  // Calculate stats based on current day
  let maxGhostHealth, ghostSpeed, ghostDamage;
  if (currentDay <= 5) {
    // MUCH easier stats for the first 5 days
    maxGhostHealth = 40 + currentDay * 10;          // Day 1: 50, Day 5: 90
    ghostSpeed = 0.4 + currentDay * 0.1;           // Day 1: 0.5, Day 5: 0.9
    ghostDamage = 3 + currentDay * 2;              // Day 1: 5, Day 5: 13
  } else {
    // Scale gradually up to 100 days
    const progressionFactor = (currentDay - 5) / 95; // 0 to 1
    maxGhostHealth = 100 + progressionFactor * 900;  // Day 6: 100, Day 100: 1000
    ghostSpeed = 1.0 + progressionFactor * 2.8;     // Day 6: 1.0, Day 100: 3.8
    ghostDamage = 25 + progressionFactor * 975;     // Day 6: 25, Day 100: 1000
  }

  return {
    mesh: newMesh,
    health: maxGhostHealth,
    maxHealth: maxGhostHealth,
    speed: ghostSpeed,
    damage: Math.round(ghostDamage),
    lastAttackTime: 0
  };
}

function spawnGhostsForDay() {
  activeGhosts.forEach((g) => {
    if (g.mesh) {
      scene.remove(g.mesh);
      g.mesh.traverse((child) => {
        if (child.isMesh) {
          const idx = cullCandidates.indexOf(child);
          if (idx !== -1) cullCandidates.splice(idx, 1);
        }
      });
    }
  });
  activeGhosts.length = 0;

  const targetCount = getGhostCountForDay(currentDay);
  for (let i = 0; i < targetCount; i++) {
    const ghost = spawnGhostInstance();
    if (ghost) {
      activeGhosts.push(ghost);
    }
  }

  if (ghostHealthContainer) {
    ghostHealthContainer.style.display = 'none';
  }
}

function winGame() {
  setUi('You survived the 100 days hauntings!');
  controls.unlock();

  const winScreen = document.getElementById('win-screen');
  if (winScreen) winScreen.classList.remove('hidden');

  canMove = false;
  activeGhosts.forEach((g) => {
    if (g.mesh) {
      scene.remove(g.mesh);
      g.mesh.traverse((child) => {
        if (child.isMesh) {
          const idx = cullCandidates.indexOf(child);
          if (idx !== -1) cullCandidates.splice(idx, 1);
        }
      });
    }
  });
  activeGhosts.length = 0;
}

function clampToCityBounds(x, z) {
  // Keep the player within the overall city boundaries to prevent walking into the void
  if (cityBounds.isEmpty()) {
    return { x, z };
  }

  const clampedX = Math.max(cityBounds.min.x + playerRadius, Math.min(x, cityBounds.max.x - playerRadius));
  const clampedZ = Math.max(cityBounds.min.z + playerRadius, Math.min(z, cityBounds.max.z - playerRadius));

  return { x: clampedX, z: clampedZ };
}

function hasFloor(x, z) {
  groundProbeOrigin.set(x, spawnGroundY + 10, z);
  groundRaycaster.set(groundProbeOrigin, new THREE.Vector3(0, -1, 0));
  groundRaycaster.near = 0;
  groundRaycaster.far = 20;

  if (groundRaycaster.intersectObjects(walkableMeshes, false).length > 0) return true;
  if (groundRaycaster.intersectObjects(collisionMeshes, false).length > 0) return true;

  return false;
}

function isValidPosition(x, z) {
  return !checkSolidCollision(x, z) && hasFloor(x, z);
}

function applyPlayerCollision(currentX, currentZ, nextX, nextZ) {
  // 1. Clamp desired position to city boundaries
  const clamped = clampToCityBounds(nextX, nextZ);
  nextX = clamped.x;
  nextZ = clamped.z;

  // 2. Try the full move first
  if (isValidPosition(nextX, nextZ)) {
    controls.object.position.x = nextX;
    controls.object.position.z = nextZ;
    return true;
  }

  // 3. Full move blocked — try sliding along X axis only
  if (isValidPosition(nextX, currentZ)) {
    controls.object.position.x = nextX;
    controls.object.position.z = currentZ;
    return true;
  }

  // 4. Try sliding along Z axis only
  if (isValidPosition(currentX, nextZ)) {
    controls.object.position.x = currentX;
    controls.object.position.z = nextZ;
    return true;
  }

  // 5. Both axes blocked — don't move at all
  controls.object.position.x = currentX;
  controls.object.position.z = currentZ;
  return false;
}

let introActive = false;

let currentDay = 1;
let dayTimeRemaining = 300; // 5 minutes in seconds
let lastDayTickTime = 0;

function updateDayTimerDisplay() {
  const dayVal = document.getElementById('day-val');
  const timerVal = document.getElementById('day-timer');
  if (dayVal) dayVal.textContent = currentDay;
  if (timerVal) {
    const mins = Math.floor(dayTimeRemaining / 60);
    const secs = dayTimeRemaining % 60;
    timerVal.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}

function showDayTransition() {
  const overlay = document.getElementById('day-transition-overlay');
  const title = document.getElementById('transition-day-title');
  const subtitle = document.getElementById('transition-day-subtitle');
  if (!overlay) return;

  title.textContent = `DAY ${currentDay}`;

  let msg = "Survive the hauntings...";
  if (currentDay === 1) {
    msg = "A faint chill in the air... The hauntings begin.";
  } else if (currentDay <= 5) {
    msg = "The curse grows, but the spirits are still weak.";
  } else if (currentDay === 6) {
    msg = "The initial safety is over. The spirits multiply and grow stronger.";
  } else if (currentDay <= 20) {
    msg = "More ghosts are crossing over. Watch your step.";
  } else if (currentDay <= 50) {
    msg = "The city screams. Ghost presence is escalating.";
  } else if (currentDay <= 75) {
    msg = "The spirits are blindingly fast and lethal. Run.";
  } else if (currentDay < 100) {
    msg = "Survive the endless nightmare. Almost there...";
  } else if (currentDay === 100) {
    msg = "THE FINAL NIGHT. Survive to break the ancient curse!";
  }

  subtitle.textContent = msg;

  overlay.style.display = 'flex';
  overlay.style.opacity = '1';
  overlay.classList.remove('hidden');

  // Fade out and hide after 2.5 seconds
  setTimeout(() => {
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.classList.add('hidden');
    }, 1500);
  }, 2500);
}

function advanceToNextDay() {
  currentDay++;

  if (currentDay > 100) {
    winGame();
    return;
  }

  dayTimeRemaining = 300; // 5 minutes

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('currentDay', currentDay);
  }

  try {
    if (ouchSound && ouchSound.isPlaying) ouchSound.stop();
    if (ouchSound && ouchSound.buffer) ouchSound.play();
  } catch (e) { }

  updatePlayerMaxHealth();
  health = maxHealth;
  updateHealthHUD();

  showDayTransition();
  updateDayTimerDisplay();
  spawnGhostsForDay();
}



function createGlowTexture(colorStr) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, colorStr);
  grad.addColorStop(0.2, colorStr);
  grad.addColorStop(0.5, 'rgba(255, 100, 0, 0.35)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  if ('colorSpace' in tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  return tex;
}

function spawnGlowingLight() {
  if (anomalyGlowSprite) {
    scene.remove(anomalyGlowSprite);
    if (anomalyGlowSprite.material) {
      if (anomalyGlowSprite.material.map) anomalyGlowSprite.material.map.dispose();
      anomalyGlowSprite.material.dispose();
    }
  }
  if (anomalyGlowLight) {
    scene.remove(anomalyGlowLight);
  }

  const texture = createGlowTexture('rgba(255, 60, 0, 1)');
  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false
  });

  anomalyGlowSprite = new THREE.Sprite(spriteMat);
  anomalyGlowSprite.scale.set(6, 6, 1);

  // Position it in front of the camera (looking down the street)
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0; // maintain height relative to floor
  forward.normalize();

  // Position at a closer distance (25 units) in front of the camera
  const targetPos = controls.object.position.clone().add(forward.multiplyScalar(15));
  targetPos.y = spawnGroundY + 1.2; // 1.2m off ground

  anomalyGlowSprite.position.copy(targetPos);

  anomalyGlowLight = new THREE.PointLight(0xff3c00, 4.0, 25);
  anomalyGlowLight.position.copy(targetPos);

  scene.add(anomalyGlowSprite);
  scene.add(anomalyGlowLight);
  console.log('Glowing light spawned at:', targetPos);
}



function loadCity() {
  healthElement = document.getElementById('health-bar');
  healthTextElement = document.getElementById('health-text');
  ghostHealthElement = document.getElementById('ghost-health-bar');
  ghostHealthContainer = document.getElementById('ghost-health-bar-container');

  if (typeof localStorage !== 'undefined') {
    const savedDay = localStorage.getItem('currentDay');
    currentDay = savedDay ? (parseInt(savedDay) || 1) : 1;
  } else {
    currentDay = 1;
  }
  dayTimeRemaining = 300; // 5 minutes in real life
  updateDayTimerDisplay();

  updatePlayerMaxHealth();
  health = maxHealth;
  updateHealthHUD();

  updateTasksUi();

  // Top HUD Buttons & Overlays Wire-up
  const taskMenuBtn = document.getElementById('task-menu-btn');
  const tasksOverlay = document.getElementById('tasks-overlay');
  const phoneBtn = document.getElementById('phone-btn');
  const phoneOverlay = document.getElementById('phone-overlay');
  const phoneCloseBtn = document.getElementById('phone-close-btn');
  const muteBtn = document.getElementById('mute-btn');

  if (taskMenuBtn && tasksOverlay) {
    taskMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      updateTasksUi();
      tasksOverlay.classList.toggle('active');
      if (phoneOverlay) phoneOverlay.classList.remove('active');
      if (tasksOverlay.classList.contains('active')) {
        controls.unlock();
      }
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isMuted = !isMuted;

      // Update AudioListener master volume
      listener.setMasterVolume(isMuted ? 0 : 1.0);

      // Explicitly update all registered THREE.Audio objects to ensure full muting
      const soundConfigs = [
        { ref: gunSound, vol: 0.5 },
        { ref: ouchSound, vol: 0.85 },
        { ref: walkSound, vol: 0.45 },
        { ref: bgMusic, vol: 0.5 }
      ];

      soundConfigs.forEach(s => {
        if (s.ref) {
          s.ref.setVolume(isMuted ? 0 : s.vol);
        }
      });

      if (isMuted) {
        muteBtn.innerHTML = '🔇 Muted';
        muteBtn.classList.add('muted');
      } else {
        muteBtn.innerHTML = '🔊 Sound';
        muteBtn.classList.remove('muted');
      }
    });
  }

  // App switcher listeners
  const appChatBtn = document.getElementById('app-chat-btn');
  const appMapsBtn = document.getElementById('app-maps-btn');
  const appLogsBtn = document.getElementById('app-logs-btn');

  if (appChatBtn) appChatBtn.addEventListener('click', (e) => { e.stopPropagation(); showPhoneScreen('chat'); });
  if (appMapsBtn) appMapsBtn.addEventListener('click', (e) => { e.stopPropagation(); showPhoneScreen('maps'); });
  if (appLogsBtn) appLogsBtn.addEventListener('click', (e) => { e.stopPropagation(); showPhoneScreen('logs'); });

  // Back buttons
  const backBtns = document.querySelectorAll('.phone-back-btn');
  backBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showPhoneScreen('home');
    });
  });

  // Run buttons for SysLogs app
  const runBtns = document.querySelectorAll('.cmd-run-btn');
  const logsConsole = document.getElementById('logs-console');
  const runCommands = { check: false, reboot: false, ping: false };

  runBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cmd = btn.getAttribute('data-cmd');
      if (logsConsole) {
        let response = '';
        if (cmd === 'check') {
          response = '\n> running diagnostics...\nStatus: OK. All systems nominal.';
          runCommands.check = true;
        } else if (cmd === 'reboot') {
          response = '\n> running reboot...\nStatus: OK. reboot sequence completed.';
          runCommands.reboot = true;
        } else if (cmd === 'ping') {
          response = '\n> running ping...\nStatus: OK. Ping time 142ms.';
          runCommands.ping = true;
        }
        logsConsole.textContent += response;
        logsConsole.scrollTop = logsConsole.scrollHeight;

        // Check if all commands have been run
        if (runCommands.check && runCommands.reboot && runCommands.ping) {
          logsConsole.textContent += '\n\n>>> ALL TASKS COMPLETED. Grid sub-station restored.';
          logsConsole.scrollTop = logsConsole.scrollHeight;

          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('questCompleted', 'true');
          }

          // Return to game after a brief pause so player sees console update
          setTimeout(() => {
            if (phoneOverlay) phoneOverlay.classList.remove('active');
            controls.lock();
          }, 1500);
        }
      }
    });
  });

  if (phoneBtn && phoneOverlay) {
    phoneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      phoneOverlay.classList.toggle('active');
      if (tasksOverlay) tasksOverlay.classList.remove('active');
      if (phoneOverlay.classList.contains('active')) {
        controls.unlock();
        // Reset to home screen when opened
        showPhoneScreen('home');
      }
    });
  }

  if (phoneCloseBtn && phoneOverlay) {
    phoneCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHome = !document.getElementById('phone-screen-home').classList.contains('hidden');
      if (isHome) {
        phoneOverlay.classList.remove('active');
      } else {
        showPhoneScreen('home');
      }
    });
  }

  controls.addEventListener('lock', () => {
    if (tasksOverlay) tasksOverlay.classList.remove('active');
    if (phoneOverlay) phoneOverlay.classList.remove('active');
  });

  // --- Audio Loading ---
  // On high-end devices (shouldPreload=true), load all SFX immediately.
  // On low-end devices, defer each SFX load until it is first needed to save RAM.

  function initGunSound(buffer) {
    gunSound.setBuffer(buffer);
    gunSound.setVolume(isMuted ? 0 : 0.5);
  }
  function initOuchSound(buffer) {
    try {
      ouchSound.setBuffer(buffer);
      ouchSound.setVolume(isMuted ? 0 : 0.85);
    } catch (e) {
      console.warn('Failed to initialize ouch sound', e);
    }
  }
  function initWalkSound(buffer) {
    try {
      walkSound.setBuffer(buffer);
      walkSound.setLoop(true);
      walkSound.setVolume(isMuted ? 0 : 0.45);
    } catch (e) {
      console.warn('Failed to initialize walk sound', e);
    }
  }
  function initBgMusic(buffer) {
    try {
      bgMusic.setBuffer(buffer);
      bgMusic.setLoop(true);
      bgMusic.setVolume(isMuted ? 0 : 0.5);
      bgMusic.play();
    } catch (e) {
      console.warn('Failed to initialize horror bg music', e);
    }
  }

  if (shouldPreload) {
    // Eager load all SFX immediately
    audioLoader.load('sfx/gun.mp3', initGunSound);
    audioLoader.load('sfx/ouch.mp3', initOuchSound);
    audioLoader.load('sfx/walk.mp3', initWalkSound);
    audioLoader.load('sfx/horror.mp3', initBgMusic);
  } else {
    // Lazy-load SFX: each sound is fetched on first demand
    // We use flags to ensure we only trigger each load once.
    let gunSoundRequested = false;
    let ouchSoundRequested = false;
    let walkSoundRequested = false;
    let bgMusicRequested = false;

    // Expose lazy-load triggers on the window so they can be called from
    // the shooting/walking/hit/bgmusic code paths.
    window._lazyLoadGunSound = () => {
      if (gunSoundRequested) return;
      gunSoundRequested = true;
      audioLoader.load('sfx/gun.mp3', initGunSound);
    };
    window._lazyLoadOuchSound = () => {
      if (ouchSoundRequested) return;
      ouchSoundRequested = true;
      audioLoader.load('sfx/ouch.mp3', initOuchSound);
    };
    window._lazyLoadWalkSound = () => {
      if (walkSoundRequested) return;
      walkSoundRequested = true;
      audioLoader.load('sfx/walk.mp3', initWalkSound);
    };
    window._lazyLoadBgMusic = () => {
      if (bgMusicRequested) return;
      bgMusicRequested = true;
      audioLoader.load('sfx/horror.mp3', initBgMusic);
    };

    // Trigger background music load right away (it's essential atmosphere)
    window._lazyLoadBgMusic();
  }

  const objLoader = new OBJLoader(loadingManager);
  objLoader.load('models/gun.glb', (obj) => {
    gunMesh = obj;
    gunMesh.traverse((child) => {
      if (child.isMesh) {
        // Dark ancient metal look
        child.material = new THREE.MeshStandardMaterial({
          color: 0x1a1510,
          roughness: 0.6,
          metalness: 0.85,
          emissive: 0x0a0805,
          emissiveIntensity: 0.1
        });
      }
    });

    // Detect mobile and adjust gun position/scale for visibility
    const isMobileDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isMobileDevice) {
      // Larger, more visible gun on mobile — centered at bottom of screen
      gunMesh.position.set(0.2, -0.55, -0.65);
      gunMesh.scale.set(0.028, 0.028, 0.028);
    } else {
      gunMesh.position.set(0.3, -0.4, -0.8);
      gunMesh.scale.set(0.02, 0.02, 0.02);
    }
    gunMesh.rotation.y = Math.PI;

    // Muzzle flash light (dark amber, initially off)
    const muzzleLight = new THREE.PointLight(0xcc6600, 0, 20);
    muzzleLight.position.set(0, 5, 40);
    gunMesh.add(muzzleLight);
    gunMesh.userData.muzzleLight = muzzleLight;

    camera.add(gunMesh);
    scene.add(camera);
  });

  loader.load(
    'models/city.glb',
    (gltf) => {
      cityScene = gltf.scene;
      prepareCityMaterials(cityScene);
      scaleImportedLights(cityScene);
      scene.add(cityScene);

      // Prepare culling candidates for the city to avoid rendering out-of-view meshes
      try {
        collectCullCandidates(cityScene);
      } catch (e) { }

      centerCity(cityScene);
      collectWalkableAreas(cityScene);

      const spawn = getBestRoadSpawn();
      let startPosition = spawn
        ? new THREE.Vector3(spawn.x, spawn.y + playerEyeHeight, spawn.z)
        : new THREE.Vector3(spawnX, spawnGroundY + playerEyeHeight, spawnZ);

      const savedPosStr = localStorage.getItem('playerPosition');
      if (savedPosStr) {
        try {
          const savedPos = JSON.parse(savedPosStr);
          if (savedPos && savedPos.x !== undefined && savedPos.y !== undefined && savedPos.z !== undefined) {
            startPosition.set(savedPos.x, savedPos.y, savedPos.z);
          }
        } catch (e) { console.error('Error parsing saved position', e); }
      }



      if (!spawn) {
        reportIssue('Spawn coordinates are invalid.');
      }
      controls.object.position.copy(startPosition);
      cityReady = true;

      // Update the overlay text to invite interaction
      const textElem = document.getElementById('start-overlay-text');
      if (textElem) textElem.textContent = 'CLICK ANYWHERE TO ENTER';

      const startOverlay = document.getElementById('start-interaction-overlay');
      if (startOverlay) {
        startOverlay.addEventListener('click', () => {
          // Resume Three.js Web Audio context to allow audio playback
          if (listener && listener.context && listener.context.resume) {
            listener.context.resume().then(() => {
              console.log('AudioContext resumed successfully.');
            }).catch(e => console.error('Failed to resume AudioContext:', e));
          }

          // Play background music (if loaded) to bypass autoplay restrictions!
          if (bgMusic && bgMusic.buffer && !bgMusic.isPlaying) {
            bgMusic.play();
          }

          startOverlay.classList.add('hidden');
          setTimeout(() => {
            startOverlay.style.display = 'none';
          }, 600);

          introActive = false;
          canMove = true;
          setUi('WASD move | Mouse look | Click to lock | Shift sprint | E to shoot');
          controls.lock();
          showDayTransition();
        });
      }

      // Load ghost after city is ready so it has walkable areas to spawn in
      loader.load(
        'models/ghost.glb',
        (ghostGltf) => {
          ghostTemplate = ghostGltf.scene;

          // Keep original material, just apply color space fixes
          prepareCityMaterials(ghostTemplate);

          // Add a point light to the ghost so it's always illuminated (since 3D viewers use env maps)
          // Add a subtle, cool-tinted fill so the model isn't completely dark
          // Use a low intensity and short distance so it doesn't wash out colors.
          const ghostLight = new THREE.PointLight(0x99bbff, 0.35, 6, 2);
          ghostLight.position.set(0, 1.2, 0);
          ghostLight.castShadow = false;
          ghostTemplate.add(ghostLight);

          // Also gently clamp any emissive on the model so emissive materials
          // don't appear overly bright compared to textures. Additionally,
          // normalize metalness/roughness so PBR lighting doesn't wash out the albedo.
          ghostTemplate.traverse((child) => {
            if (!child.isMesh) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
              if (!m) return;
              // Ensure the albedo map is applied and visible
              if (m.map) {
                if ('colorSpace' in m.map) m.map.colorSpace = THREE.SRGBColorSpace;
                if ('encoding' in m.map) m.map.encoding = THREE.sRGBEncoding;
                m.map.needsUpdate = true;
              }

              // Tone down emissive so it doesn't override the albedo
              if (m.emissive && m.emissive.isColor) {
                m.emissive.setHex(0x000000);
              }
              if ('emissiveIntensity' in m) m.emissiveIntensity = 0;

              // Favor non-metal, moderately rough surfaces for visible color
              if ('metalness' in m) m.metalness = Math.min(m.metalness || 0, 0.15);
              if ('roughness' in m) m.roughness = Math.max(m.roughness || 1, 0.5);

              // Ensure the material updates
              m.needsUpdate = true;
            });
          });

          // Scale it appropriately (may need adjustment depending on model)
          ghostTemplate.scale.set(0.05, 0.05, 0.05);

          // Inspect GLTF JSON for images/materials and try to recover
          // diffuse textures if the model used the KHR_materials_pbrSpecularGlossiness extension
          try {
            const parser = ghostGltf.parser;
            const json = parser ? parser.json : null;
            if (json) {


              // Build a map of materialName -> diffuseTextureIndex for spec-gloss materials
              const specGlossMap = {};
              if (Array.isArray(json.materials)) {
                json.materials.forEach((mat, idx) => {
                  if (mat && mat.extensions && mat.extensions.KHR_materials_pbrSpecularGlossiness) {
                    const ext = mat.extensions.KHR_materials_pbrSpecularGlossiness;
                    if (ext.diffuseTexture && typeof ext.diffuseTexture.index === 'number') {
                      specGlossMap[mat.name || `mat_${idx}`] = ext.diffuseTexture.index;
                    }
                  }
                });
              }

              // Attempt to attach textures to scene materials when missing
              const attachPromises = [];
              ghostTemplate.traverse((child) => {
                if (!child.isMesh) return;
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m) => {
                  if (!m) return;
                  const matName = m.name || '';
                  const texIndex = specGlossMap[matName];
                  if (texIndex !== undefined && !m.map) {
                    // Use parser to load the texture dependency
                    const p = parser.getDependency('texture', texIndex).then((tex) => {
                      // Ensure correct encoding for color textures
                      if (tex) {
                        if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
                        if ('encoding' in tex) tex.encoding = THREE.sRGBEncoding;
                        m.map = tex;
                        m.needsUpdate = true;
                      }
                    }).catch((e) => {
                      console.warn('Failed to load texture index', texIndex, e);
                    });
                    attachPromises.push(p);
                  }
                });
              });

              if (attachPromises.length > 0) {
                Promise.all(attachPromises).then(() => {
                });
              } else {

              }
            }
          } catch (e) {
            console.warn('Error while inspecting ghost GLTF:', e);
          }

          spawnGhostsForDay();
        },
        undefined,
        (error) => console.error('Error loading ghost:', error)
      );
    },
    (progress) => {
      if (progress.total > 0) {
        const percent = Math.floor((progress.loaded / progress.total) * 100);
        setUi(`Loading city... ${percent}%`);
        const textElem = document.getElementById('start-overlay-text');
        if (textElem) textElem.textContent = `LOADING CITY... ${percent}%`;
      } else {
        setUi('Loading city...');
        const textElem = document.getElementById('start-overlay-text');
        if (textElem) textElem.textContent = 'LOADING CITY...';
      }
    },
    (error) => {
      console.error('Failed to load city.glb.', error);
      setUi('Failed to load city.');
    }
  );
}

function onKeyDown(event) {
  switch (event.code) {
    case 'KeyW':
      moveForward = true;
      break;
    case 'KeyS':
      moveBackward = true;
      break;
    case 'KeyA':
      moveLeft = true;
      break;
    case 'KeyD':
      moveRight = true;
      break;
    case 'KeyE':
      if (controls.isLocked) isShooting = true;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      moveSpeedMultiplier = 1.75;
      break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case 'KeyW':
      moveForward = false;
      break;
    case 'KeyS':
      moveBackward = false;
      break;
    case 'KeyA':
      moveLeft = false;
      break;
    case 'KeyD':
      moveRight = false;
      break;
    case 'KeyE':
      isShooting = false;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      moveSpeedMultiplier = 1;
      break;
  }
}

let moveSpeedMultiplier = 1;

function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
}

document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);
document.addEventListener('click', () => {
  if (!cityReady || introActive) {
    return;
  }

  controls.lock();
});

document.addEventListener('mousedown', (event) => {
  if (controls.isLocked && event.button === 0) {
    isShooting = true;
  }
});

document.addEventListener('mouseup', (event) => {
  if (event.button === 0) {
    isShooting = false;
  }
});

const respawnButton = document.getElementById('respawn-button');
if (respawnButton) {
  respawnButton.addEventListener('click', () => {
    const spawn = getBestRoadSpawn();
    controls.object.position.set(spawn.x, spawn.y + playerEyeHeight, spawn.z);
    localStorage.removeItem('playerPosition');

    // Reset day and timer on death
    currentDay = 1;
    dayTimeRemaining = 300; // 5 minutes in real life
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('currentDay', 1);
    }
    updateDayTimerDisplay();

    updatePlayerMaxHealth();
    health = maxHealth;
    updateHealthHUD();

    // Reset Win Screen visibility if active
    const winScreen = document.getElementById('win-screen');
    if (winScreen) winScreen.classList.add('hidden');

    // Enable movement and spawn ghosts for Day 1
    canMove = true;
    spawnGhostsForDay();

    const gameOverScreen = document.getElementById('game-over-screen');
    if (gameOverScreen) gameOverScreen.classList.add('hidden');

    // Lock controls again to resume playing
    controls.lock();

    // Show Day 1 transition again
    showDayTransition();
  });
}

// Win Screen Restart Button Handler
const restartButton = document.getElementById('restart-button');
if (restartButton) {
  restartButton.addEventListener('click', () => {
    const spawn = getBestRoadSpawn();
    controls.object.position.set(spawn.x, spawn.y + playerEyeHeight, spawn.z);
    localStorage.removeItem('playerPosition');

    // Reset day and timer
    currentDay = 1;
    dayTimeRemaining = 300; // 5 minutes
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('currentDay', 1);
    }
    updateDayTimerDisplay();

    updatePlayerMaxHealth();
    health = maxHealth;
    updateHealthHUD();

    // Reset Win Screen visibility
    const winScreen = document.getElementById('win-screen');
    if (winScreen) winScreen.classList.add('hidden');

    // Enable movement and spawn ghosts for Day 1
    canMove = true;
    spawnGhostsForDay();

    // Lock controls again to resume playing
    controls.lock();

    // Show Day 1 transition again
    showDayTransition();
  });
}

controls.addEventListener('lock', () => {
  if (cityReady) {
    setUi('WASD move | Mouse look | Shift sprint | Esc unlock | E to shoot');
    if (bgMusic && bgMusic.buffer && !bgMusic.isPlaying) {
      bgMusic.play();
    }
  }
});

controls.addEventListener('unlock', () => {
  if (cityReady) {
    setUi('WASD move | Mouse look | Click to lock | Shift sprint | E to shoot');
  }
});

window.addEventListener('resize', handleResize);

// --- Mobile touch controls: glassmorphism joystick (fixed) + shoot + sprint + swipe to look ---
const mobile = {
  joystick: {
    active: false,
    id: null,
    centerX: 0,  // center of the fixed joystick base
    centerY: 0,
    knob: null,
    base: null,
    maxRadius: 50
  },
  lookId: null,
  lookLastX: 0,
  lookLastY: 0,
  shootId: null,
  sprintId: null
};

function createMobileUi() {
  // ── Joystick base (FIXED position — stays in place) ──
  const base = document.createElement('div');
  base.id = 'joystick-base';
  // All styles in CSS — glassmorphism horror theme

  const knob = document.createElement('div');
  knob.id = 'joystick-knob';
  // All styles in CSS
  base.appendChild(knob);
  document.body.appendChild(base);

  // ── Shoot button — modern horror glassmorphism ──
  const shootBtn = document.createElement('button');
  shootBtn.id = 'shoot-btn';
  // Text content handled by CSS ::before pseudo-element (⊕ icon)
  shootBtn.innerText = '';
  document.body.appendChild(shootBtn);

  // ── Sprint button ──
  const sprintBtn = document.createElement('button');
  sprintBtn.id = 'sprint-btn';
  sprintBtn.innerText = '';
  document.body.appendChild(sprintBtn);

  mobile.joystick.base = base;
  mobile.joystick.knob = knob;

  // Calculate fixed joystick center position
  // (matches CSS: left 20px, bottom 28px, width/height 130px)
  // Center = left + width/2, bottom + height/2 from bottom-left
  requestAnimationFrame(() => {
    const rect = base.getBoundingClientRect();
    mobile.joystick.centerX = rect.left + rect.width / 2;
    mobile.joystick.centerY = rect.top + rect.height / 2;
  });

  // ── Shoot button touch handlers ──
  shootBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    mobile.shootId = e.changedTouches[0].identifier;
    isShooting = true;
    shootBtn.classList.add('pressed');
  }, { passive: false });
  shootBtn.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === mobile.shootId) {
        isShooting = false;
        mobile.shootId = null;
        shootBtn.classList.remove('pressed');
        break;
      }
    }
  });
  shootBtn.addEventListener('touchcancel', () => {
    isShooting = false;
    mobile.shootId = null;
    shootBtn.classList.remove('pressed');
  });

  // ── Sprint button touch handlers ──
  sprintBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    mobile.sprintId = e.changedTouches[0].identifier;
    moveSpeedMultiplier = 1.75;
    sprintBtn.classList.add('active');
  }, { passive: false });
  sprintBtn.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === mobile.sprintId) {
        moveSpeedMultiplier = 1;
        mobile.sprintId = null;
        sprintBtn.classList.remove('active');
        break;
      }
    }
  });
  sprintBtn.addEventListener('touchcancel', () => {
    moveSpeedMultiplier = 1;
    mobile.sprintId = null;
    sprintBtn.classList.remove('active');
  });
}

function resetJoystick() {
  mobile.joystick.active = false;
  mobile.joystick.id = null;
  if (mobile.joystick.knob) {
    mobile.joystick.knob.style.transform = 'translate(0px, 0px)';
    mobile.joystick.knob.classList.remove('active');
  }
  moveForward = moveBackward = moveLeft = moveRight = false;
}

function onTouchStart(e) {
  if (introActive) return;
  for (const t of e.changedTouches) {
    const x = t.clientX, y = t.clientY;
    const w = window.innerWidth;

    // Check if touch is on the joystick base area (left side, fixed position)
    if (mobile.joystick.base && !mobile.joystick.active) {
      const rect = mobile.joystick.base.getBoundingClientRect();
      // Expand touch area slightly for easier grab
      const padding = 20;
      if (x >= rect.left - padding && x <= rect.right + padding &&
        y >= rect.top - padding && y <= rect.bottom + padding) {
        mobile.joystick.active = true;
        mobile.joystick.id = t.identifier;
        // Use the fixed center of the base — NOT the touch start position
        mobile.joystick.centerX = rect.left + rect.width / 2;
        mobile.joystick.centerY = rect.top + rect.height / 2;
        if (mobile.joystick.knob) mobile.joystick.knob.classList.add('active');
        continue;
      }
    }

    // Skip if this touch is on shoot/sprint buttons (handled by their own listeners)
    const target = e.target || document.elementFromPoint(x, y);
    if (target && (target.id === 'shoot-btn' || target.id === 'sprint-btn')) {
      continue;
    }

    // Right portion or upper area -> look control
    if (x >= w * 0.35) {
      mobile.lookId = t.identifier;
      mobile.lookLastX = x;
      mobile.lookLastY = y;
    }
  }
}

function onTouchMove(e) {
  if (introActive) return;
  e.preventDefault(); // Prevent scrolling/bouncing on mobile
  for (const t of e.changedTouches) {
    const x = t.clientX, y = t.clientY;
    if (mobile.joystick.active && t.identifier === mobile.joystick.id) {
      // Calculate delta from the FIXED center of the joystick base
      const dx = x - mobile.joystick.centerX;
      const dy = y - mobile.joystick.centerY;
      const maxR = mobile.joystick.maxRadius;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const clampedDist = Math.min(dist, maxR);
      const angle = Math.atan2(dy, dx);
      const clampedX = clampedDist * Math.cos(angle);
      const clampedY = clampedDist * Math.sin(angle);
      const normX = clampedX / maxR;
      const normY = clampedY / maxR;

      // Move only the knob visually (base stays fixed)
      if (mobile.joystick.knob) {
        mobile.joystick.knob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
      }

      // Thresholded movement
      moveForward = normY < -0.2;
      moveBackward = normY > 0.2;
      moveRight = normX > 0.2;
      moveLeft = normX < -0.2;
    }

    if (mobile.lookId !== null && t.identifier === mobile.lookId) {
      const dx = x - mobile.lookLastX;
      const dy = y - mobile.lookLastY;
      mobile.lookLastX = x;
      mobile.lookLastY = y;
      const sensitivity = 0.003;

      // Use YXZ Euler rotation to prevent camera roll/tilt
      const euler = new THREE.Euler(0, 0, 0, 'YXZ');
      euler.setFromQuaternion(camera.quaternion);
      euler.y -= dx * sensitivity;
      euler.x -= dy * sensitivity;

      const maxPitch = Math.PI / 2 - 0.05;
      euler.x = Math.max(-maxPitch, Math.min(maxPitch, euler.x));
      euler.z = 0; // Enforce no sideways roll

      camera.quaternion.setFromEuler(euler);
    }
  }
}

function onTouchEnd(e) {
  if (introActive) return;
  for (const t of e.changedTouches) {
    if (mobile.joystick.active && t.identifier === mobile.joystick.id) {
      resetJoystick();
    }
    if (mobile.lookId !== null && t.identifier === mobile.lookId) {
      mobile.lookId = null;
    }
    if (mobile.shootId !== null && t.identifier === mobile.shootId) {
      isShooting = false;
      mobile.shootId = null;
      const shootBtn = document.getElementById('shoot-btn');
      if (shootBtn) shootBtn.classList.remove('pressed');
    }
    if (mobile.sprintId !== null && t.identifier === mobile.sprintId) {
      moveSpeedMultiplier = 1;
      mobile.sprintId = null;
      const sprintBtn = document.getElementById('sprint-btn');
      if (sprintBtn) sprintBtn.classList.remove('active');
    }
  }
}

// Initialize mobile UI only when a touch interaction is detected (lazy)
let mobileUiInitialized = false;
function ensureMobileUi() {
  if (!mobileUiInitialized) {
    createMobileUi();
    mobileUiInitialized = true;
    // On mobile, skip pointer lock and allow free movement immediately
    canMove = !introActive;
  }
}

document.addEventListener('touchstart', (e) => { ensureMobileUi(); onTouchStart(e); }, { passive: false });
document.addEventListener('touchmove', (e) => onTouchMove(e), { passive: false });
document.addEventListener('touchend', (e) => onTouchEnd(e), { passive: false });
document.addEventListener('touchcancel', (e) => onTouchEnd(e), { passive: false });

function updateMovement(delta) {
  // Allow movement when pointer lock is active OR when mobile joystick is used.
  const isMenuOpen = document.getElementById('tasks-overlay')?.classList.contains('active') ||
    document.getElementById('phone-overlay')?.classList.contains('active');
  if (!canMove || isMenuOpen || (!controls.isLocked && !mobile.joystick.active)) {
    if (walkSound && walkSound.isPlaying) {
      walkSound.stop();
    }
    return;
  }

  // Store current position BEFORE any movement
  const currentX = controls.object.position.x;
  const currentZ = controls.object.position.z;

  direction.set(
    Number(moveRight) - Number(moveLeft),
    0,
    Number(moveForward) - Number(moveBackward)
  ).normalize();

  const speed = moveSpeed * moveSpeedMultiplier;
  if (moveForward || moveBackward) {
    controls.moveForward(direction.z * speed * delta);
  }

  if (moveLeft || moveRight) {
    controls.moveRight(direction.x * speed * delta);
  }

  // Capture where PointerLockControls wants to move
  const nextX = controls.object.position.x;
  const nextZ = controls.object.position.z;

  // Reset position back — let collision function decide final placement
  controls.object.position.x = currentX;
  controls.object.position.z = currentZ;

  // Apply collision detection with axis-separated sliding and boundary clamping
  applyPlayerCollision(currentX, currentZ, nextX, nextZ);

  controls.object.position.y = spawnGroundY + playerEyeHeight;

  // Adjust moveLight target position relative to camera forward direction
  // Compute forward vector and place target further ahead
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  moveLightTarget.position.copy(forward.clone().multiplyScalar(6));

  // Smoothly change intensity: strong when moving, low when idle
  const moving = moveForward || moveBackward || moveLeft || moveRight;
  const desiredIntensity = moving ? 2.2 : 0.15;
  moveLight.intensity = THREE.MathUtils.lerp(moveLight.intensity, desiredIntensity, Math.min(1, delta * 8));

  if (moving) {
    if (walkSound && walkSound.buffer) {
      if (!walkSound.isPlaying) {
        walkSound.play();
      }
      walkSound.setPlaybackRate(moveSpeedMultiplier === 1.75 ? 1.45 : 1.0);
    } else if (!shouldPreload && window._lazyLoadWalkSound) {
      // Lazy-load walk sound on first footstep (low-end devices)
      window._lazyLoadWalkSound();
    }
  } else {
    if (walkSound && walkSound.isPlaying) {
      walkSound.stop();
    }
  }

  // Save position periodically
  if (health > 0 && clock.elapsedTime - lastSaveTime > 1) {
    localStorage.setItem('playerPosition', JSON.stringify({
      x: controls.object.position.x,
      y: controls.object.position.y,
      z: controls.object.position.z
    }));
    lastSaveTime = clock.elapsedTime;
  }

  // Display coordinates always
  const x = controls.object.position.x.toFixed(2);
  const z = controls.object.position.z.toFixed(2);
  const coordText = `X: ${x} | Z: ${z}`;
  if (cityReady && (controls.isLocked || isMobile)) {
    setUi(`${coordText} | WASD move | Shift sprint | Esc unlock | E to shoot`);
  }
}

let animFrameId = null;

function animate() {
  animFrameId = requestAnimationFrame(animate);

  // Update FPS counter using high-resolution timestamps
  try {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const frameMs = now - lastFrameTimeForFps;
    lastFrameTimeForFps = now;
    const fps = frameMs > 0 ? 1000 / frameMs : 0;
    if (!fpsElem) createFpsCounter();
    if (fpsElem) fpsElem.textContent = `${Math.round(fps)} FPS`;
  } catch (e) { }

  const delta = Math.min(clock.getDelta(), 0.05);
  updateMovement(delta);

  // Pulse the glowing light anomaly if present
  if (anomalyGlowSprite && anomalyGlowLight) {
    const elapsed = clock.elapsedTime;
    const pulse = Math.sin(elapsed * 4.0) * 0.15 + 1.0;
    anomalyGlowSprite.scale.set(6 * pulse, 6 * pulse, 1);
    anomalyGlowLight.intensity = 3.5 * (Math.sin(elapsed * 8.0) * 0.2 + 1.0);
  }

  // Keep flashlight target perfectly in front of the camera in world space
  if (moveLightTarget && camera) {
    camera.getWorldDirection(moveLightTarget.position);
    moveLightTarget.position.multiplyScalar(100);
    moveLightTarget.position.add(camera.position);
  }

  // Tick the day timer
  const currentEpoch = clock.elapsedTime;
  if (currentEpoch - lastDayTickTime >= 1.0) {
    lastDayTickTime = currentEpoch;
    if (canMove && !introActive && health > 0 && (controls.isLocked || isMobile)) {
      dayTimeRemaining--;
      if (dayTimeRemaining <= 0) {
        advanceToNextDay();
      } else {
        updateDayTimerDisplay();
      }
    }
  }

  // Proximity check for the utility tunnel hatch (X: -4.30, Z: 8.07)
  const isAnomalyDestroyed = typeof localStorage !== 'undefined' && localStorage.getItem('anomalyDestroyed') === 'true';
  const isEnteredTunnel = typeof localStorage !== 'undefined' && localStorage.getItem('enteredTunnel') === 'true';
  if (isAnomalyDestroyed && !isEnteredTunnel) {
    const dx = controls.object.position.x - (-4.30);
    const dz = controls.object.position.z - 8.07;
    const distToTunnel = Math.sqrt(dx * dx + dz * dz);
    if (distToTunnel < 2.5) {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('enteredTunnel', 'true');
      }
      updateTasksUi();
      console.log('Player entered the utility tunnel hatch.');
    }
  }

  // Ghost movement and attack logic
  activeGhosts.forEach((ghost) => {
    if (ghost.mesh && ghost.mesh.visible) {
      const dx = controls.object.position.x - ghost.mesh.position.x;
      const dz = controls.object.position.z - ghost.mesh.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      if (distance > 1.5) { // Don't get uncomfortably close
        ghost.mesh.position.x += (dx / distance) * ghost.speed * delta;
        ghost.mesh.position.z += (dz / distance) * ghost.speed * delta;
        // Make ghost face the player
        ghost.mesh.lookAt(controls.object.position.x, ghost.mesh.position.y, controls.object.position.z);
      } else {
        // Attack player
        if (clock.elapsedTime - ghost.lastAttackTime > 1.0) {
          health -= ghost.damage;
          updateHealthHUD();
          ghost.lastAttackTime = clock.elapsedTime;
          // Flash screen red and play 'ouch' sound when player is hit
          try {
            flashScreenRed(140);
          } catch (e) { }
          try {
            if (ouchSound && ouchSound.isPlaying) ouchSound.stop();
            if (ouchSound && ouchSound.buffer) ouchSound.play();
            else if (!shouldPreload && window._lazyLoadOuchSound) window._lazyLoadOuchSound();
          } catch (e) { }

          if (health <= 0) {
            setUi('You were killed by the ghosts!');

            // Free the mouse pointer so the user can click the button
            controls.unlock();

            const gameOverScreen = document.getElementById('game-over-screen');
            if (gameOverScreen) gameOverScreen.classList.remove('hidden');
          }
        }
      }
    }
  });

  if (isShooting && gunMesh && clock.elapsedTime - lastShootTime > shootRate) {
    if (gunSound.buffer) {
      if (gunSound.isPlaying) gunSound.stop();
      gunSound.play();
    } else if (!shouldPreload && window._lazyLoadGunSound) {
      // Lazy-load gun sound on first shot (low-end devices)
      window._lazyLoadGunSound();
    }

    // Quick recoil animation
    gunMesh.position.z = -0.7;

    // Muzzle flash on
    if (gunMesh.userData.muzzleLight) gunMesh.userData.muzzleLight.intensity = 5;

    setTimeout(() => {
      if (gunMesh) {
        gunMesh.position.z = -0.8;
        if (gunMesh.userData.muzzleLight) gunMesh.userData.muzzleLight.intensity = 0;
      }
    }, 50);

    // Raycast hit detection against all active ghosts
    if (activeGhosts.length > 0) {
      shootRaycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      let hitGhost = null;
      let closestDistance = Infinity;

      activeGhosts.forEach((ghost) => {
        if (ghost.mesh && ghost.mesh.visible) {
          const hits = shootRaycaster.intersectObject(ghost.mesh, true);
          if (hits.length > 0 && hits[0].distance < closestDistance) {
            closestDistance = hits[0].distance;
            hitGhost = ghost;
          }
        }
      });

      if (hitGhost) {
        // We hit the ghost!
        hitGhost.health -= 20;
        if (ghostHealthElement) {
          ghostHealthElement.style.width = Math.max(0, (hitGhost.health / hitGhost.maxHealth) * 100) + '%';
        }
        if (ghostHealthContainer) {
          ghostHealthContainer.style.display = 'block';
        }

        if (hitGhost.health <= 0) {
          scene.remove(hitGhost.mesh);
          hitGhost.mesh.traverse((child) => {
            if (child.isMesh) {
              const idx = cullCandidates.indexOf(child);
              if (idx !== -1) cullCandidates.splice(idx, 1);
            }
          });

          const ghostIndex = activeGhosts.indexOf(hitGhost);
          if (ghostIndex !== -1) {
            activeGhosts.splice(ghostIndex, 1);
          }

          score += 10;
          const scoreElem = document.getElementById('score');
          if (scoreElem) scoreElem.innerText = score;

          // Update tasks UI so player sees the quest objective completed
          updateTasksUi();

          // Respawn it after a short delay (3 seconds) to keep the ghost count at targetCount
          setTimeout(() => {
            if (activeGhosts.length < getGhostCountForDay(currentDay) && health > 0 && !introActive && (controls.isLocked || isMobile)) {
              const newGhost = spawnGhostInstance();
              if (newGhost) {
                activeGhosts.push(newGhost);
              }
            }
          }, 3000);
        }
      }
    }

    // Raycast hit detection for the glowing light anomaly
    if (anomalyGlowSprite) {
      shootRaycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hits = shootRaycaster.intersectObject(anomalyGlowSprite, false);
      if (hits.length > 0) {
        scene.remove(anomalyGlowSprite);
        scene.remove(anomalyGlowLight);
        if (anomalyGlowSprite.material) {
          if (anomalyGlowSprite.material.map) anomalyGlowSprite.material.map.dispose();
          anomalyGlowSprite.material.dispose();
        }
        anomalyGlowSprite = null;
        anomalyGlowLight = null;
        console.log('Player shot and destroyed the glowing light anomaly.');
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('anomalyDestroyed', 'true');
        }
        updateTasksUi();
      }
    }

    lastShootTime = clock.elapsedTime;
  }

  // Manual frustum culling pass for registered candidates to avoid
  // rendering meshes outside the camera frustum.
  try {
    scene.updateMatrixWorld();
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);
    for (let i = 0; i < cullCandidates.length; i++) {
      const obj = cullCandidates[i];
      if (!obj) continue;
      // If object has been removed from scene, skip
      if (!obj.parent) continue;
      // frustum.intersectsObject will rely on geometry.boundingSphere
      const visible = frustum.intersectsObject(obj);
      obj.visible = visible;
    }
  } catch (e) { }

  // Update phone map if the map screen is active
  try {
    const mapsScreen = document.getElementById('phone-screen-maps');
    const phoneOverlay = document.getElementById('phone-overlay');
    if (mapsScreen && !mapsScreen.classList.contains('hidden') && phoneOverlay && phoneOverlay.classList.contains('active')) {
      updatePhoneMap();
    }
  } catch (e) { }

  renderer.render(scene, camera);
}

setUi('Loading city...');
loadCity();
animate();


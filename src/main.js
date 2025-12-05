import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HandLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';
import { Pane } from 'tweakpane';
import fireworkImageUrl from './assert/pt1.jpg';
import img1Url from './assert/pt1.jpg';
import img2Url from './assert/pt2.jpg';
import img3Url from './assert/pt3.jpg';
import img4Url from './assert/pt4.jpg';
import img5Url from './assert/pt5.png';
import img6Url from './assert/pt6.jpg';
import img7Url from './assert/pt7.jpg';
import img8Url from './assert/pt8.jpg';
import img9Url from './assert/pt9.jpg';

import './styles.css'
// --- 常量配置 ---
const MEDIAPIPE_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm';
const HAND_LANDMARKER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const PARTICLES_COUNT = 100000;
const POINTING_THRESHOLD = 0.07; // **强化修改 1：提高指向的检测阈值 (原为 0.04)**
const VIEW_PHOTO_SCALE = 2.5;
const AUTO_CYCLE_INTERVAL = 5000;
const MANUAL_COOLDOWN_TIME = 700; // **强化修改 2：增加手动切换的冷却时间 (原为 500ms)**
const POINTING_HOLD_TIME = 1000;  // 右手食指指向屏幕，选择当前照片需要停留的时间 (ms)
const RIGHT_SWING_DISTANCE_THRESHOLD = 0.08; // 右手左右摆动的最小位移
const RIGHT_SWING_TIME_THRESHOLD = 250;      // 右手左右摆动的时间阈值 (ms)

// --- 全局状态 ---
let handLandmarker;
let particles;
let particleMaterial;
const currentPositions = new Float32Array(PARTICLES_COUNT * 3);
const targetPositions = new Float32Array(PARTICLES_COUNT * 3);
const initialColors = new Float32Array(PARTICLES_COUNT * 3);
const targetColors = new Float32Array(PARTICLES_COUNT * 3);

// 状态
const MODES = {
    SHAPE: 'SHAPE',
    VIEW_PHOTO: 'VIEW_PHOTO'
};
let currentMode = MODES.SHAPE;
let loadedImages = [];
let selectedPhotoIndex = -1;

// 图像采样点 (Firework)
let imageSamplePoints = [];
let imageLoaded = false;

// --- 自动循环播放状态 ---
let lastCycleTime = performance.now();
let isAutoCycling = true;
let lastManualChangeTime = 0; // 记录上一次手动切换的时间
let isRotationPaused = false; // 由右手控制旋转暂停/恢复
let lastPointingStartTime = 0; // 记录右手开始 POINTING 的时间
let lastRightWristX = null;    // 记录右手手腕上一帧的 X 坐标
let lastRightSwingTime = 0;    // 上一次识别到左右摆动的时间
let photoAngleY = 0;          // 查看图片模式下的当前 Y 轴角度
let lastSideFactor = 0;       // 上一帧的侧面因子，用于检测经过“侧边”
let photoTiltDir = 1;         // 当前一次“抬头/低头”的方向 (1 向上, -1 向下)

// UI 参数
const PARAMS = {
    model: 'sphere',
    color: 'rgba(51, 146, 255, 1)',
    particleSize: 0.43,
};
async function loadDefaultImages() {
    const urls = [img1Url, img2Url, img3Url, img4Url, img5Url, img6Url, img7Url, img8Url, img9Url];

    loadedImages = [];

    for (const url of urls) {
        const img = await loadImageAsPoints(url);
        loadedImages.push(img);
    }

    console.log(`默认图片已加载: ${loadedImages.length} 张`);

    // 启动图片模式
    if (loadedImages.length > 0) {
        currentMode = MODES.VIEW_PHOTO;
        selectedPhotoIndex = 0;
        isAutoCycling = true;
        lastCycleTime = performance.now();
        updateTargetShape();
    }
}
async function loadImageAsPoints(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.src = url;
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // 启动阶段使用较小分辨率，减少卡顿
            const size = 512;
            const scale = Math.min(size / img.width, size / img.height);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;

            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

            const points = [];
            for (let y = 0; y < canvas.height; y += 1) {
                for (let x = 0; x < canvas.width; x += 1) {
                    const i = (y * canvas.width + x) * 4;
                    if (data[i + 3] > 50) {
                        points.push({
                            x: (x / canvas.width - 0.5) * 2 * (canvas.width / canvas.height),
                            y: -(y / canvas.height - 0.5) * 2,
                            r: data[i] / 255,
                            g: data[i + 1] / 255,
                            b: data[i + 2] / 255
                        });
                    }
                }
            }

            // 限制粒子数
            if (points.length > PARTICLES_COUNT) {
                points.sort(() => 0.5 - Math.random());
                points.length = PARTICLES_COUNT;
            }

            resolve({ points });
        };
    });
}

// --- 辅助函数：加载图片采样 (略) ---
function loadFireworkImageSamples() {
    const img = new Image();
    img.src = fireworkImageUrl;
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const maxSize = 256;
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = Math.floor(img.width * scale);
        canvas.height = Math.floor(img.height * scale);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        imageSamplePoints = [];
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                const idx = (y * canvas.width + x) * 4;
                if (data[idx + 3] > 20 && (data[idx] + data[idx + 1] + data[idx + 2]) / 3 > 50) {
                    imageSamplePoints.push({
                        x: (x / canvas.width) * 2 - 1,
                        y: 1 - (y / canvas.height) * 2
                    });
                }
            }
        }
        imageLoaded = true;
        if (PARAMS.model === 'Firework') updateTargetShape();
    };
}
loadFireworkImageSamples();

// --- 场景初始化 (略) ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 4;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio || 1);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// --- 粒子系统初始化 (略) ---
function initParticles() {
    const geometry = new THREE.BufferGeometry();
    for (let i = 0; i < PARTICLES_COUNT * 3; i++) {
        currentPositions[i] = (Math.random() - 0.5) * 10;
        targetPositions[i] = currentPositions[i];
        initialColors[i] = 1.0;
        targetColors[i] = 1.0;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(currentPositions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(initialColors, 3));
    particleMaterial = new THREE.PointsMaterial({
        size: PARAMS.particleSize * 0.12,
        vertexColors: true,
        blending: THREE.NormalBlending,
        depthTest: false,
        transparent: true,
        opacity: 1.0
    });
    particles = new THREE.Points(geometry, particleMaterial);
    scene.add(particles);
    updateTargetShape();
}

// --- 切换到上一张照片的逻辑 (略) ---
function switchToPreviousPhoto() {
    if (loadedImages.length > 1) {
        selectedPhotoIndex = (selectedPhotoIndex - 1 + loadedImages.length) % loadedImages.length;
        updateTargetShape();
    }
}

// --- 核心逻辑：更新目标形状 (略) ---
function updateTargetShape() {
    const type = PARAMS.model;
    const color = new THREE.Color(PARAMS.color);

    if (currentMode === MODES.SHAPE) {
        for (let i = 0; i < PARTICLES_COUNT; i++) {
            const i3 = i * 3;
            let x, y, z;
            if (type === 'Heart') {
                const t = Math.random() * Math.PI * 2;
                const r = 0.8 + Math.random() * 0.7; // 半径范围更大，让爱心整体更大更蓬松
                x = 16 * Math.pow(Math.sin(t), 3);
                y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
                z = (Math.random() - 0.5) * 6; // 稍微加厚 Z 方向
                const scale = 0.07; // 放大整体尺寸
                targetPositions[i3] = x * scale * r;
                targetPositions[i3 + 1] = y * scale * r;
                targetPositions[i3 + 2] = z * scale * r;
            } else if (type === 'Firework' && imageLoaded && imageSamplePoints.length > 0) {
                const p = imageSamplePoints[Math.floor(Math.random() * imageSamplePoints.length)];
                targetPositions[i3] = p.x * 2.0;
                targetPositions[i3 + 1] = p.y * 2.0;
                targetPositions[i3 + 2] = (Math.random() - 0.5) * 0.5;
            } else { // Sphere
                const r = Math.random() * 2;
                const theta = Math.random() * Math.PI * 2;
                const phi = Math.acos(Math.random() * 2 - 1);
                targetPositions[i3] = r * Math.sin(phi) * Math.cos(theta);
                targetPositions[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
                targetPositions[i3 + 2] = r * Math.cos(phi);
            }
            targetColors[i3] = color.r;
            targetColors[i3 + 1] = color.g;
            targetColors[i3 + 2] = color.b;
        }
    }
    else if (currentMode === MODES.VIEW_PHOTO && selectedPhotoIndex >= 0 && loadedImages.length > 0) {
        selectedPhotoIndex = selectedPhotoIndex % loadedImages.length;
        if (selectedPhotoIndex < 0) selectedPhotoIndex += loadedImages.length;

        const img = loadedImages[selectedPhotoIndex];
        const numImagePoints = img.points.length;

        for (let i = 0; i < PARTICLES_COUNT; i++) {
            const i3 = i * 3;

            if (i < numImagePoints) {
                const p = img.points[i % numImagePoints];

                targetPositions[i3] = p.x * VIEW_PHOTO_SCALE;
                targetPositions[i3 + 1] = p.y * VIEW_PHOTO_SCALE;
                targetPositions[i3 + 2] = (Math.random() - 0.5) * 0.2;
                targetColors[i3] = p.r;
                targetColors[i3 + 1] = p.g;
                targetColors[i3 + 2] = p.b;
            } else {
                targetPositions[i3] = 0;
                targetPositions[i3 + 1] = 0;
                targetPositions[i3 + 2] = 0;
                targetColors[i3] = 0;
                targetColors[i3 + 1] = 0;
                targetColors[i3 + 2] = 0;
            }
        }
    }
}

// --- 图片处理 (略) ---
async function processImage(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.src = url;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const size = 512;
            const scale = Math.min(size / img.width, size / img.height);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

            const points = [];
            for (let y = 0; y < canvas.height; y += 1) {
                for (let x = 0; x < canvas.width; x += 1) {
                    const i = (y * canvas.width + x) * 4;
                    if (data[i + 3] > 50) {
                        points.push({
                            x: (x / canvas.width - 0.5) * 2 * (canvas.width / canvas.height),
                            y: -(y / canvas.height - 0.5) * 2,
                            r: data[i] / 255, g: data[i + 1] / 255, b: data[i + 2] / 255
                        });
                    }
                }
            }
            resolve({ points });
        };
    });
}

// 文件夹选择事件 (略)
const folderInput = document.getElementById('folder-input');
if (folderInput) {
    folderInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
        if (files.length === 0) return;

        loadedImages = [];
        for (const f of files) {
            const result = await processImage(f);

            if (result.points.length > PARTICLES_COUNT) {
                result.points.sort(() => 0.5 - Math.random());
                result.points.length = PARTICLES_COUNT;
            }
            loadedImages.push(result);
        }
        console.log(`Loaded ${loadedImages.length} images`);

        if (loadedImages.length > 0) {
            currentMode = MODES.VIEW_PHOTO;
            selectedPhotoIndex = 0;
            isAutoCycling = true;
            lastCycleTime = performance.now();
            updateTargetShape();
        }
    });
}

// --- 手势识别 ---
function detectGesture(landmarks) {
    const wrist = landmarks[0];
    const tips = [8, 12, 16, 20];
    const pips = [6, 10, 14, 18];

    const extended = tips.map((tip, i) => {
        const dTip = Math.hypot(landmarks[tip].x - wrist.x, landmarks[tip].y - wrist.y);
        const dPip = Math.hypot(landmarks[pips[i]].x - wrist.x, landmarks[pips[i]].y - wrist.y);
        return dTip > dPip;
    });

    const [index, middle, ring, pinky] = extended;

    let currentGesture = 'NONE';

    if (index && middle && ring && pinky) {
        currentGesture = 'OPEN_PALM';
    } else if (!index && !middle && !ring && !pinky) {
        currentGesture = 'FIST';
    } else if (index && !middle && !ring && !pinky) {
        // 食指伸出，检测方向
        const indexTip = landmarks[8];
        const indexPip = landmarks[6];
        const deltaX = indexTip.x - indexPip.x;

        if (Math.abs(deltaX) > POINTING_THRESHOLD) {
            if (deltaX < 0) {
                // indexTip.x < indexPip.x (在镜像画面中：食指向左)
                currentGesture = 'INDEX_PREVIOUS'; // 食指向左 -> 上一张
            } else {
                // indexTip.x > indexPip.x (在镜像画面中：食指向右)
                currentGesture = 'INDEX_NEXT'; // 食指向右 -> 下一张
            }
        } else {
            currentGesture = 'POINTING'; // 食指伸出但方向不明显
        }
    }

    return currentGesture;
}

// 检测右手左右摆动（根据手腕 X 方向的快速位移）
function detectRightHandSwing(landmarks, currentTime) {
    const wrist = landmarks[0];
    const currentX = wrist.x;

    let swingGesture = 'NONE';

    if (lastRightWristX !== null) {
        const deltaX = currentX - lastRightWristX;
        const timeDiff = currentTime - lastRightSwingTime;

        if (timeDiff > RIGHT_SWING_TIME_THRESHOLD &&
            Math.abs(deltaX) > RIGHT_SWING_DISTANCE_THRESHOLD) {
            if (deltaX < 0) {
                // 在镜像画面中：手从右往左移动，看起来是向左摆
                swingGesture = 'SWING_LEFT';   // 上一张
            } else {
                swingGesture = 'SWING_RIGHT';  // 下一张
            }
            lastRightSwingTime = currentTime;
        }
    } else {
        lastRightSwingTime = currentTime;
    }

    lastRightWristX = currentX;
    return swingGesture;
}

// --- 交互逻辑：加入冷却时间逻辑 ---
function handleInteraction(leftGesture, rightGesture, rightSwingGesture) {
    let activeGesture = 'NONE';
    const currentTime = performance.now();

    // 1. 左手控制模式切换
    if (loadedImages.length > 0) {
        if (leftGesture === 'OPEN_PALM') {
            if (currentMode !== MODES.VIEW_PHOTO) {
                currentMode = MODES.VIEW_PHOTO;
                if (selectedPhotoIndex === -1) selectedPhotoIndex = 0;
                isAutoCycling = true;
                lastCycleTime = currentTime;
                updateTargetShape();
            }
            activeGesture = 'OPEN_PALM';
        } else if (leftGesture === 'FIST') {
            if (currentMode !== MODES.SHAPE) {
                currentMode = MODES.SHAPE;
                selectedPhotoIndex = -1;
                isAutoCycling = false;
                // 左手握拳：切换到粉色爱心粒子
                PARAMS.model = 'Heart';
                PARAMS.color = 'rgba(255, 105, 180, 1)'; // HotPink 粉色
                updateTargetShape();
            }
            activeGesture = 'FIST';
        }
    }

    // 2. 右手控制图片切换 (应用冷却时间) —— 使用左右摆动
    if (currentMode === MODES.VIEW_PHOTO && loadedImages.length > 1) {

        // 即使在冷却期，也要检查是否是切换手势，以便在 UI 上显示
        if (rightSwingGesture === 'SWING_LEFT' || rightSwingGesture === 'SWING_RIGHT') {
            activeGesture = rightSwingGesture;
        }

        // 检查是否通过冷却期
        if (currentTime - lastManualChangeTime > MANUAL_COOLDOWN_TIME) {

            if (rightSwingGesture === 'SWING_LEFT') {
                selectedPhotoIndex = (selectedPhotoIndex - 1 + loadedImages.length) % loadedImages.length;
                lastCycleTime = currentTime;
                lastManualChangeTime = currentTime;
                updateTargetShape();
                // activeGesture 已在前面更新
            } else if (rightSwingGesture === 'SWING_RIGHT') {
                selectedPhotoIndex = (selectedPhotoIndex + 1) % loadedImages.length;
                lastCycleTime = currentTime;
                lastManualChangeTime = currentTime;
                updateTargetShape();
                // activeGesture 已在前面更新
            }
        }
    }

    // 3. 右手握拳 / 食指指向屏幕：控制旋转与“选择照片”
    if (rightGesture === 'FIST') {
        // 右手握拳：立即停止旋转和自动切换
        isRotationPaused = true;
        isAutoCycling = false;
        lastPointingStartTime = 0;
        activeGesture = 'RIGHT_FIST';
    } else if (rightGesture === 'POINTING') {
        // 右手食指指向屏幕：停留 1 秒视为“选择当前照片并暂停观看”
        if (lastPointingStartTime === 0) {
            lastPointingStartTime = currentTime;
        }
        const holdTime = currentTime - lastPointingStartTime;
        if (holdTime >= POINTING_HOLD_TIME) {
            isRotationPaused = true;
            isAutoCycling = false;
            activeGesture = 'RIGHT_POINTING_SELECT';
        } else {
            // 显示正在指向但尚未选择
            if (activeGesture === 'NONE') {
                activeGesture = 'RIGHT_POINTING_HOLD';
            }
        }
    } else {
        // 其他手势 / 没有右手：恢复旋转和自动切换
        lastPointingStartTime = 0;
        isRotationPaused = false;
        if (currentMode === MODES.VIEW_PHOTO && loadedImages.length > 1) {
            isAutoCycling = true;
        }
    }

    return activeGesture;
}

// --- 动画循环 (略) ---
function animate(currentTime) {
    requestAnimationFrame(animate);

    // 自动循环逻辑 (每5秒切换到上一张照片)
    if (currentMode === MODES.VIEW_PHOTO && isAutoCycling && loadedImages.length > 1) {
        if (currentTime - lastCycleTime >= AUTO_CYCLE_INTERVAL) {
            switchToPreviousPhoto();
            lastCycleTime = currentTime;
        }
    }

    // 粒子插值 (略)
    const positions = particles.geometry.attributes.position.array;
    const colors = particles.geometry.attributes.color.array;

    for (let i = 0; i < PARTICLES_COUNT * 3; i++) {
        positions[i] += (targetPositions[i] - positions[i]) * 0.05;
        colors[i] += (targetColors[i] - colors[i]) * 0.05;
    }
    particles.geometry.attributes.position.needsUpdate = true;
    particles.geometry.attributes.color.needsUpdate = true;

    // 旋转逻辑：
    // - 其他时候始终缓慢旋转；
    // - 查看图片模式下，转到侧面时加速；
    // - 经过侧边时，随机决定这一次是“抬头”还是“低头”一点。
    if (!isRotationPaused) {
        if (currentMode === MODES.VIEW_PHOTO) {
            const baseSpeed = 0.004;
            const sideFactor = Math.abs(Math.sin(photoAngleY)); // 0 正面，1 侧面
            const speed = baseSpeed * (0.5 + 1.5 * sideFactor); // 侧面更快

            photoAngleY += speed;

            // 当从非侧边进入“接近侧边”区间时，随机选择向上或向下倾斜
            if (sideFactor > 0.9 && lastSideFactor <= 0.9) {
                photoTiltDir = Math.random() < 0.5 ? 1 : -1;
            }
            lastSideFactor = sideFactor;

            // 主旋转：绕 Y 轴转动
            particles.rotation.y = photoAngleY;
            // 随着旋转，轻微上下/左右晃动
            particles.rotation.x = 0.18 * photoTiltDir * Math.sin(photoAngleY * 0.7);
            particles.rotation.z = 0.08 * Math.sin(photoAngleY * 0.5);
        } else {
            // 形状模式：简单缓慢旋转即可
            particles.rotation.y += 0.002;
        }
    }

    controls.update();
    renderer.render(scene, camera);
}

// --- MediaPipe 预测及 UI 显示 (略) ---
async function setupHandTracking() {
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('gesture-canvas');
    const ctx = canvas.getContext('2d');

    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_LANDMARKER_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2
    });

    const drawingUtils = new DrawingUtils(ctx);

    async function predict() {
        if (video.currentTime !== 0) {
            const results = handLandmarker.detectForVideo(video, performance.now());

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.canvas.width = video.videoWidth;
            ctx.canvas.height = video.videoHeight;

            let leftHandGesture = 'NONE';
            let rightHandGesture = 'NONE';
            let rightHandSwingGesture = 'NONE';
            let usedGesture = 'NONE';

            if (results.landmarks && results.landmarks.length > 0) {
                for (let i = 0; i < results.landmarks.length; i++) {
                    const landmarks = results.landmarks[i];
                    const handedness = results.handedness[i][0].categoryName;
                    const gesture = detectGesture(landmarks);
                    const color = handedness === 'Left' ? '#00FF00' : '#FF8C00';

                    drawingUtils.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, { color: color });
                    drawingUtils.drawLandmarks(landmarks, { color: color, radius: 1 });

                    if (handedness === 'Left') {
                        leftHandGesture = gesture;
                    } else if (handedness === 'Right') {
                        rightHandGesture = gesture;
                        // 右手额外检测左右摆动，用于切换照片
                        rightHandSwingGesture = detectRightHandSwing(landmarks, performance.now());
                    }
                }

                usedGesture = handleInteraction(leftHandGesture, rightHandGesture, rightHandSwingGesture);
            }

            // --- UI 文本显示 ---
            ctx.fillStyle = 'white';
            ctx.font = '24px Arial';

            ctx.save();
            ctx.scale(-1, 1);
            ctx.translate(-ctx.canvas.width, 0);

            // 模式显示
            let modeText = '';
            if (currentMode === MODES.SHAPE) modeText = '形状模式 (左手握拳 = 粉色爱心粒子)';
            else if (currentMode === MODES.VIEW_PHOTO) modeText = '图片循环模式 (左手张开切换)';

            ctx.fillText(`模式: ${modeText}`, 10, 30);

            // 手势显示
            let gestureText = '';
            const inCooldown = performance.now() - lastManualChangeTime <= MANUAL_COOLDOWN_TIME;

            if (usedGesture === 'NONE') gestureText = '无控制手势';
            else if (usedGesture === 'OPEN_PALM') gestureText = '左手张开 (已切换到图片)';
            else if (usedGesture === 'FIST') gestureText = '左手握拳 (粒子聚成粉色爱心)';
            else if (usedGesture === 'SWING_LEFT') gestureText = `右手向左摆动 (上一张${inCooldown ? " - 冷却中" : " - 切换成功"})`;
            else if (usedGesture === 'SWING_RIGHT') gestureText = `右手向右摆动 (下一张${inCooldown ? " - 冷却中" : " - 切换成功"})`;
            else if (usedGesture === 'RIGHT_POINTING_HOLD') gestureText = '右手食指指向屏幕 (继续保持 1 秒选择照片)';
            else if (usedGesture === 'RIGHT_POINTING_SELECT') gestureText = '右手食指指向屏幕 (已选择照片并暂停旋转)';
            else if (usedGesture === 'RIGHT_FIST') gestureText = '右手握拳 (停止旋转，暂停自动切换)';

            ctx.fillText(`控制手势: ${gestureText}`, 10, 60);

            // 照片索引和自动循环提示显示
            if (currentMode === MODES.VIEW_PHOTO && loadedImages.length > 0) {
                ctx.fillText(`照片: ${selectedPhotoIndex + 1} / ${loadedImages.length}`, 10, 90);

                // 自动循环计时器显示
                if (isAutoCycling && loadedImages.length > 1) {
                    const elapsed = performance.now() - lastCycleTime;
                    const progress = elapsed / AUTO_CYCLE_INTERVAL;
                    const remainingTime = Math.ceil((AUTO_CYCLE_INTERVAL - elapsed) / 1000);

                    ctx.fillStyle = 'lightblue';
                    ctx.fillText(`自动切换倒计时: ${remainingTime} 秒 (上一张)`, 10, 120);

                    // 进度条
                    ctx.fillStyle = 'yellow';
                    ctx.fillRect(10, 130, 200 * progress, 10);
                }
            }

            ctx.restore();
        }
        requestAnimationFrame(predict);
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error('当前浏览器不支持摄像头 API (navigator.mediaDevices.getUserMedia)。');
        return;
    }

    navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
        console.log('摄像头流获取成功');
        video.srcObject = stream;

        // 某些浏览器需要手动调用 play 才会真正开始播放
        const startPredict = () => {
            console.log('视频已开始播放，启动手势识别循环');
            video.removeEventListener('loadeddata', startPredict);
            video.removeEventListener('playing', startPredict);
            predict();
        };

        video.addEventListener('loadeddata', startPredict);
        video.addEventListener('playing', startPredict);

        // 主动尝试播放，防止 autoplay 被浏览器拦截后 currentTime 一直为 0
        const playPromise = video.play();
        if (playPromise && typeof playPromise.then === 'function') {
            playPromise.catch(err => {
                console.warn('video.play() 被浏览器拦截或失败:', err);
            });
        }
    }).catch(err => {
        console.error('获取摄像头失败，请检查权限或设备：', err);
    });
}

// --- UI Setup (略) ---
function setupUI() {
    const pane = new Pane();
    pane.addBinding(PARAMS, 'model', {
        options: { Heart: '心形', Sphere: '球形', Firework: '烟花' }
    }).on('change', updateTargetShape);

    pane.addBinding(PARAMS, 'color', { view: 'color', label: '颜色' }).on('change', updateTargetShape);
    pane.addBinding(PARAMS, 'particleSize', { min: 0.1, max: 2.0, label: '粒子大小' }).on('change', v => {
        particleMaterial.size = v.value * 0.12;
    });

    document.getElementById('fullscreen-btn').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else renderer.domElement.requestFullscreen();
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

initParticles();
setupUI();
setupHandTracking();
animate(performance.now());

// 延迟一点时间再批量加载默认图片，避免刚进入页面时卡顿
setTimeout(() => {
    loadDefaultImages();
}, 500);

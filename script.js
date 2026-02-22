/*
 * 모델 전략 (remove.bg 방식 참고)
 * ─────────────────────────────────────────────────────
 * RMBG-2.0: BriaAI의 최신 범용 배경 제거 모델
 * - RMBG-1.4 대비 복잡한 배경, 어두운 배경, 반투명 객체에서 대폭 개선
 * - IS-Net 아키텍처 기반, 1024×1024 입력
 *
 * 전처리: 이미지 정규화 (ImageNet mean/std) → 모델 정확도 향상
 * 후처리: 엣지 전용 페더링 (내부 픽셀 보존, 경계만 블러)
 * ─────────────────────────────────────────────────────
 */

// RMBG-1.4: 로그인 없이 브라우저에서 직접 사용 가능한 최고 품질 공개 모델
const MODEL_URL  = 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx';
const MODEL_SIZE = 1024;

// RMBG-1.4 공식 정규화: /255 후 mean=0.5 빼기, std=1.0 (즉 -0.5 shift만)
const MEAN = [0.5, 0.5, 0.5];
const STD  = [1.0, 1.0, 1.0];

let session = null, origData = null, isCompareMode = false;
let scale = 1, posX = 0, posY = 0, isDragging = false, isSpacePressed = false, lastMouseX = 0, lastMouseY = 0;
let currentBgColor = 'transparent', isModelLoading = false, compareJustOff = false;
let fillTolerance = 32, fillDir = 'erase';
let brushSize = 40;
let isBrushPainting = false;
const undoStack = [], redoStack = [];
let initialImageData = null;
let rawAlpha = null;   // AI 추론 후 원본 알파 (페더링 실시간 재적용용)
let bgRaw = 0, bgGRaw = 0, bgBRaw = 0, bgDarkRaw = false; // 배경색 캐시

const el = id => document.getElementById(id);
const elUpload       = el('upload');
const elUploadCard   = el('uploadCard');
const elProcessBtn   = el('processBtn');
const elDownloadBtn  = el('downloadBtn');
const elProgressBar  = el('progressBar');
const elStatusText   = el('statusText');
const elProgWrap     = el('progWrap');
const elInputCanvas  = el('inputCanvas');
const elOutputCanvas = el('outputCanvas');
const elEditorLayout = el('editorLayout');
const elOrigOverlay  = el('originalOverlay');
const elCmpWrapper   = el('compareWrapper');
const elCmpBar       = el('compareBar');
const elCmpContainer = el('canvasContainer');

/* ── 유틸 ── */
function showToast(msg) {
    const t = el('toastEl');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
}

function setProgress(pct, txt) {
    elProgWrap.style.display = 'block';
    elProgressBar.style.width = pct + '%';
    elStatusText.textContent = txt;
    if (pct >= 100) setTimeout(() => elProgWrap.style.display = 'none', 2000);
}

/* ── 배경색 ── */
function changeBgColor(c) {
    currentBgColor = c;
    elCmpContainer.style.backgroundImage = 'none';
    elCmpContainer.style.backgroundColor = c;
}

function resetBgTransparent() {
    currentBgColor = 'transparent';
    elCmpContainer.style.backgroundColor = 'transparent';
    elCmpContainer.style.backgroundImage = 'conic-gradient(#f1f5f9 25%, white 0 50%, #f1f5f9 0 75%, white 0)';
    showToast('투명 배경으로 설정됨');
}

/* ── 키보드 ── */
window.addEventListener('keydown', e => {
    if (e.code === 'Space') {
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') e.preventDefault();
        isSpacePressed = true;
        if (elEditorLayout.classList.contains('show')) elCmpContainer.style.cursor = 'grab';
    }
    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); fillUndo(); }
    if (e.ctrlKey && e.code === 'KeyY') { e.preventDefault(); fillRedo(); }
});

window.addEventListener('keyup', e => {
    if (e.code === 'Space') {
        isSpacePressed = false;
        elCmpContainer.style.cursor = 'crosshair';
    }
});

/* ── 줌/패닝 ── */
elCmpContainer.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = elCmpContainer.getBoundingClientRect();
    applyZoom(e.deltaY > 0 ? -.08 : .08, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

function manualZoom(d) {
    applyZoom(d, elCmpContainer.offsetWidth / 2, elCmpContainer.offsetHeight / 2);
}

function applyZoom(d, mx, my) {
    const tx = (mx - posX) / scale;
    const ty = (my - posY) / scale;
    scale = Math.min(Math.max(.1, scale + d), 10);
    posX = mx - tx * scale;
    posY = my - ty * scale;
    updateTransform();
}

elCmpContainer.addEventListener('mousedown', e => {
    if (isSpacePressed && e.button === 0) {
        isDragging = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        elCmpContainer.style.cursor = 'grabbing';
        e.preventDefault();
    }
});

window.addEventListener('mousemove', e => {
    if (isCompareMode) {
        const r = elOutputCanvas.getBoundingClientRect();
        const p = Math.max(0, Math.min(100, (((e.clientX - r.left) / scale) / elOutputCanvas.width) * 100));
        elOrigOverlay.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
        elCmpBar.style.left = p + '%';
        elCmpBar.style.display = 'block';
    }
    if (isDragging) {
        posX += e.clientX - lastMouseX;
        posY += e.clientY - lastMouseY;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        updateTransform();
    }
});

window.addEventListener('mouseup', () => {
    isDragging = false;
    elCmpContainer.style.cursor = isSpacePressed ? 'grab' : 'crosshair';
});

elCmpContainer.addEventListener('contextmenu', e => e.preventDefault());

function updateTransform() {
    elCmpWrapper.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`;
    el('zoomVal').textContent = Math.round(scale * 100);
}

function resetZoom(msg = false) {
    const iw = elOutputCanvas.width;
    const ih = elOutputCanvas.height;
    if (!iw || !ih) return;
    const cw = elCmpContainer.offsetWidth;
    const ch = elCmpContainer.offsetHeight;
    scale = Math.min((cw * .98) / iw, (ch * .98) / ih);
    posX = (cw - iw * scale) / 2;
    posY = (ch - ih * scale) / 2;
    updateTransform();
    if (msg) showToast('화면에 맞게 정렬됨');
}

function toggleCompareMode(e) {
    if (e) {
        e.preventDefault();
        e.currentTarget.blur();
    }
    isCompareMode = !isCompareMode;
    const btn = el('btnCompareMode');
    if (isCompareMode) {
        btn.classList.add('active');
        showToast('원본 비교 모드 ON');
    } else {
        btn.classList.remove('active');
        elOrigOverlay.style.clipPath = 'inset(0 100% 0 0)';
        elCmpBar.style.display = 'none';
        compareJustOff = true;
        setTimeout(() => { compareJustOff = false; }, 200);
    }
}

/* ── 파일 업로드 ── */
elUploadCard.addEventListener('click', e => {
    if (e.target.id === 'reUploadBtn' || e.target.closest('#reUploadBtn')) return;
    if (!elUploadCard.classList.contains('has-file')) elUpload.click();
});

elUpload.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            elInputCanvas.width = img.width;
            elInputCanvas.height = img.height;
            elInputCanvas.getContext('2d').drawImage(img, 0, 0);
            elOrigOverlay.src = reader.result;
            el('thumb').src = reader.result;
            el('fName').textContent = file.name;
            el('fMeta').textContent = img.width + '×' + img.height;
            el('uploadUI').style.display = 'none';
            el('fileRow').classList.add('show');
            elUploadCard.classList.add('has-file');
            elProcessBtn.disabled = false;
            elEditorLayout.classList.remove('show');
            elCmpWrapper.classList.remove('ready');
            undoStack.length = 0;
            redoStack.length = 0;
            updateUndoBtns();
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
});

el('reUploadBtn').addEventListener('click', e => {
    e.stopPropagation();
    elUpload.value = '';
    elUpload.click();
});

/* ── 모델 로드 ── */
async function loadModel() {
    if (session || isModelLoading) return;
    isModelLoading = true;
    try {
        setProgress(10, 'AI 모델 로딩 중... (최초 1회, 약 20-40초)');
        session = await ort.InferenceSession.create(MODEL_URL, {
            executionProviders: ['wasm']
        });
    } finally {
        isModelLoading = false;
    }
}

/* ══════════════════════════════════════════════════════
    전처리: ImageNet 정규화
══════════════════════════════════════════════════════ */
function preprocessImage(imageData) {
    const { data, width, height } = imageData;
    const n = width * height;
    const tensor = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
        tensor[i]         = (data[i * 4]     / 255 - MEAN[0]) / STD[0]; // R
        tensor[i + n]     = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1]; // G
        tensor[i + 2 * n] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2]; // B
    }
    return tensor;
}

/* ══════════════════════════════════════════════════════
    후처리 ①: 고립 잔여물 자동 제거
══════════════════════════════════════════════════════ */
function removeIsolatedComponents(alpha, w, h, minRatio = 0.002) {
    const n = w * h;
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = alpha[i] >= 128 ? 1 : 0;
    
    const labels = new Int32Array(n);
    const sizes = [0];
    let nextLbl = 1;
    const q = [];
    
    for (let s = 0; s < n; s++) {
        if (!bin[s] || labels[s]) continue;
        labels[s] = nextLbl;
        q.length = 0;
        q.push(s);
        let qi = 0, sz = 0;
        
        while (qi < q.length) {
            const idx = q[qi++];
            sz++;
            const px = idx % w, py = (idx / w) | 0;
            if (px > 0     && bin[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = nextLbl; q.push(idx - 1); }
            if (px < w - 1 && bin[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = nextLbl; q.push(idx + 1); }
            if (py > 0     && bin[idx - w] && !labels[idx - w]) { labels[idx - w] = nextLbl; q.push(idx - w); }
            if (py < h - 1 && bin[idx + w] && !labels[idx + w]) { labels[idx + w] = nextLbl; q.push(idx + w); }
        }
        sizes.push(sz);
        nextLbl++;
    }
    
    const maxSz = Math.max(...sizes.slice(1), 1);
    const minSz = Math.max(10, Math.floor(maxSz * minRatio));
    for (let i = 0; i < n; i++) {
        if (labels[i] > 0 && sizes[labels[i]] < minSz) alpha[i] = 0;
    }
}

/* ── 페더링 + 합성 공통 함수 (실시간 재적용 가능) ── */
function applyAndComposite() {
    if (!rawAlpha || !origData) return;
    const W = origData.width, H = origData.height, n2 = W * H;
    const d = origData.data;

    // rawAlpha 복사
    const alpha = new Float32Array(rawAlpha);

    // 합성
    const outCtx = elOutputCanvas.getContext('2d');
    const outImg = outCtx.createImageData(W, H);
    
    for (let i = 0; i < n2; i++) {
        const a = Math.round(Math.max(0, Math.min(255, alpha[i])));
        let r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
        
        if (bgDarkRaw && a > 0 && a < 255) {
            const af = a / 255;
            r = Math.min(255, Math.max(0, Math.round((r - bgRaw * (1 - af)) / af)));
            g = Math.min(255, Math.max(0, Math.round((g - bgGRaw * (1 - af)) / af)));
            b = Math.min(255, Math.max(0, Math.round((b - bgBRaw * (1 - af)) / af)));
        }
        
        outImg.data[i * 4] = r;
        outImg.data[i * 4 + 1] = g;
        outImg.data[i * 4 + 2] = b;
        outImg.data[i * 4 + 3] = a;
    }
    outCtx.putImageData(outImg, 0, 0);
}

/* ── 메인 파이프라인 ── */
elProcessBtn.addEventListener('click', async () => {
    if (elProcessBtn.disabled) return;
    elProcessBtn.disabled = true;
    try {
        await loadModel();
        setProgress(30, '이미지 전처리 중...');

        const W = elInputCanvas.width, H = elInputCanvas.height;

        const resC = document.createElement('canvas');
        resC.width = MODEL_SIZE;
        resC.height = MODEL_SIZE;
        resC.getContext('2d').drawImage(elInputCanvas, 0, 0, MODEL_SIZE, MODEL_SIZE);
        const imgD = resC.getContext('2d').getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);

        const tensor = preprocessImage(imgD);

        setProgress(50, 'AI 배경 분석 중...');

        const inputName = session.inputNames[0];
        const res = await session.run({
            [inputName]: new ort.Tensor('float32', tensor, [1, 3, MODEL_SIZE, MODEL_SIZE])
        });
        const outputName = session.outputNames[0];
        const rawMask = res[outputName].data; 

        setProgress(75, '마스크 정제 중...');

        const mC = document.createElement('canvas');
        mC.width = MODEL_SIZE;
        mC.height = MODEL_SIZE;
        const mCtx = mC.getContext('2d');
        const mImg = mCtx.createImageData(MODEL_SIZE, MODEL_SIZE);
        
        let ma = -Infinity, mi = Infinity;
        for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
            if (rawMask[i] > ma) ma = rawMask[i];
            if (rawMask[i] < mi) mi = rawMask[i];
        }
        
        const range = ma - mi || 1e-6;
        for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
            const v = Math.round(((rawMask[i] - mi) / range) * 255);
            mImg.data[i * 4] = mImg.data[i * 4 + 1] = mImg.data[i * 4 + 2] = v;
            mImg.data[i * 4 + 3] = 255;
        }
        mCtx.putImageData(mImg, 0, 0);

        const bC = document.createElement('canvas');
        bC.width = W;
        bC.height = H;
        const bCtx = bC.getContext('2d');
        bCtx.imageSmoothingEnabled = true;
        bCtx.imageSmoothingQuality = 'high';
        bCtx.drawImage(mC, 0, 0, W, H);
        const bPx = bCtx.getImageData(0, 0, W, H).data;

        const n2 = W * H;
        const alpha = new Float32Array(n2);
        for (let i = 0; i < n2; i++) alpha[i] = bPx[i * 4];

        removeIsolatedComponents(alpha, W, H, 0.002);

        rawAlpha = new Float32Array(alpha);

        origData = elInputCanvas.getContext('2d').getImageData(0, 0, W, H);
        const d0 = origData.data;
        let bgCnt0 = 0;
        bgRaw = 0; bgGRaw = 0; bgBRaw = 0;
        
        for (let i = 0; i < n2; i++) {
            if (alpha[i] === 0) {
                bgRaw += d0[i * 4];
                bgGRaw += d0[i * 4 + 1];
                bgBRaw += d0[i * 4 + 2];
                bgCnt0++;
            }
        }
        if (bgCnt0 > 0) {
            bgRaw /= bgCnt0;
            bgGRaw /= bgCnt0;
            bgBRaw /= bgCnt0;
        }
        bgDarkRaw = (bgRaw + bgGRaw + bgBRaw) < 150 && bgCnt0 > n2 * 0.03;

        setProgress(92, '최종 합성 중...');

        elOutputCanvas.width = W;
        elOutputCanvas.height = H;
        applyAndComposite();

        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoBtns();
        initialImageData = elOutputCanvas.getContext('2d').getImageData(0, 0, elOutputCanvas.width, elOutputCanvas.height);

        setProgress(100, '완료!');
        elEditorLayout.classList.add('show');
        setTimeout(() => {
            resetZoom();
            elCmpWrapper.classList.add('ready');
        }, 50);
        showToast('✨ 배경 제거 완료!');
    } catch (err) {
        console.error(err);
        showToast('오류: ' + err.message);
    } finally {
        elProcessBtn.disabled = false;
    }
});

/* ── Undo/Redo ── */
function setFillDir(d) {
    if (isCompareMode) toggleCompareMode();
    fillDir = d;
    el('fillDirErase').className = 'fill-dir-btn' + (d === 'erase' ? ' on' : '');
    el('fillDirRestore').className = 'fill-dir-btn' + (d === 'restore' ? ' restore-on' : '');
}

function fillUndo() {
    if (undoStack.length === 0) {
        if (initialImageData) {
            elOutputCanvas.getContext('2d').putImageData(initialImageData, 0, 0);
            showToast('최초 상태입니다.');
        }
        return;
    }
    redoStack.push(elOutputCanvas.getContext('2d').getImageData(0, 0, elOutputCanvas.width, elOutputCanvas.height));
    elOutputCanvas.getContext('2d').putImageData(undoStack.pop(), 0, 0);
    updateUndoBtns();
    showToast('실행 취소됨');
}

function fillRedo() {
    if (redoStack.length === 0) return;
    undoStack.push(elOutputCanvas.getContext('2d').getImageData(0, 0, elOutputCanvas.width, elOutputCanvas.height));
    elOutputCanvas.getContext('2d').putImageData(redoStack.pop(), 0, 0);
    updateUndoBtns();
    showToast('다시 실행됨');
}

function updateUndoBtns() {
    el('fillUndoBtn').disabled = (undoStack.length === 0 && !initialImageData);
    el('fillRedoBtn').disabled = (redoStack.length === 0);
}

/* ══════════════════════════════════════════════
    Magic Brush
══════════════════════════════════════════════ */
let brushDir = 'erase';
let activeTab = 'magic'; // 'magic' | 'fill'

function switchTab(tab) {
    activeTab = tab;
    el('tabMagic').className = 'tab-btn' + (tab === 'magic' ? ' active' : '');
    el('tabFill').className  = 'tab-btn' + (tab === 'fill'  ? ' active' : '');
    el('contentMagic').className = 'tab-content' + (tab === 'magic' ? ' show' : '');
    el('contentFill').className  = 'tab-content' + (tab === 'fill'  ? ' show' : '');
    updateCursorColor();
}

function updateCursorColor() {
    const isRestore = activeTab === 'magic' ? brushDir === 'restore' : fillDir === 'restore';
    el('fillCursorRing').className = 'fill-cursor-ring' + (isRestore ? ' restore' : '');
}

let lastBrushX = -999, lastBrushY = -999; 

function setBrushDir(d) {
    brushDir = d;
    el('brushDirErase').className = 'fill-dir-btn' + (d === 'erase' ? ' on' : '');
    el('brushDirRestore').className = 'fill-dir-btn' + (d === 'restore' ? ' restore-on' : '');
}

function updateBrushCursor() {
    const ring = el('fillCursorRing');
    const sz = Math.max(10, brushSize * scale);
    ring.style.width = sz + 'px';
    ring.style.height = sz + 'px';
}

/* ── 캔버스 마우스 이벤트 ── */
elOutputCanvas.addEventListener('mousedown', e => {
    if (isCompareMode || isSpacePressed || compareJustOff || !origData || e.button !== 0) return;
    if (activeTab !== 'magic') return; 
    isBrushPainting = true;
    lastBrushX = -999;
    lastBrushY = -999;
    const _snap = elOutputCanvas.getContext('2d').getImageData(0, 0, elOutputCanvas.width, elOutputCanvas.height);
    undoStack.push(_snap);
    redoStack.length = 0;
    updateUndoBtns();
    _brushCache = null; 
    const { cx, cy } = canvasXY(e);
    magicBrushAt(cx, cy);
});

window.addEventListener('mouseup', () => {
    if (isBrushPainting) {
        _brushCache = null; 
    }
    isBrushPainting = false;
});

elOutputCanvas.addEventListener('click', e => {
    if (isCompareMode || isSpacePressed || compareJustOff || !origData) return;
    if (activeTab !== 'fill') return; 
    const { cx, cy } = canvasXY(e);
    undoStack.push(elOutputCanvas.getContext('2d').getImageData(0, 0, elOutputCanvas.width, elOutputCanvas.height));
    redoStack.length = 0;
    updateUndoBtns();
    floodFill(cx, cy, fillDir === 'erase');
});

elOutputCanvas.addEventListener('mousemove', e => {
    const fc = el('fillCursor');
    if (isCompareMode || isSpacePressed) {
        fc.style.display = 'none';
        return;
    }
    fc.style.display = 'block';
    fc.style.left = e.clientX + 'px';
    fc.style.top = e.clientY + 'px';
    updateBrushCursor();
    updateCursorColor();

    if (isBrushPainting && activeTab === 'magic') {
        const { cx, cy } = canvasXY(e);
        const r = Math.round(brushSize / 2);
        const moved = Math.abs(cx - lastBrushX) > r * 0.4 || Math.abs(cy - lastBrushY) > r * 0.4;
        if (moved) {
            magicBrushAt(cx, cy);
            lastBrushX = cx;
            lastBrushY = cy;
        }
    }
});

elOutputCanvas.addEventListener('mouseleave', () => el('fillCursor').style.display = 'none');

function canvasXY(e) {
    const rect = elOutputCanvas.getBoundingClientRect();
    return {
        cx: Math.round(((e.clientX - rect.left) / rect.width) * elOutputCanvas.width),
        cy: Math.round(((e.clientY - rect.top) / rect.height) * elOutputCanvas.height)
    };
}

let _brushCache = null;

function magicBrushAt(cx, cy) {
    if (!origData || !rawAlpha) return;
    const w = elOutputCanvas.width, h = elOutputCanvas.height;
    const ctx = elOutputCanvas.getContext('2d');
    const r = Math.round(brushSize / 2);
    const isErase = brushDir === 'erase';

    if (!_brushCache) _brushCache = ctx.getImageData(0, 0, w, h);
    const od = _brushCache.data;
    const src = origData.data;

    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > r) continue;
            
            const px = cx + dx, py = cy + dy;
            if (px < 0 || px >= w || py < 0 || py >= h) continue;

            const idx = (py * w + px) * 4;
            const origA = rawAlpha[py * w + px]; 
            const strength = Math.pow(1 - dist / r, 0.5);

            if (isErase) {
                if (origA >= 200) continue;
                const eraseStr = strength * (1 - origA / 200);
                od[idx + 3] = Math.max(0, Math.round(od[idx + 3] * (1 - eraseStr)));

            } else {
                if (origA < 30) continue;
                const targetA = origA;
                od[idx + 3] = Math.min(255, Math.round(od[idx + 3] + (targetA - od[idx + 3]) * strength));
                od[idx]     = Math.round(od[idx]     + (src[idx]     - od[idx]    ) * strength);
                od[idx + 1] = Math.round(od[idx + 1] + (src[idx + 1] - od[idx + 1]) * strength);
                od[idx + 2] = Math.round(od[idx + 2] + (src[idx + 2] - od[idx + 2]) * strength);
            }
        }
    }
    ctx.putImageData(_brushCache, 0, 0);
}

function floodFill(sx, sy, isErase) {
    const w = elOutputCanvas.width, h = elOutputCanvas.height;
    const ctx = elOutputCanvas.getContext('2d');
    const out = ctx.getImageData(0, 0, w, h);
    const od = out.data;
    const src = origData.data;
    
    const si = (sy * w + sx) * 4;
    const sr = src[si], sg = src[si + 1], sb = src[si + 2];
    const tol = fillTolerance * fillTolerance * 3;
    const vis = new Uint8Array(w * h);
    
    const stk = [sy * w + sx];
    vis[sy * w + sx] = 1;
    
    while (stk.length) {
        const idx = stk.pop(), pi = idx * 4;
        const dr = src[pi] - sr, dg = src[pi + 1] - sg, db = src[pi + 2] - sb;
        
        if (dr * dr + dg * dg + db * db <= tol) {
            if (isErase) {
                od[pi + 3] = 0;
            } else {
                od[pi] = src[pi];
                od[pi + 1] = src[pi + 1];
                od[pi + 2] = src[pi + 2];
                od[pi + 3] = 255;
            }
            
            const px = idx % w, py = (idx / w) | 0;
            if (px > 0     && !vis[idx - 1]) { vis[idx - 1] = 1; stk.push(idx - 1); }
            if (px < w - 1 && !vis[idx + 1]) { vis[idx + 1] = 1; stk.push(idx + 1); }
            if (py > 0     && !vis[idx - w]) { vis[idx - w] = 1; stk.push(idx - w); }
            if (py < h - 1 && !vis[idx + w]) { vis[idx + w] = 1; stk.push(idx + w); }
        }
    }
    ctx.putImageData(out, 0, 0);
}

/* ── 다운로드 ── */
elDownloadBtn.addEventListener('click', () => {
    const sc = document.createElement('canvas');
    sc.width = elOutputCanvas.width;
    sc.height = elOutputCanvas.height;
    const sctx = sc.getContext('2d');
    
    if (currentBgColor !== 'transparent') {
        sctx.fillStyle = currentBgColor;
        sctx.fillRect(0, 0, sc.width, sc.height);
    }
    sctx.drawImage(elOutputCanvas, 0, 0);
    
    const a = document.createElement('a');
    a.download = '누끼결과.png';
    a.href = sc.toDataURL();
    a.click();
});

updateUndoBtns();
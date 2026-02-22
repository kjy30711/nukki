const upArea = document.getElementById('up-uploadArea');
const upInput = document.getElementById('up-uploadInput');
const upUI = document.getElementById('up-uploadUI');
const upFileRow = document.getElementById('up-fileRow');
const upName = document.getElementById('up-fileNameText');
const upMeta = document.getElementById('up-fileMeta');
const upThumb = document.getElementById('up-thumb');
const upReBtn = document.getElementById('up-reUploadBtn');

const upBtn = document.getElementById('up-upscaleBtn');
const dnBtn = document.getElementById('up-downloadBtn');
const upEmpty = document.getElementById('up-emptyState');
const cmpCont = document.getElementById('up-compareContainer');
const imgBef = document.getElementById('up-imgBefore');
const imgAft = document.getElementById('up-imgAfter');
const sLine = document.getElementById('up-sliderLine');
const sBtn = document.getElementById('up-sliderBtn');

const pCont = document.getElementById('up-progressContainer');
const pFill = document.getElementById('up-progressFill');
const pPct = document.getElementById('up-progressPercent');
const pTxt = document.getElementById('up-progressText');

let origSrc = null;
let upSrc = null;

// [추가] AI 모델을 전역 변수로 선언하여 한 번만 로딩 (메모리 누수 방지)
let globalUpscaler = null;

// 파일 업로드 처리
upArea.addEventListener('click', (e) => {
    if (e.target.id === 'up-reUploadBtn' || e.target.closest('#up-reUploadBtn')) return;
    if (!upArea.classList.contains('has-file')) upInput.click();
});

upReBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    upInput.value = '';
    upInput.click();
});

upInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        origSrc = event.target.result;
        const img = new Image();
        img.onload = () => {
            upName.textContent = file.name;
            upMeta.textContent = img.width + ' × ' + img.height;
            upThumb.src = origSrc;
            
            upUI.style.display = 'none';
            upFileRow.style.display = 'flex';
            upFileRow.classList.add('show');
            upArea.classList.add('has-file');

            imgBef.src = origSrc;
            imgAft.src = origSrc; 
            
            upEmpty.style.display = 'none';
            cmpCont.style.display = 'block';
            upBtn.disabled = false;
            dnBtn.style.display = 'none';
            upBtn.style.display = 'flex'; 
            
            updateUpSlider(50);
        };
        img.src = origSrc;
    };
    reader.readAsDataURL(file);
});

// 슬라이더 처리
let isDrag = false;
function updateUpSlider(pct) {
    pct = Math.max(0, Math.min(100, pct));
    imgBef.style.clipPath = `polygon(0 0, ${pct}% 0, ${pct}% 100%, 0 100%)`;
    sLine.style.left = `${pct}%`;
    sBtn.style.left = `${pct}%`;
}

cmpCont.addEventListener('mousedown', () => isDrag = true);
window.addEventListener('mouseup', () => isDrag = false);
window.addEventListener('mousemove', (e) => {
    if (!isDrag) return;
    const rect = cmpCont.getBoundingClientRect();
    updateUpSlider(((e.clientX - rect.left) / rect.width) * 100);
});

cmpCont.addEventListener('touchstart', () => isDrag = true);
window.addEventListener('touchend', () => isDrag = false);
window.addEventListener('touchmove', (e) => {
    if (!isDrag) return;
    const rect = cmpCont.getBoundingClientRect();
    updateUpSlider(((e.touches[0].clientX - rect.left) / rect.width) * 100);
});

// 브라우저 튕김 방지용 한계치 대폭 축소 (800px)
function getSafeInput(imgElem, maxSize = 800) {
    let w = imgElem.width;
    let h = imgElem.height;
    
    if (w <= maxSize && h <= maxSize) {
        return imgElem;
    }
    
    let ratio = maxSize / Math.max(w, h);
    let canvas = document.createElement('canvas');
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    let ctx = canvas.getContext('2d');
    
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imgElem, 0, 0, canvas.width, canvas.height);
    
    return canvas;
}

// 업스케일 실행 로직
upBtn.addEventListener('click', async () => {
    if (!origSrc) return;
    upBtn.disabled = true;
    pCont.style.display = 'block';
    pTxt.textContent = '메모리 정리 및 준비 중...';
    pFill.style.width = '5%';
    pPct.textContent = '5%';

    try {
        const img = new Image();
        img.src = origSrc;
        await new Promise(r => img.onload = r);

        pTxt.textContent = '이미지 규격 최적화 중...';
        const safeInput = getSafeInput(img, 800); 

        pFill.style.width = '15%';
        pPct.textContent = '15%';

        // 모델이 없으면 생성, 있으면 기존 모델 재사용 (매우 중요)
        if (!globalUpscaler) {
            pTxt.textContent = 'AI 모델 로딩 중 (최초 1회만)...';
            globalUpscaler = new Upscaler();
        }

        pTxt.textContent = '해상도 복원 및 화질 개선 중...';
        pFill.style.width = '30%';
        pPct.textContent = '30%';

        // 더 잘게 쪼개서 연산 (patchSize 32, 경계선 보정을 위해 padding 4)
        upSrc = await globalUpscaler.upscale(safeInput, {
            patchSize: 32,
            padding: 4,
            progress: (amt) => {
                const pct = Math.round(30 + (amt * 70)); 
                pFill.style.width = `${pct}%`;
                pPct.textContent = `${pct}%`;
            }
        });

        imgAft.src = upSrc;
        dnBtn.style.display = 'flex';
        upBtn.style.display = 'none'; 
        pTxt.textContent = '처리 완료!';

        let auto = 100;
        const si = setInterval(() => {
            auto -= 2;
            updateUpSlider(auto);
            if (auto <= 30) clearInterval(si);
        }, 16);

    } catch (err) {
        console.error("Upscale Error:", err);
        alert("메모리 초과 오류가 발생했습니다.\n\n해결방법: 브라우저 창을 완전히 닫았다가 다시 열어주세요(캐시 비우기).");
    } finally {
        upBtn.disabled = false;
        setTimeout(() => pCont.style.display = 'none', 3000);
    }
});

// 다운로드 처리
dnBtn.addEventListener('click', () => {
    if (!upSrc) return;
    const a = document.createElement('a');
    a.href = upSrc;
    a.download = `upscaled_pro_${Date.now()}.png`;
    a.click();
});

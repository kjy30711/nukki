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

// [핵심 해결 방법] 브라우저 메모리 초과 방지를 위한 안전 크기 리사이징 함수
function getSafeInput(imgElem, maxSize = 1200) {
    let w = imgElem.width;
    let h = imgElem.height;
    
    // 이미지가 기준치보다 작으면 그대로 반환
    if (w <= maxSize && h <= maxSize) {
        return imgElem;
    }
    
    // 이미지가 크면 비율을 유지한 채 최대 크기로 줄임
    let ratio = maxSize / Math.max(w, h);
    let canvas = document.createElement('canvas');
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    let ctx = canvas.getContext('2d');
    
    // 고품질 리사이징 옵션 적용
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
    pTxt.textContent = 'AI 모델 로딩 중...';
    pFill.style.width = '10%';
    pPct.textContent = '10%';

    try {
        const img = new Image();
        img.src = origSrc;
        await new Promise(r => img.onload = r);

        // 이미지 크기가 너무 클 경우 브라우저 튕김 현상을 막기 위해 리사이징 처리
        pTxt.textContent = '이미지 메모리 최적화 중...';
        const safeInput = getSafeInput(img, 1200); // 1200px 이상의 이미지는 축소 후 진행

        pFill.style.width = '30%';
        pPct.textContent = '30%';

        // 메모리 해제를 돕기 위해 기존 텐서플로우 백엔드 강제 정리 (선택적)
        if (typeof tf !== 'undefined') {
            await tf.ready();
        }

        const upscaler = new Upscaler();

        pTxt.textContent = '해상도 복원 및 화질 개선 중...';
        pFill.style.width = '50%';
        pPct.textContent = '50%';

        // 패치 크기(patchSize)를 64로 유지하여 메모리 사용량을 최소화
        upSrc = await upscaler.upscale(safeInput, {
            patchSize: 64,
            padding: 2,
            progress: (amt) => {
                const pct = Math.round(50 + (amt * 50)); 
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
        // 에러 메시지를 좀 더 명확하게 수정
        alert("메모리 초과 오류가 발생했습니다. 브라우저를 새로고침(F5)한 뒤 다시 시도해주세요.");
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

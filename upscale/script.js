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

        if (img.width * img.height > 1500000) {
            alert('이미지 크기가 커서 처리에 시간이 다소 걸릴 수 있습니다.');
        }

        pFill.style.width = '30%';
        pPct.textContent = '30%';

        const upscaler = new Upscaler();

        pTxt.textContent = '해상도 복원 및 화질 개선 중...';
        pFill.style.width = '50%';
        pPct.textContent = '50%';

        upSrc = await upscaler.upscale(img, {
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
        alert("오류가 발생했습니다. 브라우저 메모리가 부족할 수 있습니다.");
    } finally {
        upBtn.disabled = false;
        setTimeout(() => pCont.style.display = 'none', 3000);
    }
});

dnBtn.addEventListener('click', () => {
    if (!upSrc) return;
    const a = document.createElement('a');
    a.href = upSrc;
    a.download = `upscaled_pro_${Date.now()}.png`;
    a.click();
});
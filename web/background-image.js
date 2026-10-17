// Private, account-bound images. The original stays in this browser and is never uploaded.
const CropState = {bitmap: null, scale: 1, minimum: 1, x: 0, y: 0, drag: null, frame: 0, busy: false, loadVersion: 0};

function syncBackgroundImage() {
    const version = AppState.backgroundImageVersion;
    const choice = document.querySelector('[data-background-choice="custom"]');
    choice.hidden = !version;
    document.getElementById('remove-background').hidden = !version;
    document.querySelector('#upload-background span').textContent = version ? '更换图片' : '上传图片';
    document.querySelectorAll('.livo-wallpaper, .background-swatch[data-background="custom"]').forEach(node => {
        if (version) {
            const url = new URL('api/background-image', location.href);
            url.searchParams.set('v', version);
            node.style.setProperty('--custom-image', `url("${url.href}")`);
        } else node.style.removeProperty('--custom-image');
    });
}

function clampCrop() {
    const image = CropState.bitmap;
    if (!image) return;
    CropState.x = Math.max(960 - image.width * CropState.scale, Math.min(0, CropState.x));
    CropState.y = Math.max(540 - image.height * CropState.scale, Math.min(0, CropState.y));
}

function drawCrop() {
    cancelAnimationFrame(CropState.frame);
    CropState.frame = requestAnimationFrame(() => {
        if (!CropState.bitmap) return;
        clampCrop();
        const context = document.getElementById('background-crop').getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0, 0, 960, 540);
        context.drawImage(CropState.bitmap, CropState.x, CropState.y, CropState.bitmap.width * CropState.scale, CropState.bitmap.height * CropState.scale);
    });
}

function zoomCrop(value) {
    if (!CropState.bitmap || CropState.busy) return;
    const scale = CropState.minimum * Math.max(1, Math.min(3, value / 100));
    const factor = scale / CropState.scale;
    CropState.x = 480 - (480 - CropState.x) * factor;
    CropState.y = 270 - (270 - CropState.y) * factor;
    CropState.scale = scale;
    drawCrop();
}

function setCropBusy(busy) {
    CropState.busy = busy;
    for (const id of ['save-crop', 'cancel-crop', 'close-crop', 'crop-zoom']) document.getElementById(id).disabled = busy;
    document.getElementById('save-crop').textContent = busy ? '正在保存' : '保存背景';
}

async function openBackgroundFile(file) {
    if (!file || !AppState.session || backgroundSaving) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
        showLivoStatus('请选择 8 MB 以内的 JPG、PNG 或 WebP 图片。'); return;
    }
    const version = ++CropState.loadVersion;
    const session = AppState.session;
    const upload = document.getElementById('upload-background');
    upload.disabled = true;
    try {
        const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
        if (version !== CropState.loadVersion || session !== AppState.session) { bitmap.close(); return; }
        if (bitmap.width < 960 || bitmap.height < 540 || bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 24000000) {
            bitmap.close(); throw new Error('图片至少为 960×540，单边不超过 8192，且不超过 2400 万像素。');
        }
        CropState.bitmap?.close(); CropState.bitmap = bitmap;
        CropState.minimum = Math.max(960 / bitmap.width, 540 / bitmap.height);
        CropState.scale = CropState.minimum;
        CropState.x = (960 - bitmap.width * CropState.scale) / 2;
        CropState.y = (540 - bitmap.height * CropState.scale) / 2;
        document.getElementById('crop-zoom').value = '100';
        document.getElementById('crop-error').textContent = '';
        setCropBusy(false);
        document.getElementById('crop-dialog').showModal(); drawCrop();
    } catch (error) { if (session === AppState.session) showLivoStatus(error.message || '无法读取这张图片，请换一张。'); }
    finally { upload.disabled = backgroundSaving; }
}

async function saveCroppedBackground() {
    if (CropState.busy || !CropState.bitmap || !AppState.session) return;
    const session = AppState.session;
    const version = ++backgroundSaveVersion;
    setCropBusy(true); backgroundSaving = true; renderBackgroundChoices();
    document.getElementById('crop-error').textContent = '';
    try {
        const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0, 0, 1600, 900);
        context.scale(1600 / 960, 900 / 540);
        clampCrop();
        context.drawImage(CropState.bitmap, CropState.x, CropState.y, CropState.bitmap.width * CropState.scale, CropState.bitmap.height * CropState.scale);
        let image;
        for (const quality of [.86, .78, .68, .56, .44]) {
            image = canvas.toDataURL('image/jpeg', quality);
            if ((image.length - image.indexOf(',') - 1) * .75 <= 700 * 1024) break;
        }
        if ((image.length - image.indexOf(',') - 1) * .75 > 700 * 1024) throw new Error('这张图片压缩后仍然过大，请换一张。');
        const result = await livoAPI('background-image', {image});
        if (session !== AppState.session) return;
        applyServerBackground(result);
        Object.assign(session, result);
        document.getElementById('background-status').textContent = '已保存';
        document.getElementById('crop-dialog').close();
    } catch (error) { if (session === AppState.session) document.getElementById('crop-error').textContent = error.message; }
    finally {
        setCropBusy(false);
        if (version === backgroundSaveVersion) { backgroundSaving = false; renderBackgroundChoices(); }
    }
}

function initImageBackgrounds() {
    const input = document.getElementById('background-file');
    const dialog = document.getElementById('crop-dialog');
    const canvas = document.getElementById('background-crop');
    const slider = document.getElementById('crop-zoom');
    document.getElementById('upload-background').onclick = () => { input.value = ''; input.click(); };
    input.onchange = () => openBackgroundFile(input.files[0]);
    document.getElementById('close-crop').onclick = document.getElementById('cancel-crop').onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (CropState.busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
        CropState.loadVersion++; cancelAnimationFrame(CropState.frame);
        CropState.bitmap?.close(); CropState.bitmap = null; CropState.drag = null;
        input.value = ''; canvas.getContext('2d').clearRect(0, 0, 960, 540);
    });
    slider.oninput = () => zoomCrop(Number(slider.value));
    canvas.onpointerdown = event => {
        if (CropState.busy || !CropState.bitmap || (event.pointerType === 'mouse' && event.button !== 0)) return;
        canvas.setPointerCapture(event.pointerId);
        CropState.drag = {id: event.pointerId, x: event.clientX, y: event.clientY};
        canvas.classList.add('dragging');
    };
    canvas.onpointermove = event => {
        const drag = CropState.drag;
        if (!drag || drag.id !== event.pointerId || CropState.busy) return;
        const bounds = canvas.getBoundingClientRect();
        CropState.x += (event.clientX - drag.x) * 960 / bounds.width;
        CropState.y += (event.clientY - drag.y) * 540 / bounds.height;
        drag.x = event.clientX; drag.y = event.clientY; drawCrop();
    };
    canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = () => { CropState.drag = null; canvas.classList.remove('dragging'); };
    canvas.onkeydown = event => {
        if (CropState.busy || !CropState.bitmap) return;
        const moves = {ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10]};
        if (!moves[event.key]) return;
        event.preventDefault(); CropState.x += moves[event.key][0]; CropState.y += moves[event.key][1]; drawCrop();
    };
    document.getElementById('save-crop').onclick = saveCroppedBackground;
    document.getElementById('remove-background').onclick = async () => {
        if (backgroundSaving || !AppState.session) return;
        const session = AppState.session, version = ++backgroundSaveVersion;
        backgroundSaving = true; renderBackgroundChoices();
        const status = document.getElementById('background-status'); status.textContent = '正在移除';
        try {
            const result = await livoAPI('background-image/delete', {});
            if (session !== AppState.session) return;
            applyServerBackground(result); Object.assign(session, result); status.textContent = '已移除';
        } catch (error) { if (session === AppState.session) { status.textContent = '移除失败，请重试'; showLivoStatus(error.message); } }
        finally { if (version === backgroundSaveVersion) { backgroundSaving = false; renderBackgroundChoices(); } }
    };
}

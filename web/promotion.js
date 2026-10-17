/* Entirely local poster generation. Private records never leave the browser. */
(() => {
    const dialog = document.getElementById('share-dialog');
    const preview = document.getElementById('share-preview');
    const include = document.getElementById('include-note');
    const status = document.getElementById('share-status');
    let blob = null, url = null, sequence = 0, owner = null;
    function closePreview() {
        if(!dialog.open || dialog.classList.contains('is-closing')) return;
        if(matchMedia('(prefers-reduced-motion:reduce)').matches) { dialog.close(); return; }
        dialog.classList.add('is-closing');
        setTimeout(()=>dialog.close(),180);
    }
    const font = '"Livo Sans SC", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const heart = 'M16 28.2c-.3 0-.6-.1-.8-.3-7.8-6.5-11.7-11.2-11.7-15.4C3.5 8.9 5.8 6 9 6c2.1 0 4.2 1.4 5.6 3.1.3.4.8.6 1.4.6s1.1-.2 1.4-.6C18.8 7.4 20.9 6 23 6c3.2 0 5.5 2.9 5.5 6.5 0 4.2-3.9 8.9-11.7 15.4-.2.2-.5.3-.8.3z';
    async function render() {
        const ticket = ++sequence;
        blob = null;
        await document.fonts.ready;
        if (!owner || owner !== AppState.session || !dialog.open) return;
        const canvas = document.createElement('canvas');
        canvas.width = 1080; canvas.height = 1440;
        const c = canvas.getContext('2d');
        const palette = {cloud:['#f7f3f6','#ece4ec'],dawn:['#fff5ec','#f1ddd7'],forest:['#f1f7ee','#dbe8dd'],sea:['#f0f8fd','#dae7f1'],dusk:['#f6f1fb','#e5dcef'],paper:['#fff9eb','#f0e6d1'],custom:['#f7f3f6','#ece4ec']};
        const colors = palette[AppState.background] || palette.cloud;
        const gradient = c.createLinearGradient(0,0,1080,1440);
        gradient.addColorStop(0,colors[0]); gradient.addColorStop(1,colors[1]);
        c.fillStyle = gradient; c.fillRect(0,0,1080,1440);
        c.textAlign = 'center'; c.fillStyle = '#1d1d1f';
        c.font = `600 44px ${font}`; c.fillText('Livo',540,150);
        c.font = `400 32px ${font}`; c.fillText(formatBeijingDate(),540,260);
        c.save(); c.translate(348,330); c.scale(12,12); c.fillStyle='#e8677c'; c.fill(new Path2D(heart));
        c.strokeStyle='#fff'; c.lineWidth=1.6; c.lineCap='round'; c.lineJoin='round';
        c.beginPath(); c.moveTo(10,16); c.lineTo(13.5,16); c.lineTo(15.3,11.8); c.lineTo(17.7,20.2); c.lineTo(19.7,16); c.lineTo(23.5,16); c.stroke(); c.restore();
        c.fillStyle='#1d1d1f'; c.font=`600 84px ${font}`; c.fillText('今天，也在。',540,820);
        const note = include.checked ? document.getElementById('checkin-note').value.trim() : '';
        c.font=`400 32px ${font}`;
        if (note) {
            const lines=[]; let line='';
            for (const character of [...note].slice(0,100)) {
                if(c.measureText(line+character).width>800) { lines.push(line); line=''; }
                line+=character;
            }
            if(line) lines.push(line);
            lines.slice(0,5).forEach((text,i)=>c.fillText(text,540,920+i*48));
        } else { c.fillText('为自己，留下一份记录。',540,950); }
        c.font=`400 28px ${font}`; c.fillText('livo.workstudioai.top',540,1310);
        const result = await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        if(ticket!==sequence || owner!==AppState.session || !dialog.open) return;
        if(!result) throw Error('暂时无法生成图片，请重试。');
        if(url) URL.revokeObjectURL(url);
        blob=result; url=URL.createObjectURL(result); preview.src=url;
    }
    document.getElementById('share-today').onclick = async () => {
        if(!AppState.session || !AppState.checkinData[getBeijingDateKey()]) return;
        owner=AppState.session; include.checked=false; status.textContent='';
        dialog.showModal();
        try { await render(); } catch(error) { status.textContent=error.message; }
    };
    include.onchange=()=>render().catch(error=>status.textContent=error.message);
    document.getElementById('close-share').onclick=closePreview;
    dialog.addEventListener('cancel',event=> { event.preventDefault(); closePreview(); });
    dialog.addEventListener('click',event=> { if(event.target===dialog) { const r=dialog.getBoundingClientRect(); if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom) closePreview(); } });
    dialog.addEventListener('close',()=> { dialog.classList.remove('is-closing'); sequence++; owner=null; blob=null; preview.removeAttribute('src'); if(url) URL.revokeObjectURL(url); url=null; });
    document.getElementById('save-share').onclick=async()=> {
        if(!blob || owner!==AppState.session) return;
        const file=new File([blob],`Livo-${getBeijingDateKey()}.png`,{type:'image/png'});
        try {
            if(navigator.canShare?.({files:[file]}) && matchMedia('(pointer:coarse)').matches) {
                await navigator.share({files:[file],title:'Livo · 今天，也在。'});
                status.textContent='';
            } else {
                const link=document.createElement('a'); link.href=url; link.download=file.name; link.click();
                status.textContent='图片已生成，请在下载列表中查看。';
            }
        } catch(error) { if(error.name!=='AbortError') status.textContent='请长按预览图片保存。'; }
    };
    document.getElementById('copy-share').onclick=async()=> {
        try { await navigator.clipboard.writeText(new URL('about',location.href).href); status.textContent='链接已复制。'; }
        catch { status.textContent='可直接复制浏览器中的网站地址。'; }
    };
})();

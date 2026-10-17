// Real administrator data is fetched only after a server-verified admin login.
let adminRequest = 0;
let memberRequest = 0;
let regionRequest = 0;
let regionDays = 7;
let regionPage = 1;
let memberPage = 1;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function placeName(row) {
    let country = row.country;
    if (!country && row.country_code) {
        try { country = new Intl.DisplayNames(['zh-CN'], {type: 'region'}).of(row.country_code); }
        catch (_) { country = row.country_code; }
    }
    return [...new Set([country, row.region, row.city].filter(Boolean))].join(' · ') || '未知地区';
}

function shortDate(timestamp, withTime = false) {
    if (!timestamp) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
        ...(withTime ? {hour: '2-digit', minute: '2-digit', hour12: false} : {})
    }).format(new Date(timestamp * 1000));
}

function pager(id, parent, onChange) {
    let node = document.getElementById(id);
    if (node) return node;
    node = el('div', 'livo-pager'); node.id = id;
    const previous = el('button', 'btn-secondary', '上一页');
    const label = el('span');
    const next = el('button', 'btn-secondary', '下一页');
    previous.type = next.type = 'button';
    previous.onclick = () => onChange(-1);
    next.onclick = () => onChange(1);
    node.append(previous, label, next); parent.append(node);
    return node;
}

function updatePager(node, page, pages) {
    node.hidden = pages <= 1;
    node.children[0].disabled = page <= 1;
    node.children[1].textContent = `${page} / ${pages}`;
    node.children[2].disabled = page >= pages;
}

function renderRegions(data) {
    const summary = data.summary;
    document.getElementById('region-login-count').textContent = summary.logins.toLocaleString();
    document.getElementById('region-user-count').textContent = summary.users.toLocaleString();
    document.getElementById('region-place-count').textContent = summary.places.toLocaleString();
    const ranking = document.getElementById('regions-list');
    ranking.replaceChildren();
    data.regions.forEach(row => {
        const item = el('div', 'livo-region-row');
        item.append(el('div', 'livo-region-name', placeName(row)));
        const count = el('div', 'livo-region-count', `${row.count} 次`);
        item.append(count);
        const bar = el('div', 'livo-region-bar');
        const fill = el('div', 'livo-region-bar-fill');
        fill.style.setProperty('--share', `${Math.max(0, Math.min(100, row.count / Math.max(1, summary.logins) * 100))}%`);
        bar.append(fill); item.append(bar); ranking.append(item);
    });
    if (!data.regions.length) ranking.append(el('p', 'livo-empty', '还没有登录记录'));
    if (data.other) ranking.append(el('p', 'livo-login-meta', `其余地区 · ${data.other} 次`));
    const recent = document.getElementById('recent-logins');
    recent.replaceChildren();
    data.records.forEach(row => {
        const item = el('article', 'livo-login-row');
        item.append(el('div', 'livo-login-name', row.nickname || row.username));
        item.append(el('time', 'livo-login-time', shortDate(row.created, true)));
        item.append(el('div', 'livo-login-place', placeName(row)));
        item.append(el('div', 'livo-login-meta', [row.device, row.browser, row.ip_mask || '未获取公网 IP'].join(' · ')));
        recent.append(item);
    });
    if (!data.records.length) recent.append(el('p', 'livo-empty', '真实登录后会显示在这里'));
    const pagination = pager('region-pagination', recent.parentElement, delta => {
        regionPage += delta; loadRegions();
    });
    updatePager(pagination, data.page, data.pages);
    document.querySelector('.region-footnote').textContent = '地区为 IP 大致位置 · 仅记录成功登录 · 保留 30 天';
    revealContent(document.querySelector('.region-content'), 260);
}

async function loadRegions() {
    const version = ++regionRequest;
    if (AppState.mode !== 'account') return;
    const session = AppState.session;
    try {
        const data = await livoAPI(`admin/regions?days=${regionDays}&page=${regionPage}`);
        if (version !== regionRequest || AppState.mode !== 'account' || session !== AppState.session) return;
        renderRegions(data);
    } catch (error) {
        if (version === regionRequest && session === AppState.session) {
            document.getElementById('regions-list').replaceChildren(el('p', 'livo-empty', '读取失败，请点击刷新'));
            document.getElementById('recent-logins').replaceChildren();
            ['region-login-count', 'region-user-count', 'region-place-count'].forEach(id => { document.getElementById(id).textContent = '—'; });
            showLivoStatus(error.message);
        }
    }
}

function renderMembers(data) {
    const body = document.getElementById('users-table-body');
    body.replaceChildren();
    data.members.forEach(user => {
        const row = el('tr');
        [user.nickname || user.username, shortDate(user.created), shortDate(user.last_login, true), `${user.total} 天`].forEach(text => row.append(el('td', '', text)));
        body.append(row);
    });
    if (!data.members.length) {
        const row = el('tr'), cell = el('td', 'livo-empty', '没有匹配的用户');
        cell.colSpan = 4; row.append(cell); body.append(row);
    }
    const pagination = pager('member-pagination', document.querySelector('.users-section'), delta => {
        memberPage += delta; loadMembers();
    });
    updatePager(pagination, data.page, data.pages);
}

async function loadMembers() {
    const version = ++memberRequest;
    const session = AppState.session;
    const query = document.getElementById('user-search').value.trim();
    try {
        const data = await livoAPI(`admin?page=${memberPage}&q=${encodeURIComponent(query)}`);
        if (version === memberRequest && AppState.mode === 'account' && session === AppState.session) renderMembers(data);
    } catch (error) { if (AppState.mode === 'account') showLivoStatus(error.message); }
}

async function updateAdminPage() {
    const version = ++adminRequest;
    AppState.adminData = null;
    document.querySelectorAll('.livo-pager').forEach(node => { node.hidden = true; });
    const badge = document.querySelector('.admin-badge span');
    const buttons = document.querySelectorAll('[data-region-days]');
    regionDays = 7; regionPage = memberPage = 1;
    buttons.forEach(button => {
        button.classList.toggle('active', button.dataset.regionDays === '7');
        button.setAttribute('aria-pressed', String(button.dataset.regionDays === '7'));
        button.onclick = () => {
            regionDays = Number(button.dataset.regionDays); regionPage = 1;
            buttons.forEach(other => {
                other.classList.toggle('active', other === button);
                other.setAttribute('aria-pressed', String(other === button));
            });
            syncIndicator(button.parentElement);
            if (AppState.mode === 'account') loadRegions();
        };
    });
    syncIndicator(document.querySelector('.region-range-buttons'));
    if (AppState.session?.role !== 'admin') { showPage('today'); return; }
    badge.textContent = '管理后台';
    document.getElementById('exit-admin').onclick = () => showPage('today');
    document.getElementById('exit-admin').textContent = '返回';
    document.getElementById('refresh-admin').onclick = updateAdminPage;
    document.querySelectorAll('.chart-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.chart-tab').forEach(other => other.classList.toggle('active', other === tab));
            syncIndicator(tab.parentElement);
            drawChart(Number(tab.dataset.period));
        };
    });
    const labels = ['注册用户', '今日新增', '今日打卡', '近 7 日打卡用户'];
    document.querySelectorAll('.admin-stat-label').forEach((label, index) => { label.textContent = labels[index]; label.removeAttribute('title'); });
    document.querySelectorAll('.admin-stat-value').forEach(value => { value.textContent = '—'; });
    document.getElementById('users-table-body').replaceChildren();
    document.getElementById('regions-list').replaceChildren(el('p', 'livo-empty', '正在读取'));
    document.getElementById('recent-logins').replaceChildren();
    ['region-login-count', 'region-user-count', 'region-place-count'].forEach(id => { document.getElementById(id).textContent = '—'; });
    // Clear old account data while reading the current, authorized report.
    AppState.adminData = {trend: Array.from({length: 30}, () => ({checkins: 0}))}; drawChart(7);
    const input = document.getElementById('user-search');
    input.replaceWith(input.cloneNode(true));
    let searchTimer;
    document.getElementById('user-search').addEventListener('input', () => {
        clearTimeout(searchTimer); memberPage = 1;
        searchTimer = setTimeout(loadMembers, 220);
    });
    const session = AppState.session;
    try {
        const [data] = await Promise.all([livoAPI('admin'), loadRegions()]);
        if (version !== adminRequest || AppState.mode !== 'account' || session !== AppState.session) return;
        AppState.adminData = data;
        [data.users, data.new_users, data.checked_today, data.active_7d].forEach((count, index) => {
            document.querySelectorAll('.admin-stat-value')[index].textContent = count.toLocaleString();
        });
        if (!document.getElementById('user-search').value.trim()) renderMembers(data);
        drawChart(Number(document.querySelector('.chart-tab.active').dataset.period));
    } catch (error) {
        if (version === adminRequest && AppState.session === session) {
            document.getElementById('regions-list').replaceChildren(el('p', 'livo-empty', '读取失败，请点击刷新'));
            showLivoStatus(error.message);
        }
    }
}

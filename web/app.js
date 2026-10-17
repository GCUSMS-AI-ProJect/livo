// ==================== 全局状态 ====================

const AppState = {
    currentUser: null,
    currentPage: 'auth',
    checkinData: {},
    calendarYear: null,
    calendarMonth: null,
    checkinInProgress: false,
    mode: 'account',
    session: null,
    adminData: null,
    background: 'cloud',
    backgroundImageVersion: '',
    backgroundUpdated: 0
};

async function livoAPI(path, data, session = AppState.session) {
    const response = await fetch(`api/${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', cache: 'no-store',
        headers: data === undefined ? {} : {'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || ''},
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(15000)
    });
    const value = await response.json();
    if (!response.ok) {
        if (response.status === 401 && session && session === AppState.session && !['login', 'register', 'auth'].includes(path)) {
            clearAccount();
            showLivoStatus('登录已过期，请重新登录。');
        }
        throw new Error(value.error || '暂时无法连接，请重试。');
    }
    return value;
}

function setLivoSession(value) {
    AppState.mode = 'account';
    AppState.session = value.user;
    AppState.currentUser = value.user.username;
    AppState.checkinData = value.calendar?.records || {};
    syncServerDay(value.calendar);
    syncAccountChrome();
    applyServerBackground(value.user, false);
}

function syncAccountChrome() {
    document.querySelectorAll('.user-name').forEach(el => {
        el.textContent = AppState.session?.nickname || AppState.currentUser || '';
        el.title = AppState.currentUser || '';
    });
    document.querySelectorAll('.account-admin-entry').forEach(el => {
        el.hidden = !(AppState.mode === 'account' && AppState.session?.role === 'admin');
    });
}

async function leaveAccount() {
    try {
        await flushNote();
        await livoAPI('logout', {});
        clearAccount();
    } catch (error) { showLivoStatus(error.message); }
}

function clearAccount() {
    clearTimeout(noteTimer);
    pendingNote = null;
    noteQueue = Promise.resolve();
    AppState.session = AppState.currentUser = AppState.adminData = null;
    AppState.checkinData = {};
    AppState.background = 'cloud';
    AppState.backgroundImageVersion = '';
    document.getElementById('crop-dialog').close();
    document.getElementById('share-dialog').close();
    syncBackgroundImage();
    AppState.backgroundUpdated = 0;
    backgroundSaveVersion++;
    backgroundSaving = false;
    document.getElementById('background-status').textContent = '';
    applyBackground('cloud', false);
    renderBackgroundChoices();
    document.getElementById('password-dialog').close();
    document.getElementById('password-form').reset();
    document.querySelectorAll('.auth-form').forEach(form => form.reset());
    updateLoginHeart();
    document.querySelectorAll('.toggle-password').forEach(button => setPasswordVisibility(button, false));
    document.getElementById('history-list').replaceChildren();
    document.getElementById('users-table-body').replaceChildren();
    document.getElementById('recent-logins').replaceChildren();
    document.getElementById('regions-list').replaceChildren();
    document.getElementById('checkin-note').value = '';
    syncAccountChrome();
    showPage('auth');
}

let serverClockOffset = 0;
function syncServerDay(calendar) {
    if (calendar?.now) serverClockOffset = calendar.now * 1000 - Date.now();
}

function showLivoStatus(text) {
    const status = document.getElementById('livo-status');
    status.textContent = text;
    status.hidden = false;
    clearTimeout(showLivoStatus.timer);
    showLivoStatus.timer = setTimeout(() => { status.hidden = true; }, 4000);
}

// ==================== 北京时间工具 ====================

function getBeijingDateParts() {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const parts = {};
    formatter.formatToParts(new Date(Date.now() + serverClockOffset)).forEach(part => {
        parts[part.type] = part.value;
    });

    return parts;
}

function getBeijingDateKey() {
    const parts = getBeijingDateParts();
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function getBeijingTime() {
    const parts = getBeijingDateParts();
    return `${parts.hour}:${parts.minute}`;
}

function formatBeijingDate() {
    const parts = getBeijingDateParts();
    return `${parseInt(parts.month)}月${parseInt(parts.day)}日`;
}

function createUTCDate(year, month, day) {
    return new Date(Date.UTC(year, month, day));
}

function addDays(dateKey, days) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = createUTCDate(year, month - 1, day);
    date.setUTCDate(date.getUTCDate() + days);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ==================== 数据管理 ====================

// ==================== 页面切换 ====================

const contentAnimations = new WeakMap();
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let heartbeatTimer;

function celebrateLife(button) {
    clearTimeout(heartbeatTimer);
    button.classList.remove('is-celebrating');
    if (reducedMotion() || !button.closest('.page.active')) return;
    void button.offsetWidth;
    button.classList.add('is-celebrating');
    heartbeatTimer = setTimeout(() => button.classList.remove('is-celebrating'), 2300);
}

function revealContent(element, duration = 300) {
    if (!element) return;
    contentAnimations.get(element)?.cancel();
    if (reducedMotion() || typeof element.animate !== 'function') return;
    const animation = element.animate([
        { opacity: 0.35, transform: 'translateY(5px)' },
        { opacity: 1, transform: 'translateY(0)' }
    ], { duration, easing: 'cubic-bezier(.22,1,.36,1)' });
    contentAnimations.set(element, animation);
}

function syncIndicator(container) {
    if (!container || !container.getClientRects().length) return;
    const active = container.querySelector('button.active');
    if (!active) return;
    container.style.setProperty('--selection-x', `${active.offsetLeft}px`);
    container.style.setProperty('--selection-y', `${active.offsetTop}px`);
    container.style.setProperty('--selection-width', `${active.offsetWidth}px`);
    container.style.setProperty('--selection-height', `${active.offsetHeight}px`);
    container.querySelectorAll('button').forEach(button => {
        button.setAttribute('aria-pressed', String(button === active));
    });
    requestAnimationFrame(() => container.classList.add('selection-ready'));
}

function initMotion() {
    const containers = document.querySelectorAll('.auth-tabs, .bottom-nav, .chart-tabs, .region-range-buttons');
    const resize = new ResizeObserver(entries => entries.forEach(entry => syncIndicator(entry.target)));
    containers.forEach(container => resize.observe(container));
    document.fonts.ready.then(() => containers.forEach(syncIndicator));
    document.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.matches('.auth-tab, .nav-item, .chart-tab, .region-range-btn')) {
            syncIndicator(button.parentElement);
        }
        if (button.matches('.chart-tab')) revealContent(document.querySelector('#trend-chart'), 240);
        if (button.matches('.calendar-nav-btn')) revealContent(document.querySelector('#calendar-grid'), 240);
    });
}

function showPage(pageName) {
    if (pageName !== 'auth' && !AppState.session) pageName = 'auth';
    if (pageName === 'admin' && AppState.session?.role !== 'admin') pageName = 'today';
    const previousPage = AppState.currentPage;
    if (pageName !== 'today') {
        clearTimeout(heartbeatTimer);
        document.getElementById('checkin-button').classList.remove('is-celebrating');
    }
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });

    const targetPage = document.getElementById(`${pageName}-page`);
    if (targetPage) {
        targetPage.classList.add('active');
        AppState.currentPage = pageName;

        if (pageName === 'today') {
            updateTodayPage();
        } else if (pageName === 'records') {
            const parts = getBeijingDateParts();
            AppState.calendarYear = parseInt(parts.year);
            AppState.calendarMonth = parseInt(parts.month) - 1;
            updateRecordsPage();
        } else if (pageName === 'admin') {
            updateAdminPage();
        }
        const navigation = document.getElementById('app-nav');
        navigation.hidden = !['today', 'records'].includes(pageName);
        updateNavigation(pageName);
        targetPage.querySelectorAll('.auth-tabs, .chart-tabs').forEach(syncIndicator);
        if (previousPage !== pageName && pageName !== 'auth') {
            revealContent(targetPage.querySelector('main, .auth-card'));
        }
    }
}

// ==================== 登录/注册 ====================

function setPasswordVisibility(button, visible) {
    const input = document.getElementById(button.getAttribute('aria-controls'));
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
    button.title = visible ? '隐藏密码' : '显示密码';
}

function updateLoginHeart() {
    const hasAccount = document.getElementById('login-email').value.trim().length > 0;
    const hasPassword = document.getElementById('login-password').value.length >= 6;
    document.getElementById('login-brand').dataset.heartLevel = hasAccount ? (hasPassword ? '2' : '1') : '0';
}

function initAuth() {
    const loginForm = document.getElementById('login-form');
    const togglePasswordButtons = document.querySelectorAll('.toggle-password');
    loginForm.addEventListener('input', updateLoginHeart);
    loginForm.addEventListener('change', updateLoginHeart);
    loginForm.addEventListener('focusin', updateLoginHeart);
    loginForm.addEventListener('reset', () => requestAnimationFrame(updateLoginHeart));
    window.addEventListener('pageshow', updateLoginHeart);
    // Password managers can populate fields after the initial document render.
    [0, 200, 800, 1600].forEach(delay => setTimeout(updateLoginHeart, delay));

    togglePasswordButtons.forEach(button => {
        setPasswordVisibility(button, false);
        button.addEventListener('click', () => {
            const input = document.getElementById(button.getAttribute('aria-controls'));
            setPasswordVisibility(button, input.type === 'password');
        });
    });

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('login-error');
        const submitButton = loginForm.querySelector('button[type="submit"]');

        errorEl.textContent = '';

        if (!username) {
            errorEl.textContent = '请输入用户名或邮箱';
            return;
        }

        if (!password || password.length < 6) {
            errorEl.textContent = '密码至少需要 6 位';
            return;
        }

        submitButton.classList.add('loading');
        submitButton.disabled = true;

        try {
            setLivoSession(await livoAPI('auth', {username, password}));
            document.getElementById('login-password').value = '';
            showPage('today');
        } catch (error) { errorEl.textContent = error.message; }
        finally {
            submitButton.classList.remove('loading');
            submitButton.disabled = false;
        }
    });

}

// ==================== 今天页 ====================

let noteTimer;
let pendingNote = null;
let noteQueue = Promise.resolve();
async function flushNote() {
    clearTimeout(noteTimer);
    const pending = pendingNote;
    if (!pending) return noteQueue;
    pendingNote = null;
    const saving = noteQueue.catch(() => {}).then(() => livoAPI('note', pending.data, pending.session));
    noteQueue = saving;
    try { await saving; }
    catch (error) {
        if (pending.session === AppState.session && !pendingNote) pendingNote = pending;
        throw error;
    }
}

function initToday() {
    const checkinButton = document.getElementById('checkin-button');
    const navItems = document.querySelectorAll('.nav-item');
    const userMenuButtons = document.querySelectorAll('#logout-account');
    const noteInput = document.getElementById('checkin-note');

    checkinButton.addEventListener('click', handleCheckin);

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetPage = item.dataset.page;
            if (targetPage) {
                showPage(targetPage);
                updateNavigation(targetPage);
            }
        });
    });

    userMenuButtons.forEach(button => {
        button.addEventListener('click', leaveAccount);
    });

    const saveNote = () => flushNote().catch(error => showLivoStatus(error.message));
    noteInput.addEventListener('blur', saveNote);
    noteInput.addEventListener('input', () => {
        const todayKey = getBeijingDateKey();
        if (AppState.checkinData[todayKey]) {
            AppState.checkinData[todayKey].note = noteInput.value;
            pendingNote = {data: {day: todayKey, note: noteInput.value}, session: AppState.session};
            clearTimeout(noteTimer);
            noteTimer = setTimeout(saveNote, 450);
        }
    });
}

function updateTodayPage() {
    const dateEl = document.getElementById('today-date');
    const titleEl = document.getElementById('today-title');
    const buttonEl = document.getElementById('checkin-button');
    const noteContainer = document.getElementById('note-container');
    const noteInput = document.getElementById('checkin-note');

    dateEl.textContent = formatBeijingDate();
    titleEl.textContent = '今天，也在。';

    const todayKey = getBeijingDateKey();
    const todayRecord = AppState.checkinData[todayKey];

    if (todayRecord) {
        buttonEl.querySelector('.checkin-button-text').textContent = '已记录';
        buttonEl.classList.add('done');
        buttonEl.disabled = false;
        noteContainer.style.display = 'block';
        noteInput.value = todayRecord.note || '';
    } else {
        buttonEl.querySelector('.checkin-button-text').textContent = '我还在';
        buttonEl.classList.remove('done');
        buttonEl.disabled = false;
        noteContainer.style.display = 'none';
        noteInput.value = '';
    }
}

async function handleCheckin() {
    if (AppState.checkinInProgress) return;

    const todayKey = getBeijingDateKey();
    if (AppState.checkinData[todayKey]) {
        celebrateLife(document.getElementById('checkin-button'));
        return;
    }

    AppState.checkinInProgress = true;
    const buttonEl = document.getElementById('checkin-button');
    buttonEl.disabled = true;

    try {
        const session = AppState.session;
        const result = await livoAPI('checkin', {});
        if (session !== AppState.session) { AppState.checkinInProgress = false; return; }
        syncServerDay(result);
        AppState.checkinData = result.records;
    } catch (error) {
        buttonEl.disabled = false;
        AppState.checkinInProgress = false;
        showLivoStatus(error.message);
        return;
    }

    const noteContainer = document.getElementById('note-container');

    buttonEl.classList.add('done');
    buttonEl.querySelector('.checkin-button-text').textContent = '已记录';
    revealContent(buttonEl.querySelector('.checkin-button-text'), 260);
    celebrateLife(buttonEl);

    setTimeout(() => {
        noteContainer.style.display = 'block';
        buttonEl.disabled = false;
        AppState.checkinInProgress = false;
    }, 300);
}

function updateNavigation(currentPage) {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === currentPage);
    });
    syncIndicator(document.querySelector('.bottom-nav'));
}

// ==================== 我的记录页 ====================

function updateRecordsPage() {
    updateStats();
    updateCalendar();
    updateHistory();
}

function updateStats() {
    const totalDays = Object.keys(AppState.checkinData).length;
    const streakDays = calculateStreak();
    const monthDays = calculateMonthDays();

    document.getElementById('total-days').textContent = totalDays;
    document.getElementById('streak-days').textContent = streakDays;
    document.getElementById('month-days').textContent = monthDays;
}

function calculateStreak() {
    const today = getBeijingDateKey();
    const todayRecord = AppState.checkinData[today];

    let checkDate = todayRecord ? today : addDays(today, -1);
    let streak = 0;

    while (AppState.checkinData[checkDate]) {
        streak++;
        checkDate = addDays(checkDate, -1);
    }

    return streak;
}

function calculateMonthDays() {
    const parts = getBeijingDateParts();
    const currentMonth = `${parts.year}-${parts.month}`;

    return Object.keys(AppState.checkinData).filter(dateKey =>
        dateKey.startsWith(currentMonth)
    ).length;
}

function updateCalendar() {
    const year = AppState.calendarYear;
    const month = AppState.calendarMonth;

    document.getElementById('calendar-title').textContent = `${year}年${month + 1}月`;

    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = '';

    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    weekdays.forEach(day => {
        const header = document.createElement('div');
        header.className = 'calendar-day header';
        header.textContent = day;
        grid.appendChild(header);
    });

    const firstDay = createUTCDate(year, month, 1);
    const lastDay = createUTCDate(year, month + 1, 0);
    const firstDayWeek = firstDay.getUTCDay();
    const totalDays = lastDay.getUTCDate();

    for (let i = 0; i < firstDayWeek; i++) {
        const empty = document.createElement('div');
        empty.className = 'calendar-day other-month';
        grid.appendChild(empty);
    }

    const todayKey = getBeijingDateKey();
    const todayParts = todayKey.split('-').map(Number);

    for (let day = 1; day <= totalDays; day++) {
        const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dateParts = dateKey.split('-').map(Number);
        const isFuture = dateParts[0] > todayParts[0] ||
                        (dateParts[0] === todayParts[0] && dateParts[1] > todayParts[1]) ||
                        (dateParts[0] === todayParts[0] && dateParts[1] === todayParts[1] && dateParts[2] > todayParts[2]);

        const dayEl = document.createElement('button');
        dayEl.type = 'button';
        dayEl.className = 'calendar-day';
        dayEl.textContent = day;
        dayEl.setAttribute('aria-label', `${month + 1}月${day}日`);

        if (dateKey === todayKey) {
            dayEl.classList.add('today');
        }

        if (!isFuture && AppState.checkinData[dateKey]) {
            dayEl.classList.add('checked');
        }

        if (isFuture) {
            dayEl.disabled = true;
        } else {
            dayEl.addEventListener('click', () => {
                showDateDetail(dateKey);
            });
        }

        grid.appendChild(dayEl);
    }
}

function showDateDetail(dateKey) {
    const record = AppState.checkinData[dateKey];
    const [year, month, day] = dateKey.split('-');
    const dateStr = `${parseInt(month)}月${parseInt(day)}日`;

    let detailEl = document.getElementById('date-detail');
    if (!detailEl) {
        detailEl = document.createElement('div');
        detailEl.id = 'date-detail';
        detailEl.setAttribute('role', 'status');
        detailEl.setAttribute('aria-live', 'polite');
        detailEl.style.cssText = 'margin-top:20px;padding:16px;background:#f9fafb;border-radius:8px;color:#374151';
        document.querySelector('.calendar-section').appendChild(detailEl);
    }

    if (record) {
        detailEl.textContent = `${dateStr} · ${record.note || '已记录'}`;
    } else {
        detailEl.textContent = `${dateStr} · 未记录`;
    }
    revealContent(detailEl, 240);

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!prefersReducedMotion && detailEl.getBoundingClientRect().top > window.innerHeight) {
        detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function updateHistory() {
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '';

    const dateKeys = Object.keys(AppState.checkinData).sort().reverse();

    if (dateKeys.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = `
            <svg width="80" height="80" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 28.2c-.3 0-.6-.1-.8-.3-7.8-6.5-11.7-11.2-11.7-15.4C3.5 8.9 5.8 6 9 6c2.1 0 4.2 1.4 5.6 3.1.3.4.8.6 1.4.6s1.1-.2 1.4-.6C18.8 7.4 20.9 6 23 6c3.2 0 5.5 2.9 5.5 6.5 0 4.2-3.9 8.9-11.7 15.4-.2.2-.5.3-.8.3z" stroke="currentColor" stroke-width="1.8"/><path d="M10 16h3.5l1.8-4.2 2.4 8.4 2-4.2h3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <p>暂无记录</p>
        `;
        historyList.appendChild(empty);
        return;
    }

    const recentDates = dateKeys.slice(0, 10);

    recentDates.forEach(dateKey => {
        const record = AppState.checkinData[dateKey];
        const [year, month, day] = dateKey.split('-');
        const dateStr = `${parseInt(month)}月${parseInt(day)}日`;

        const historyItem = document.createElement('button');
        historyItem.type = 'button';
        historyItem.className = 'history-item';
        historyItem.addEventListener('click', () => showDateDetail(dateKey));

        const dateDiv = document.createElement('div');
        dateDiv.className = 'history-date';
        dateDiv.textContent = dateStr;

        historyItem.appendChild(dateDiv);

        if (record.note) {
            const noteDiv = document.createElement('div');
            noteDiv.className = 'history-note';
            noteDiv.textContent = record.note;
            historyItem.appendChild(noteDiv);
        }

        historyList.appendChild(historyItem);
    });
}

function initCalendarNav() {
    const prevBtn = document.getElementById('prev-month');
    const nextBtn = document.getElementById('next-month');

    prevBtn.addEventListener('click', () => {
        if (AppState.calendarMonth === 0) {
            AppState.calendarYear--;
            AppState.calendarMonth = 11;
        } else {
            AppState.calendarMonth--;
        }
        updateCalendar();
    });

    nextBtn.addEventListener('click', () => {
        const parts = getBeijingDateParts();
        const currentYear = parseInt(parts.year);
        const currentMonth = parseInt(parts.month) - 1;

        if (AppState.calendarYear > currentYear ||
            (AppState.calendarYear === currentYear && AppState.calendarMonth >= currentMonth)) {
            return;
        }

        if (AppState.calendarMonth === 11) {
            AppState.calendarYear++;
            AppState.calendarMonth = 0;
        } else {
            AppState.calendarMonth++;
        }
        updateCalendar();
    });
}

// ==================== 管理员页 ====================

function drawChart(days) {
    const canvas = document.getElementById('trend-chart');
    const ctx = canvas.getContext('2d');
    const palette = getComputedStyle(document.body);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;

    ctx.clearRect(0, 0, width, height);

    const fullData = AppState.adminData ? AppState.adminData.trend.map(row => row.checkins) : Array(30).fill(0);
    const data = days === 7 ? fullData.slice(-7) : fullData;

    const padding = { top: 30, right: 30, bottom: 50, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(...data, 1);
    const minValue = 0;
    const valueRange = maxValue - minValue;
    const step = chartWidth / (data.length - 1);

    ctx.strokeStyle = palette.getPropertyValue('--theme-edge').trim() || '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
    }

    ctx.strokeStyle = palette.getPropertyValue('--theme-accent').trim() || '#0071e3';
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    data.forEach((value, index) => {
        const x = padding.left + step * index;
        const y = padding.top + chartHeight - ((value - minValue) / valueRange) * chartHeight;

        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });

    ctx.stroke();

    ctx.fillStyle = palette.getPropertyValue('--theme-accent').trim() || '#0071e3';
    data.forEach((value, index) => {
        const x = padding.left + step * index;
        const y = padding.top + chartHeight - ((value - minValue) / valueRange) * chartHeight;

        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
    });

    ctx.fillStyle = palette.getPropertyValue('--theme-muted').trim() || '#515154';
    ctx.font = `400 17px ${getComputedStyle(canvas).fontFamily}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= 4; i++) {
        const value = Math.round(minValue + (valueRange / 4) * (4 - i));
        const y = padding.top + (chartHeight / 4) * i;
        ctx.fillText(value.toString(), padding.left - 10, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const isMobile = width < 600;
    const labelStep = days <= 7 ? 1 : Math.ceil(days / 6);
    const mobileLabels = new Set([0, Math.round((data.length - 1) / 2), data.length - 1]);
    data.forEach((value, index) => {
        if (isMobile ? mobileLabels.has(index) : (index % labelStep === 0 || index === data.length - 1)) {
            const x = padding.left + step * index;
            const label = index === data.length - 1 ? '今天' : `${days - 1 - index}天前`;
            ctx.fillText(label, x, height - padding.bottom + 10);
        }
    });
}

function filterUsers(query) {
    const rows = document.querySelectorAll('#users-table-body tr');
    rows.forEach(row => {
        const username = row.cells[0].textContent.toLowerCase();
        if (username.includes(query)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// ==================== 初始化 ====================

let refreshingAccount = false;
async function refreshAccount() {
    if (!AppState.session || refreshingAccount || AppState.checkinInProgress || document.getElementById('password-dialog').open) return;
    refreshingAccount = true;
    const session = AppState.session;
    try {
        await flushNote();
        const value = await livoAPI('session');
        if (session !== AppState.session) return;
        if (!value.user) { clearAccount(); showLivoStatus('请重新登录。'); return; }
        // Keep the session object stable for pending requests from this account.
        if (value.user.id !== session.id || value.user.csrf !== session.csrf) {
            clearAccount(); setLivoSession(value); showPage('today');
        } else {
            if (!backgroundSaving) applyServerBackground(value.user);
            syncServerDay(value.calendar);
            AppState.checkinData = value.calendar.records;
            if (AppState.currentPage === 'today') updateTodayPage();
            if (AppState.currentPage === 'records') updateRecordsPage();
        }
    } catch (_) { /* Keep the last confirmed view; mutations still require the server. */ }
    finally { refreshingAccount = false; }
}

const backgroundNames = ['cloud', 'dawn', 'forest', 'sea', 'dusk', 'paper', 'custom'];
let backgroundTimer;
let backgroundSaving = false;
let backgroundSaveVersion = 0;

function applyBackground(value, animate = true) {
    const background = backgroundNames.includes(value) ? value : 'cloud';
    document.body.dataset.wallpaper = background;
    const current = document.getElementById('background-current');
    const next = document.getElementById('background-next');
    if (animate && next.dataset.background === background && next.style.opacity === '1') return;
    clearTimeout(backgroundTimer);
    if (!animate || reducedMotion()) {
        current.dataset.background = next.dataset.background = background;
        next.style.transition = 'none'; next.style.opacity = '0';
        return;
    }
    if (current.dataset.background === background && next.style.opacity !== '1') return;
    next.style.transition = 'none'; next.style.opacity = '0';
    next.dataset.background = background;
    void next.offsetWidth;
    next.style.transition = 'opacity 550ms cubic-bezier(.22,1,.36,1)';
    next.style.opacity = '1';
    backgroundTimer = setTimeout(() => {
        current.dataset.background = background;
        next.style.transition = 'none'; next.style.opacity = '0';
    }, 580);
}

function renderBackgroundChoices() {
    document.querySelectorAll('[data-background-choice]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.backgroundChoice === AppState.background));
        button.disabled = backgroundSaving;
    });
    document.getElementById('upload-background').disabled = backgroundSaving;
    document.getElementById('remove-background').disabled = backgroundSaving;
}

function applyServerBackground(value, animate = true) {
    const version = value.background_updated || 0;
    if (version < AppState.backgroundUpdated) return;
    AppState.backgroundUpdated = version;
    AppState.backgroundImageVersion = value.background_image_version || '';
    syncBackgroundImage();
    const background = backgroundNames.includes(value.background) ? value.background : 'cloud';
    AppState.background = background;
    applyBackground(background, animate);
    renderBackgroundChoices();
}

function initBackgrounds() {
    document.querySelectorAll('[data-background-choice]').forEach(button => {
        const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        mark.setAttribute('viewBox', '0 0 24 24');
        mark.setAttribute('aria-hidden', 'true');
        mark.classList.add('background-selected');
        mark.innerHTML = '<path d="m6 12 4 4 8-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
        button.querySelector('.background-swatch').append(mark);
        button.onclick = async () => {
            if (backgroundSaving || !AppState.session || button.dataset.backgroundChoice === AppState.background) return;
            const previous = AppState.background;
            const session = AppState.session;
            const version = ++backgroundSaveVersion;
            const status = document.getElementById('background-status');
            AppState.background = button.dataset.backgroundChoice;
            backgroundSaving = true;
            applyBackground(AppState.background); renderBackgroundChoices();
            status.textContent = '正在保存';
            try {
                const result = await livoAPI('preferences', {background: AppState.background});
                if (session !== AppState.session) return;
                applyServerBackground(result);
                session.background = result.background;
                session.background_updated = result.background_updated;
                session.background_image_version = result.background_image_version;
                status.textContent = '已保存';
            } catch (error) {
                if (session !== AppState.session) return;
                AppState.background = previous;
                applyBackground(previous);
                status.textContent = '保存失败，请重试';
                showLivoStatus(error.message);
            } finally {
                if (version === backgroundSaveVersion) {
                    backgroundSaving = false;
                    renderBackgroundChoices();
                }
            }
        };
    });
}

function initPasswordSettings() {
    const dialog = document.getElementById('password-dialog');
    const form = document.getElementById('password-form');
    const button = document.createElement('button');
    button.className = 'icon-button';
    button.id = 'change-password';
    button.title = button.ariaLabel = '修改密码';
    button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9 9M17 17l3-3M14 14l3-3"/></svg>';
    document.getElementById('logout-account').before(button);
    button.onclick = () => { form.reset(); document.getElementById('password-error').textContent = ''; dialog.showModal(); };
    document.getElementById('close-password').onclick = () => dialog.close();
    dialog.addEventListener('close', () => form.reset());
    form.onsubmit = async event => {
        event.preventDefault();
        const error = document.getElementById('password-error');
        const password = document.getElementById('new-password').value;
        error.textContent = '';
        if (password !== document.getElementById('confirm-password').value) { error.textContent = '两次输入的密码不一致。'; return; }
        const submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
            await livoAPI('password', {current: document.getElementById('current-password').value, password});
            dialog.close(); showLivoStatus('密码已更新。');
        } catch (failure) { error.textContent = failure.message; }
        finally { submit.disabled = false; }
    };
}

async function init() {
    initMotion();
    initAuth();
    initToday();
    initCalendarNav();
    initBackgrounds();
    initImageBackgrounds();

    document.querySelectorAll('.app-header').forEach(header => {
        const button = document.createElement('button');
        button.className = 'icon-button account-admin-entry';
        button.title = button.ariaLabel = '管理后台';
        button.hidden = true;
        button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.7"/><rect x="14" y="3" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.7"/><rect x="3" y="14" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.7"/><rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.7"/></svg>';
        button.addEventListener('click', () => showPage('admin'));
        header.append(button);
    });

    initPasswordSettings();
    try {
        const value = await livoAPI('session');
        if (value.user && !AppState.currentUser) {
            setLivoSession(value);
            showPage('today');
        }
    } catch (_) { document.getElementById('login-error').textContent = '暂时无法连接，请稍后重试登录。'; }
    finally { document.body.classList.remove('session-loading'); }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) flushNote().catch(error => showLivoStatus(error.message));
        else refreshAccount();
    });
    window.addEventListener('focus', refreshAccount);
    setInterval(() => { if (!document.hidden) refreshAccount(); }, 60000);

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (AppState.currentPage === 'admin') {
                const activeTab = document.querySelector('.chart-tab.active');
                if (activeTab) {
                    const period = parseInt(activeTab.dataset.period);
                    drawChart(period);
                }
            }
        }, 250);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

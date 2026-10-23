const USE_AUTH = true;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzn9ttSMjIDz041CJWVnbla1pdf7qCh50hb8XUoybc_Le2iND9O57OuJ4IK9Zx5Uv52/exec";
const STORAGE_PREFIX = "imed_pathophys_col1_";

let QUESTIONS_DATA = [];
let availableTopics = [];
let accessData = null; 
let videoFinished = false; 
let accessError = null;
let currentUserId = null;
let isSaving = false;

let searchDebounceTimer = null;
let learnObserver = null;

const tg = window.Telegram ? window.Telegram.WebApp : null;

try { 
    if (tg) {
        tg.expand(); 
        tg.ready(); 
        try { tg.requestFullscreen(); } catch(e){}
        if(tg.isVerticalSwipesEnabled!==undefined) tg.isVerticalSwipesEnabled=false; 
        tg.setHeaderColor('#ffffff'); 
    }
} catch(e){}


function safeIcons() { try { if (window.lucide) lucide.createIcons(); } catch(e) {} }

let localLoaded = false, serverSynced = false, localDirty = false, saveVer = 0, saveTimer = null;

function persistLocal() {
    try {
        localStorage.setItem(`${STORAGE_PREFIX}progress_${currentUserId}`, JSON.stringify({ progress: state.userProgress, selectedTopics: state.selectedTopics, dirty: localDirty }));
    } catch(e) {}
}

function loadLocalFallback() {
    try {
        const raw = localStorage.getItem(`${STORAGE_PREFIX}progress_${currentUserId}`);
        if (raw) {
            const p = JSON.parse(raw);
            if (p && typeof p === 'object') {
                if (p.progress) state.userProgress = p.progress;
                if (p.selectedTopics) state.selectedTopics = p.selectedTopics;
                localDirty = !!p.dirty;
            }
        }
    } catch(e) {}
}

// Сервер — источник правды; если на телефоне есть несинхронизированные ответы, берём по каждому вопросу версию с большим числом попыток
function applyServerData(data) {
    const server = (data.progress && typeof data.progress === 'object') ? data.progress : {};
    if (localDirty) {
        const merged = Object.assign({}, server);
        for (const [id, lp] of Object.entries(state.userProgress || {})) {
            const sp = server[id];
            if (!sp || (lp.attempts || 0) > (sp.attempts || 0)) merged[id] = lp;
        }
        state.userProgress = merged;
    } else {
        state.userProgress = server;
        if (Array.isArray(data.selectedTopics) && data.selectedTopics.length) state.selectedTopics = data.selectedTopics;
    }
}

function saveProgressToCloud() {
    localDirty = true;
    persistLocal();
    // пока не получили данные с сервера — не отправляем, чтобы не затереть чужой прогресс
    if (!serverSynced || !currentUserId || window.location.protocol === 'file:') return;
    clearTimeout(saveTimer);
    const ver = ++saveVer;
    saveTimer = setTimeout(async () => {
        try {
            await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST', mode: 'no-cors',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action: 'save', userId: String(currentUserId), progress: state.userProgress, selectedTopics: state.selectedTopics })
            });
            if (ver === saveVer) { localDirty = false; persistLocal(); }
        } catch(e) {}
    }, 800);
}

function haptic(type='light') {
    try {
        if(tg && tg.HapticFeedback) {
            if(type === 'error' || type === 'success' || type === 'warning') tg.HapticFeedback.notificationOccurred(type);
            else tg.HapticFeedback.impactOccurred(type);
        } else if(navigator.vibrate) navigator.vibrate(10);
    } catch(e) {}
}

document.addEventListener('touchstart', (e)=>{if(e.touches[0].clientX<40){window.sx=e.touches[0].clientX;window.sy=e.touches[0].clientY;window.sw=true}else{window.sw=false}},{passive:true});
document.addEventListener('touchend', (e)=>{if(!window.sw)return;const ex=e.changedTouches[0].clientX;const ey=e.changedTouches[0].clientY;if((ex-window.sx)>60 && Math.abs(ey-window.sy)<50 && state.view!=='menu' && !state.showFilterModal && !state.showResetModal && !state.showConfirmResetDialog){haptic('medium');goHome();}window.sw=false},{passive:true});

function escapeHtml(t) { if(!t)return""; return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function processQuestions() {
    QUESTIONS_DATA = RAW_PATHOPHYS_QUESTIONS.map((q) => {
        const t = TOPIC_RANGES.find(r => q.id >= r.start && q.id <= r.end) || TOPIC_RANGES[0];
        const qText = escapeHtml(q.q);
        const oText = (q.o || []).map(o => escapeHtml(o));
        const cleanTopic = t ? t.title.replace(/^\s*\d+\s*[\.\)\-:]\s*/, '') : "";
        
        return { 
            id: q.id, 
            topic: t ? t.title : "Общее", 
            question: qText, 
            options: oText, 
            correctIndices: q.c, 
            image: null,
            searchString: (qText + ' ' + oText.join(' ') + ' ' + cleanTopic).toLowerCase()
        };
    });
    availableTopics = [...new Set(QUESTIONS_DATA.map(q => q.topic))];
    if (!state.selectedTopics || state.selectedTopics.length === 0) {
        state.selectedTopics = [...availableTopics];
    } else {
        state.selectedTopics = state.selectedTopics.filter(t => availableTopics.includes(t));
        const oldTopics = availableTopics.slice(0, 7);
        const hadAllOldSelected = oldTopics.every(t => state.selectedTopics.includes(t));
        if (hadAllOldSelected && state.selectedTopics.length === 7) {
            state.selectedTopics = [...availableTopics];
        }
        if (state.selectedTopics.length === 0) {
            state.selectedTopics = [...availableTopics];
        }
    }
}

const state = { 
    view: 'menu', isDark: false, showFilterModal: false, showResetModal: false, showConfirmResetDialog: false, 
    selectedTopics: [], resetSelectedTopics: [], userProgress: {}, resumeState: null, playableQuestions: [], 
    currentQuestionIndex: 0, quizFinished: false, sessionAnswers: {}, selectedOptions: [], isAnswerChecked: false, 
    lastResult: false, isShuffleEnabled: false, hideAnswersInLearn: false, isFlipped: false, swipeX: 0, animState: 'idle',
    searchQuery: '', filteredLearnQuestions: [], learnRenderLimit: 20, searchCurrentIndex: -1
};

function getTelegramUserId() {
    try {
        if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) {
            return window.Telegram.WebApp.initDataUnsafe.user.id;
        }
    } catch (e) {}

    const parseUserFromStr = (str) => {
        try {
            if (!str) return null;
            const params = new URLSearchParams(str);
            const userStr = params.get('user');
            if (userStr) return JSON.parse(userStr).id;
            let tgWebAppData = params.get('tgWebAppData');
            if (tgWebAppData) {
                tgWebAppData = decodeURIComponent(tgWebAppData);
                const subParams = new URLSearchParams(tgWebAppData);
                const subUser = subParams.get('user');
                if (subUser) return JSON.parse(subUser).id;
            }
        } catch (e) {}
        return null;
    };

    try { if (tg && tg.initData) { const id = parseUserFromStr(tg.initData); if (id) return id; } } catch (e) {}
    try { let hash = window.location.hash; if (hash.startsWith('#')) hash = hash.substring(1); const idHash = parseUserFromStr(hash); if (idHash) return idHash; } catch (e) {}
    try { let search = window.location.search; if (search.startsWith('?')) search = search.substring(1); const idSearch = parseUserFromStr(search); if (idSearch) return idSearch; } catch (e) {}
    return null;
}

async function userClickedStart() {
    haptic('medium'); 
    const txt = document.getElementById('start-text'); if(txt) txt.remove();
    const vid = document.getElementById('intro-video');
    performAccessCheck();
    let played = false;
    try { vid.muted=false; await vid.play(); played = true; vid.onended=()=>{ finishVideo(); }; } catch(err){}
    if (!played) finishVideo();
}

function finishVideo() { videoFinished = true; checkStateTransition(); }

let accessCheckAttempts = 0;
async function performAccessCheck() {
    currentUserId = getTelegramUserId();
    if (currentUserId && !localLoaded) { localLoaded = true; loadLocalFallback(); }

    // ⚡ 1. МГНОВЕННЫЙ ВХОД ИЗ ПАМЯТИ ТЕЛЕФОНА (0.01 сек!)
    const ck = `${STORAGE_PREFIX}access_${currentUserId}`; 
    const cached = localStorage.getItem(ck);
    if (cached) {
        try {
            const p = JSON.parse(cached);
            if (p && p.allowed) {
                accessData = p;
                processQuestions();
                checkStateTransition(); // Открывает приложение сразу после видео!
            }
        } catch(e) {}
    }

    if (!currentUserId && accessCheckAttempts < 5) {
        accessCheckAttempts++;
        setTimeout(performAccessCheck, 150);
        return;
    }

    if (window.location.protocol === 'file:') { 
        accessData = { allowed: true, progress: {} };
        loadLocalFallback();
        processQuestions();
        checkStateTransition();
        return;
    }
    
    if (!currentUserId) { 
        accessError = { type: 'browser', msg: 'Откройте приложение внутри Telegram бота.' };
        checkStateTransition();
        return;
    }
    
    // ⚡ 2. ФОНОВАЯ ПРОВЕРКА ЧЕРЕЗ СЕРВЕР (Идет пока играет видео)
    const tgUser = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user) || {};
    const uName = encodeURIComponent(tgUser.first_name || "Студент");
    const uHandle = encodeURIComponent(tgUser.username || "");

    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(`${GOOGLE_SCRIPT_URL}?userId=${currentUserId}&name=${uName}&username=${uHandle}`, { signal: ctrl.signal });
        const data = await res.json();
        
        if (data.allowed) { 
            accessData = data; 
            applyServerData(data);
            
            processQuestions();
            localStorage.setItem(ck, JSON.stringify({ allowed: true })); 
            serverSynced = true;
            if (localDirty) saveProgressToCloud();
            if (appStarted) render();
        } else {
            localStorage.removeItem(ck);
            accessData = null;
            accessError = { type: 'denied', msg: 'Для открытия доступа отправьте чек об оплате (499 ₽) прямо в чат бота.' };
            const appEl = document.getElementById('app');
            if (appEl) appEl.classList.add('hidden-force');
        }
    } catch(e) { 
        if (!accessData) {
            accessError = { type: 'network', msg: 'Ошибка сети. Проверьте интернет.' };
        }
    }
    
    checkStateTransition();
}

// ПЛАВНЫЙ ПЕРЕХОД: НИКАКИХ ЭКРАНОВ ЗАГРУЗКИ ПОСЛЕ ВИДЕО
let appStarted = false;
function checkStateTransition() {
    // Ждем, пока видео ТОЧНО закончится
    if (!videoFinished) return; 

    const intro = document.getElementById('intro-layer');
    const auth = document.getElementById('auth-screen');
    const block = document.getElementById('block-screen');
    const app = document.getElementById('app');

    // Если нет доступа (включая случай, когда кэш пустил, а сервер затем отказал)
    if (accessError) { 
        if (intro) intro.style.display = 'none'; 
        if (auth) auth.classList.add('hidden-force'); 
        if (app) app.classList.add('hidden-force');
        if (block) {
            block.classList.remove('hidden-force');
            let icon = 'lock', title = 'Доступ закрыт';
            block.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full animate-fade-in px-4">
                <div class="bg-rose-100 dark:bg-rose-900/30 p-6 rounded-full mb-6">
                    <i data-lucide="${icon}" class="w-16 h-16 text-rose-500"></i>
                </div>
                <h1 class="text-3xl font-black text-slate-900 dark:text-white mb-4">${title}</h1>
                <p class="text-slate-500 dark:text-slate-400 mb-8 max-w-sm font-medium leading-relaxed">${accessError.msg}</p>
                ${accessError.type === 'denied'
                    ? `<button onclick="try{window.Telegram.WebApp.close()}catch(e){}" class="w-full max-w-xs bg-black dark:bg-white text-white dark:text-black py-4 rounded-2xl font-bold shadow-lg btn-click mb-3">🧾 Отправить чек в бота</button>`
                    : `<button onclick="location.reload()" class="w-full max-w-xs bg-black dark:bg-white text-white dark:text-black py-4 rounded-2xl font-bold shadow-lg btn-click mb-3">Повторить</button>`}
                <a href="https://t.me/stewonly" class="w-full max-w-xs bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-3.5 rounded-2xl font-bold text-sm text-center btn-click">Написать @stewonly</a>
            </div>`;
            safeIcons();
        }
        return; 
    }

    // Если доступ есть — плавно растворяем видео и сразу открываем меню
    if (accessData && !appStarted) {
        appStarted = true;
        if (auth) auth.classList.add('hidden-force');
        if (intro) { 
            intro.style.transition = 'opacity 0.3s ease'; 
            intro.style.opacity = '0'; 
            setTimeout(() => {
                intro.style.display = 'none';
                if (!accessError) {
                    app.classList.remove('hidden-force');
                    initApp();
                }
            }, 300); 
        } else { 
            app.classList.remove('hidden-force'); 
            initApp(); 
        }
    } else if (!accessData) {
        if (intro) intro.style.display = 'none';
        if (auth) auth.classList.remove('hidden-force');
    }
}

function initApp() { state.resumeState = null; render(); }

function toggleTheme() {
    haptic('light'); state.isDark = !state.isDark;
    const body=document.documentElement, auth=document.getElementById('auth-screen'), block=document.getElementById('block-screen');
    if(state.isDark) { body.classList.add('dark'); if(auth)auth.style.backgroundColor='#000'; if(block)block.style.backgroundColor='#000'; try{if(tg)tg.setHeaderColor('#000000');}catch(e){} }
    else { body.classList.remove('dark'); if(auth)auth.style.backgroundColor='#fff'; if(block)block.style.backgroundColor='#fff'; try{if(tg)tg.setHeaderColor('#ffffff');}catch(e){} }
    render();
}

function toggleFilterModal(show) { if(show)haptic('light'); state.showFilterModal=show; render(); }
function toggleResetModal(show) { if(show) { haptic('light'); state.resetSelectedTopics = []; } state.showResetModal=show; render(); }

function toggleShuffle() { 
    haptic('light'); 
    state.isShuffleEnabled=!state.isShuffleEnabled; 
    const knob = document.getElementById('shuffle-toggle-knob');
    const bg = document.getElementById('shuffle-toggle-bg');
    if(knob && bg) {
        if(state.isShuffleEnabled) {
            bg.classList.remove('bg-slate-300', 'dark:bg-slate-600');
            bg.classList.add('bg-indigo-500');
            knob.classList.remove('left-1');
            knob.classList.add('left-7');
        } else {
            bg.classList.add('bg-slate-300', 'dark:bg-slate-600');
            bg.classList.remove('bg-indigo-500');
            knob.classList.add('left-1');
            knob.classList.remove('left-7');
        }
    }
}

function toggleTopic(t) { 
    if(state.selectedTopics.includes(t)) state.selectedTopics=state.selectedTopics.filter(x=>x!==t); 
    else state.selectedTopics.push(t); 
    if(state.showFilterModal) { updateTopicListUI('filter'); updateSelectAllButtonUI('filter'); } else render();
    saveProgressToCloud();
}
function toggleSelectAllTopics() { 
    haptic('medium'); if(state.selectedTopics.length===availableTopics.length) state.selectedTopics=[]; else state.selectedTopics=[...availableTopics]; 
    if(state.showFilterModal){updateTopicListUI('filter');updateSelectAllButtonUI('filter');} else render(); 
    saveProgressToCloud();
}

function toggleResetTopic(t) { 
    if(state.resetSelectedTopics.includes(t)) state.resetSelectedTopics=state.resetSelectedTopics.filter(x=>x!==t); 
    else state.resetSelectedTopics.push(t); 
    updateTopicListUI('reset'); updateSelectAllButtonUI('reset');
}
function toggleSelectAllReset() { 
    haptic('medium'); if(state.resetSelectedTopics.length===availableTopics.length) state.resetSelectedTopics=[]; else state.resetSelectedTopics=[...availableTopics]; 
    updateTopicListUI('reset'); updateSelectAllButtonUI('reset'); 
}

function confirmReset() { if(!state.resetSelectedTopics.length) { haptic('error'); return; } haptic('warning'); state.showResetModal = false; state.showConfirmResetDialog = true; render(); }
function executeFinalReset() {
    haptic('success');
    const newProgress = {};
    const topicsToRemove = new Set(state.resetSelectedTopics);
    for (const [id, prog] of Object.entries(state.userProgress)) {
        const q = QUESTIONS_DATA.find(x => x.id == id);
        if (!q || topicsToRemove.has(q.topic)) continue; 
        newProgress[id] = prog;
    }
    state.userProgress = newProgress; 
    state.resetSelectedTopics = []; 
    state.showConfirmResetDialog = false; 
    state.resumeState = null; 
    saveProgressToCloud(); render();
}
function cancelReset() { state.showConfirmResetDialog = false; state.showResetModal = true; render(); setTimeout(() => { updateTopicListUI('reset'); updateSelectAllButtonUI('reset'); }, 0); }

function updateTopicListUI(mode) {
    const listId = mode === 'filter' ? 'topics-list' : 'reset-topics-list';
    const list = document.getElementById(listId); if(!list) return;
    const selectedArr = mode === 'filter' ? state.selectedTopics : state.resetSelectedTopics;

    const stats = {};
    if (mode === 'filter') {
        QUESTIONS_DATA.forEach(q => {
            if (!stats[q.topic]) stats[q.topic] = { total: 0, correct: 0 };
            stats[q.topic].total++;
            if (state.userProgress && state.userProgress[q.id]?.status === 'correct') stats[q.topic].correct++;
        });
    }

    list.querySelectorAll('button[data-topic]').forEach(btn => {
        const t = btn.getAttribute('data-topic');
        const sel = selectedArr.includes(t);
        const icon = btn.querySelector('.icon-area');
        
        let btnClass = "w-full text-left px-4 py-3 rounded-xl font-bold text-sm flex flex-col gap-1 group btn-click relative";
        let progressHtml = '';
        if (mode === 'filter' && stats[t]) {
            const { total, correct } = stats[t];
            const progress = total > 0 ? Math.round((correct / total) * 100) : 0;
            let barBg = sel ? 'bg-white/20 dark:bg-black/20' : 'bg-slate-200 dark:bg-slate-700';
            let fillBg = sel ? 'bg-emerald-400 dark:bg-emerald-600' : 'bg-emerald-500';
            let txtColor = sel ? 'text-white/60 dark:text-black/60' : 'text-slate-400';
            progressHtml = `<div class="w-full h-1.5 ${barBg} rounded-full mt-2 overflow-hidden"><div class="h-full ${fillBg} rounded-full" style="width: ${progress}%"></div></div><div class="text-[10px] ${txtColor} mt-1 flex justify-between"><span>Прогресс (${correct}/${total})</span><span>${progress}%</span></div>`;
        }

        if(sel) { btnClass += " bg-black text-white dark:bg-white dark:text-black border border-transparent"; if(icon) icon.innerHTML='<i data-lucide="check-circle" class="w-4 h-4 absolute top-3 right-3 text-emerald-400 dark:text-emerald-600"></i>'; } 
        else { btnClass += " bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 relative"; if(icon) icon.innerHTML=''; }
        btn.className = btnClass;
        const contentDiv = btn.querySelector('.topic-content');
        if(contentDiv) contentDiv.innerHTML = `<span class="block text-wrap leading-tight pr-6 mb-1">${t}</span> ${progressHtml}`;
    });
    
    if (mode === 'filter') updateSelectAllButtonUI('filter');
    
    const apply = document.getElementById(mode === 'filter' ? 'apply-btn' : 'confirm-reset-btn'); 
    if(apply) apply.innerText = mode === 'filter' ? `Применить (${selectedArr.length})` : `Сбросить (${selectedArr.length})`;
    safeIcons();
}

function updateSelectAllButtonUI(mode) {
    const btn = document.getElementById(mode === 'filter' ? 'select-all-btn' : 'reset-select-all-btn'); if(!btn) return;
    const all = (mode === 'filter' ? state.selectedTopics : state.resetSelectedTopics).length === availableTopics.length;
    btn.innerHTML=`<span>${all?'Снять все':'Выбрать все'}</span><i data-lucide="${all?'trash-2':'layers'}" class="w-4 h-4"></i>`;
    safeIcons();
}

function startMode(mode, resume=false) {
    haptic('medium');
    if(resume && (!state.playableQuestions || state.playableQuestions.length === 0)) resume = false;
    if(resume && state.resumeState?.mode===mode){ state.playableQuestions = state.resumeState.questions; state.currentQuestionIndex = state.resumeState.index; state.view=mode; state.quizFinished=false; loadStateForIndex(state.currentQuestionIndex); render(); return; }
    
    let q;
    if (mode === 'mistakes') {
        q = QUESTIONS_DATA.filter(x => state.userProgress && state.userProgress[x.id]?.status === 'wrong');
    } else {
        q = QUESTIONS_DATA.filter(x => state.selectedTopics.includes(x.topic));
    }

    if (mode === 'quiz' || mode === 'cards') {
        const unsolved = q.filter(question => { const p = state.userProgress[question.id]; return !p || p.status !== 'correct'; });
        if (unsolved.length > 0) q = unsolved;
    }
    
    if(!q.length){ 
        if (mode === 'mistakes') {
            state.playableQuestions = [];
            state.view = 'mistakes';
            render();
            return;
        }
        alert("Выберите хотя бы одну тему в фильтре!"); 
        return; 
    }
    
    if (mode === 'learn') {
        state.searchQuery = '';
        state.filteredLearnQuestions = q;
        state.learnRenderLimit = 25;
        state.searchCurrentIndex = -1;
    }

    if((mode==='quiz'||mode==='cards') && state.isShuffleEnabled) q = [...q].sort(()=>Math.random()-0.5);
    state.playableQuestions = q;

    if (!state.userProgress) state.userProgress = {};
    state.currentQuestionIndex = 0; state.view = mode; state.quizFinished = false; state.sessionAnswers = {}; state.resumeState = null; 
    loadStateForIndex(state.currentQuestionIndex);
    render();
}

function resetQuestionState() { state.selectedOptions=[]; state.isAnswerChecked=false; state.lastResult=false; state.isFlipped=false; state.swipeX=0; state.animState='idle'; }
function saveCurrentState() { state.sessionAnswers[state.currentQuestionIndex] = { selectedOptions: [...state.selectedOptions], isAnswerChecked: state.isAnswerChecked, lastResult: state.lastResult }; }
function loadStateForIndex(i) {
    const q = state.playableQuestions[i]; if (!q) return resetQuestionState();
    if (state.sessionAnswers[i]) { const s = state.sessionAnswers[i]; state.selectedOptions = s.selectedOptions; state.isAnswerChecked = s.isAnswerChecked; state.lastResult = (s.lastResult); return; }
    if (['quiz', 'cards', 'mistakes'].includes(state.view)) { resetQuestionState(); return; }
    const history = state.userProgress && state.userProgress[q.id];
    if (history && history.selected) { state.selectedOptions = history.selected; state.isAnswerChecked = true; state.lastResult = (history.status === 'correct'); } else { resetQuestionState(); }
}

function handleOptionSelect(idx) {
    if(state.isAnswerChecked) return; haptic('light');
    if(state.selectedOptions.includes(idx)) state.selectedOptions=state.selectedOptions.filter(x=>x!==idx); else state.selectedOptions.push(idx);
    render();
}
function checkAnswer() {
    if(!state.selectedOptions.length) return;
    state.isAnswerChecked=true; const q=state.playableQuestions[state.currentQuestionIndex];
    const sel=[...state.selectedOptions].sort((a,b)=>a-b).toString(), corr=[...q.correctIndices].sort((a,b)=>a-b).toString();
    state.lastResult=(sel===corr); haptic(state.lastResult?'success':'error');
    if(!state.userProgress) state.userProgress = {};
    state.userProgress[q.id]={ status: state.lastResult?'correct':'wrong', attempts: (state.userProgress[q.id]?.attempts||0)+1, selected: [...state.selectedOptions] };
    saveCurrentState(); saveProgressToCloud(); render();
}
function nextQuestion() {
    haptic('light'); saveCurrentState();
    if(state.currentQuestionIndex<state.playableQuestions.length-1) { state.currentQuestionIndex++; loadStateForIndex(state.currentQuestionIndex); document.querySelector('.layout-content').scrollTop=0; }
    else state.quizFinished=true;
    render();
}
function prevQuestion() {
    haptic('light'); saveCurrentState();
    if(state.currentQuestionIndex>0) { state.currentQuestionIndex--; loadStateForIndex(state.currentQuestionIndex); }
    render();
}
function goHome() {
    haptic('medium'); saveProgressToCloud();
    if(['quiz','cards','mistakes'].includes(state.view) && !state.quizFinished && state.playableQuestions.length) state.resumeState={mode:state.view, index:state.currentQuestionIndex, questions:state.playableQuestions};
    else state.resumeState=null;
    state.view='menu'; render();
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}

function updateSearchUI() {
    const controls = document.getElementById('search-controls');
    if (!controls) return;
    if (state.searchQuery && state.searchQuery.trim().length > 0) controls.classList.add('visible');
    else controls.classList.remove('visible');
}

function handleSearchInput(val) {
    state.searchQuery = val;
    updateSearchUI();
    
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        state.learnRenderLimit = 25;
        state.searchCurrentIndex = -1;
        
        const trimmed = val.trim().toLowerCase();
        
        if (!trimmed) {
            state.filteredLearnQuestions = state.playableQuestions;
        } else {
            const words = trimmed.split(/\s+/).filter(w => w.length > 0);
            state.filteredLearnQuestions = state.playableQuestions.filter(q => {
                return words.every(w => q.searchString.includes(w) || String(q.id) === w);
            });
        }
        renderLearnList();
    }, 200);
}

function clearSearch() {
    haptic('light');
    const input = document.getElementById('learn-search-input');
    if(input) { input.value = ''; input.focus(); }
    handleSearchInput('');
}

function toggleAnswersVisibility() {
    haptic('light');
    state.hideAnswersInLearn = !state.hideAnswersInLearn;
    render();
}

function navigateSearch(direction) {
    haptic('light');
    document.activeElement?.blur(); 
    
    if (state.filteredLearnQuestions.length === 0) return;
    
    if(state.searchCurrentIndex >= 0) {
        const prevId = `learn-q-${state.filteredLearnQuestions[state.searchCurrentIndex]?.id}`;
        const prevEl = document.getElementById(prevId);
        if(prevEl) prevEl.classList.remove('active-search-result');
    }

    if (direction === 'next') {
        if (state.searchCurrentIndex < state.filteredLearnQuestions.length - 1) state.searchCurrentIndex++;
    } else {
        if (state.searchCurrentIndex > 0) state.searchCurrentIndex--;
    }
    
    if (state.searchCurrentIndex === -1 && direction === 'next') state.searchCurrentIndex = 0;

    if (state.searchCurrentIndex >= 0 && state.searchCurrentIndex < state.filteredLearnQuestions.length) {
        if (state.searchCurrentIndex >= state.learnRenderLimit) {
            state.learnRenderLimit = state.searchCurrentIndex + 5;
            renderLearnList();
            setTimeout(scrollToCurrentMatch, 50);
        } else {
            const currentQ = state.filteredLearnQuestions[state.searchCurrentIndex];
            const el = document.getElementById(`learn-q-${currentQ.id}`);
            if(el) el.classList.add('active-search-result');
            scrollToCurrentMatch();
        }
    }
}

function scrollToCurrentMatch() {
    if(state.searchCurrentIndex < 0 || !state.filteredLearnQuestions[state.searchCurrentIndex]) return;
    const id = `learn-q-${state.filteredLearnQuestions[state.searchCurrentIndex].id}`;
    const el = document.getElementById(id);
    if (el) { el.classList.add('active-search-result'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function highlightText(text, query) {
    if (!query || !query.trim()) return text;
    const words = query.trim().split(/\s+/).filter(w => w.length > 0).map(escapeRegExp);
    const re = new RegExp('(' + words.join('|') + ')', 'gi');
    // split into entities and plain text, highlight only plain text
    return text.split(/(&(?:amp|lt|gt|quot|#\d+);)/).map((part, i) =>
        i % 2 === 1 ? part : part.replace(re, '<mark>$1</mark>')
    ).join('');
}

function renderLearnList() {
    const container = document.getElementById('learn-list-container'); if (!container) return;
    const visibleItems = state.filteredLearnQuestions.slice(0, state.learnRenderLimit);
    
    if (visibleItems.length === 0) {
        container.innerHTML = `<div class="text-center py-12 text-slate-400 font-medium text-sm">Ничего не найдено</div>`;
        return;
    }

    const html = visibleItems.map((q, idx) => {
        const isActive = idx === state.searchCurrentIndex;
        const qHtml = state.searchQuery ? highlightText(q.question, state.searchQuery) : q.question;
        return `
        <div id="learn-q-${q.id}" class="border border-black dark:border-slate-700 rounded-2xl overflow-hidden bg-white dark:bg-black shadow-sm mb-4 ${isActive ? 'active-search-result' : ''}">
            <div class="bg-slate-100 dark:bg-slate-900 border-b border-black dark:border-slate-700 p-2 flex justify-between gap-4 px-4">
                <span class="font-bold text-black dark:text-slate-300 text-[10px] tracking-widest uppercase flex-1 truncate">${q.topic}</span>
                <span class="font-bold text-slate-500 dark:text-slate-400 text-[10px] shrink-0">Задание №${q.id}</span>
            </div>
            <div class="p-3 border-b border-black dark:border-slate-800 bg-white dark:bg-black">
                <div class="font-bold text-black dark:text-white leading-snug text-sm">${qHtml}</div>
            </div>
            <div class="divide-y divide-black dark:divide-slate-800">
                ${q.options.map((opt, i) => {
                    if(!opt||!opt.trim())return'';
                    const cleanOpt = opt.replace(/^[\d]+[).]\s*/, '');
                    const optHtml = state.searchQuery ? highlightText(cleanOpt, state.searchQuery) : cleanOpt;
                    const isC = q.correctIndices.includes(i); 
                    let bgClass = "bg-white dark:bg-black text-black dark:text-slate-300";
                    if(isC) bgClass += " correct-answer";
                    return `<div class="flex"><div class="w-8 flex-shrink-0 flex items-center justify-center border-r border-black dark:border-slate-800 text-xs font-bold ${bgClass}">${i+1})</div><div class="flex-1 p-2.5 text-xs font-medium ${bgClass}">${optHtml}</div></div>`;
                }).join('')}
            </div>
        </div>`;
    }).join('');

    container.innerHTML = html + '<div id="learn-sentinel" class="h-10 w-full"></div>';
    
    if (learnObserver) learnObserver.disconnect();
    const sentinel = document.getElementById('learn-sentinel');
    if (sentinel) {
        learnObserver = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                if (state.learnRenderLimit < state.filteredLearnQuestions.length) {
                    state.learnRenderLimit += 25;
                    renderLearnList(); 
                }
            }
        }, { rootMargin: '200px' });
        learnObserver.observe(sentinel);
    }
}

function render() {
    const app=document.getElementById('app');
    let scrollTop=0; const cd=document.querySelector('.layout-content');
    if(cd && app.dataset.view===state.view) scrollTop=cd.scrollTop;
    app.dataset.view=state.view;

    let bodyHTML='', footerHTML='';
    if(state.view==='menu') bodyHTML=renderMenuContent();
    else if(state.view==='learn') bodyHTML=renderLearnContent();
    else if(state.view==='quiz'||state.view==='mistakes') { bodyHTML=renderQuizContent(); footerHTML=renderQuizFooter(); }
    else if(state.view==='cards') { bodyHTML=renderCardsContent(); footerHTML=renderCardsFooter(); }
    
    app.innerHTML = `${renderHeader()}<div class="layout-content bg-slate-50 dark:bg-black">${bodyHTML}</div>${footerHTML}${state.showFilterModal?renderFilterModal():''}${state.showResetModal?renderResetModal():''}${state.showConfirmResetDialog?renderConfirmResetDialog():''}`;
    
    if(state.view==='cards') setTimeout(initCardEvents,0);
    if(state.showFilterModal) setTimeout(initFilterSwipeEvents, 0);
    
    if (state.view === 'learn') {
        renderLearnList();
        updateSearchUI(); 
        const container = document.getElementById('learn-list-container');
        if (state.hideAnswersInLearn && container) container.classList.add('hide-answers');
    }
    
    if(cd && scrollTop>0 && !state.searchQuery) document.querySelector('.layout-content').scrollTop=scrollTop;
    safeIcons();
}

function renderHeader() {
    const isHome=state.view==='menu';
    return `<div class="layout-header bg-slate-50 dark:bg-black shadow-sm">
        <div class="flex items-center gap-3">
            ${!isHome?`<button onclick="goHome()" class="p-1 -ml-1 rounded-full hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-800 dark:text-white btn-click"><i data-lucide="chevron-left" class="w-6 h-6"></i></button>`:''}
            <div onclick="goHome()" class="flex items-center gap-2 cursor-pointer group btn-click">
                <div class="transition-transform group-hover:scale-105"><img src="${state.isDark?"https://i.ibb.co/tw2sGMTs/image.png":"https://i.ibb.co/zWn4xWnk/image.png"}" class="w-8 h-8 object-contain rounded-lg shadow-sm"></div>
                <span class="font-bold text-lg text-black dark:text-white flex items-baseline"><span class="font-serif mr-[1px]">I</span>med</span>
            </div>
        </div>
        <div class="flex items-center gap-2">
            <button onclick="toggleTheme()" class="p-2 text-slate-500 hover:text-black dark:text-slate-400 dark:hover:text-white btn-click"><i data-lucide="${state.isDark?'sun':'moon'}" class="w-6 h-6"></i></button>
            <a href="https://t.me/stewonly" target="_blank" class="p-2 text-slate-500 hover:text-[#2AABEE] dark:text-slate-400 dark:hover:text-[#2AABEE] btn-click"><i data-lucide="send" class="w-5 h-5"></i></a>
        </div>
    </div>`;
}

function renderMenuContent() {
    const learned=Object.values(state.userProgress||{}).filter(p=>p.status==='correct').length;
    const errors=Object.values(state.userProgress||{}).filter(p=>p.status==='wrong').length;
    
    if(state.resumeState && state.resumeState.mode === 'mistakes' && errors === 0) {
        state.resumeState = null;
    }
    
    const allSel=state.selectedTopics.length===availableTopics.length;
    const selectedQuestionsCount = QUESTIONS_DATA.filter(q => state.selectedTopics.includes(q.topic)).length;

    return `<div class="p-4 space-y-4 animate-fade-in pb-10">
        <div class="bg-black dark:bg-slate-900 rounded-[2rem] p-6 text-white shadow-soft dark:shadow-none relative overflow-hidden">
            <div class="relative z-10">
                <h1 class="text-2xl font-black mb-1 tracking-tight">Патофизиология</h1>
                <p class="text-slate-400 font-medium text-xs mb-4">Коллоквиум №1 • ${QUESTIONS_DATA.length} вопросов</p>
                <button onclick="toggleFilterModal(true)" class="flex items-center gap-2 text-[10px] font-bold bg-white/10 hover:bg-white/20 active:scale-95 w-fit px-4 py-2 rounded-xl border border-white/10 btn-click"><i data-lucide="filter" class="w-3 h-3 text-white"></i><span>${allSel?'Все темы':`${state.selectedTopics.length} тем выбрано`}</span></button>
            </div>
            <div class="absolute -right-6 -bottom-6 w-32 h-32 bg-white/10 rounded-full blur-2xl pointer-events-none"></div>
        </div>
        ${state.resumeState ? `<button onclick="startMode('${state.resumeState.mode}', true)" class="w-full bg-indigo-600 text-white p-4 rounded-[2rem] shadow-lg shadow-indigo-200 dark:shadow-none flex items-center justify-between group active:scale-[0.98] animate-slide-up btn-click"><div class="flex items-center gap-3"><div class="bg-white/20 p-2 rounded-xl"><i data-lucide="play-circle" class="w-6 h-6 text-white"></i></div><div class="text-left"><span class="block font-black text-base">Продолжить</span><span class="text-indigo-100 text-[10px] font-bold uppercase tracking-wide">${state.resumeState.mode==='quiz'?'Тест':(state.resumeState.mode==='cards'?'Карточки':'Ошибки')} • Вопрос ${state.resumeState.index+1}</span></div></div><i data-lucide="chevron-right" class="w-5 h-5"></i></button>`:''}
        <div class="space-y-3">
            <button onclick="startMode('learn')" class="w-full bg-white dark:bg-slate-900 p-4 rounded-[2rem] border border-slate-200 dark:border-slate-800 shadow-soft hover:shadow-lg flex justify-between items-center group active:scale-[0.98] btn-click"><div class="flex items-center gap-4"><div class="bg-yellow-100 dark:bg-yellow-900/30 p-3 rounded-2xl text-yellow-700 dark:text-yellow-400"><i data-lucide="book-open" class="w-6 h-6"></i></div><div class="text-left"><span class="block font-black text-slate-900 dark:text-white text-base">Конспект (${selectedQuestionsCount})</span><span class="text-slate-500 dark:text-slate-400 text-[10px] font-bold uppercase">Учить вопросы</span></div></div><i data-lucide="chevron-right" class="w-5 h-5 text-slate-300 dark:text-slate-600"></i></button>
            <button onclick="startMode('quiz')" class="w-full bg-white dark:bg-slate-900 p-4 rounded-[2rem] border border-slate-200 dark:border-slate-800 shadow-soft hover:shadow-lg flex justify-between items-center group active:scale-[0.98] btn-click"><div class="flex items-center gap-4"><div class="bg-blue-100 dark:bg-blue-900/30 p-3 rounded-2xl text-blue-700 dark:text-blue-400"><i data-lucide="flask-conical" class="w-6 h-6"></i></div><div class="text-left"><span class="block font-black text-slate-900 dark:text-white text-base">Тест</span><span class="text-slate-500 dark:text-slate-400 text-[10px] font-bold uppercase">Проверить знания</span></div></div><i data-lucide="chevron-right" class="w-5 h-5 text-slate-300 dark:text-slate-600"></i></button>
            <div class="grid grid-cols-2 gap-3">
                <button onclick="startMode('cards')" class="bg-white dark:bg-slate-900 p-4 rounded-[2rem] border border-slate-200 dark:border-slate-800 shadow-soft hover:shadow-lg flex flex-col items-center justify-center gap-3 active:scale-[0.98] btn-click"><div class="bg-emerald-100 dark:bg-emerald-900/30 p-3 rounded-2xl text-emerald-700 dark:text-emerald-400"><i data-lucide="brain" class="w-6 h-6"></i></div><span class="font-bold text-slate-900 dark:text-white text-xs">Карточки</span></button>
                <button onclick="startMode('mistakes')" class="bg-white dark:bg-slate-900 p-4 rounded-[2rem] border border-slate-200 dark:border-slate-800 shadow-soft hover:shadow-lg flex flex-col items-center justify-center gap-3 active:scale-[0.98] btn-click"><div class="bg-rose-100 dark:bg-rose-900/30 p-3 rounded-2xl text-rose-700 dark:text-rose-400"><i data-lucide="alert-triangle" class="w-6 h-6"></i></div><span class="font-bold text-slate-900 dark:text-white text-xs">Ошибки (${errors})</span></button>
            </div>
        </div>
        <div class="grid grid-cols-2 gap-3 pt-1">
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 rounded-[2rem] flex flex-col items-center justify-center"><span class="text-2xl font-black text-slate-900 dark:text-white">${learned}</span><span class="text-[9px] font-bold uppercase tracking-widest text-slate-400">Выучено</span></div>
            <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 rounded-[2rem] flex flex-col items-center justify-center"><span class="text-2xl font-black text-slate-900 dark:text-white">${errors}</span><span class="text-[9px] font-bold uppercase tracking-widest text-slate-400">Ошибок</span></div>
        </div>
        <button onclick="toggleResetModal(true)" class="w-full mt-4 py-3 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold rounded-xl border border-slate-200 dark:border-slate-700 btn-click">Сбросить прогресс</button>
    </div>`;
}

function renderLearnContent() {
    const isSearchVisible = state.searchQuery && state.searchQuery.trim().length > 0;
    
    return `<div class="px-4 pt-2 h-full flex flex-col animate-fade-in gap-2">
        <div class="flex gap-2 items-center shrink-0 z-20 bg-slate-50 dark:bg-black pb-1">
        <div class="relative flex-1">
                <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><i data-lucide="search" class="w-4 h-4 text-slate-400"></i></div>
                <input id="learn-search-input" type="text" 
                    value="${escapeHtml(state.searchQuery)}"
                    oninput="handleSearchInput(this.value)" 
                    onkeyup="if(event.key==='Enter') this.blur()"
                    enterkeyhint="search"
                    placeholder="Поиск по ${QUESTIONS_DATA.length} вопросам..." 
                    class="search-input w-full pl-9 pr-[85px] py-2 bg-slate-100 dark:bg-slate-900 border border-transparent focus:border-blue-500 dark:focus:border-blue-500 rounded-xl text-sm font-bold text-slate-900 dark:text-white outline-none transition-all placeholder:font-medium shadow-sm focus:shadow-md">
                
                <div id="search-controls" class="absolute inset-y-0 right-0 flex items-center pr-1 gap-0.5 search-controls ${isSearchVisible ? 'visible' : ''}">
                     <button onclick="navigateSearch('prev')" class="p-1 rounded-lg text-slate-400 hover:text-black hover:bg-slate-200 dark:hover:text-white dark:hover:bg-slate-700 transition-colors"><i data-lucide="chevron-up" class="w-4 h-4"></i></button>
                     <button onclick="navigateSearch('next')" class="p-1 rounded-lg text-slate-400 hover:text-black hover:bg-slate-200 dark:hover:text-white dark:hover:bg-slate-700 transition-colors"><i data-lucide="chevron-down" class="w-4 h-4"></i></button>
                     <button onclick="clearSearch()" class="p-1 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-100 dark:hover:bg-rose-900/30 transition-colors"><i data-lucide="x" class="w-4 h-4"></i></button>
                </div>
            </div>
            <button onclick="toggleAnswersVisibility()" class="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-xl border btn-click transition-all shadow-sm active:scale-95 ${state.hideAnswersInLearn?'bg-black text-white border-black dark:bg-white dark:text-black':'bg-white text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'}">
                <i data-lucide="${state.hideAnswersInLearn?'eye':'eye-off'}" class="w-5 h-5"></i>
            </button>
        </div>
        
        <div id="learn-list-container" 
             onscroll="document.activeElement?.blur()"
             ontouchstart="if(document.activeElement.tagName==='INPUT') document.activeElement.blur()"
             class="learn-container transition-opacity duration-200 flex-1 overflow-y-auto -mx-4 px-4 pb-0">
        </div>
    </div>`;
}

function renderQuizContent() {
    if(!state.playableQuestions.length || state.quizFinished) return renderQuizFinished();
    const q=state.playableQuestions[state.currentQuestionIndex];
    const pct=((state.currentQuestionIndex+1)/state.playableQuestions.length)*100;
    const isMulti = q.correctIndices.length > 1;

    return `<div class="flex flex-col h-full animate-fade-in relative">
        <div class="h-1 w-full bg-slate-200 dark:bg-slate-800 shrink-0"><div class="h-full bg-black dark:bg-white transition-all duration-300" style="width:${pct}%"></div></div>
        <div class="p-4 w-full max-w-xl mx-auto pb-10">
            <div class="flex justify-between items-start mb-3 gap-4">
                <span class="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest bg-white dark:bg-slate-900 px-3 py-1.5 rounded-xl border border-slate-100 dark:border-slate-800 leading-tight">${q.topic}</span>
                <span class="text-xs font-black text-slate-300 dark:text-slate-600 whitespace-nowrap mt-1">#${q.id} • ${state.currentQuestionIndex+1}/${state.playableQuestions.length}</span>
            </div>
            <div class="mb-2">
                <span class="inline-block text-[10px] font-bold px-2.5 py-0.5 rounded-md ${isMulti ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'}">
                    ${isMulti ? `Выберите несколько вариантов` : `Выберите один вариант`}
                </span>
            </div>
            <h3 class="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100 mb-6 leading-snug">${q.question}</h3>
            <div class="space-y-3">
                ${q.options.map((opt, i) => {
                    if(!opt||!opt.trim())return'';
                    let cls="w-full p-4 rounded-2xl text-left font-semibold text-sm transition-all border relative btn-click ";
                    if(!state.isAnswerChecked) { 
                        if(state.selectedOptions.includes(i)) cls+="border-black bg-black text-white dark:border-white dark:bg-white dark:text-black shadow-lg scale-[1.01]"; 
                        else cls+="border-slate-200 bg-white text-black hover:bg-slate-50 dark:border-slate-800 dark:bg-black dark:text-white dark:hover:bg-slate-900"; 
                    }
                    else {
                        const sel=state.selectedOptions.includes(i), corr=q.correctIndices.includes(i);
                        if(sel&&corr) cls+="border-emerald-500 bg-emerald-500 text-white shadow-md"; 
                        else if(sel&&!corr) cls+="border-rose-500 bg-rose-500 text-white shadow-md"; 
                        else if(!sel&&corr) cls+="border-[3px] border-emerald-500 text-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-300 font-bold";
                        else cls+="border-transparent bg-slate-100 text-slate-400 opacity-50 dark:bg-slate-800 dark:text-slate-400";
                    }
                    return `<button onclick="handleOptionSelect(${i})" ${state.isAnswerChecked?'disabled':''} class="${cls}"><span class="opacity-60 mr-1.5">${i+1})</span>${opt}</button>`;
                }).join('')}
            </div>
        </div>
    </div>`;
}

function renderQuizFooter() {
    if(!state.playableQuestions.length || state.quizFinished) return '';
    let btnText="Дальше", btnCls="bg-black text-white shadow-lg dark:bg-white dark:text-black";
    if(state.isAnswerChecked) { if(state.lastResult) { btnText="Верно!"; btnCls="bg-emerald-500 text-white shadow-emerald-200 shadow-lg"; } else { btnText="Ошибка"; btnCls="bg-rose-500 text-white shadow-rose-200 shadow-lg"; } }
    return `<div class="layout-footer bg-slate-50/90 dark:bg-black/90 backdrop-blur-md border-t border-slate-200 dark:border-slate-800">
        <div class="max-w-xl mx-auto flex gap-3 items-stretch">
            <button onclick="prevQuestion()" ${state.currentQuestionIndex===0?'disabled':''} class="px-5 rounded-2xl font-bold text-lg bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-30 btn-click"><i data-lucide="chevron-left" class="w-6 h-6"></i></button>
            ${!state.isAnswerChecked ? `<button onclick="checkAnswer()" ${state.selectedOptions.length===0?'disabled':''} class="flex-1 py-4 rounded-2xl font-bold text-lg shadow-lg transition-transform active:scale-[0.98] btn-click ${state.selectedOptions.length>0?'bg-black text-white shadow-slate-300 dark:bg-white dark:text-black dark:shadow-none':'bg-slate-100 text-slate-300 dark:bg-slate-800 dark:text-slate-600 cursor-not-allowed'}">Проверить</button>` : `<button onclick="nextQuestion()" class="flex-1 py-4 rounded-2xl font-bold text-lg active:scale-[0.98] btn-click flex items-center justify-center gap-2 ${btnCls}">${state.currentQuestionIndex===state.playableQuestions.length-1?'Завершить':btnText}</button>`}
            <button onclick="nextQuestion()" ${state.currentQuestionIndex===state.playableQuestions.length-1?'disabled':''} class="px-5 rounded-2xl font-bold text-lg bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-30 btn-click"><i data-lucide="chevron-right" class="w-6 h-6"></i></button>
        </div>
    </div>`;
}

function renderQuizFinished() {
    const isMistakes = state.view === 'mistakes';
    return `<div class="flex flex-col items-center justify-center h-full p-6 text-center animate-fade-in">
        ${state.playableQuestions.length===0 ? `<div class="bg-slate-100 dark:bg-slate-800 p-6 rounded-full mb-6"><i data-lucide="${isMistakes?'check-circle':'filter'}" class="w-12 h-12 ${isMistakes?'text-emerald-500':'text-slate-400 dark:text-slate-600'}"></i></div><h2 class="text-2xl font-black text-slate-900 dark:text-white mb-2">${isMistakes?'Чисто!':'Пусто'}</h2><p class="text-slate-500 dark:text-slate-400 mb-8 max-w-xs font-medium">${isMistakes?'Ошибок нет. Ты машина!':'Нет вопросов в выбранных темах.'}</p>` : `<i data-lucide="award" class="w-24 h-24 text-yellow-400 mb-6 drop-shadow-xl"></i><h2 class="text-3xl font-black text-slate-900 dark:text-white mb-2">Финиш!</h2><p class="text-slate-500 dark:text-slate-400 mb-10 font-medium">Все вопросы пройдены.</p><div class="flex flex-col gap-3 w-full max-w-xs"><button onclick="startMode('${state.view}')" class="w-full bg-black dark:bg-white text-white dark:text-black py-4 rounded-2xl font-bold shadow-lg btn-click">Пройти еще раз</button></div>`}
        <button onclick="goHome()" class="mt-4 bg-transparent border-2 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white px-10 py-4 rounded-2xl font-bold btn-click">В меню</button>
    </div>`;
}

function renderCardsContent() {
    if(!state.playableQuestions.length) return renderQuizFinished();
    const q=state.playableQuestions[state.currentQuestionIndex];
    const correctText=q.correctIndices.map(i=>`<span class="opacity-70">${i+1})</span> ${q.options[i]}`).join('<br><br>');
    
    return `<div class="flex flex-col h-full p-4 overflow-hidden select-none animate-fade-in relative">
        <div class="flex justify-center mb-2 text-xs font-black text-slate-300 dark:text-slate-700 flex-shrink-0">#${q.id} • ${state.currentQuestionIndex+1} / ${state.playableQuestions.length}</div>
        <div class="flex-1 relative perspective-1000 max-w-sm mx-auto w-full mb-4">
            <div id="flashcard" class="w-full h-full relative" onclick="handleCardClick()">
                <div id="card-inner" class="w-full h-full relative preserve-3d cursor-pointer transition-transform duration-500 ${state.isFlipped?'rotate-y-180':''}">
                    <div class="absolute inset-0 backface-hidden flex flex-col p-4 rounded-[2rem] bg-white dark:bg-slate-900 shadow-2xl shadow-slate-200 dark:shadow-none border border-slate-200 dark:border-slate-800 items-start overflow-hidden">
                         <div class="w-full flex justify-center mb-2 shrink-0"><div class="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50 dark:bg-slate-800 px-3 py-1 rounded-full truncate max-w-full">${q.topic}</div></div>
                         <div class="w-full flex flex-col gap-2 flex-1 card-scroll justify-start min-h-0">
                             <h3 class="text-sm sm:text-base font-bold text-slate-900 dark:text-white leading-snug text-left shrink-0 mb-1">${q.question}</h3>
                             <div class="w-full space-y-2 pb-4 shrink-0">
                                ${q.options.map((opt, idx)=>{
                                    if(!opt||!opt.trim())return'';
                                    return `<div class="w-full p-3 rounded-lg border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-black/20 text-xs font-medium text-slate-600 dark:text-slate-300 text-left leading-tight">${idx+1}) ${opt}</div>`
                                }).join('')}
                                <div class="h-8 w-full shrink-0"></div>
                             </div>
                         </div>
                         <div class="mt-auto w-full text-center pt-2 border-t border-slate-100 dark:border-slate-800 shrink-0"><span class="text-slate-400 text-[10px] font-bold flex items-center justify-center gap-1 opacity-50"><i data-lucide="rotate-ccw" class="w-3 h-3"></i> Нажми для ответа</span></div>
                    </div>
                    <div class="absolute inset-0 backface-hidden bg-black dark:bg-slate-800 p-6 flex flex-col items-center justify-center text-center rounded-[2rem] shadow-2xl rotate-y-180 border-2 border-slate-100 dark:border-slate-600">
                        <h3 class="text-[10px] font-bold opacity-50 uppercase tracking-widest mb-4 text-white dark:text-white shrink-0">Правильный ответ</h3>
                        <div class="flex-1 flex flex-col items-center justify-center w-full card-scroll min-h-0">
                            <div class="text-base sm:text-lg font-bold mb-6 text-[#FFD700] dark:text-[#FFD700] select-none leading-snug">${correctText}</div>
                            <div class="h-8 w-full shrink-0"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}

function renderCardsFooter() {
    if(!state.playableQuestions.length) return '';
    return `<div class="layout-footer bg-slate-50/90 dark:bg-black/90 backdrop-blur-md border-t border-slate-200 dark:border-slate-800">
        <div class="max-w-sm mx-auto flex gap-3">
             <button onclick="animateCard('prev')" class="flex-1 py-4 rounded-2xl font-bold bg-white dark:bg-slate-900 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 btn-click">Назад</button>
             <button onclick="animateCard('next')" ${state.currentQuestionIndex===state.playableQuestions.length-1?'disabled':''} class="flex-[2] py-4 rounded-2xl font-bold transition-all btn-click ${state.currentQuestionIndex===state.playableQuestions.length-1?'bg-slate-100 text-slate-300 dark:bg-slate-800 dark:text-slate-600 cursor-not-allowed shadow-none':'bg-black dark:bg-white text-white dark:text-black shadow-xl shadow-slate-300 dark:shadow-none active:scale-[0.98]'}">Дальше</button>
        </div>
    </div>`;
}

function initFilterSwipeEvents() {
    const modalContent = document.getElementById('filter-modal-content');
    const topicsList = document.getElementById('topics-list');
    if(!modalContent || !topicsList) return;

    let startY = 0; let currentY = 0; let isDragging = false; let isScrollAtTop = true;

    modalContent.addEventListener('touchstart', (e) => {
        if(topicsList.scrollTop > 0) { isScrollAtTop = false; return; }
        isScrollAtTop = true; startY = e.touches[0].clientY; isDragging = true; modalContent.style.transition = 'none';
    }, {passive: true});

    modalContent.addEventListener('touchmove', (e) => {
        if(!isDragging) return;
        currentY = e.touches[0].clientY;
        const diff = currentY - startY;
        if(diff > 0 && isScrollAtTop) {
            if(e.cancelable) e.preventDefault();
            modalContent.style.transform = `translateY(${diff}px)`;
        }
    }, {passive: false});

    modalContent.addEventListener('touchend', () => {
        if(!isDragging) return;
        isDragging = false;
        const diff = currentY - startY;
        modalContent.style.transition = 'transform 0.3s ease-out';
        if(diff > 120 && isScrollAtTop) {
            modalContent.style.transform = `translateY(100%)`;
            setTimeout(() => toggleFilterModal(false), 200);
        } else {
            modalContent.style.transform = '';
        }
    });
}

function renderFilterModal() {
    if(!state.showFilterModal) return '';
    const allSel=state.selectedTopics.length===availableTopics.length;

    const stats = {};
    QUESTIONS_DATA.forEach(q => {
        if (!stats[q.topic]) stats[q.topic] = { total: 0, correct: 0 };
        stats[q.topic].total++;
        if (state.userProgress && state.userProgress[q.id]?.status === 'correct') stats[q.topic].correct++;
    });

    const shuffleBg = state.isShuffleEnabled ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-600';
    const shuffleKnob = state.isShuffleEnabled ? 'left-7' : 'left-1';
    
    const btnBase = "flex-1 flex items-center justify-between px-3 py-2 rounded-xl btn-click border transition-colors";
    const shuffleBtnClass = state.isShuffleEnabled 
        ? `${btnBase} bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800`
        : `${btnBase} bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700`;

    return `<div class="absolute inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onclick="if(event.target===this) toggleFilterModal(false)">
        <div id="filter-modal-content" class="bg-white dark:bg-slate-900 w-full sm:w-[400px] sm:rounded-3xl rounded-t-3xl p-6 shadow-2xl flex flex-col h-[85vh] mb-0 sm:mb-4 animate-slide-up">
            <div class="flex justify-between items-center mb-2 shrink-0"><h3 class="text-xl font-bold text-slate-900 dark:text-white">Фильтр тем</h3><button onclick="toggleFilterModal(false)" class="p-2 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-500 btn-click"><i data-lucide="x" class="w-5 h-5"></i></button></div>
            
            <div class="flex gap-2 mb-2 shrink-0">
                <div onclick="toggleShuffle()" class="${shuffleBtnClass}">
                    <div class="flex items-center gap-2">
                        <i data-lucide="shuffle" class="w-4 h-4 ${state.isShuffleEnabled ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500'}"></i>
                        <span class="text-xs font-bold ${state.isShuffleEnabled ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-600 dark:text-slate-300'}">Случайный</span>
                    </div>
                    <div id="shuffle-toggle-bg" class="w-12 h-6 rounded-full relative transition-colors ${shuffleBg} scale-75 origin-right"><div id="shuffle-toggle-knob" class="w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${shuffleKnob}"></div></div>
                </div>

                <button id="select-all-btn" onclick="toggleSelectAllTopics()" class="flex-1 flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors btn-click"><span>${allSel?'Снять все':'Выбрать все'}</span><i data-lucide="${allSel?'trash-2':'layers'}" class="w-4 h-4"></i></button>
            </div>

            <div id="topics-list" class="flex-1 overflow-y-auto space-y-2 mb-4 pr-1">
                ${availableTopics.map(t=>{
                    const sel = state.selectedTopics.includes(t);
                    const { total, correct } = stats[t] || { total: 0, correct: 0 };
                    const progress = total > 0 ? Math.round((correct / total) * 100) : 0;
                    let barBg = sel ? 'bg-white/20 dark:bg-black/20' : 'bg-slate-200 dark:bg-slate-700';
                    let fillBg = sel ? 'bg-emerald-400 dark:bg-emerald-600' : 'bg-emerald-500';
                    let txtColor = sel ? 'text-white/60 dark:text-black/60' : 'text-slate-400';
                    let progressHtml = `<div class="w-full h-1.5 ${barBg} rounded-full mt-2 overflow-hidden"><div class="h-full ${fillBg} rounded-full" style="width: ${progress}%"></div></div><div class="text-[10px] ${txtColor} mt-1 flex justify-between"><span>Прогресс (${correct}/${total})</span><span>${progress}%</span></div>`;

                    let btnClass = "w-full text-left px-4 py-3 rounded-xl font-bold text-sm flex flex-col gap-1 group btn-click relative";
                    let iconHtml = '';
                    if(sel) { btnClass += " bg-black text-white dark:bg-white dark:text-black border border-transparent"; iconHtml='<i data-lucide="check-circle" class="w-4 h-4 absolute top-3 right-3 text-emerald-400 dark:text-emerald-600"></i>'; } 
                    else { btnClass += " bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 relative"; }
                    
                    return `<button data-topic="${t}" onclick="toggleTopic('${t}')" class="${btnClass}"><div class="topic-content w-full"><span class="block text-wrap leading-tight pr-6 mb-1">${t}</span> ${progressHtml}</div><div class="icon-area">${iconHtml}</div></button>`
                }).join('')}
            </div>
            <button id="apply-btn" onclick="toggleFilterModal(false)" class="w-full py-4 bg-black dark:bg-white text-white dark:text-black rounded-2xl font-bold text-lg shrink-0 btn-click">Применить (${state.selectedTopics.length})</button>
        </div>
    </div>`;
}

function renderResetModal() {
    if(!state.showResetModal) return '';
    const allSel=state.resetSelectedTopics.length===availableTopics.length;
    return `<div class="absolute inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onclick="if(event.target===this) toggleResetModal(false)">
        <div class="bg-white dark:bg-slate-900 w-full sm:w-[400px] sm:rounded-3xl rounded-t-3xl p-6 shadow-2xl flex flex-col h-[85vh] mb-0 sm:mb-4 animate-slide-up">
            <div class="flex justify-between items-center mb-4 shrink-0"><h3 class="text-xl font-bold text-slate-900 dark:text-white">Сброс прогресса</h3><button onclick="toggleResetModal(false)" class="p-2 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-500 btn-click"><i data-lucide="x" class="w-5 h-5"></i></button></div>
            <div id="reset-topics-list" class="flex-1 overflow-y-auto space-y-2 mb-4 pr-1">
                <button id="reset-select-all-btn" onclick="toggleSelectAllReset()" class="w-full text-left px-4 py-3 rounded-xl font-bold text-sm bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex justify-between items-center btn-click"><span>${allSel?'Снять все':'Выбрать все'}</span><i data-lucide="${allSel?'trash-2':'layers'}" class="w-4 h-4"></i></button>
                ${availableTopics.map(t=>{return`<button data-topic="${t}" onclick="toggleResetTopic('${t}')" class="w-full text-left px-4 py-3 rounded-xl font-bold text-sm flex flex-col gap-1 group btn-click bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 relative"><div class="topic-content w-full"><span class="block text-wrap leading-tight pr-6 mb-1">${t}</span></div><div class="icon-area"></div></button>`}).join('')}
            </div>
            <button id="confirm-reset-btn" onclick="confirmReset()" class="w-full py-4 bg-rose-500 text-white rounded-2xl font-bold text-lg shrink-0 btn-click shadow-lg shadow-rose-500/30">Сбросить</button>
        </div>
    </div>`;
}

function renderConfirmResetDialog() {
    return `<div class="absolute inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6 animate-fade-in">
        <div class="bg-white dark:bg-slate-900 w-full max-w-xs rounded-3xl p-6 shadow-2xl flex flex-col items-center text-center animate-slide-up">
            <div class="w-16 h-16 bg-rose-100 dark:bg-rose-900/30 rounded-full flex items-center justify-center mb-4">
                <i data-lucide="alert-triangle" class="w-8 h-8 text-rose-500"></i>
            </div>
            <h3 class="text-xl font-black text-slate-900 dark:text-white mb-2">Вы уверены?</h3>
            <p class="text-sm text-slate-500 dark:text-slate-400 mb-6 font-medium leading-relaxed">
                Вы собираетесь сбросить прогресс для <span class="text-slate-900 dark:text-white font-bold">${state.resetSelectedTopics.length} тем</span>. 
            </p>
            <div class="flex flex-col gap-3 w-full">
                <button onclick="executeFinalReset()" class="w-full py-3 bg-rose-500 text-white rounded-xl font-bold shadow-lg shadow-rose-500/30 active:scale-95 transition-transform btn-click">Сбросить</button>
                <button onclick="cancelReset()" class="w-full py-3 bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white rounded-xl font-bold active:scale-95 transition-transform btn-click">Отмена</button>
            </div>
        </div>
    </div>`;
}

function initCardEvents() {
    const card = document.getElementById('flashcard'); if (!card) return;
    let startX = 0; let startY = 0; let isSwiping = false; let isScrolling = false;
    card.style.transform = 'translateX(0px) rotate(0deg)'; card.style.transition = 'transform 0.3s ease-out';
    card.ontouchstart = (e) => { if (state.animState !== 'idle') return; startX = e.touches[0].clientX; startY = e.touches[0].clientY; isSwiping = false; isScrolling = false; card.style.transition = 'none'; };
    card.ontouchmove = (e) => {
        if (state.animState !== 'idle') return; if (isScrolling) return;
        const diffX = e.touches[0].clientX - startX; const diffY = e.touches[0].clientY - startY;
        if (Math.abs(diffY) > Math.abs(diffX)) { isScrolling = true; return; }
        if (Math.abs(diffX) > 10) { isSwiping = true; if(e.cancelable) e.preventDefault(); state.swipeX = diffX; card.style.transform = `translateX(${diffX}px) rotate(${diffX * 0.05}deg)`; }
    };
    card.ontouchend = () => {
        if (state.animState !== 'idle') return;
        if (isSwiping) { if (Math.abs(state.swipeX) > 100) animateCard(state.swipeX > 0 ? 'prev' : 'next'); else { card.style.transition = 'transform 0.3s ease-out'; card.style.transform = 'translateX(0px) rotate(0deg)'; } }
    };
}

function handleCardClick() { if (state.animState === 'idle') toggleFlip(); }

function animateCard(dir) {
    const card = document.getElementById('flashcard');
    if ((dir === 'next' && state.currentQuestionIndex >= state.playableQuestions.length - 1) || (dir === 'prev' && state.currentQuestionIndex <= 0)) { card.style.transition = 'transform 0.3s ease-out'; card.style.transform = 'translateX(0) rotate(0deg)'; return; }
    state.animState = 'animating'; card.style.transition = 'transform 0.2s ease-in, opacity 0.2s ease-in';
    card.style.transform = dir === 'next' ? 'translateX(-120vw) rotate(-20deg)' : 'translateX(120vw) rotate(20deg)'; card.style.opacity = '0';
    setTimeout(() => {
        if (dir === 'next') state.currentQuestionIndex++; else state.currentQuestionIndex--;
        state.isFlipped = false; state.swipeX = 0; render(); 
        const newCard = document.getElementById('flashcard'); newCard.style.transition = 'none';
        newCard.style.transform = dir === 'next' ? 'translateX(120vw) rotate(20deg)' : 'translateX(-120vw) rotate(-20deg)'; newCard.style.opacity = '0';
        requestAnimationFrame(() => { newCard.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out'; newCard.style.transform = 'translateX(0) rotate(0deg)'; newCard.style.opacity = '1'; setTimeout(() => { state.animState = 'idle'; }, 300); });
    }, 200);
}
function toggleFlip() { haptic('light'); state.isFlipped = !state.isFlipped; const inner = document.getElementById('card-inner'); if (inner) { if (state.isFlipped) inner.classList.add('rotate-y-180'); else inner.classList.remove('rotate-y-180'); } }

// --- ЗАПУСК ПРИЛОЖЕНИЯ ---
// --- ПАРАЛЛЕЛЬНЫЙ ЗАПУСК: ИНТРО ИГРАЕТ, ДОСТУП ПРОВЕРЯЕТСЯ В ФОНЕ ---
window.addEventListener('DOMContentLoaded', () => {
    const intro = document.getElementById('intro-layer');
    const video = document.getElementById('intro-video');
    let done = false;
    const finishOnce = () => { if (done) return; done = true; finishVideo(); };

    if (intro && video) {
        intro.classList.remove('hidden-force');
        video.muted = true;
        const src = video.querySelector('source');
        if (src) src.addEventListener('error', finishOnce);
        video.addEventListener('error', finishOnce);
        video.addEventListener('ended', finishOnce);
        video.addEventListener('loadedmetadata', () => {
            if (isFinite(video.duration)) setTimeout(finishOnce, (video.duration + 1) * 1000);
        });
        setTimeout(() => { if (video.readyState < 1) finishOnce(); }, 4000);
        const pr = video.play();
        if (pr && pr.catch) pr.catch(finishOnce);
    } else {
        finishOnce();
    }

    if (USE_AUTH) {
        performAccessCheck();
    } else {
        loadLocalFallback();
        processQuestions();
        accessData = { allowed: true };
        checkStateTransition();
    }
});
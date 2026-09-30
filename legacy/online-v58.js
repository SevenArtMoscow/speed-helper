
/* SPEED HELPER V5.8 RESILIENT PROXY
   Live Supabase adapter over the V4 interface.
   Client key is publishable by design; access is enforced by RLS.
*/
const SH_SUPABASE_URL = 'https://pbkwthztlpyvkyvhgqea.supabase.co';
const SH_SUPABASE_KEY = "sb_publishable_J7vqDkWGmMqPORsk_HQIkA_Yp-oEkx2";
const SH_BUILD = "5.8";

function shHeadersEach(headers, cb) {
  if (!headers) return;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => cb(key, value));
    return;
  }
  if (Array.isArray(headers)) {
    headers.forEach(([key, value]) => cb(key, value));
    return;
  }
  Object.keys(headers).forEach(key => cb(key, headers[key]));
}

function shTelegramXhrFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : (input && input.url);
  const method = init.method || (input && input.method) || 'GET';
  const retryStatuses = new Set([502, 503, 504]);
  const maxAttempts = 3;

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function attempt(attemptNo) {
    try {
      const response = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.timeout = 20000;

        try {
          if (input && input.headers) {
            shHeadersEach(input.headers, (k, v) => {
              try { xhr.setRequestHeader(k, v); } catch (_) {}
            });
          }
          shHeadersEach(init.headers, (k, v) => {
            try { xhr.setRequestHeader(k, v); } catch (_) {}
          });
        } catch (_) {}

        let aborted = false;
        const signal = init.signal;
        const onAbort = () => {
          aborted = true;
          try { xhr.abort(); } catch (_) {}
        };

        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          try { signal.addEventListener('abort', onAbort, { once: true }); } catch (_) {}
        }

        function cleanup() {
          if (signal) {
            try { signal.removeEventListener('abort', onAbort); } catch (_) {}
          }
        }

        xhr.onload = () => {
          cleanup();
          const responseHeaders = new Headers();
          const raw = xhr.getAllResponseHeaders() || '';
          raw.trim().split(/[\r\n]+/).forEach(line => {
            const idx = line.indexOf(':');
            if (idx > 0) {
              const key = line.slice(0, idx).trim();
              const value = line.slice(idx + 1).trim();
              try { responseHeaders.append(key, value); } catch (_) {}
            }
          });

          resolve(new Response(xhr.responseText || '', {
            status: xhr.status,
            statusText: xhr.statusText || '',
            headers: responseHeaders
          }));
        };

        xhr.onerror = () => {
          cleanup();
          reject(new TypeError('Netlify proxy network request failed'));
        };
        xhr.ontimeout = () => {
          cleanup();
          reject(new TypeError('Netlify proxy request timed out'));
        };
        xhr.onabort = () => {
          cleanup();
          reject(new DOMException(aborted ? 'Aborted' : 'Aborted', 'AbortError'));
        };

        try {
          xhr.send(init.body == null ? null : init.body);
        } catch (e) {
          cleanup();
          reject(e);
        }
      });

      if (retryStatuses.has(response.status) && attemptNo < maxAttempts) {
        await wait(attemptNo === 1 ? 500 : 1400);
        return attempt(attemptNo + 1);
      }
      return response;
    } catch (e) {
      const isTransient = e instanceof TypeError ||
        String((e && e.message) || e || '').toLowerCase().includes('network') ||
        String((e && e.message) || e || '').toLowerCase().includes('timed out');

      if (isTransient && attemptNo < maxAttempts) {
        await wait(attemptNo === 1 ? 500 : 1400);
        return attempt(attemptNo + 1);
      }
      throw e;
    }
  }

  return attempt(1);
}

const SH_AUTH_STORAGE_KEY = "sb-pbkwthztlpyvkyvhgqea-auth-token";

const shDb = window.supabase.createClient(SH_SUPABASE_URL, SH_SUPABASE_KEY, {
  global: { fetch: shTelegramXhrFetch },
  auth: {
    storageKey: SH_AUTH_STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

let shUser = null;
let shOnlineReady = false;
let shProfiles = {};
let shShiftRows = [];
let shApplicationRows = [];
let shChannels = [];
let shRefreshTimer = null;
let shApplicationBusy = false;
let shBackgroundFailures = 0;
const SH_MAX_BACKGROUND_FAILURES = 3;
const SH_POLL_MS = 20000;

function shLog(...a) { console.log('[SPEED HELPER ONLINE]', ...a); }
function shIsUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
}
function shError(context, error) {
  console.error('[SPEED HELPER ONLINE]', context, error);
  const code = error && error.code ? String(error.code) : '—';
  const message = error && error.message ? String(error.message) : String(error || 'Неизвестная ошибка');
  const details = error && error.details ? String(error.details) : '';
  const hint = error && error.hint ? String(error.hint) : '';
  const full = [
    'SPEED HELPER · диагностика · V5.8',
    'Этап: ' + context,
    'Код: ' + code,
    'Ошибка: ' + message,
    details ? 'Детали: ' + details : '',
    hint ? 'Подсказка: ' + hint : ''
  ].filter(Boolean).join('\n');
  if (typeof toast === 'function') toast('Ошибка: ' + message);
  try {
    if (window.Telegram && Telegram.WebApp && typeof Telegram.WebApp.showAlert === 'function') {
      Telegram.WebApp.showAlert(full);
    } else {
      window.alert(full);
    }
  } catch (_) {
    window.alert(full);
  }
}
function shDateOffset(dateStr) {
  if (!dateStr) return 0;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}
function shTime(t) { return t ? String(t).slice(0,5) : ''; }
function shTimeRange(row) {
  const a = shTime(row.start_time), b = shTime(row.end_time);
  return a && b ? a + '–' + b : (a || b || 'Время не указано');
}
function shCategory(title='') {
  const s=title.toLowerCase();
  if (s.includes('водит')) return 'driver';
  if (s.includes('курьер')) return 'courier';
  if (s.includes('склад')||s.includes('упаков')||s.includes('комплект')) return 'warehouse';
  if (s.includes('стро')||s.includes('монтаж')||s.includes('разгруз')) return 'build';
  if (s.includes('мероприят')||s.includes('выстав')||s.includes('хелпер')) return 'events';
  return 'any';
}
function shPseudoDistance(id='') {
  let h=0; for (const c of String(id)) h=(h*31+c.charCodeAt(0))>>>0;
  return Math.round((1.2 + (h % 85)/10)*10)/10;
}
function shProfilePayload() {
  if (!shUser || !state.registered || !state.role) return null;
  if (state.role === 'worker') {
    const p=state.profile;
    return {
      id:shUser.id,
      telegram_id:(window.Telegram&&Telegram.WebApp&&Telegram.WebApp.initDataUnsafe&&Telegram.WebApp.initDataUnsafe.user&&Telegram.WebApp.initDataUnsafe.user.id)||null,
      role:'worker',
      full_name:p.name||'Пользователь',
      company_name:null,
      city:p.city||null,
      phone:p.phone?'+7 '+p.phone:null,
      bio:p.bio||null,
      avatar_url:p.avatar||null,
      profile_completion:typeof profileCompletion==='function'?profileCompletion(p):0,
      skills:{skills:p.skills||[],licenses:p.licenses||[],experience:p.experience||'',driveYears:p.driveYears||'',gearbox:p.gearbox||''},
      documents:{items:p.docs||[]},
      updated_at:new Date().toISOString()
    };
  }
  const p=state.contractorProfile;
  return {
    id:shUser.id,
    telegram_id:(window.Telegram&&Telegram.WebApp&&Telegram.WebApp.initDataUnsafe&&Telegram.WebApp.initDataUnsafe.user&&Telegram.WebApp.initDataUnsafe.user.id)||null,
    role:'contractor',
    full_name:p.name||'Подрядчик',
    company_name:p.company||null,
    city:p.city||null,
    phone:p.phone?'+7 '+p.phone:null,
    bio:p.bio||null,
    avatar_url:p.avatar||null,
    profile_completion:typeof contractorCompletion==='function'?contractorCompletion(p):0,
    skills:{},
    documents:{},
    updated_at:new Date().toISOString()
  };
}
async function shEnsureAuth() {
  const {data:sessionData} = await shDb.auth.getSession();
  if (sessionData && sessionData.session) {
    shUser=sessionData.session.user;
    return shUser;
  }
  const {data,error} = await shDb.auth.signInAnonymously();
  if (error) throw error;
  shUser=data.user;
  return shUser;
}
async function shUpsertProfile() {
  const payload=shProfilePayload();
  if (!payload) return;

  const {error}=await shDb.from('profiles').upsert(payload,{onConflict:'id'});
  if (!error) return;

  if (String(error.code) === '23505' && String(error.message || '').includes('profiles_telegram_id_key')) {
    const tgId=payload.telegram_id;
    let existing=null;
    if (tgId) {
      const {data}=await shDb.from('profiles')
        .select('id,telegram_id,role,full_name,company_name')
        .eq('telegram_id',tgId)
        .maybeSingle();
      existing=data||null;
    }

    const e=new Error(
      existing && existing.id !== shUser.id
        ? 'Сессия пользователя не совпала с уже существующим Telegram-профилем'
        : error.message
    );
    e.code='AUTH_IDENTITY_MISMATCH';
    e.details=existing
      ? ('Текущий auth.uid: '+shUser.id+'; профиль Telegram уже привязан к auth.uid: '+existing.id)
      : 'Telegram ID уже существует в profiles.';
    e.hint='V5.7 использует исходный ключ хранения Supabase-сессии, чтобы восстановить прежний auth.uid.';
    throw e;
  }

  throw error;
}
async function shFetchProfiles(ids) {
  const unique=[...new Set((ids||[]).filter(Boolean))];
  if (!unique.length) return {};
  const {data,error}=await shDb.from('profiles')
    .select('id,role,full_name,company_name,city,bio,avatar_url,profile_completion,rating,completed_shifts,skills')
    .in('id',unique);
  if (error) throw error;
  const map={};
  (data||[]).forEach(p=>map[p.id]=p);
  Object.assign(shProfiles,map);
  return map;
}
function shJobFromRow(r,p={}) {
  const company=p.company_name||p.full_name||'Подрядчик';
  return {
    id:r.id,
    title:r.title,
    company,
    contractorId:r.contractor_id,
    verified:Number(p.profile_completion||0)>=80,
    rating:Number(p.rating||0),
    reviews:0,
    pay:Number(r.pay_amount||0),
    offset:shDateOffset(r.work_date),
    time:shTimeRange(r),
    dist:shPseudoDistance(r.id),
    city:r.city||'',
    place:r.address||r.city||'Адрес уточняется',
    cat:shCategory(r.title),
    desc:r.description||'Описание пока не добавлено.',
    tags:Array.isArray(r.requirements)?r.requirements:[],
    dbRow:r
  };
}
function shCreatedShift(r, filled=0) {
  return {
    id:r.id,title:r.title,city:r.city||'',address:r.address||'',time:shTimeRange(r),
    pay:Number(r.pay_amount||0),needed:Number(r.people_needed||1),filled,
    requirements:Array.isArray(r.requirements)?r.requirements:[],
    desc:r.description||'',offset:shDateOffset(r.work_date),
    status:r.status==='cancelled'?'deleted':r.status,workDate:r.work_date
  };
}
async function shLoadShifts() {
  if (!shUser) return;
  const {data:openRows,error:openErr}=await shDb.from('shifts')
    .select('*').eq('status','open').order('created_at',{ascending:false});
  if (openErr) throw openErr;
  let ownRows=[];
  if (state.role==='contractor') {
    const {data,error}=await shDb.from('shifts').select('*')
      .eq('contractor_id',shUser.id).neq('status','cancelled')
      .order('created_at',{ascending:false});
    if (error) throw error;
    ownRows=data||[];
  }
  const all=[...(openRows||[]),...ownRows];
  const dedup=[...new Map(all.map(x=>[x.id,x])).values()];
  shShiftRows=dedup;
  const profileMap=await shFetchProfiles(dedup.map(x=>x.contractor_id));
  jobs.splice(0,jobs.length,...(openRows||[]).map(r=>shJobFromRow(r,profileMap[r.contractor_id]||{})));
  deckIds=jobs.map(j=>j.id);
  if(deckIndex>=deckIds.length) deckIndex=0;
  // Rebuild contractor directory used by the public profile screen.
  Object.keys(profileMap).forEach(id=>{
    const p=profileMap[id];
    contractors[id]={
      id,
      name:p.company_name||p.full_name||'Подрядчик',
      verified:Number(p.profile_completion||0)>=80,
      rating:Number(p.rating||0),
      reviews:0,
      about:p.bio||'Профиль подрядчика SPEED HELPER.',
      jobs:jobs.filter(j=>j.contractorId===id).map(j=>j.id)
    };
  });
  if (state.role==='contractor') {
    state.createdShifts=ownRows.map(r=>shCreatedShift(r,0));
    if (state.currentShift && !state.createdShifts.some(s=>s.id===state.currentShift)) state.currentShift=null;
    if (!state.currentShift && state.createdShifts[0]) state.currentShift=state.createdShifts[0].id;
  }
}
async function shLoadApplications() {
  if (!shUser) return;
  if (state.role==='worker') {
    const {data,error}=await shDb.from('applications').select('*')
      .eq('worker_id',shUser.id).order('created_at',{ascending:false});
    if (error) throw error;
    shApplicationRows=data||[];
    state.applications=(data||[]).filter(a=>a.status==='pending').map(a=>({jobId:a.shift_id,status:'waiting',applicationId:a.id}));
    state.confirmed=(data||[]).filter(a=>a.status==='accepted').map(a=>({jobId:a.shift_id,status:'confirmed',applicationId:a.id}));
    state.rejected=(data||[]).filter(a=>a.status==='rejected').map(a=>({jobId:a.shift_id,status:'rejected',applicationId:a.id}));
    // Accepted/rejected shifts may no longer be open, so fetch them explicitly.
    const ids=(data||[]).map(a=>a.shift_id);
    if (ids.length) {
      const {data:rows,error:e2}=await shDb.from('shifts').select('*').in('id',ids);
      if (!e2 && rows) {
        const ps=await shFetchProfiles(rows.map(r=>r.contractor_id));
        rows.forEach(r=>{
          if (!jobs.some(j=>j.id===r.id)) jobs.push(shJobFromRow(r,ps[r.contractor_id]||{}));
        });
      }
    }
  } else if (state.role==='contractor') {
    const shiftIds=state.createdShifts.map(s=>s.id);
    if (!shiftIds.length) {
      shApplicationRows=[]; state.onlineApplications=[]; state.candidateStatus={};
      candidates.splice(0,candidates.length);
      return;
    }
    const {data,error}=await shDb.from('applications').select('*')
      .in('shift_id',shiftIds).order('created_at',{ascending:false});
    if (error) throw error;
    shApplicationRows=data||[];
    state.onlineApplications=data||[];
    const pm=await shFetchProfiles((data||[]).map(a=>a.worker_id));
    candidates.splice(0,candidates.length,...[...new Set((data||[]).map(a=>a.worker_id))].map(id=>{
      const p=pm[id]||{};
      const sk=p.skills||{};
      const parts=[...(sk.skills||[]),...(sk.licenses||[]).map(x=>'Права '+x)];
      return {id,name:p.full_name||'Исполнитель',rating:Number(p.rating||0),shifts:Number(p.completed_shifts||0),skills:parts.length?parts:['Профиль заполнен']};
    }));
    state.candidateStatus={};
    (data||[]).forEach(a=>state.candidateStatus[a.worker_id]=a.status==='pending'?'new':a.status);
    // Fill counts from accepted applications.
    state.createdShifts.forEach(s=>s.filled=(data||[]).filter(a=>a.shift_id===s.id&&a.status==='accepted').length);
  }
}
async function shRefreshAll(render=true, quiet=false) {
  if (!shOnlineReady) return false;

  try {
    await shLoadShifts();
    await shLoadApplications();
    saveState();

    shBackgroundFailures=0;
    shSetOnlineBadge(true);

    if (render) shRerender();
    return true;
  } catch(e) {
    if (quiet) {
      shBackgroundFailures++;
      console.warn('[SPEED HELPER ONLINE] background refresh failed', shBackgroundFailures, e);

      // Do not scare the user because of one temporary 502.
      if (shBackgroundFailures >= SH_MAX_BACKGROUND_FAILURES) {
        shSetOnlineBadge(false);
      }
      return false;
    }

    shBackgroundFailures=SH_MAX_BACKGROUND_FAILURES;
    shSetOnlineBadge(false);
    if (render) shRerender();
    shError('refresh · Netlify proxy · resilient',e);
    return false;
  }
}
function shRerender() {
  try {
    if (currentScreen==='workerHome') renderWorkerHome();
    else if (currentScreen==='workerShifts') renderWorkerShifts();
    else if (currentScreen==='deck') renderDeck();
    else if (currentScreen==='contractorHome') renderContractorHome();
    else if (currentScreen==='contractorShifts') renderContractorShifts();
    else if (currentScreen==='shiftManage') renderManageShift();
    else if (currentScreen==='applicants') renderApplicants();
    else if (currentScreen==='workerTeams') renderWorkerTeams();
    else if (currentScreen==='workerTeam') renderWorkerTeam();
    else if (currentScreen==='contractorTeam') renderContractorTeam();
    else if (currentScreen==='groupChat') renderGroupChat();
    else if (currentScreen==='contractorGroupChat') renderContractorGroupChat();
  } catch(e) { console.warn(e); }
}
function shScheduleRefresh() {
  clearTimeout(shRefreshTimer);
  shRefreshTimer=setTimeout(()=>shRefreshAll(true),350);
}
function shSubscribe() {
  // Telegram iOS: use low-frequency HTTP polling.
  // One temporary gateway error must not switch the whole app to "offline".
  shChannels.forEach(c=>{ try{ shDb.removeChannel(c); }catch(_){} });
  shChannels=[];
  if (window.__shPollTimer) clearInterval(window.__shPollTimer);

  window.__shPollTimer=setInterval(()=>{
    if (shOnlineReady && !document.hidden) shRefreshAll(false, true);
  }, SH_POLL_MS);
}
function shSetOnlineBadge(ok=true) {
  const el=document.getElementById('contextText');
  if (!el) return;
  let b=document.getElementById('onlineBadge');
  if (!b) {
    b=document.createElement('div'); b.id='onlineBadge'; b.className='onlineBadge';
    b.innerHTML='<span class="onlineDot"></span><span class="onlineText"></span>';
    el.parentNode.appendChild(b);
  }
  b.querySelector('.onlineDot').className='onlineDot '+(ok?'ok':'err');
  b.querySelector('.onlineText').textContent=ok?'онлайн':'нет связи';
}
async function shStart() {
  try {
    if (Array.isArray(jobs)) jobs.splice(0,jobs.length);
    if (Array.isArray(deckIds)) deckIds.splice(0,deckIds.length);
    deckIndex=0;
  } catch (_) {}
  try {
    await shEnsureAuth();
    shOnlineReady=true;
    shSetOnlineBadge(true);
    if (state.registered && state.role) await shUpsertProfile();
    await shRefreshAll(true);
    shSubscribe();
    shLog('ready',shUser.id);
  } catch(e) {
    shOnlineReady=false; shSetOnlineBadge(false); shError('start · Netlify proxy · resilient · resilient',e);
  }
}


// Telegram iOS WebView can occasionally throw TypeError: Load failed on fetch POSTs.
// For application creation we first try supabase-js, then fall back to XMLHttpRequest.
// The fallback still uses the current user's JWT, so the same Supabase RLS policies apply.
function shRestErrorFromResponse(status, raw) {
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (_) {}
  const err = new Error(
    (body && (body.message || body.error_description || body.error)) ||
    ('HTTP ' + status)
  );
  err.code = body && body.code ? String(body.code) : String(status || 'XHR');
  err.details = body && body.details ? String(body.details) : '';
  err.hint = body && body.hint ? String(body.hint) : '';
  err.httpStatus = status;
  return err;
}

async function shCurrentAccessToken() {
  const { data, error } = await shDb.auth.getSession();
  if (error) throw error;
  const token = data && data.session && data.session.access_token;
  if (!token) {
    const e = new Error('Нет активной авторизации пользователя');
    e.code = 'NO_SESSION';
    throw e;
  }
  return token;
}

function shXhrJson(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, SH_SUPABASE_URL + '/rest/v1/' + path, true);
    xhr.timeout = 15000;
    xhr.setRequestHeader('apikey', SH_SUPABASE_KEY);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Prefer', 'return=minimal');

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, status: xhr.status });
      } else {
        reject(shRestErrorFromResponse(xhr.status, xhr.responseText));
      }
    };
    xhr.onerror = () => {
      const e = new Error('XHR network error');
      e.code = 'XHR_NETWORK';
      reject(e);
    };
    xhr.ontimeout = () => {
      const e = new Error('XHR timeout');
      e.code = 'XHR_TIMEOUT';
      reject(e);
    };
    xhr.onabort = () => {
      const e = new Error('XHR aborted');
      e.code = 'XHR_ABORTED';
      reject(e);
    };

    try {
      xhr.send(body == null ? null : JSON.stringify(body));
    } catch (e) {
      reject(e);
    }
  });
}

function shIsNetworkFetchError(e) {
  const msg = String((e && e.message) || e || '').toLowerCase();
  return (
    e instanceof TypeError ||
    msg.includes('load failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('network')
  );
}

async function shInsertApplicationResilient(payload) {
  let sdkNetworkError = null;

  try {
    const { error } = await shDb.from('applications').insert(payload);
    if (!error) return { method: 'supabase-js' };

    // A real PostgREST/database error should not be hidden by a network fallback.
    if (error.code === '23505') return { method: 'duplicate', duplicate: true };
    throw error;
  } catch (e) {
    if (!shIsNetworkFetchError(e)) throw e;
    sdkNetworkError = e;
    shLog('applications insert fetch failed; switching to XHR fallback', e);
  }

  try {
    const token = await shCurrentAccessToken();
    await shXhrJson('POST', 'applications', payload, token);
    return { method: 'xhr-fallback' };
  } catch (xhrError) {
    if (xhrError && String(xhrError.code) === '23505') {
      return { method: 'duplicate-xhr', duplicate: true };
    }
    const combined = new Error(
      'Основной запрос: ' +
      String((sdkNetworkError && sdkNetworkError.message) || sdkNetworkError || 'Load failed') +
      '; резервный запрос: ' +
      String((xhrError && xhrError.message) || xhrError || 'ошибка XHR')
    );
    combined.code = (xhrError && xhrError.code) ? String(xhrError.code) : 'TELEGRAM_NETWORK';
    combined.details = 'Supabase fetch не прошёл, затем не прошёл XHR fallback.';
    throw combined;
  }
}


// ---- Capture V4 functions and replace only the parts that must be live. ----
const shV4FinishRegistration = finishRegistration;
finishRegistration = function() {
  const role=state.pendingRole||'worker';
  const companyValue=document.getElementById('regCompany')?document.getElementById('regCompany').value.trim():'';
  shV4FinishRegistration();
  // Company is optional; do not silently replace it with the person's name.
  if (role==='contractor' && !companyValue) {
    state.contractorProfile.company='';
    saveState();
  }
  (async()=>{
    try { if (!shUser) await shEnsureAuth(); await shUpsertProfile(); await shRefreshAll(true); toast('Профиль сохранён онлайн'); }
    catch(e) { shError('profile',e); }
  })();
};

const shV4ContractorCompletion=contractorCompletion;
contractorCompletion=function(p) {
  // Optional: company and bio. Required for 100%: name, city, phone, avatar.
  const fields=[p.name,p.city,p.phone,p.avatar];
  return Math.round(fields.filter(Boolean).length/fields.length*100);
};

const shV4RenderWorkerHome=renderWorkerHome;
renderWorkerHome=function() {
  shV4RenderWorkerHome();
  const list=document.getElementById('workerHomeJobs');
  if (list && !jobs.length) list.innerHTML='<div class="emptyStateCard"><div class="icon">⌕</div><h3>Открытых смен пока нет</h3><p>Как только подрядчик опубликует смену, она появится здесь автоматически.</p><button class="btn secondary full section" onclick="shRefreshAll(true)">Обновить</button></div>';
};

publishShift = async function() {
  if (!shOnlineReady) { toast('Подключаемся к серверу…'); await shStart(); if(!shOnlineReady)return; }
  try {
    await shUpsertProfile();
    const req=activeValues('#reqChips');
    const title=$('csTitle').value.trim(), pay=Number($('csPay').value||0), needed=Number($('csPeople').value||1);
    const city=$('csCity').value.trim()||'Москва', address=$('csAddress').value.trim(), desc=$('csDesc').value.trim();
    const workDate=$('csDate').value || new Date(Date.now()+86400000).toISOString().slice(0,10);
    const rawTime=$('csTime').value.trim()||'09:00–18:00';
    const parts=rawTime.split(/[–—-]/).map(x=>x.trim());
    const row={
      contractor_id:shUser.id,title,description:desc||null,city,address:address||null,
      work_date:workDate,start_time:(parts[0]||'09:00').slice(0,5),end_time:(parts[1]||'18:00').slice(0,5),
      pay_amount:pay,people_needed:needed,requirements:req,status:'open',updated_at:new Date().toISOString()
    };
    if (!title||!pay) { toast('Заполните название и оплату'); return; }
    if (typeof v4EditingShiftId!=='undefined' && v4EditingShiftId) {
      const id=v4EditingShiftId;
      const {error}=await shDb.from('shifts').update(row).eq('id',id);
      if(error)throw error;
      v4EditingShiftId=null; state.currentShift=id;
      await shRefreshAll(false); saveState(); toast('Смена обновлена онлайн'); go('shiftManage');
    } else {
      const {data,error}=await shDb.from('shifts').insert(row).select().single();
      if(error)throw error;
      state.currentShift=data.id; saveState();
      await shRefreshAll(false); toast('Смена опубликована онлайн'); go('shiftManage');
    }
  } catch(e) { shError('publish shift',e); }
};

createNewShiftFromForm = async function(data) {
  // Compatibility path if older V4 code calls this function.
  $('csTitle').value=data.title||''; $('csPay').value=data.pay||''; $('csPeople').value=data.needed||1;
  $('csCity').value=data.city||'Москва'; $('csAddress').value=data.address||''; $('csTime').value=data.time||'09:00–18:00';
  $('csDesc').value=data.desc||'';
  await publishShift();
};

deleteShift = function(id) {
  const s=state.createdShifts.find(x=>x.id===id);
  if(!s)return;
  openConfirm('Удалить смену?','Смена будет отменена для всех пользователей. Уже откликнувшиеся увидят, что она больше не активна.',async()=>{
    const {error}=await shDb.from('shifts').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',id);
    if(error){shError('delete shift',error);return}
    state.currentShift=null; await shRefreshAll(true); toast('Смена отменена');
    go('contractorShifts');
  });
};

const shV4ActCard=actCard;
actCard = async function(type) {
  const j=currentJob(); if(!j)return;
  if(type==='skip') { shV4ActCard(type); return; }

  if(!shIsUuid(j.id)) {
    jobs.splice(0,jobs.length);
    deckIds=[];
    deckIndex=0;
    renderDeck();
    toast('Обновляю реальные смены…');
    await shRefreshAll(true);
    return;
  }
  if(!shOnlineReady) { toast('Нет соединения с сервером'); return; }
  if(shApplicationBusy) return;

  shApplicationBusy=true;
  const card=$('jobCard');
  if(card) card.classList.add('isSending');

  try {
    // Profile is already synchronized at registration/startup.
    // Do not add a second blocking POST before the actual application.
    const result=await shInsertApplicationResilient({
      shift_id:j.id,
      worker_id:shUser.id,
      status:'pending'
    });

    lastAction={type:'accept',jobId:j.id,index:deckIndex,similarBase:j.id};
    toast(result.duplicate?'Вы уже откликались на эту смену':'Отклик отправлен онлайн');

    if(card) card.classList.add('outRight');

    // Optimistic UI: do not hold the card half-swiped while waiting for another network refresh.
    setTimeout(()=>{
      deckIndex++;
      renderDeck();
      shApplicationBusy=false;
      // Refresh in background; the successful application itself is already saved.
      shRefreshAll(false);
    },180);
  } catch(e) {
    shApplicationBusy=false;
    if(card) {
      card.classList.remove('isSending');
      card.classList.remove('outRight');
    }
    shError('application · Telegram fallback',e);
  }
};

undoLast = async function() {
  if(!lastAction)return;
  if(lastAction.type==='accept' && shOnlineReady) {
    const {error}=await shDb.from('applications').delete().eq('shift_id',lastAction.jobId).eq('worker_id',shUser.id);
    if(error){shError('undo',error);return}
  }
  if(lastAction.type==='skip') state.discarded=state.discarded.filter(id=>id!==lastAction.jobId);
  deckIndex=lastAction.index; lastAction=null; saveState();
  await shRefreshAll(false); renderDeck(); toast('Карточка возвращена');
};

cancelApplication = async function(id) {
  if(!shOnlineReady)return;
  const {error}=await shDb.from('applications').delete().eq('shift_id',id).eq('worker_id',shUser.id);
  if(error){shError('cancel application',error);return}
  await shRefreshAll(true); toast('Отклик отменён');
};

const shV4RenderContractorHome=renderContractorHome;
renderContractorHome=function() {
  shV4RenderContractorHome();
  const newCount=(state.onlineApplications||[]).filter(a=>a.status==='pending').length;
  if($('newApplicantCount')) $('newApplicantCount').textContent=newCount;
};

renderApplicants = function() {
  const shift=getCurrentShift();
  const el=$('applicantList');
  if(!shift) { el.innerHTML='<div class="emptyStateCard"><h3>Сначала создайте смену</h3></div>'; return; }
  const rows=(state.onlineApplications||[]).filter(a=>a.shift_id===shift.id);
  if(!rows.length) { el.innerHTML='<div class="emptyStateCard"><div class="icon">◌</div><h3>Новых откликов пока нет</h3><p>Когда исполнитель откликнется на эту смену, он появится здесь автоматически.</p></div>'; return; }
  el.innerHTML=rows.map(a=>{
    const p=shProfiles[a.worker_id]||{}, sk=p.skills||{};
    const name=p.full_name||'Исполнитель', status=a.status;
    const skills=[...(sk.skills||[]),...(sk.licenses||[]).map(x=>'Права '+x)].slice(0,3);
    return `<div class="person">${avatarHTML(name,p.avatar_url||'')}<div class="grow"><h4>${name} ${status==='accepted'?'<span class="badge ok">принят</span>':status==='rejected'?'<span class="badge rejected">отклонён</span>':''}</h4><small>★ ${Number(p.rating||0).toFixed(1)} · ${Number(p.completed_shifts||0)} смен${skills.length?' · '+skills.join(' · '):''}</small><div class="minirow">${status==='pending'?`<button class="mini ok" onclick="selectCandidate('${a.worker_id}');confirmApplicant('accept')">Принять</button><button class="mini no" onclick="selectCandidate('${a.worker_id}');confirmApplicant('reject')">Отклонить</button>`:''}<button class="mini" onclick="selectCandidate('${a.worker_id}');openCandidateChat('${a.worker_id}')">💬 Карточка</button></div></div></div>`;
  }).join('');
};

confirmApplicant = function(action) {
  const workerId=activeCandidate||state.selectedCandidate;
  const shift=getCurrentShift();
  const row=(state.onlineApplications||[]).find(a=>a.worker_id===workerId && (!shift||a.shift_id===shift.id));
  const p=shProfiles[workerId]||{}, name=p.full_name||'Исполнитель';
  if(!row)return;
  const isAccept=action==='accept';
  openConfirm(isAccept?'Принять исполнителя?':'Отклонить исполнителя?',
    isAccept?`После подтверждения ${name} получит доступ к команде и общему чату.`:`${name} увидит статус «Отклонён».`,
    async()=>{
      const {error}=await shDb.from('applications').update({status:isAccept?'accepted':'rejected',updated_at:new Date().toISOString()}).eq('id',row.id);
      if(error){shError('accept applicant',error);return}
      await shRefreshAll(true); toast(isAccept?'Исполнитель принят':'Отклик отклонён');
    });
};

renderCandidateChat = function() {
  const p=shProfiles[state.selectedCandidate]||{}, name=p.full_name||'Исполнитель';
  activeCandidate=state.selectedCandidate;
  if($('candidateName')) $('candidateName').textContent=name;
  if($('candidateChatName')) $('candidateChatName').textContent=name;
  const row=(state.onlineApplications||[]).find(a=>a.worker_id===state.selectedCandidate && a.shift_id===(getCurrentShift()||{}).id);
  $('candidateMessages').innerHTML=`<div class="notice"><b>Карточка отклика</b><p>Личный чат до принятия пока не подключён. После принятия исполнителя откроется общий чат конкретной смены.</p></div>${row&&row.status==='accepted'?'<div class="notice section"><b>Исполнитель принят</b><p>Откройте «Команда → Общий чат».</p></div>':''}`;
};

sendCandidateMessage = function() { toast('После принятия используйте общий чат смены'); };

async function shFetchTeam(shiftId) {
  const shift=shShiftRows.find(r=>r.id===shiftId) || (await shDb.from('shifts').select('*').eq('id',shiftId).single()).data;
  if(!shift)return {shift:null,members:[],contractor:null};
  const {data:members,error}=await shDb.from('shift_members').select('*').eq('shift_id',shiftId);
  if(error)throw error;
  const ids=[shift.contractor_id,...(members||[]).map(m=>m.user_id)];
  const pm=await shFetchProfiles(ids);
  return {shift,members:members||[],contractor:pm[shift.contractor_id]||{},profiles:pm};
}
renderWorkerTeams = function() {
  const ids=(state.confirmed||[]).map(x=>x.jobId);
  const el=$('workerTeamList');
  if(!ids.length) {el.innerHTML='<div class="empty"><div class="icon">👥</div><b>Команда появится после подтверждения на смену</b><div>Пока подрядчик не принял ваш отклик, раздел пуст.</div></div>';return}
  el.innerHTML=ids.map(id=>{const j=jobs.find(x=>x.id===id);return j?`<div class="job"><h3>${j.title}</h3><div class="muted">${j.company} · ${dateLabel(j.offset)} · ${j.time}</div><button class="btn primary section" onclick="openWorkerTeam('${id}')">Открыть команду</button></div>`:''}).join('');
};
renderWorkerTeam = function() {
  const shiftId=state.selectedTeamShift;
  $('workerTeamMembers').innerHTML='<div class="empty">Загружаем команду…</div>';
  (async()=>{
    try{
      const t=await shFetchTeam(shiftId); if(!t.shift)return;
      const j=jobs.find(x=>x.id===shiftId)||shJobFromRow(t.shift,t.contractor);
      $('workerTeamTitle').textContent=j.title;
      $('workerTeamSub').textContent=(t.contractor.company_name||t.contractor.full_name||'Подрядчик')+' · '+dateLabel(j.offset);
      $('workerTeamSummary').innerHTML=`<b>${j.place}</b><div class="muted tiny section">${j.time} · ${fmtMoney(j.pay)}</div><div class="notice section"><b>Вы приняты на смену</b><p>Вам доступна команда и общий чат этой смены.</p></div>`;
      $('workerTeamCount').textContent=(t.members.length+1)+' участников';
      const contractorName=t.contractor.company_name||t.contractor.full_name||'Подрядчик';
      let html=`<div class="person">${avatarHTML(contractorName,t.contractor.avatar_url||'')}<div class="grow"><h4>${contractorName} <span class="badge contractor">подрядчик</span></h4><small>Создатель смены</small></div></div>`;
      html+=t.members.map(m=>{const p=t.profiles[m.user_id]||{},n=p.full_name||'Исполнитель';return `<div class="person">${avatarHTML(n,p.avatar_url||'')}<div class="grow"><h4>${n} <span class="badge ${m.member_role==='senior'?'admin':'worker'}">${m.member_role==='senior'?'старший':'исполнитель'}</span></h4><small>Участник смены</small></div></div>`}).join('');
      $('workerTeamMembers').innerHTML=html;
    }catch(e){shError('team',e)}
  })();
};
renderContractorTeam = function() {
  const shift=getCurrentShift();
  const el=$('contractorTeamBody');
  if(!shift){el.innerHTML='<div class="empty">Смена не выбрана</div>';return}
  el.innerHTML='<div class="empty">Загружаем команду…</div>';
  (async()=>{
    try{
      const t=await shFetchTeam(shift.id), pct=Math.min(100,Math.round((t.members.length)/(shift.needed||1)*100));
      let html=`<div class="card"><div class="progressline"><b>${t.members.length} из ${shift.needed}</b><span class="muted">${shift.title}</span></div><div class="progress"><i style="width:${pct}%"></i></div></div><div class="title"><h2>Участники</h2><span>роли</span></div>`;
      const contractorName=t.contractor.company_name||t.contractor.full_name||state.contractorProfile.name||'Подрядчик';
      html+=`<div class="person">${avatarHTML(contractorName,t.contractor.avatar_url||'')}<div class="grow"><h4>${contractorName} <span class="badge contractor">подрядчик</span></h4><small>Полный доступ</small></div></div>`;
      html+=t.members.map(m=>{const p=t.profiles[m.user_id]||{},n=p.full_name||'Исполнитель';return `<div class="person">${avatarHTML(n,p.avatar_url||'')}<div class="grow"><h4>${n} <span class="badge ${m.member_role==='senior'?'admin':'worker'}">${m.member_role==='senior'?'старший':'исполнитель'}</span></h4><small>Принят на смену</small></div></div>`}).join('');
      html+='<button class="btn primary full section" onclick="go(\'contractorGroupChat\')">Открыть общий чат</button>';
      el.innerHTML=html;
    }catch(e){shError('contractor team',e)}
  })();
};

async function shRenderMessages(containerId,shiftId,myId) {
  const el=$(containerId); if(!shiftId){el.innerHTML='<div class="empty">Смена не выбрана</div>';return}
  const {data,error}=await shDb.from('messages').select('*').eq('shift_id',shiftId).order('created_at',{ascending:true});
  if(error)throw error;
  const pm=await shFetchProfiles((data||[]).map(m=>m.sender_id));
  el.innerHTML=(data||[]).length?(data||[]).map(m=>{
    const p=pm[m.sender_id]||{}, n=p.company_name||p.full_name||'Участник';
    return `<div class="msg ${m.sender_id===myId?'me':''}"><div class="who ${p.role==='contractor'?'contractor':'worker'}">${n}${p.role==='contractor'?' · подрядчик':''}</div>${m.body}</div>`;
  }).join(''):'<div class="empty"><div class="icon">ϟ</div><b>SPEED HELPER</b><div>Напишите первое сообщение этой команде.</div></div>';
  el.scrollTop=el.scrollHeight;
}
renderGroupChat = function() {
  const id=state.selectedTeamShift; const j=jobs.find(x=>x.id===id);
  if($('groupChatTitle')) $('groupChatTitle').textContent='Чат · '+(j?j.title:'смена');
  shRenderMessages('groupChatMessages',id,shUser&&shUser.id).catch(e=>shError('messages',e));
};
sendGroupMessage = async function() {
  const input=$('groupChatInput'),text=input.value.trim(),shiftId=state.selectedTeamShift;
  if(!text||!shiftId)return;
  const {error}=await shDb.from('messages').insert({shift_id:shiftId,sender_id:shUser.id,body:text});
  if(error){shError('send message',error);return}
  input.value=''; renderGroupChat();
};
renderContractorGroupChat = function() {
  const s=getCurrentShift(); const id=s&&s.id;
  shRenderMessages('contractorGroupMessages',id,shUser&&shUser.id).catch(e=>shError('messages',e));
};
sendContractorGroupMessage = async function() {
  const input=$('contractorGroupInput'),text=input.value.trim(),s=getCurrentShift();
  if(!text||!s)return;
  const {error}=await shDb.from('messages').insert({shift_id:s.id,sender_id:shUser.id,body:text});
  if(error){shError('send contractor message',error);return}
  input.value=''; renderContractorGroupChat();
};

// Keep online data fresh whenever the user enters a data-dependent screen.
const shV4Go=go;
go=function(id,push=true) {
  shV4Go(id,push);
  if(shOnlineReady && ['workerHome','workerSearch','deck','workerShifts','workerTeams','workerTeam','contractorHome','contractorShifts','shiftManage','applicants','contractorTeam','groupChat','contractorGroupChat'].includes(id)) {
    shRefreshAll(true);
  }
};

setTimeout(shStart, 0);


document.addEventListener('visibilitychange',()=>{
  if (!document.hidden && shOnlineReady) shRefreshAll(false, true);
});

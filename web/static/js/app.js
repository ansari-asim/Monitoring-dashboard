/* ============================================================
   Monitoring Dashboard — Main App Logic
   ============================================================ */
let currentTab='overview',statusPollTimer=null,overviewRefreshTimer=null;
let adminIdleTimer=null;
const USER_ROLE=(window.USER_ROLE||'user').toLowerCase();

// Pagination state: {key: {page, pageSize, headers, rows}}
const tableState={camera:{page:0,pageSize:10,headers:[],rows:[]},
  hardware:{page:0,pageSize:10,headers:[],rows:[]},
  services:{page:0,pageSize:10,headers:[],rows:[]}};

async function api(url,opts={}){
  try{
    const r=await fetch(url,opts);
    if(r.status===401){window.location='/login';return null;}
    const ct=r.headers.get('content-type')||'';
    if(!ct.includes('application/json')) return null;
    return await r.json();
  }catch(e){console.error('API:',e);return null;}
}
function postApi(url){return api(url,{method:'POST'});}

function toast(msg,type='info'){
  const c=document.getElementById('toast-container'),el=document.createElement('div');
  el.className=`toast ${type}`;el.textContent=msg;c.appendChild(el);setTimeout(()=>el.remove(),3000);
}

function isAdmin(){return USER_ROLE==='admin';}

function forceAdminLogout(){
  window.location='/logout';
}

function resetAdminIdleTimer(){
  if(!isAdmin()) return;
  if(adminIdleTimer) clearTimeout(adminIdleTimer);
  adminIdleTimer=setTimeout(forceAdminLogout, 5 * 60 * 1000);
}

function bindAdminActivityTracking(){
  if(!isAdmin()) return;
  ['mousedown','mousemove','keydown','scroll','touchstart','click'].forEach(evt=>{
    window.addEventListener(evt, resetAdminIdleTimer, {passive:true});
  });
  resetAdminIdleTimer();
}

function applyRoleRestrictions(){
  const adminOnly=document.querySelectorAll('.admin-only');
  adminOnly.forEach(el=>{el.style.display=isAdmin()?'':'none';});
  const userName=document.getElementById('user-name');
  const userRole=document.getElementById('user-role');
  if(userName) userName.textContent=window.USER_NAME||'User';
  if(userRole) userRole.textContent=isAdmin()?'Admin':'User';
}

// ---- Status ----
async function refreshStatus(){
  const d=await api('/api/status');if(!d)return;
  Object.keys(d).forEach(k=>{
    const card=document.getElementById(`card-${k}`);if(!card)return;
    const run=d[k].running;
    card.className=`status-card ${run?'running':'stopped'}`;
    const badge=card.querySelector('.status-badge'),dot=card.querySelector('.pulse-dot');
    if(badge){badge.className=`status-badge ${run?'running':'stopped'}`;badge.querySelector('span:last-child').textContent=run?'Running':'Stopped';}
    if(dot)dot.className=`pulse-dot ${run?'running':'stopped'}`;
  });
}
function startStatusPoll(){refreshStatus();statusPollTimer=setInterval(refreshStatus,5000);}

async function startMonitor(k){const r=await postApi(`/api/start/${k}`);toast(r?.msg||'Started',r?.ok?'success':'info');refreshStatus();}
async function stopMonitor(k){const r=await postApi(`/api/stop/${k}`);toast(r?.msg||'Stopped',r?.ok?'success':'info');refreshStatus();}
async function restartMonitor(k){const r=await postApi(`/api/restart/${k}`);toast(r?.msg||'Restarted',r?.ok?'success':'info');refreshStatus();}
async function startAll(){await postApi('/api/start-all');toast('All monitors started','success');refreshStatus();}
async function stopAll(){await postApi('/api/stop-all');toast('All monitors stopped','success');refreshStatus();}

// ---- Tabs ----
function switchTab(tab){
  if(!isAdmin() && tab.startsWith('config-')) return;
  currentTab=tab;
  document.querySelectorAll('.nav-item[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===`tab-${tab}`));
  if(tab==='overview'){
    loadOverviewData();
    refreshCharts();
    if(!overviewRefreshTimer) overviewRefreshTimer = setInterval(()=>{
      if(currentTab==='overview'){ loadOverviewData(); refreshCharts(); }
    }, 10000);
  } else {
    if(overviewRefreshTimer){ clearInterval(overviewRefreshTimer); overviewRefreshTimer=null; }
  }
  if(tab.startsWith('config-'))loadConfig(tab.replace('config-',''));
}

// ---- Paginated Table ----
function renderPaginatedTable(key){
  const st=tableState[key];
  const wrap=document.getElementById(`table-${key}`);
  if(!st.headers.length||!st.rows.length){
    wrap.innerHTML='<div class="empty-state">No data available</div>';return;
  }
  const total=st.rows.length;
  const maxPage=Math.max(0,Math.ceil(total/st.pageSize)-1);
  st.page=Math.min(st.page,maxPage);
  // Show latest first: reverse rows, then paginate
  const reversed=[...st.rows].reverse();
  const start=st.page*st.pageSize;
  const pageRows=reversed.slice(start,start+st.pageSize);
  const showing=`${start+1}–${Math.min(start+st.pageSize,total)} of ${total}`;

  let h='<div class="table-pagination">';
  h+=`<span class="page-info">Showing <strong>${showing}</strong> (latest first)</span>`;
  h+='<div class="page-btns">';
  h+=`<button class="btn btn-ghost btn-sm" onclick="tablePrev('${key}')" ${st.page===0?'disabled':''}>← Prev 10</button>`;
  h+=`<button class="btn btn-ghost btn-sm" onclick="tableNext('${key}')" ${st.page>=maxPage?'disabled':''}>Next 10 →</button>`;
  h+='</div></div>';
  h+='<div class="table-wrap"><table><thead><tr>';
  st.headers.forEach(c=>{h+=`<th>${esc(c)}</th>`;});
  h+='</tr></thead><tbody>';
  pageRows.forEach(r=>{
    h+='<tr>';r.forEach((c,i)=>{
      let cls='';
      const hdr=st.headers[i]?.toLowerCase()||'';
      if(hdr==='status'){
        if(c==='Connected'||c==='Running')cls=' style="color:#00ff88;font-weight:600"';
        else if(c==='Not Connected'||c==='Stopped')cls=' style="color:#ff4466;font-weight:600"';
        else if(c==='High Latency')cls=' style="color:#ffaa00;font-weight:600"';
      }
      h+=`<td${cls}>${esc(c)}</td>`;
    });h+='</tr>';
  });
  h+='</tbody></table></div>';
  wrap.innerHTML=h;
}

function tablePrev(key){tableState[key].page=Math.max(0,tableState[key].page-1);renderPaginatedTable(key);}
function tableNext(key){tableState[key].page++;renderPaginatedTable(key);}

async function loadOverviewData(){
  for(const k of ['camera','hardware','services']){
    const d=await api(`/api/data/${k}`);
    if(d){
      const s=document.getElementById(`src-${k}`);if(s)s.textContent=d.file||'Not found';
      tableState[k].headers=d.headers||[];
      tableState[k].rows=d.rows||[];
      tableState[k].page=0;
      renderPaginatedTable(k);
    }
  }
}

// ---- Config ----
async function loadConfig(k){
  const d=await api(`/api/config/${k}`);if(!d)return;
  const c=document.getElementById(`config-form-${k}`);if(c)renderConfigForm(k,d,c);
  const raw=document.getElementById(`config-raw-${k}`);if(raw)raw.value=JSON.stringify(d,null,2);
}

function renderConfigForm(k,d,c){
  if(k==='camera')renderCameraForm(d,c);
  else if(k==='hardware')renderHardwareForm(d,c);
  else if(k==='services')renderServicesForm(d,c);
}

// ---- Camera Config ----
function renderCameraForm(cfg,el){
  el.innerHTML='';
  const em=cfg.email_settings||{};
  el.innerHTML+=secTitle('General Settings');
  el.innerHTML+=`<div class="form-grid">
    ${nf('cam-interval','Check Interval (sec)',cfg.check_interval_seconds||60)}
    ${nf('cam-offline','Offline Confirm (sec)',cfg.offline_confirm_seconds||5)}
    ${tf('cam-logdir','Log Directory',cfg.log_directory||'logs')}
    ${nf('cam-latency','Latency Threshold (ms)',cfg.latency_threshold_ms||100)}
    ${cf('cam-csv','Save CSV',cfg.save_csv!==false)}
    ${cf('cam-frame','Save Frame',cfg.save_frame===true)}
  </div>`;
  el.innerHTML+=secTitle('Alert Channels');
  el.innerHTML+=`<div class="form-grid">
    ${cf('cam-email-on','Email Alerts',cfg.email_alerts_enabled===true)}
    ${cf('cam-chat-on','Google Chat Alerts',cfg.google_chat_enabled===true)}
    ${tf('cam-receivers','Email Receivers (comma-sep)',(em.receiver||[]).join(', '))}
    ${tf('cam-subject','Email Subject',em.subject||'Camera Alert Notification')}
  </div>`;
  el.innerHTML+=secTitle('Cameras');
  let h='<div class="list-items" id="cam-list">';
  (cfg.cameras||[]).forEach((c,i)=>{h+=camItem(i,c.name,c.url);});
  h+='</div><button class="btn-add-item" onclick="addCamItem()">+ Add Camera</button>';
  el.innerHTML+=h;
}
function camItem(i,n,u){
  return `<div class="list-item"><input placeholder="Name" value="${ea(n)}" data-field="name">
  <input placeholder="RTSP URL" value="${ea(u)}" data-field="url" style="flex:2">
  <button class="btn-remove" onclick="this.parentElement.remove()">✕</button></div>`;
}
function addCamItem(){const l=document.getElementById('cam-list');l.insertAdjacentHTML('beforeend',camItem(l.children.length,'',''));}

function collectCameraConfig(){
  const cams=[];
  document.querySelectorAll('#cam-list .list-item').forEach(it=>{
    const n=it.querySelector('[data-field="name"]').value.trim(),u=it.querySelector('[data-field="url"]').value.trim();
    if(n||u)cams.push({name:n,url:u});
  });
  const recv=gv('cam-receivers').split(',').map(s=>s.trim()).filter(Boolean);
  return {cameras:cams,check_interval_seconds:gn('cam-interval'),offline_confirm_seconds:gn('cam-offline'),
    log_directory:gv('cam-logdir'),latency_threshold_ms:gn('cam-latency'),save_csv:gc('cam-csv'),save_frame:gc('cam-frame'),
    email_alerts_enabled:gc('cam-email-on'),google_chat_enabled:gc('cam-chat-on'),
    email_settings:{receiver:recv,subject:gv('cam-subject')}};
}

// ---- Hardware Config ----
function renderHardwareForm(cfg,el){
  el.innerHTML='';
  const th=cfg.thresholds||{},fi=cfg.filters||{},em=cfg.email||{};
  el.innerHTML+=secTitle('General');
  el.innerHTML+=`<div class="form-grid">
    ${nf('hw-interval','Interval (sec)',cfg.interval_seconds||30)}
    ${tf('hw-csv','CSV File Path',cfg.csv_file||'')}
    ${nf('hw-cooldown','Alert Cooldown (min)',cfg.alert_cooldown_minutes||1)}
  </div>`;
  el.innerHTML+=secTitle('Thresholds');
  el.innerHTML+=`<div class="form-grid">
    ${nf('hw-cpu','CPU %',th.cpu_percent||80)}
    ${nf('hw-ram','RAM (GB)',th.ram_gb||8)}
    ${nf('hw-gpu','GPU Util %',th.gpu_util_percent||70)}
    ${nf('hw-vram','VRAM (GB)',th.vram_gb||9)}
    ${nf('hw-disk','Disk (GB)',th.disk_gb||180)}
  </div>`;
  el.innerHTML+=secTitle('Alert Channels');
  el.innerHTML+=`<div class="form-grid">
    ${cf('hw-chat-on','Google Chat Enabled',(cfg.google_chat||{}).enabled===true)}
    ${cf('hw-email-on','Email Enabled',em.enabled===true)}
    ${tf('hw-email-to','To Emails (comma-sep)',(em.to_emails||[]).join(', '))}
    ${tf('hw-email-subj','Email Subject',em.subject||'Hardware Alert')}
  </div>`;
  el.innerHTML+=secTitle('Filters');
  el.innerHTML+=`<div class="form-grid">
    ${tf('hw-cpuf','CPU Name Contains',fi.cpu_name_contains||'')}
    ${tf('hw-gpun','GPU Names (comma-sep)',(fi.gpu_names||[]).join(', '))}
  </div>`;
}
function collectHardwareConfig(){
  const te=gv('hw-email-to').split(',').map(s=>s.trim()).filter(Boolean);
  const gn2=gv('hw-gpun').split(',').map(s=>s.trim()).filter(Boolean);
  return {interval_seconds:gn('hw-interval'),csv_file:gv('hw-csv'),alert_cooldown_minutes:gn('hw-cooldown'),
    thresholds:{cpu_percent:gn('hw-cpu'),ram_gb:gn('hw-ram'),gpu_util_percent:gn('hw-gpu'),vram_gb:gn('hw-vram'),disk_gb:gn('hw-disk')},
    google_chat:{enabled:gc('hw-chat-on')},
    email:{enabled:gc('hw-email-on'),to_emails:te,subject:gv('hw-email-subj')},
    filters:{cpu_name_contains:gv('hw-cpuf'),gpu_names:gn2}};
}

// ---- Services Config ----
function renderServicesForm(cfg,el){
  el.innerHTML='';
  const em=cfg.email||{};
  el.innerHTML+=secTitle('General');
  el.innerHTML+=`<div class="form-grid">
    ${nf('svc-interval','Check Interval (sec)',cfg.check_interval_seconds||60)}
    ${tf('svc-state','State File',cfg.state_file||'service_state.json')}
    ${tf('svc-logdir','Log Directory',cfg.log_directory||'logs')}
  </div>`;
  el.innerHTML+=secTitle('Alert Channels');
  el.innerHTML+=`<div class="form-grid">
    ${cf('svc-chat-on','Google Chat Enabled',cfg.google_chat_enabled===true)}
    ${cf('svc-email-on','Email Enabled',em.enabled===true)}
    ${tf('svc-email-to','To Emails (comma-sep)',(em.to_emails||[]).join(', '))}
    ${tf('svc-subdown','Email Subject (Down)',em.subject_down||'Service DOWN Alert')}
    ${tf('svc-subup','Email Subject (Recovered)',em.subject_recovered||'Service RECOVERED Alert')}
    ${tf('svc-bodydown','Body Down Template',em.body_down||'{service_name} is down.')}
    ${tf('svc-bodyup','Body Recovered Template',em.body_recovered||'{service_name} recovered.')}
  </div>`;
  const types=[
    ['Python Scripts','python','python_scripts','process_name'],
    ['.NET Apps','dotnet','dotnet_apps','process_name'],
    ['Linux Services','linux','linux_services','service_name'],
    ['IIS Sites','iis','iis_sites','site_name']
  ];
  types.forEach(([title,type,key,f2])=>{
    el.innerHTML+=secTitle(title);
    let h=`<div class="list-items" id="svc-${type}-list">`;
    (cfg[key]||[]).forEach((s,i)=>{h+=svcItem(type,i,s,f2);});
    h+=`</div><button class="btn-add-item" onclick="addSvcItem('${type}','${f2}')">+ Add</button>`;
    el.innerHTML+=h;
  });
}
function svcItem(type,i,s,f2){
  return `<div class="list-item" data-type="${type}">
    <input placeholder="Name" value="${ea(s.name||'')}" data-field="name">
    <input placeholder="${f2}" value="${ea(s[f2]||'')}" data-field="${f2}" style="flex:2">
    <label style="font-size:.73rem;color:var(--text-secondary);display:flex;align-items:center;gap:.3rem">
      <input type="checkbox" ${s.enabled!==false?'checked':''} data-field="enabled"> On</label>
    <button class="btn-remove" onclick="this.parentElement.remove()">✕</button></div>`;
}
function addSvcItem(type,f2){
  const l=document.getElementById(`svc-${type}-list`);
  l.insertAdjacentHTML('beforeend',svcItem(type,l.children.length,{},f2));
}
function collectServicesConfig(){
  const te=gv('svc-email-to').split(',').map(s=>s.trim()).filter(Boolean);
  function collectList(id,fields){
    const items=[];
    document.querySelectorAll(`#${id} .list-item`).forEach(it=>{
      const o={};fields.forEach(f=>{const inp=it.querySelector(`[data-field="${f}"]`);
        if(inp)o[f]=inp.type==='checkbox'?inp.checked:inp.value.trim();});
      if(o.name)items.push(o);
    });return items;
  }
  return {check_interval_seconds:gn('svc-interval'),state_file:gv('svc-state'),log_directory:gv('svc-logdir'),
    google_chat_enabled:gc('svc-chat-on'),
    python_scripts:collectList('svc-python-list',['name','process_name','enabled']),
    dotnet_apps:collectList('svc-dotnet-list',['name','process_name','enabled']),
    linux_services:collectList('svc-linux-list',['name','service_name','enabled']),
    iis_sites:collectList('svc-iis-list',['name','site_name','enabled']),
    email:{enabled:gc('svc-email-on'),to_emails:te,subject_down:gv('svc-subdown'),
      subject_recovered:gv('svc-subup'),body_down:gv('svc-bodydown'),body_recovered:gv('svc-bodyup')}};
}

// ---- Save config ----
async function saveConfig(k){
  let d;const rawEl=document.getElementById(`config-raw-${k}`),tog=document.getElementById(`raw-toggle-${k}`);
  if(tog&&tog.checked&&rawEl){try{d=JSON.parse(rawEl.value);}catch(e){toast('Invalid JSON: '+e.message,'error');return;}}
  else{if(k==='camera')d=collectCameraConfig();else if(k==='hardware')d=collectHardwareConfig();else if(k==='services')d=collectServicesConfig();}
  const r=await api(`/api/config/${k}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
  if(r?.ok){toast('Config saved','success');if(rawEl)rawEl.value=JSON.stringify(d,null,2);}
  else toast(r?.msg||'Save failed','error');
}
async function saveAndRestart(k){await saveConfig(k);await restartMonitor(k);}

function toggleRawJson(k){
  const form=document.getElementById(`config-form-${k}`),raw=document.getElementById(`config-raw-wrap-${k}`),tog=document.getElementById(`raw-toggle-${k}`);
  if(tog.checked){form.style.display='none';raw.style.display='block';}
  else{form.style.display='block';raw.style.display='none';
    try{renderConfigForm(k,JSON.parse(document.getElementById(`config-raw-${k}`).value),form);}catch(e){}}
}

// ---- Helpers ----
function secTitle(t){return `<div class="config-section-title" style="margin-top:1.2rem">${t}</div>`;}
function tf(id,label,val){return `<div class="form-group"><label for="${id}">${label}</label><input type="text" id="${id}" value="${ea(val)}"></div>`;}
function nf(id,label,val){return `<div class="form-group"><label for="${id}">${label}</label><input type="number" id="${id}" value="${val}" step="any"></div>`;}
function cf(id,label,chk){return `<div class="form-group"><label for="${id}">${label}</label><div class="form-row"><input type="checkbox" id="${id}" ${chk?'checked':''}></div></div>`;}
function gv(id){const e=document.getElementById(id);return e?e.value.trim():'';}
function gn(id){const v=parseFloat(gv(id));return isNaN(v)?0:v;}
function gc(id){const e=document.getElementById(id);return e?e.checked:false;}
function esc(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function ea(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

// ---- Init ----
document.addEventListener('DOMContentLoaded',()=>{
  applyRoleRestrictions();
  if(!isAdmin()){
    document.querySelectorAll('.admin-only').forEach(el=>el.style.display='none');
  }
  bindAdminActivityTracking();
  startStatusPoll();
  switchTab('overview');
});

// ---- UI Enhancements ----
// Global time points (used by charts module)
window.TIME_POINTS = 80; // default mapping (adjusted by setTimeRange)

function setTimeRange(val){
  // Map human ranges to number of points shown in charts
  const map = { '5m': 40, '15m': 80, '1h': 200, '6h': 500, '24h': 1000 };
  window.TIME_POINTS = map[val] || 80;
  // re-render charts immediately
  try{ if(typeof refreshCharts==='function') refreshCharts(); }catch(e){}
}

function downloadPanelCSV(key){
  // key: camera|hardware|services
  if(!key) return;
  const st = tableState[key];
  if(!st || !st.headers || !st.rows) return toast('No data to download','info');
  // construct CSV from current rows (latest first)
  const rows = [...st.rows].reverse();
  const csv = [st.headers.join(',')].concat(rows.map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(','))).join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${key}-data.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('CSV downloaded','success');
}

/* ============================================================
   Charts Module — Grafana-Inspired Visualizations
   ============================================================ */
let hwChart=null,diskGpuChart=null,networkChart=null,camLatChart=null;
let sparkCharts={};
let hwMode='cpu_ram',dgMode='both';
let _hwData=null,_camData=null,_svcData=null;

const COLORS={
  blue:  '#5794f2',
  orange:'#ff9830',
  green: '#73bf69',
  red:   '#f2495c',
  purple:'#b877d9',
  teal:  '#8ab8ff',
  yellow:'#f2c94c'
};
const PALETTES=[COLORS.blue, COLORS.orange, COLORS.green, COLORS.purple, COLORS.teal, COLORS.yellow, COLORS.red];

function hexToRgba(hex,a){
  if(!hex) return 'rgba(255,255,255,0.1)';
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

const CHART_FONT={family:"'Inter',sans-serif"};

function lineOpts(yLabel,y2Label){
  const o={
    responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
    animation:false, // Faster rendering for Grafana feel
    plugins:{
      legend:{position:'bottom', labels:{color:'#ccccdc',font:{...CHART_FONT,size:11},usePointStyle:true,boxWidth:8}},
      tooltip:{
        backgroundColor:'rgba(24,27,31,0.95)', titleColor:'#eeeeee', bodyColor:'#ccccdc', borderColor:'#2c3235', borderWidth:1,
        padding:8, cornerRadius:2, titleFont:{...CHART_FONT,size:12,weight:500}, bodyFont:{...CHART_FONT,size:11},
        displayColors:true, boxPadding:4
      }
    },
    scales:{
      x:{
        ticks:{color:'#8e8e93',font:{...CHART_FONT,size:10},maxTicksLimit:8,maxRotation:0},
        grid:{color:'rgba(255,255,255,0.02)',drawBorder:false}
      },
      y:{
        position:'left', title:{display:!!yLabel,text:yLabel,color:'#8e8e93',font:{...CHART_FONT,size:11}},
        ticks:{color:'#8e8e93',font:{...CHART_FONT,size:10}},
        grid:{color:'rgba(255,255,255,0.04)',drawBorder:false}
      }
    }
  };
  if(y2Label){
    o.scales.y1={
      position:'right', title:{display:true,text:y2Label,color:'#8e8e93',font:{...CHART_FONT,size:11}},
      ticks:{color:'#8e8e93',font:{...CHART_FONT,size:10}}, grid:{drawOnChartArea:false}
    };
  }
  return o;
}

function sparklineOpts(){
  return {
    responsive:true, maintainAspectRatio:false, animation:false,
    plugins:{legend:{display:false},tooltip:{enabled:false}},
    scales:{x:{display:false},y:{display:false}},
    layout:{padding:0}
  };
}

function barOpts(yLabel){
  return {
    responsive:true, maintainAspectRatio:false, animation:false,
    plugins:{
      legend:{display:false},
      tooltip:{
        backgroundColor:'rgba(24,27,31,0.95)', titleColor:'#eeeeee', bodyColor:'#ccccdc', borderColor:'#2c3235', borderWidth:1,
        padding:8, cornerRadius:2, bodyFont:{...CHART_FONT,size:11}
      }
    },
    scales:{
      x:{ticks:{color:'#8e8e93',font:{...CHART_FONT,size:10}},grid:{display:false}},
      y:{
        title:{display:!!yLabel,text:yLabel,color:'#8e8e93',font:{...CHART_FONT,size:11}},
        ticks:{color:'#8e8e93',font:{...CHART_FONT,size:10}},grid:{color:'rgba(255,255,255,0.04)',drawBorder:false}
      }
    }
  };
}

function destroy(c){if(c){c.destroy();}return null;}

function makeLineDS(label,data,colorHex,yAxisID){
  return {
    label, data, borderColor:colorHex, backgroundColor:hexToRgba(colorHex,0.15),
    tension:0, fill:true, pointRadius:0, pointHoverRadius:4,
    borderWidth:1.5, ...(yAxisID?{yAxisID}:{})
  };
}

function updateSparkline(id, data, color) {
  if (sparkCharts[id]) sparkCharts[id].destroy();
  const ctx = document.getElementById(id);
  if (!ctx || !data || data.length === 0) return;
  sparkCharts[id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{
        data, borderColor: color, backgroundColor: hexToRgba(color, 0.2),
        tension: 0, fill: true, pointRadius: 0, borderWidth: 1
      }]
    },
    options: sparklineOpts()
  });
}

function safeStatText(id, value, suffix=''){
  const el=document.getElementById(id);
  if(el) el.textContent = `${value}${suffix}`;
}

function setText(id, value){
  const el=document.getElementById(id);
  if(el) el.textContent=value;
}

function setWidth(id, pct){
  const el=document.getElementById(id);
  if(el) el.style.width=`${Math.max(0,Math.min(100,pct))}%`;
}

function metricValue(value){
  const n=parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function compactHardwareRows(hd, rows){
  const ti=hd.indexOf('time');
  if(ti<0) return [];
  const byTime=new Map();
  rows.forEach(r=>{
    const t=r[ti]||'';
    if(!t) return;
    if(!byTime.has(t)) byTime.set(t, r);
    else {
      const existing=byTime.get(t);
      const gi=hd.indexOf('gpu_util_percent');
      const currentGpu=gi>=0 ? metricValue(r[gi]) : null;
      const existingGpu=gi>=0 ? metricValue(existing[gi]) : null;
      if(currentGpu !== null && (existingGpu === null || currentGpu > existingGpu)) {
        byTime.set(t, r);
      }
    }
  });
  return Array.from(byTime.values());
}

// ---- Hardware Line Chart & Single Stats ----
function buildHwChart(hd,rows){
  hwChart=destroy(hwChart);
  if(!hd||!rows.length)return;
  const ti=hd.indexOf('time'),ci=hd.indexOf('cpu_percent'),ri=hd.indexOf('ram_used_gb'),di=hd.indexOf('disk_used_gb');
  if(ti<0)return;
  
  // Single Stats Update
  if (ci >= 0) {
    const latestCpu = parseFloat(rows[rows.length-1][ci])||0;
    document.getElementById('stat-cpu').textContent = latestCpu + '%';
    const pts = window.TIME_POINTS || 80;
    const cpuArr = rows.slice(-Math.min(pts,60)).map(r => parseFloat(r[ci])||0);
    updateSparkline('spark-cpu', cpuArr, COLORS.blue);
  }
  if (ri >= 0) {
    const latestRam = parseFloat(rows[rows.length-1][ri])||0;
    document.getElementById('stat-ram').textContent = latestRam + ' GB';
    const pts2 = window.TIME_POINTS || 80;
    const ramArr = rows.slice(-Math.min(pts2,60)).map(r => parseFloat(r[ri])||0);
    updateSparkline('spark-ram', ramArr, COLORS.orange);
  }
  if (di >= 0) {
    const latestDisk = parseFloat(rows[rows.length-1][di])||0;
    document.getElementById('stat-disk').textContent = latestDisk + ' GB';
    const pts3 = window.TIME_POINTS || 80;
    const diskArr = rows.slice(-Math.min(pts3,60)).map(r => parseFloat(r[di])||0);
    updateSparkline('spark-disk', diskArr, COLORS.green);
  }
  const ndi = hd.indexOf('net_download_mbps');
  const ui = hd.indexOf('net_upload_mbps');
  if (ndi >= 0) {
    const latestDown = parseFloat(rows[rows.length-1][ndi])||0;
    safeStatText('stat-net-down', latestDown.toFixed(2), ' Mbps');
    const pts4 = window.TIME_POINTS || 80;
    const downArr = rows.slice(-Math.min(pts4,60)).map(r => parseFloat(r[ndi])||0);
    updateSparkline('spark-net-down', downArr, COLORS.teal);
  }
  if (ui >= 0) {
    const latestUp = parseFloat(rows[rows.length-1][ui])||0;
    safeStatText('stat-net-up', latestUp.toFixed(2), ' Mbps');
    const pts5 = window.TIME_POINTS || 80;
    const upArr = rows.slice(-Math.min(pts5,60)).map(r => parseFloat(r[ui])||0);
    updateSparkline('spark-net-up', upArr, COLORS.orange);
  }

  // Chart Update
  const ptsAll = window.TIME_POINTS || 80;
  const last=rows.slice(-ptsAll);
  const labels=last.map(r=>r[ti]||'');
  const ds=[];
  if((hwMode==='cpu_ram'||hwMode==='cpu')&&ci>=0)
    ds.push(makeLineDS('CPU %',last.map(r=>parseFloat(r[ci])||0),COLORS.blue));
  if((hwMode==='cpu_ram'||hwMode==='ram')&&ri>=0)
    ds.push(makeLineDS('RAM (GB)',last.map(r=>parseFloat(r[ri])||0),COLORS.orange,hwMode==='cpu_ram'?'y1':undefined));
  const ctx=document.getElementById('chart-hw-line');
  if(!ctx)return;
  const opts=hwMode==='cpu_ram'?lineOpts('CPU %','RAM (GB)'):lineOpts(hwMode==='cpu'?'CPU %':'RAM (GB)');
  hwChart=new Chart(ctx,{type:'line',data:{labels,datasets:ds},options:opts});
}

// ---- Disk & GPU Chart ----
function buildDiskGpuChart(hd,rows){
  diskGpuChart=destroy(diskGpuChart);
  if(!hd||!rows.length)return;
  const ti=hd.indexOf('time'),di=hd.indexOf('disk_used_gb'),gi=hd.indexOf('gpu_util_percent');
  if(ti<0)return;
  const ptsAll = window.TIME_POINTS || 80;
  const last=compactHardwareRows(hd, rows).slice(-ptsAll);
  const labels=last.map(r=>r[ti]||'');
  const ds=[];
  if((dgMode==='both'||dgMode==='disk')&&di>=0)
    ds.push(makeLineDS('Disk (GB)',last.map(r=>metricValue(r[di]) ?? null),COLORS.green));
  if((dgMode==='both'||dgMode==='gpu')&&gi>=0)
    ds.push(makeLineDS('GPU %',last.map(r=>metricValue(r[gi])),COLORS.purple,dgMode==='both'?'y1':undefined));
  const ctx=document.getElementById('chart-disk-gpu');
  if(!ctx)return;
  const opts=dgMode==='both'?lineOpts('Disk (GB)','GPU %'):lineOpts(dgMode==='disk'?'Disk (GB)':'GPU %');
  if(opts.scales.y1){
    opts.scales.y1.min=0;
    opts.scales.y1.max=100;
  } else if(dgMode==='gpu') {
    opts.scales.y.min=0;
    opts.scales.y.max=100;
  }
  diskGpuChart=new Chart(ctx,{type:'line',data:{labels,datasets:ds},options:opts});
}

function buildNetworkChart(hd, rows){
  networkChart=destroy(networkChart);
  if(!hd||!rows.length)return;
  const ti=hd.indexOf('time'),di=hd.indexOf('net_download_mbps'),ui=hd.indexOf('net_upload_mbps');
  if(ti<0||(di<0&&ui<0))return;
  const ptsAll = window.TIME_POINTS || 80;
  const last=compactHardwareRows(hd, rows).slice(-ptsAll);
  const labels=last.map(r=>r[ti]||'');
  const ds=[];
  if(di>=0) ds.push(makeLineDS('Download Mbps',last.map(r=>metricValue(r[di]) ?? 0),COLORS.teal));
  if(ui>=0) ds.push(makeLineDS('Upload Mbps',last.map(r=>metricValue(r[ui]) ?? 0),COLORS.yellow));
  const ctx=document.getElementById('chart-network');
  if(!ctx)return;
  networkChart=new Chart(ctx,{type:'line',data:{labels,datasets:ds},options:lineOpts('Mbps')});
}

// ---- Camera Latency Bar Chart & Single Stats ----
function buildCamChart(hd,rows){
  camLatChart=destroy(camLatChart);
  if(!hd||!rows.length)return;
  const ni=hd.indexOf('Camera'),li=hd.indexOf('Latency'),si=hd.indexOf('Status');
  if(ni<0||li<0)return;
  const cams={};
  const ptsCam = Math.max(200, (window.TIME_POINTS||80) * 2);
  rows.slice(-ptsCam).forEach(r=>{
    const n=r[ni],v=parseFloat(r[li]);
    if(n&&!isNaN(v)){
      if(!cams[n])cams[n]={vals:[],ok:0,fail:0,latestStatus:r[si]};
      cams[n].vals.push(v);
      if(r[si]==='Connected')cams[n].ok++;else cams[n].fail++;
      cams[n].latestStatus = r[si]; // keep track of latest
    }
  });
  const names=Object.keys(cams);
  if(!names.length)return;
  
  // Single stat update
  let activeCams = 0;
  names.forEach(n => { if (cams[n].latestStatus === 'Connected') activeCams++; });
  document.getElementById('stat-cams').textContent = activeCams;
  document.getElementById('stat-cams-desc').textContent = `${names.length} Total`;

  const avgData=names.map(n=>{const a=cams[n].vals;return Math.round(a.reduce((s,v)=>s+v,0)/a.length);});
  const maxData=names.map(n=>Math.max(...cams[n].vals));
  const ctx=document.getElementById('chart-cam-latency');
  if(!ctx)return;
  camLatChart=new Chart(ctx,{type:'bar',data:{labels:names,datasets:[
    {label:'Avg Latency',data:avgData,backgroundColor:COLORS.blue,borderWidth:0,borderRadius:2,barPercentage:0.6},
    {label:'Max Latency',data:maxData,backgroundColor:hexToRgba(COLORS.blue, 0.3),borderWidth:0,borderRadius:2,barPercentage:0.6}
  ]},options:barOpts('Latency (ms)')});

  buildCamStatusChart(cams);
}

function buildCamStatusChart(cams){
  let ok=0,fail=0;
  Object.values(cams).forEach(c=>{if(c.latestStatus==='Connected')ok++;else fail++;});
  if(ok+fail===0)return;
  const total=ok+fail;
  setText('cam-health-count', `${ok} / ${total}`);
  setText('cam-health-ok-text', ok);
  setText('cam-health-bad-text', fail);
  setWidth('cam-health-ok', (ok/total)*100);
  setWidth('cam-health-bad', (fail/total)*100);
}

// ---- Service Status & Single Stats ----
function buildSvcChart(hd,rows){
  if(!hd||!rows.length)return;
  const si=hd.indexOf('Status'),ni=hd.indexOf('Service');
  if(si<0)return;
  const latest={};
  rows.forEach(r=>{const name=r[ni]||r[1];latest[name]=r[si];});
  let run=0,stop=0;
  Object.values(latest).forEach(s=>{if(s==='Running')run++;else stop++;});
  
  // Single stat update
  document.getElementById('stat-svcs').textContent = run;
  document.getElementById('stat-svcs-desc').textContent = `${run+stop} Total`;

  if(run+stop===0)return;
  const total=run+stop;
  setText('svc-health-count', `${run} / ${total}`);
  setText('svc-health-ok-text', run);
  setText('svc-health-bad-text', stop);
  setWidth('svc-health-ok', (run/total)*100);
  setWidth('svc-health-bad', (stop/total)*100);
}

// ---- Refresh all charts ----
async function refreshCharts(){
  const hw=await api('/api/data/hardware');
  if(hw&&hw.headers){_hwData=hw;buildHwChart(hw.headers,hw.rows);buildDiskGpuChart(hw.headers,hw.rows);buildNetworkChart(hw.headers,hw.rows);}
  const cam=await api('/api/data/camera');
  if(cam&&cam.headers){_camData=cam;buildCamChart(cam.headers,cam.rows);}
  const svc=await api('/api/data/services');
  if(svc&&svc.headers){_svcData=svc;buildSvcChart(svc.headers,svc.rows);}
}

function setHwChartMode(mode,btn){
  hwMode=mode;
  document.querySelectorAll('.cpu-ram-panel .panel-icon-btn').forEach(b=>b.style.color='var(--text-muted)');
  if(btn)btn.style.color='var(--text-title)';
  if(_hwData)buildHwChart(_hwData.headers,_hwData.rows);
}
function setDiskGpuMode(mode,btn){
  dgMode=mode;
  document.querySelectorAll('.disk-gpu-panel .panel-icon-btn').forEach(b=>b.style.color='var(--text-muted)');
  if(btn)btn.style.color='var(--text-title)';
  if(_hwData)buildDiskGpuChart(_hwData.headers,_hwData.rows);
}

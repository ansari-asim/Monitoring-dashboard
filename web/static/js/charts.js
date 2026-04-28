/* ============================================================
   Charts Module — Grafana-Inspired Visualizations
   ============================================================ */
let hwChart=null,diskGpuChart=null,camLatChart=null,camStatusChart=null,svcChart=null;
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

function doughnutOpts(){
  return {
    responsive:true, maintainAspectRatio:false, cutout:'70%', animation:false,
    plugins:{
      legend:{position:'right',labels:{color:'#ccccdc',font:{...CHART_FONT,size:11},usePointStyle:true,boxWidth:8}},
      tooltip:{
        backgroundColor:'rgba(24,27,31,0.95)', titleColor:'#eeeeee', bodyColor:'#ccccdc', borderColor:'#2c3235', borderWidth:1,
        padding:8, cornerRadius:2, bodyFont:{...CHART_FONT,size:11}
      }
    }
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
  const last=rows.slice(-ptsAll);
  const labels=last.map(r=>r[ti]||'');
  const ds=[];
  if((dgMode==='both'||dgMode==='disk')&&di>=0)
    ds.push(makeLineDS('Disk (GB)',last.map(r=>parseFloat(r[di])||0),COLORS.green));
  if((dgMode==='both'||dgMode==='gpu')&&gi>=0)
    ds.push(makeLineDS('GPU %',last.map(r=>parseFloat(r[gi])||0),COLORS.purple,dgMode==='both'?'y1':undefined));
  const ctx=document.getElementById('chart-disk-gpu');
  if(!ctx)return;
  const opts=dgMode==='both'?lineOpts('Disk (GB)','GPU %'):lineOpts(dgMode==='disk'?'Disk (GB)':'GPU %');
  diskGpuChart=new Chart(ctx,{type:'line',data:{labels,datasets:ds},options:opts});
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
  camStatusChart=destroy(camStatusChart);
  let ok=0,fail=0;
  Object.values(cams).forEach(c=>{if(c.latestStatus==='Connected')ok++;else fail++;});
  if(ok+fail===0)return;
  const ctx=document.getElementById('chart-cam-status');
  if(!ctx)return;
  camStatusChart=new Chart(ctx,{type:'doughnut',data:{labels:['Connected','Disconnected'],
    datasets:[{data:[ok,fail],
      backgroundColor:[COLORS.green,COLORS.red],
      borderColor: '#181b1f', borderWidth:2}]},
    options:doughnutOpts()});
}

// ---- Service Status Doughnut & Single Stats ----
function buildSvcChart(hd,rows){
  svcChart=destroy(svcChart);
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
  const ctx=document.getElementById('chart-svc-status');
  if(!ctx)return;
  svcChart=new Chart(ctx,{type:'doughnut',data:{labels:['Running','Stopped'],
    datasets:[{data:[run,stop],
      backgroundColor:[COLORS.green,COLORS.red],
      borderColor:'#181b1f', borderWidth:2}]},
    options:doughnutOpts()});
}

// ---- Refresh all charts ----
async function refreshCharts(){
  const hw=await api('/api/data/hardware');
  if(hw&&hw.headers){_hwData=hw;buildHwChart(hw.headers,hw.rows);buildDiskGpuChart(hw.headers,hw.rows);}
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

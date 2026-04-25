/* ============================================================
   Charts Module — Premium Visualizations
   ============================================================ */
let hwChart=null,diskGpuChart=null,camLatChart=null,camStatusChart=null,svcChart=null;
let hwMode='cpu_ram',dgMode='both';
let _hwData=null,_camData=null,_svcData=null;

const COLORS={
  cyan:'#00d4ff',cyanBg:'rgba(0,212,255,.15)',
  purple:'#a855f7',purpleBg:'rgba(168,85,247,.15)',
  green:'#00ff88',greenBg:'rgba(0,255,136,.15)',
  amber:'#ffaa00',amberBg:'rgba(255,170,0,.15)',
  red:'#ff4466',redBg:'rgba(255,68,102,.15)',
  pink:'#ff88cc',pinkBg:'rgba(255,136,204,.15)',
  blue:'#3b82f6',blueBg:'rgba(59,130,246,.15)',
  teal:'#14b8a6',tealBg:'rgba(20,184,166,.15)',
};
const PALETTES=[
  [COLORS.cyan,COLORS.cyanBg],[COLORS.purple,COLORS.purpleBg],
  [COLORS.green,COLORS.greenBg],[COLORS.amber,COLORS.amberBg],
  [COLORS.red,COLORS.redBg],[COLORS.pink,COLORS.pinkBg],
  [COLORS.blue,COLORS.blueBg],[COLORS.teal,COLORS.tealBg],
];

function makeGradient(ctx,color,alpha1=0.35,alpha2=0.02){
  const g=ctx.createLinearGradient(0,0,0,ctx.canvas.height);
  g.addColorStop(0,color.replace(')',`,${alpha1})`).replace('rgb','rgba'));
  g.addColorStop(1,color.replace(')',`,${alpha2})`).replace('rgb','rgba'));
  return g;
}

function hexToRgba(hex,a){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

const CHART_FONT={family:"'Inter',sans-serif"};

function lineOpts(yLabel,y2Label){
  const o={responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
    animation:{duration:600,easing:'easeOutQuart'},
    plugins:{legend:{labels:{color:'#aaa',font:{...CHART_FONT,size:11},usePointStyle:true,pointStyle:'circle',padding:16}},
      tooltip:{backgroundColor:'rgba(10,10,20,.9)',titleColor:'#e8e8f0',bodyColor:'#bbb',borderColor:'rgba(255,255,255,.1)',borderWidth:1,
        padding:10,cornerRadius:8,titleFont:{...CHART_FONT,size:12,weight:600},bodyFont:{...CHART_FONT,size:11},
        displayColors:true,boxPadding:4}},
    scales:{x:{ticks:{color:'#666',font:{...CHART_FONT,size:10},maxTicksLimit:10,maxRotation:0},
        grid:{color:'rgba(255,255,255,.03)',drawBorder:false}},
      y:{position:'left',title:{display:!!yLabel,text:yLabel,color:'#888',font:{...CHART_FONT,size:11}},
        ticks:{color:'#666',font:{...CHART_FONT,size:10}},grid:{color:'rgba(255,255,255,.04)',drawBorder:false}}}};
  if(y2Label){
    o.scales.y1={position:'right',title:{display:true,text:y2Label,color:'#888',font:{...CHART_FONT,size:11}},
      ticks:{color:'#666',font:{...CHART_FONT,size:10}},grid:{drawOnChartArea:false}};
  }
  return o;
}

function doughnutOpts(){
  return {responsive:true,maintainAspectRatio:false,cutout:'65%',
    animation:{animateRotate:true,duration:800},
    plugins:{legend:{position:'bottom',labels:{color:'#aaa',font:{...CHART_FONT,size:11},usePointStyle:true,pointStyle:'circle',padding:14}},
      tooltip:{backgroundColor:'rgba(10,10,20,.9)',titleColor:'#e8e8f0',bodyColor:'#bbb',borderColor:'rgba(255,255,255,.1)',borderWidth:1,
        padding:10,cornerRadius:8,bodyFont:{...CHART_FONT,size:11}}}};
}

function barOpts(yLabel){
  return {responsive:true,maintainAspectRatio:false,
    animation:{duration:700,easing:'easeOutQuart'},
    plugins:{legend:{labels:{color:'#aaa',font:{...CHART_FONT,size:11},usePointStyle:true,padding:14}},
      tooltip:{backgroundColor:'rgba(10,10,20,.9)',titleColor:'#e8e8f0',bodyColor:'#bbb',borderColor:'rgba(255,255,255,.1)',borderWidth:1,
        padding:10,cornerRadius:8,bodyFont:{...CHART_FONT,size:11}}},
    scales:{x:{ticks:{color:'#666',font:{...CHART_FONT,size:10}},grid:{color:'rgba(255,255,255,.03)',drawBorder:false}},
      y:{title:{display:!!yLabel,text:yLabel,color:'#888',font:{...CHART_FONT,size:11}},
        ticks:{color:'#666',font:{...CHART_FONT,size:10}},grid:{color:'rgba(255,255,255,.04)',drawBorder:false}}}};
}

function destroy(c){if(c){c.destroy();}return null;}

function makeLineDS(label,data,colorIdx,yAxisID){
  const [c]=PALETTES[colorIdx%PALETTES.length];
  return {label,data,borderColor:c,backgroundColor:hexToRgba(c,0.1),
    tension:.4,fill:true,pointRadius:2,pointHoverRadius:5,
    pointBackgroundColor:c,pointBorderColor:'transparent',borderWidth:2,
    ...(yAxisID?{yAxisID}:{})};
}

// ---- Hardware Line Chart ----
function buildHwChart(hd,rows){
  hwChart=destroy(hwChart);
  if(!hd||!rows.length)return;
  const ti=hd.indexOf('time'),ci=hd.indexOf('cpu_percent'),ri=hd.indexOf('ram_used_gb');
  if(ti<0)return;
  const last=rows.slice(-80);
  const labels=last.map(r=>r[ti]||'');
  const ds=[];
  if((hwMode==='cpu_ram'||hwMode==='cpu')&&ci>=0)
    ds.push(makeLineDS('CPU %',last.map(r=>parseFloat(r[ci])||0),0));
  if((hwMode==='cpu_ram'||hwMode==='ram')&&ri>=0)
    ds.push(makeLineDS('RAM (GB)',last.map(r=>parseFloat(r[ri])||0),1,hwMode==='cpu_ram'?'y1':undefined));
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
  const last=rows.slice(-80);
  const labels=last.map(r=>r[ti]||'');
  const ds=[];
  if((dgMode==='both'||dgMode==='disk')&&di>=0)
    ds.push(makeLineDS('Disk (GB)',last.map(r=>parseFloat(r[di])||0),3));
  if((dgMode==='both'||dgMode==='gpu')&&gi>=0)
    ds.push(makeLineDS('GPU %',last.map(r=>parseFloat(r[gi])||0),2,dgMode==='both'?'y1':undefined));
  const ctx=document.getElementById('chart-disk-gpu');
  if(!ctx)return;
  const opts=dgMode==='both'?lineOpts('Disk (GB)','GPU %'):lineOpts(dgMode==='disk'?'Disk (GB)':'GPU %');
  diskGpuChart=new Chart(ctx,{type:'line',data:{labels,datasets:ds},options:opts});
}

// ---- Camera Latency Bar Chart ----
function buildCamChart(hd,rows){
  camLatChart=destroy(camLatChart);
  if(!hd||!rows.length)return;
  const ni=hd.indexOf('Camera'),li=hd.indexOf('Latency'),si=hd.indexOf('Status');
  if(ni<0||li<0)return;
  const cams={};
  rows.slice(-200).forEach(r=>{
    const n=r[ni],v=parseFloat(r[li]);
    if(n&&!isNaN(v)){if(!cams[n])cams[n]={vals:[],ok:0,fail:0};cams[n].vals.push(v);
      if(r[si]==='Connected')cams[n].ok++;else cams[n].fail++;}
  });
  const names=Object.keys(cams);
  if(!names.length)return;
  const avgData=names.map(n=>{const a=cams[n].vals;return Math.round(a.reduce((s,v)=>s+v,0)/a.length);});
  const maxData=names.map(n=>Math.max(...cams[n].vals));
  const ctx=document.getElementById('chart-cam-latency');
  if(!ctx)return;
  camLatChart=new Chart(ctx,{type:'bar',data:{labels:names,datasets:[
    {label:'Avg Latency (ms)',data:avgData,backgroundColor:names.map((_,i)=>hexToRgba(PALETTES[i%PALETTES.length][0],0.7)),
      borderColor:names.map((_,i)=>PALETTES[i%PALETTES.length][0]),borderWidth:1,borderRadius:6,barPercentage:0.6},
    {label:'Max Latency (ms)',data:maxData,backgroundColor:names.map((_,i)=>hexToRgba(PALETTES[i%PALETTES.length][0],0.25)),
      borderColor:names.map((_,i)=>hexToRgba(PALETTES[i%PALETTES.length][0],0.5)),borderWidth:1,borderRadius:6,barPercentage:0.6}
  ]},options:barOpts('Latency (ms)')});

  // Also build status doughnut
  buildCamStatusChart(cams);
}

function buildCamStatusChart(cams){
  camStatusChart=destroy(camStatusChart);
  let ok=0,fail=0;
  Object.values(cams).forEach(c=>{ok+=c.ok;fail+=c.fail;});
  if(ok+fail===0)return;
  const ctx=document.getElementById('chart-cam-status');
  if(!ctx)return;
  camStatusChart=new Chart(ctx,{type:'doughnut',data:{labels:['Connected','Disconnected'],
    datasets:[{data:[ok,fail],
      backgroundColor:[hexToRgba(COLORS.green,0.75),hexToRgba(COLORS.red,0.75)],
      borderColor:[COLORS.green,COLORS.red],borderWidth:2,hoverOffset:8}]},
    options:doughnutOpts()});
}

// ---- Service Status Doughnut ----
function buildSvcChart(hd,rows){
  svcChart=destroy(svcChart);
  if(!hd||!rows.length)return;
  const si=hd.indexOf('Status'),ni=hd.indexOf('Service');
  if(si<0)return;
  // Get latest status per service
  const latest={};
  rows.forEach(r=>{const name=r[ni]||r[1];latest[name]=r[si];});
  let run=0,stop=0;
  Object.values(latest).forEach(s=>{if(s==='Running')run++;else stop++;});
  if(run+stop===0)return;
  const ctx=document.getElementById('chart-svc-status');
  if(!ctx)return;
  svcChart=new Chart(ctx,{type:'doughnut',data:{labels:['Running','Stopped'],
    datasets:[{data:[run,stop],
      backgroundColor:[hexToRgba(COLORS.green,0.75),hexToRgba(COLORS.red,0.75)],
      borderColor:[COLORS.green,COLORS.red],borderWidth:2,hoverOffset:8}]},
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
  document.querySelectorAll('#hw-chart-controls button').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  if(_hwData)buildHwChart(_hwData.headers,_hwData.rows);
}
function setDiskGpuMode(mode,btn){
  dgMode=mode;
  document.querySelectorAll('#disk-gpu-controls button').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  if(_hwData)buildDiskGpuChart(_hwData.headers,_hwData.rows);
}

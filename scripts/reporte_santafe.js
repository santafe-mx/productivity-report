// v6 severidades fix
import fetch from 'node-fetch';

const GH_TOKEN=process.env.GH_TOKEN,SLACK_BOT_TOKEN=process.env.SLACK_BOT_TOKEN,SLACK_CHANNEL_ID=process.env.SLACK_CHANNEL_ID||'C0B55J8C740',PROJECT_NUMBER=parseInt(process.env.GH_PROJECT_NUMBER||'1'),PROJECT_OWNER=process.env.GH_PROJECT_OWNER||'santafe-mx',PROJECT_OWNER_TYPE=process.env.GH_PROJECT_OWNER_TYPE||'user',REPORT_TITLE=process.env.REPORT_TITLE||'Santa Fe';
const ST={BL:'Backlog',SB:'Sprint Backlog',IP:'In progress',RT:'Ready to test (UAT)',RP:'Ready for production',IR:'In review',DN:'Done'};
const SEV=new Set(['S1-Crítico','S2-Media','S3-Baja (Mejora)','S1','S2','S3']);
function labels(ls=[]){const s=[],e=[],a=[];for(const l of ls){if(SEV.has(l))s.push(l);else if(l.endsWith('PRY'))e.push(l);else a.push(l);}return{sev:s,ent:e,act:a};}
function weekRange(){const n=new Date(),d=n.getDay(),m=new Date(n);m.setDate(n.getDate()-(d===0?6:d-1));m.setHours(0,0,0,0);const s=new Date(m);s.setDate(m.getDate()+6);s.setHours(23,59,59,999);return{m,s};}
function inWeek(sd){if(!sd)return false;const{m,s}=weekRange();const d=new Date(sd);return d>=m&&d<=s;}
function query(ot,cur=null){const ac=cur?`, after:"${cur}"`:'',oq=ot==='org'?`organization(login:"${PROJECT_OWNER}")`:`user(login:"${PROJECT_OWNER}")`;return`{${oq}{projectV2(number:${PROJECT_NUMBER}){id title items(first:100${ac}){pageInfo{hasNextPage endCursor}nodes{id fieldValues(first:20){nodes{...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2SingleSelectField{name}}}...on ProjectV2ItemFieldNumberValue{number field{...on ProjectV2Field{name}}}...on ProjectV2ItemFieldTextValue{text field{...on ProjectV2Field{name}}}...on ProjectV2ItemFieldDateValue{date field{...on ProjectV2Field{name}}}...on ProjectV2ItemFieldIterationValue{title startDate duration field{...on ProjectV2IterationField{name}}}...on ProjectV2ItemFieldUserValue{users(first:5){nodes{login}}field{...on ProjectV2Field{name}}}}}content{...on Issue{title state assignees(first:5){nodes{login}}labels(first:10){nodes{name}}createdAt closedAt}...on DraftIssue{title assignees(first:5){nodes{login}}}}}}}}}`;}
async function gql(q){const r=await fetch('https://api.github.com/graphql',{method:'POST',headers:{'Authorization':`bearer ${GH_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(j.errors[0]?.message);if(!j.data)throw new Error('Sin datos GitHub');return j.data;}
async function fetchAll(){let all=[],cur=null,next=true,title='';while(next){const d=await gql(query(PROJECT_OWNER_TYPE,cur));const o=d.organization||d.user;const p=o?.projectV2;if(!p)throw new Error('Project no encontrado');title=p.title;const pg=p.items;all=all.concat(pg.nodes);next=pg.pageInfo.hasNextPage;cur=pg.pageInfo.endCursor;console.log(`  -> ${all.length} items`);}return{items:all,title};}
function parse(node){const f={};for(const fv of node.fieldValues?.nodes||[]){const n=fv.field?.name;if(!n)continue;if(fv.name!==undefined)f[n]=fv.name;if(fv.number!==undefined)f[n]=fv.number;if(fv.text!==undefined)f[n]=fv.text;if(fv.date!==undefined)f[n]=fv.date;if(fv.title!==undefined)f[n]=fv.title;if(fv.startDate!==undefined)f[`${n}__s`]=fv.startDate;if(fv.users!==undefined)f[n]=fv.users.nodes.map(u=>u.login).join(', ');}const c=node.content||{};const asg=c.assignees?.nodes?.map(a=>a.login)||[];const rl=c.labels?.nodes?.map(l=>l.name)||[];const{sev,ent,act}=labels(rl);return{status:f['Status']||'?',hrs:Number(f['Estimate (hrs)']||f['Estimate']||0),isd:f['Iteración__s']||f['Iteration__s']||null,ref:f['Reported Date']||c.createdAt||null,asg:asg.length?asg:['Sin asignar'],sev,act:act.length?act:['Sin tipo']};}
function analyze(raw){const now=new Date(),start=new Date(`${now.getFullYear()}-01-01`);const items=raw.map(parse).filter(i=>{const d=i.ref?new Date(i.ref):null;return!d||d>=start;});const stv=Object.values(ST);function si(list){const m={};for(const s of stv)m[s]={c:0,h:0};m['?']={c:0,h:0};for(const i of list){const k=stv.includes(i.status)?i.status:'?';m[k].c++;m[k].h+=i.hrs;}return m;}function gb(list,key){const m={};for(const i of list){const vs=Array.isArray(i[key])?i[key]:[i[key]];for(const v of vs){if(!m[v])m[v]={c:0,h:0};m[v].c++;m[v].h+=i.hrs;}}return m;}function sc(list){const m={S1:0,S2:0,S3:0};for(const i of list)for(const s of i.sev)if(m[s]!==undefined)m[s]++;return m;}const wi=items.filter(i=>inWeek(i.isd));const wr=weekRange();return{yt:items.length,yh:items.reduce((s,i)=>s+i.hrs,0),ys:si(items),ysev:sc(items),wr,wt:wi.length,wh:wi.reduce((s,i)=>s+i.hrs,0),ws:si(wi),wa:gb(wi,'act'),wasg:gb(wi,'asg'),wsev:sc(wi)};}
function f(c,h){return`*${c}* tareas · *${h}h*`;}
function report(title,s){
const now=new Date();
const ds=now.toLocaleDateString('es-MX',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
const ms=s.wr.m.toLocaleDateString('es-MX',{day:'2-digit',month:'short'});
const ss=s.wr.s.toLocaleDateString('es-MX',{day:'2-digit',month:'short'});
const ys=s.ys,ws=s.ws,sv=s.ysev,svw=s.wsev;
const ar=Object.entries(s.wa).filter(([k])=>k!=='Sin tipo').sort((a,b)=>b[1].h-a[1].h).map(([n,d])=>`  • ${n}: *${d.c}* tareas · *${d.h}h*`).join('\n');
const asr=Object.entries(s.wasg).sort((a,b)=>b[1].h-a[1].h).map(([n,d])=>`  • *${n}*: ${d.c} tareas · ${d.h}h`).join('\n');
const al=[];
if(sv.S1>0)al.push(`🔴 *${sv.S1} S1* en acumulado — atención inmediata.`);
if(svw.S1>0)al.push(`🔴 *${svw.S1} S1 esta semana* — escalar.`);
const dp=s.yt?Math.round((ys[ST.DN].c/s.yt)*100):0;
if(dp<50)al.push(`⚠️ Completitud *${dp}%* — revisar avance.`);
const als=al.length?`*Alertas*\n${al.join('\n')}`:'✅ Sin alertas críticas.';
return[
`📊 *Reporte de Productividad — ${REPORT_TITLE}*`,
`_${ds} · GitHub Project #${PROJECT_NUMBER} · Esfuerzo en horas_`,
`_Proyecto: ${title}_`,
``,
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
`📅 *INDICADORES GLOBALES ${now.getFullYear()} · ${s.yt} tareas · ${s.yh}h*`,
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
`  📋 Backlog:              ${f(ys[ST.BL].c,ys[ST.BL].h)}`,
`  📌 Sprint Backlog:       ${f(ys[ST.SB].c,ys[ST.SB].h)}`,
`  🔄 In Progress:          ${f(ys[ST.IP].c,ys[ST.IP].h)}`,
`  🔍 In Review:            ${f(ys[ST.IR].c,ys[ST.IR].h)}`,
`  🧪 Ready to Test:        ${f(ys[ST.RT].c,ys[ST.RT].h)}`,
`  🚀 Ready for Production: ${f(ys[ST.RP].c,ys[ST.RP].h)}`,
`  ✅ Done:                 ${f(ys[ST.DN].c,ys[ST.DN].h)}`,
`  Severidades año: 🔴 S1:${sv.S1} 🟡 S2:${sv.S2} 🟢 S3:${sv.S3}`,
``,
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
`🗓 *SEMANA CORRIENTE · ${ms}–${ss} · ${s.wt} tareas · ${s.wh}h*`,
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
`  📌 Sprint Backlog:       ${f(ws[ST.SB].c,ws[ST.SB].h)}`,
`  🔄 In Progress:          ${f(ws[ST.IP].c,ws[ST.IP].h)}`,
`  🧪 Ready to Test:        ${f(ws[ST.RT].c,ws[ST.RT].h)}`,
`  🚀 Ready for Production: ${f(ws[ST.RP].c,ws[ST.RP].h)}`,
`  ✅ Done:                 ${f(ws[ST.DN].c,ws[ST.DN].h)}`,
`  Severidades semana: 🔴 S1:${svw.S1} 🟡 S2:${svw.S2} 🟢 S3:${svw.S3}`,
``,
`*Por tipo de actividad — semana*`,
ar||`  Sin actividades esta semana`,
``,
`*Por responsable — semana*`,
asr||`  Sin asignaciones esta semana`,
``,
als,
``,
`_Fuente: GitHub Project #${PROJECT_NUMBER} · ${REPORT_TITLE}_`,
].join('\n');}
async function slack(text){const r=await fetch('https://slack.com/api/chat.postMessage',{method:'POST',headers:{'Authorization':`Bearer ${SLACK_BOT_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({channel:SLACK_CHANNEL_ID,text,mrkdwn:true})});const j=await r.json();if(!j.ok)throw new Error(`Slack:${j.error}`);return j;}
async function main(){console.log(`\n🚀 REPORTE SANTAFE V5 — ${REPORT_TITLE}`);try{const{items,title}=await fetchAll();console.log(`✓ ${items.length} items`);const s=analyze(items);console.log(`✓ Año:${s.yt} Semana:${s.wt}`);await slack(report(title,s));console.log('✅ Enviado.');}catch(e){console.error('❌',e.message);try{await slack(`❌ Error: ${e.message}`);}catch(_){}process.exit(1);}}
main();

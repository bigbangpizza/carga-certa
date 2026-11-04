(function(){
'use strict';
var C=window.CARGA||{};
var MIN=60000, AVG=150*MIN;
var $=function(s){return document.querySelector(s)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
if(!C.SUPABASE_URL||C.SUPABASE_URL.indexOf('COLE')>-1){
  document.body.innerHTML='<div class="wrap"><section class="card" style="margin-top:20px"><h3>Falta configurar</h3><p class="note">Preencha SUPABASE_URL e SUPABASE_ANON_KEY no arquivo config.js. O passo a passo está no README.</p></section></div>';
  return;
}
var BOLT='<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 2 5 13.5h5.5L9.5 22 19 9.8h-5.7z"/></svg>';
function brandHTML(big){
  var cls='logo'+(big?' lg':'')+(C.CONDO_LOGO?' img':'');
  var mark=C.CONDO_LOGO?'<img src="'+esc(C.CONDO_LOGO)+'" alt="">':BOLT;
  return '<div class="brand"><span class="'+cls+'" aria-hidden="true">'+mark+'</span><span class="bn">Carga Certa'+(C.CONDO_NAME?'<small>'+esc(C.CONDO_NAME)+'</small>':'')+'</span></div>';
}
var hdrBrand=document.querySelector('#app .brand');
if(hdrBrand)hdrBrand.outerHTML=brandHTML(false);
var sb=supabase.createClient(C.SUPABASE_URL,C.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});

/* ---------- estado ---------- */
var user=null, me=null, board=null, skew=0, role='morador', tab='pontos', filter='todos';
var residents=[], reports=[], notifs=[], rpt=null, hist=[], pushOn=false, started=false, booting=false;
var loginStep=1, loginEmail='', chan=null, refreshTimer=null, lastRefresh=0;
var now=function(){return Date.now()+skew};
var ts=function(s){return Date.parse(s)};
var fmtT=function(t){return new Date(t).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})};
var fmtD=function(t){var d=new Date(t),n=new Date(now());return (d.toDateString()===n.toDateString()?'Hoje':d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}))+' '+fmtT(t)};
function fmtDur(ms){ms=Math.max(0,ms);var m=Math.floor(ms/MIN);
  if(m>=60)return Math.floor(m/60)+' h '+String(m%60).padStart(2,'0')+' min';
  if(m>=10)return m+' min';
  return m+' min '+String(Math.floor(ms%MIN/1000)).padStart(2,'0')+' s'}
var toastTimer;
function toast(msg){var el=$('#toast');el.textContent=msg;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(function(){el.hidden=true},5000)}
var errMsg=function(e){return (e&&e.message)?e.message:'Algo deu errado. Tente de novo.'};
async function rpc(fn,args){var r=await sb.rpc(fn,args||{});if(r.error)throw r.error;return r.data}
async function call(fn,args,okMsg){try{var d=await rpc(fn,args);await refresh();if(okMsg)toast(okMsg);return {ok:true,data:d}}catch(e){toast(errMsg(e));return {ok:false}}}

/* ---------- acesso aos dados do painel ---------- */
var P=function(){return board?board.points:[]};
var mySession=function(){return P().find(function(p){return p.session&&p.session.profile_id===me.id})};
var inQueue=function(){return board.queue.some(function(q){return q.profile_id===me.id})};
var freeFor=function(){return P().filter(function(p){return !p.off&&!p.session&&(!p.reservation||p.reservation.profile_id===me.id)})};
var anyOn=function(){return P().some(function(p){return !p.off})};
var plate=function(r){return '<span class="plate"><i></i>'+esc(r.plate)+'</span>'};
var waLink=function(phone,name){return '<a class="lnk" href="https://wa.me/55'+String(phone||'').replace(/\D/g,'')+'?text='+encodeURIComponent('Olá, '+String(name||'').split(' ')[0]+', aqui é a administração. Sobre o ponto de recarga do condomínio: pode me retornar, por favor?')+'" target="_blank" rel="noopener">WhatsApp</a>'};
var phoneBlock=function(phone,name){return '<span class="phr"><button class="lnk mono" data-act="copy" data-id="'+esc(phone)+'">'+esc(phone)+'</button>'+waLink(phone,name)+'</span>'};

/* ---------- componentes ---------- */
function cellsHTML(s){
  var st=ts(s.started_at),en=ts(s.ends_at);
  var pr=Math.min(1,Math.max(0,(now()-st)/(en-st))),pc=Math.round(pr*100);
  return '<div class="trk"><div class="fill" style="width:'+pc+'%"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 2 5 13.5h5.5L9.5 22 19 9.8h-5.7z"/></svg></div></div><div class="pct mono">'+pc+'% do tempo de carga</div>';
}
function countText(p){
  var t=now();
  if(p.session){var e=ts(p.session.ends_at);return t<=e?'faltam '+fmtDur(e-t):'passou '+fmtDur(t-e)}
  if(p.reservation)return fmtDur(ts(p.reservation.until)-t);
  return '';
}
function personPanel(r,isMe,admin){
  return '<div class="panel"><div class="pi"><b>'+esc(r.name)+(isMe?'<span class="you">Você</span>':'')+'</b><span>Bl '+esc(r.bloco)+' · '+esc(r.apto)+' · '+esc(r.car)+'</span></div>'+plate(r)
   +(admin&&r.phone?'<div class="ph"><span>Celular</span>'+phoneBlock(r.phone,r.name)+'</div>':'')+'</div>';
}
function pointCard(p,admin){
  var s=p.session,rs=p.reservation,t=now(),pill,cls,main='',act='';
  if(p.off){
    return '<article class="card"><div class="ctop"><h3>Ponto '+p.id+'</h3><span class="pill bad">Fora de serviço</span></div><p class="free">'+esc(p.off_reason||'')+'</p><span class="note">Desde '+fmtT(ts(p.off_since))+'</span>'
      +(admin?'<button class="btn sm primary" data-act="reactivate" data-id="'+p.id+'">Reativar ponto</button>':'')+'</article>';
  }
  if(s){
    var en=ts(s.ends_at),late=t>en,soon=!late&&en-t<=10*MIN;
    cls=late?'bad':soon?'warn':'good';pill=late?'Passou do horário':soon?'Termina em breve':'Carregando';
    main='<div class="big"><div><span class="lbl">Termina às</span><b>'+fmtT(en)+'</b></div><span class="mono cnt'+(late?' bad':'')+'" data-count="'+p.id+'">'+countText(p)+'</span></div>'
      +'<div class="cells'+(late?' late':'')+'" data-cells="'+p.id+'">'+cellsHTML(s)+'</div>'+personPanel(s,s.profile_id===me.id,admin);
    if(s.profile_id===me.id&&!admin)act='<button class="btn primary full" data-act="release" data-id="'+p.id+'">Terminei, liberar ponto</button>';
    else if(admin)act='<button class="btn sm" data-act="force" data-id="'+p.id+'">Liberar ponto</button>';
  }else if(rs){
    cls='warn';pill='Reservado';
    main='<div class="big"><div><span class="lbl">Reservado por</span><b class="mono" data-count="'+p.id+'">'+countText(p)+'</b></div></div>'+personPanel(rs,rs.profile_id===me.id,admin);
    if(rs.profile_id===me.id&&!admin)act='<button class="btn primary full" data-act="start" data-id="'+p.id+'">Assumir ponto</button>';
    else if(admin)act='<button class="btn sm" data-act="force" data-id="'+p.id+'">Liberar reserva</button>';
  }else{
    cls='idle';pill='Livre';main='<p class="free">Disponível agora.</p>';
    if(!admin&&!mySession()&&!inQueue())act='<button class="btn primary full" data-act="start" data-id="'+p.id+'">Iniciar carga</button>';
  }
  return '<article class="card"><div class="ctop"><h3>Ponto '+p.id+'</h3><span class="pill '+cls+'">'+pill+'</span></div>'+main
    +(admin?'<div class="row">'+act+'<button class="btn sm danger" data-act="offOpen" data-id="'+p.id+'">Bloquear ponto</button></div>':act)+'</article>';
}
function noticeBanner(){return board.notice?'<div class="banner warn"><b>Aviso da administração</b><span>'+esc(board.notice.text)+'</span></div>':''}
function bannerHTML(){
  var t=now(),ms=mySession(),rp=P().find(function(p){return p.reservation&&p.reservation.profile_id===me.id});
  if(rp)return '<div class="banner good"><b>Sua vez na fila</b><span>O ponto '+rp.id+' está reservado para você. Assuma antes de acabar o tempo.</span></div>';
  if(ms){var e=ts(ms.session.ends_at);
    if(t>e)return '<div class="banner bad"><b>Seu carro já terminou</b><span>Retire do ponto '+ms.id+' para liberar para o próximo.</span></div>';
    if(e-t<=10*MIN)return '<div class="banner warn"><b>Termina em '+fmtDur(e-t)+'</b><span>Vá retirar o carro do ponto '+ms.id+'. O próximo da fila já foi avisado.</span></div>';
  }
  return '';
}
function isIOS(){return /iphone|ipad|ipod/i.test(navigator.userAgent)}
function standalone(){return window.navigator.standalone===true||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)}
function pushCard(){
  if(pushOn||!('serviceWorker' in navigator)||!C.VAPID_PUBLIC_KEY)return '';
  if(isIOS()&&!standalone())return '<section class="card"><h3 style="font-size:16px;font-weight:800">Ative os avisos no iPhone</h3><ol class="note" style="margin:0;padding-left:20px"><li>Abra este link no Safari</li><li>Toque em Compartilhar e em Adicionar à Tela de Início</li><li>Abra o app pela tela inicial e ative os avisos</li></ol></section>';
  return '<section class="card"><div class="ctop"><div><h3 style="font-size:16px;font-weight:800">Receba avisos no celular</h3><span class="note">Fim da carga, sua vez na fila e recados da administração.</span></div></div><button class="btn primary full" data-act="enablePush">Ativar avisos</button></section>';
}
function estimates(){
  var slots=P().filter(function(p){return !p.off}).map(function(p){return p.session?Math.max(ts(p.session.ends_at),now()):p.reservation?ts(p.reservation.until):now()});
  if(!slots.length)return board.queue.map(function(){return null});
  return board.queue.map(function(){slots.sort(function(a,b){return a-b});var v=slots[0];slots[0]+=AVG;return v});
}
function queueList(admin){
  var est=estimates();
  if(!board.queue.length)return '<p class="note" style="padding:14px 0">Ninguém na fila agora.</p>';
  return board.queue.map(function(q,i){var mine=q.profile_id===me.id&&!admin;
    return '<div class="qrow'+(mine?' me':'')+'"><span class="qn">'+(i+1)+'</span><div class="l"><b>'+esc(q.name)+(mine?'<span class="you">Você</span>':'')+'</b><span class="note">Bl '+esc(q.bloco)+' · '+esc(q.apto)+'</span></div>'
     +(admin?'<button class="btn sm danger" data-act="kick" data-id="'+q.profile_id+'">Remover</button>':'<div class="eta">'+(est[i]?'~'+fmtT(est[i]):'—')+'<small>vaga prevista</small></div>')+'</div>';
  }).join('');
}
var openCount=function(){return reports.filter(function(x){return x.status==='open'}).length};
function openBanner(){var n=openCount();return n?'<div class="banner warn"><b>'+n+(n>1?' problemas abertos':' problema aberto')+'</b><span>Veja os detalhes na aba Problemas.</span></div>':''}
function repItem(x,admin){
  var open=x.status==='open',pr=x.profiles||{},pt=P().find(function(p){return p.id===x.point_id}),cur=admin&&x.tipo==='Carro esquecido no ponto'&&pt?pt.session:null;
  return '<div class="item"><div class="l"><b>Ponto '+x.point_id+' · '+esc(x.tipo)+'</b>'+(x.descricao?'<span class="note">'+esc(x.descricao)+'</span>':'')
   +'<span class="note">'+(admin?esc(pr.name)+' · Bl '+esc(pr.bloco)+' · '+esc(pr.apto)+' · ':'')+fmtD(ts(x.created_at))+'</span>'
   +(admin&&pr.phone?phoneBlock(pr.phone,pr.name):'')
   +(cur&&cur.phone?'<span class="note">No ponto agora: '+esc(cur.name)+'</span>'+phoneBlock(cur.phone,cur.name):'')
   +'</div><div class="r"><span class="pill '+(open?'warn':'good')+'">'+(open?'Aberto':'Resolvido')+'</span>'+(admin&&open?'<button class="btn sm" data-act="resolve" data-id="'+x.id+'">Resolver</button>':'')+'</div></div>';
}
function appUrl(){return location.origin+location.pathname}
function qrSvg(text){try{var q=qrcode(0,'M');q.addData(text);q.make();return q.createSvgTag({cellSize:4,margin:2,scalable:true})}catch(e){return ''}}
function qrSection(){
  return '<h2 class="sh">QR Codes dos pontos</h2><section class="card"><div class="qrs">'+P().map(function(p){
    return '<div class="qrbox"><div class="qrimg">'+qrSvg(appUrl()+'#ponto-'+p.id)+'</div><b>Ponto '+p.id+'</b><button class="btn sm" data-act="scan" data-id="'+p.id+'">Testar leitura</button></div>'}).join('')
   +'</div><button class="btn sm" data-act="exportPdf">Imprimir QR Codes</button><p class="note">Cole um em cada ponto. Quem ler abre o app direto na tela de iniciar carga.</p></section>';
}
function monthLabel(){var m=new Date(now()).toLocaleDateString('pt-BR',{month:'long',year:'numeric'});return m.charAt(0).toUpperCase()+m.slice(1)}

/* ---------- telas ---------- */
function heading(){
  if(role==='morador'){
    if(tab==='pontos')return ['Pontos de recarga','Olá, '+me.name.split(' ')[0]+' · Bl '+me.bloco+' · '+me.apto];
    if(tab==='fila')return ['Fila de espera','Pela ordem de chegada. Ninguém fura.'];
    return ['Reportar problema','Carregador com defeito? Avise a administração.'];
  }
  if(tab==='painel')return ['Painel','Situação em tempo real'];
  if(tab==='moradores')return ['Moradores','Cadastro e acesso aos pontos'];
  if(tab==='problemas')return ['Problemas','Relatos dos moradores'];
  return ['Relatório do mês',monthLabel()];
}
var views={morador:{},sindico:{}};
views.morador.pontos=function(){
  var join='';
  if(!mySession()&&!inQueue()&&freeFor().length===0&&anyOn())join='<button class="btn primary full" data-act="join">Entrar na fila</button>';
  if(!anyOn()&&!mySession())join='<p class="note" style="text-align:center">Todos os pontos estão fora de serviço no momento.</p>';
  if(inQueue())join='<p class="note" style="text-align:center">Você está na fila. Veja sua posição na aba Fila.</p>';
  return '<div class="stack">'+noticeBanner()+bannerHTML()+P().map(function(p){return pointCard(p,false)}).join('')+join+pushCard()+'</div>';
};
views.morador.fila=function(){
  var btn='';
  if(inQueue())btn='<button class="btn full" data-act="leave">Sair da fila</button>';
  else if(!mySession()&&freeFor().length===0&&anyOn())btn='<button class="btn primary full" data-act="join">Entrar na fila</button>';
  return '<div class="stack"><section class="list">'+queueList(false)+'</section>'+btn+'</div>';
};
views.morador.problema=function(){
  var mine=reports.filter(function(x){return x.profile_id===me.id});
  return '<div class="stack"><button class="btn primary full" data-act="report">Reportar problema</button>'
   +(mine.length?'<section class="list">'+mine.map(function(x){return repItem(x,false)}).join('')+'</section>':'<p class="note" style="text-align:center">Você ainda não enviou nenhum relato.</p>')+'</div>';
};
views.sindico.painel=function(){
  return '<div class="stack">'+openBanner()+(board.notice?'<div class="banner warn"><b>Aviso ativo para os moradores</b><span>'+esc(board.notice.text)+'</span><button class="lnk" data-act="noticeEnd">Encerrar aviso</button></div>':'')
   +'<div class="row"><button class="btn sm primary" data-act="noticeOpen">Enviar aviso</button><button class="btn sm danger" data-act="offOpen" data-id="0">Bloquear pontos</button></div>'
   +P().map(function(p){return pointCard(p,true)}).join('')+'</div>'
   +'<h2 class="sh">Fila ('+board.queue.length+')</h2><section class="list">'+queueList(true)+'</section>'
   +'<h2 class="sh">Avisos enviados</h2><section class="list">'+(notifs.length?notifs.map(function(a){return '<div class="item"><div class="l"><span>'+(a.profiles?esc(a.profiles.name.split(' ')[0]):'Todos os moradores')+': '+esc(a.body)+'</span><span class="note mono">'+fmtT(ts(a.created_at))+'</span></div><span class="tag">Push</span></div>'}).join(''):'<p class="note" style="padding:14px 0">Os avisos enviados aparecem aqui.</p>')+'</section>'
   +qrSection();
};
views.sindico.moradores=function(){
  var lbl={approved:['good','Aprovado'],pending:['warn','Pendente'],blocked:['bad','Bloqueado']};
  var list=residents.filter(function(r){return filter==='todos'||(filter==='pendentes'&&r.status==='pending')||(filter==='bloqueados'&&r.status==='blocked')});
  var f=function(k,n){return '<button class="chip" data-act="filter" data-id="'+k+'" aria-pressed="'+(filter===k)+'">'+n+'</button>'};
  return '<div class="bar"><div class="chips" style="margin:0">'+f('todos','Todos')+f('pendentes','Pendentes ('+residents.filter(function(r){return r.status==='pending'}).length+')')+f('bloqueados','Bloqueados')+'</div><button class="btn sm primary" data-act="importOpen">Importar lista</button></div>'
   +'<section class="list" style="margin-top:14px">'+(list.map(function(r){var l=lbl[r.status],a;
     if(r.status==='pending')a='<button class="btn sm primary" data-act="approve" data-id="'+r.id+'">Aprovar</button>';
     else if(r.status==='approved'&&r.id!==me.id)a='<button class="btn sm" data-act="block" data-id="'+r.id+'">Bloquear</button>';
     else if(r.status==='blocked')a='<button class="btn sm" data-act="approve" data-id="'+r.id+'">Liberar</button>';
     else a='';
     return '<div class="item"><div class="l"><b>'+esc(r.name)+'</b><span class="note">Bl '+esc(r.bloco)+' · '+esc(r.apto)+' · <span class="mono">'+esc(r.plate)+'</span></span>'+phoneBlock(r.phone,r.name)+'</div><div class="r"><span class="pill '+l[0]+'">'+l[1]+'</span>'+a+'</div></div>'}).join('')||'<p class="note" style="padding:14px 0">Nenhum morador nesta lista.</p>')+'</section>';
};
views.sindico.problemas=function(){
  return '<div class="stack">'+(reports.length?'<section class="list">'+reports.map(function(x){return repItem(x,true)}).join('')+'</section>':'<p class="note" style="text-align:center">Nenhum problema relatado.</p>')+'</div>';
};
views.sindico.registro=function(){
  if(!rpt)return '<p class="note" style="text-align:center;margin-top:20px">Carregando relatório...</p>';
  var h=rpt.hist,total=rpt.total,max=Math.max.apply(null,h.concat([1])),bw=0,bs=0;
  for(var i=0;i<=21;i++){var w=h[i]+h[i+1]+h[i+2];if(w>bw){bw=w;bs=i}}
  var pct=total?Math.round(bw/total*100):0;
  var bars=h.map(function(v,i){var ht=Math.round(v/max*96),pk=total>0&&i>=bs&&i<bs+3;
    return '<rect class="hb'+(pk?' pk':'')+'" x="'+(i*15+2)+'" y="'+(112-ht)+'" width="11" height="'+Math.max(ht,1)+'" rx="2"/>'+(i%3===0?'<text x="'+(i*15+7.5)+'" y="128" text-anchor="middle">'+i+'h</text>':'')}).join('');
  var stat=function(n,l){return '<div class="stat"><b>'+n+'</b><span>'+l+'</span></div>'};
  var avg=rpt.avg_minutes?Math.floor(rpt.avg_minutes/60)+' h '+String(Math.round(rpt.avg_minutes%60)).padStart(2,'0'):'—';
  return '<div class="stack">'
   +'<section class="card"><div class="stats">'+stat(total,'cargas no mês')+stat(rpt.hours+' h','horas carregadas')+stat(avg,'tempo médio por carga')+stat(rpt.avg_wait?rpt.avg_wait+' min':'—','espera média na fila')+'</div></section>'
   +'<section class="card"><h3 style="font-size:16px;font-weight:800">Horário de maior demanda</h3><svg class="chart" viewBox="0 0 360 134" role="img" aria-label="Cargas por horário de início">'+bars+'</svg>'
   +'<p class="note">Cargas por horário de início. Em verde, a janela de pico.</p>'
   +(total?'<div class="panel"><div class="pi"><b>'+pct+'% das cargas começam entre '+bs+'h e '+(bs+3)+'h</b><span>Se a fila costuma passar de 2 pessoas nesse período, vale avaliar um terceiro ponto.</span></div></div>':'')+'</section>'
   +'<section class="card"><h3 style="font-size:16px;font-weight:800">Quem mais usou</h3><div style="margin:-6px 0">'+(rpt.top.length?rpt.top.map(function(t){return '<div class="item" style="padding:10px 0"><span>'+esc(t.name)+'</span><span class="mono">'+t.count+' cargas</span></div>'}).join(''):'<p class="note" style="padding:10px 0">Sem cargas neste mês ainda.</p>')+'</div></section>'
   +'<section class="card"><div class="item" style="padding:0;border:0"><span>Carros além do horário</span><span class="mono">'+rpt.late+'</span></div><div class="item" style="padding:12px 0 0"><span>Problemas relatados</span><span class="mono">'+(rpt.reports_open+rpt.reports_done)+' · '+rpt.reports_done+' resolvidos</span></div></section>'
   +'<button class="btn primary full" data-act="exportPdf">Exportar PDF para a assembleia</button></div>'
   +'<h2 class="sh">Últimas cargas</h2><section class="list">'+(hist.length?hist.map(function(x){return '<div class="item"><div class="l"><b>'+esc(x.name)+'</b><span class="note">Bl '+esc(x.bloco)+' · '+esc(x.apto)+' · Ponto '+x.point_id+'</span></div><div class="l" style="text-align:right"><span class="mono">'+fmtD(ts(x.started_at))+'</span><span class="note mono">'+fmtDur(ts(x.ended_at)-ts(x.started_at))+'</span></div></div>'}).join(''):'<p class="note" style="padding:14px 0">Nenhuma carga finalizada ainda.</p>')+'</section>';
};
var tabDefs={
  morador:[['pontos','Pontos','<path d="M13.5 2 5 13.5h5.5L9.5 22 19 9.8h-5.7z"/>'],['fila','Fila','<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z"/>'],['problema','Problema','<path d="M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z"/>']],
  sindico:[['painel','Painel','<path d="M3 3h8v8H3zm10 0h8v5h-8zM3 13h8v8H3zm10-3h8v11h-8z"/>'],['moradores','Moradores','<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5z"/>'],['problemas','Problemas','<path d="M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z"/>'],['registro','Relatório','<path d="M4 20V10h4v10zm6 0V4h4v16zm6 0v-7h4v7z"/>']]
};
function render(){
  if(!board)return;
  document.querySelectorAll('.role button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.id===role))});
  $('.role').hidden=me.role!=='sindico';
  var h=heading();$('#ttl').textContent=h[0];$('#sub').textContent=h[1];
  $('#view').innerHTML=views[role][tab]()+'<div class="demo"><span>'+esc(user.email||'')+'</span><button data-act="logout">Sair</button></div>';
  $('#tabs').innerHTML=tabDefs[role].map(function(d){return '<button data-act="tab" data-id="'+d[0]+'"'+(d[0]===tab?' aria-current="page"':'')+'><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'+d[2]+'</svg>'+d[1]+(d[0]==='problemas'&&openCount()?'<span class="badge">'+openCount()+'</span>':'')+'</button>'}).join('');
}
function updateLive(){
  if(!board)return;
  P().forEach(function(p){
    document.querySelectorAll('[data-count="'+p.id+'"]').forEach(function(e){e.textContent=countText(p)});
    document.querySelectorAll('[data-cells="'+p.id+'"]').forEach(function(e){if(p.session)e.innerHTML=cellsHTML(p.session)});
  });
}

/* ---------- dados ---------- */
async function loadReport(){try{rpt=await rpc('monthly_report');hist=await rpc('admin_history',{p_limit:30})}catch(e){toast(errMsg(e))}}
async function refresh(){
  if(!me||me.status!=='approved')return;
  lastRefresh=Date.now();
  try{
    board=await rpc('board');skew=ts(board.now)-Date.now();
    if(me.role==='sindico'){
      var r=await Promise.all([
        sb.from('profiles').select('*').order('name'),
        sb.from('reports').select('*, profiles(name,bloco,apto,phone)').order('created_at',{ascending:false}),
        sb.from('notifications').select('*, profiles(name)').order('created_at',{ascending:false}).limit(8)]);
      residents=r[0].data||[];reports=r[1].data||[];notifs=r[2].data||[];
      if(tab==='registro'&&role==='sindico')await loadReport();
    }else{
      var rp=await sb.from('reports').select('*').eq('profile_id',me.id).order('created_at',{ascending:false});reports=rp.data||[];
    }
    render();
  }catch(e){
    if(/Sem acesso/.test(errMsg(e))){await boot(true)}else{toast('Sem conexão. Tentando de novo...')}
  }
}
function debounceRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,400)}
function subscribe(){
  if(chan)sb.removeChannel(chan);
  chan=sb.channel('carga-certa');
  ['points','sessions','queue','reservations','notices'].forEach(function(t){chan.on('postgres_changes',{event:'*',schema:'public',table:t},debounceRefresh)});
  chan.on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications'},function(p){
    var r=p.new;if(r.profile_id===me.id||(r.profile_id===null&&me.role!=='sindico'))toast(r.body);
    if(me.role==='sindico')debounceRefresh();
  });
  chan.subscribe();
}

/* ---------- acesso, cadastro e espera ---------- */
function showOnly(which){
  $('#auth').hidden=which!=='auth';$('#app').hidden=which!=='app';$('#tabbar').hidden=which!=='app';
}
function authFrame(inner){
  $('#auth').innerHTML='<section class="hero"><div class="top">'+brandHTML(true)+'</div><div><h1>Recarga sem confusão</h1><p>Fila, horário e avisos num só lugar</p></div></section><div class="stack">'+inner+'</div>';
  showOnly('auth');
}
function showLogin(){
  if(loginStep===1){
    authFrame('<section class="card"><h3 style="font-size:18px;font-weight:800">Entrar</h3><label class="f" for="em">Seu e-mail<input id="em" type="email" inputmode="email" autocomplete="email" placeholder="voce@email.com"></label><div class="err" id="err"></div><button class="btn primary full" data-act="sendCode">Receber código</button><p class="note">Enviamos um código de 6 dígitos. Não precisa de senha.</p></section>');
  }else{
    authFrame('<section class="card"><h3 style="font-size:18px;font-weight:800">Digite o código</h3><p class="note">Enviamos para '+esc(loginEmail)+'. Confira também o spam.</p><label class="f" for="cd">Código<input id="cd" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></label><div class="err" id="err"></div><button class="btn primary full" data-act="verify">Entrar</button><button class="btn full" data-act="backLogin">Usar outro e-mail</button></section>');
  }
}
function showRegister(){
  authFrame('<section class="card"><h3 style="font-size:18px;font-weight:800">Seu cadastro</h3><p class="note">A administração confere os dados e libera o acesso.</p>'
   +'<div class="grid2"><label class="f" for="pl" style="grid-column:1/-1">Placa do carro<input id="pl" type="text" autocomplete="off" maxlength="7" style="text-transform:uppercase"><span class="note" id="hint">Se a placa estiver na lista da administração, preenchemos o resto.</span></label>'
   +'<label class="f" for="nm" style="grid-column:1/-1">Nome<input id="nm" type="text" autocomplete="name"></label>'
   +'<label class="f" for="bl">Bloco<input id="bl" type="text" autocomplete="off"></label><label class="f" for="ap">Apartamento<input id="ap" type="text" autocomplete="off"></label>'
   +'<label class="f" for="ph" style="grid-column:1/-1">Celular com DDD<input id="ph" type="text" inputmode="tel" autocomplete="tel" placeholder="(71) 9"></label>'
   +'<label class="f" for="cr" style="grid-column:1/-1">Carro (modelo)<input id="cr" type="text" autocomplete="off"></label></div>'
   +'<div class="err" id="err"></div><button class="btn primary full" data-act="register">Enviar cadastro</button><button class="btn full" data-act="logout">Sair</button></section>');
}
function showWaiting(){
  var blocked=me.status==='blocked';
  authFrame('<section class="card"><h3 style="font-size:18px;font-weight:800">'+(blocked?'Acesso bloqueado':'Cadastro em análise')+'</h3><p class="note">'+(blocked?'Fale com a administração do condomínio para voltar a usar os pontos.':'A administração precisa aprovar sua placa. Você recebe o acesso assim que for liberado.')+'</p><button class="btn primary full" data-act="recheck">Atualizar</button><button class="btn full" data-act="logout">Sair</button></section>');
}
async function boot(force){
  if(booting&&!force)return;booting=true;
  try{
    var s=await sb.auth.getSession();user=s.data.session?s.data.session.user:null;
    if(!user){me=null;board=null;started=false;showLogin();return}
    var pr=await sb.from('profiles').select('*').eq('id',user.id).maybeSingle();
    me=pr.data;
    if(!me){showRegister();return}
    if(me.status!=='approved'){showWaiting();return}
    role=me.role==='sindico'?'sindico':'morador';tab=role==='sindico'?'painel':'pontos';
    showOnly('app');await refresh();
    if(!started){started=true;subscribe();checkPush();route()}
  }catch(e){toast(errMsg(e))}finally{booting=false}
}
async function lookupPlate(){
  var v=$('#pl').value.toUpperCase(),h=$('#hint');if(!h)return;
  if(v.length<7){h.textContent='Se a placa estiver na lista da administração, preenchemos o resto.';return}
  try{
    var r=await rpc('lookup_plate',{p_plate:v});
    if(!r){h.textContent='Placa fora da lista. Preencha os dados à mão.';return}
    if(r.registered){h.textContent='Essa placa já está cadastrada.';return}
    if(!$('#nm').value)$('#nm').value=r.first_name||'';
    $('#bl').value=r.bloco||'';$('#ap').value=r.apto||'';if(r.car)$('#cr').value=r.car;
    h.textContent='Placa encontrada na lista da administração. Complete o nome e informe o celular.';
  }catch(e){h.textContent=errMsg(e)}
}

/* ---------- avisos push ---------- */
function b64(s){var p='='.repeat((4-s.length%4)%4),b=(s+p).replace(/-/g,'+').replace(/_/g,'/'),r=atob(b),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o}
async function checkPush(){
  try{
    if(!('serviceWorker' in navigator)||!('PushManager' in window))return;
    var reg=await navigator.serviceWorker.ready,sub=await reg.pushManager.getSubscription();
    pushOn=!!sub&&Notification.permission==='granted';
    if(pushOn){var j=sub.toJSON();await sb.from('push_subscriptions').upsert({profile_id:me.id,endpoint:j.endpoint,p256dh:j.keys.p256dh,auth:j.keys.auth},{onConflict:'endpoint'})}
    render();
  }catch(e){}
}
async function enablePush(){
  try{
    var perm=await Notification.requestPermission();
    if(perm!=='granted'){toast('Os avisos ficaram desligados. Ative nas configurações do celular.');return}
    var reg=await navigator.serviceWorker.ready;
    var sub=await reg.pushManager.getSubscription()||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(C.VAPID_PUBLIC_KEY)});
    var j=sub.toJSON();
    var r=await sb.from('push_subscriptions').upsert({profile_id:me.id,endpoint:j.endpoint,p256dh:j.keys.p256dh,auth:j.keys.auth},{onConflict:'endpoint'});
    if(r.error)throw r.error;
    pushOn=true;render();toast('Avisos ativados neste celular.');
  }catch(e){toast('Não foi possível ativar os avisos: '+errMsg(e))}
}

/* ---------- janelas ---------- */
function modal(html){var m=$('#modal');m.innerHTML='<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true">'+html+'</div>';m.hidden=false}
function closeModal(){$('#modal').hidden=true;$('#modal').innerHTML=''}
function readDur(){var h=parseInt($('#hh').value||'0',10),m=parseInt($('#mm').value||'0',10);return (isNaN(h)?0:h)*60+(isNaN(m)?0:m)}
function updEnd(){var d=readDur();$('#endT').textContent=d>0?fmtT(now()+d*MIN):'--:--'}
function openStart(pid){
  var opts=freeFor();
  if(!opts.length){toast(anyOn()?'Nenhum ponto livre agora. Entre na fila.':'Os pontos estão fora de serviço.');return}
  var sel=opts.find(function(p){return p.id===pid})||opts[0];
  modal('<h2>Iniciar carga</h2><p class="muted">Digite o tempo estimado que o painel do carro mostra. O app calcula o horário de término.</p>'
   +'<div class="pts">'+P().map(function(p){var ok=opts.indexOf(p)>-1;return '<label class="opt'+(ok?'':' off')+'"><input type="radio" name="pt" value="'+p.id+'"'+(p.id===sel.id?' checked':'')+(ok?'':' disabled')+'><span>Ponto '+p.id+'<small>'+(ok?'Livre':p.off?'Fora de serviço':'Ocupado')+'</small></span></label>'}).join('')+'</div>'
   +'<div class="timein"><label class="f" for="hh">Horas<input id="hh" type="number" inputmode="numeric" min="0" max="12" value="2"></label><label class="f" for="mm">Minutos<input id="mm" type="number" inputmode="numeric" min="0" max="59" value="30"></label></div>'
   +'<div class="presets">'+[[1,0],[2,0],[3,30],[5,48]].map(function(a){return '<button class="chip" data-act="preset" data-h="'+a[0]+'" data-m="'+a[1]+'">'+a[0]+' h '+String(a[1]).padStart(2,'0')+'</button>'}).join('')+'</div>'
   +'<div class="endprev"><span class="note">Termina às</span><b id="endT">--:--</b></div><div class="err" id="err"></div>'
   +'<div class="row"><button class="btn" data-act="close">Cancelar</button><button class="btn primary" data-act="confirmStart">Iniciar carga</button></div>');
  updEnd();
}
function openOff(pid){
  var motivos=['Manutenção programada','Carregador com defeito','Outro motivo'];
  var pre=pid||(P().find(function(p){return !p.off})||{}).id;
  modal('<h2>Bloquear pontos</h2><div class="pts">'+P().map(function(p){return '<label class="opt"><input type="radio" name="os" value="'+p.id+'"'+(p.id===pre?' checked':'')+(p.off?' disabled':'')+'><span>Ponto '+p.id+'<small>'+(p.off?'Já bloqueado':'Em serviço')+'</small></span></label>'}).join('')+'<label class="opt wide"><input type="radio" name="os" value="0"><span>Todos os pontos</span></label></div>'
   +'<div class="opts1">'+motivos.map(function(m,i){return '<label class="opt"><input type="radio" name="om" value="'+m+'"'+(i===0?' checked':'')+'><span>'+m+'</span></label>'}).join('')+'</div>'
   +'<label class="f" for="od">Detalhes (opcional)<input id="od" type="text" maxlength="100" autocomplete="off" placeholder="Ex.: volta amanhã às 12h"></label>'
   +'<label class="chk"><input type="checkbox" id="on" checked>Avisar todos os moradores</label><div class="err" id="err"></div>'
   +'<div class="row"><button class="btn" data-act="close">Cancelar</button><button class="btn primary" data-act="confirmOff">Bloquear</button></div>');
}
function openNotice(){
  modal('<h2>Aviso aos moradores</h2><p class="muted">Todos recebem a mensagem por push.</p>'
   +'<div class="presets">'+['Manutenção hoje das 8h às 12h','Ponto 1 com defeito, técnico avisado','Pontos liberados para uso'].map(function(x){return '<button class="chip" data-act="presetN" data-id="'+esc(x)+'">'+esc(x)+'</button>'}).join('')+'</div>'
   +'<label class="f" for="nt">Mensagem<input id="nt" type="text" maxlength="140" autocomplete="off"></label><div class="err" id="err"></div>'
   +'<div class="row"><button class="btn" data-act="close">Cancelar</button><button class="btn primary" data-act="confirmNotice">Enviar aviso</button></div>');
}
function openReport(){
  var tipos=['Não está carregando','Cabo ou tomada danificado','Disjuntor desarmou','Carro esquecido no ponto','Outro'];
  modal('<h2>Reportar problema</h2><div class="pts">'+P().map(function(p,i){return '<label class="opt"><input type="radio" name="rp" value="'+p.id+'"'+(i===0?' checked':'')+'><span>Ponto '+p.id+'</span></label>'}).join('')+'</div>'
   +'<div class="opts1">'+tipos.map(function(tp,i){return '<label class="opt"><input type="radio" name="rt" value="'+tp+'"'+(i===0?' checked':'')+'><span>'+tp+'</span></label>'}).join('')+'</div>'
   +'<label class="f" for="rd">Detalhes (opcional)<input id="rd" type="text" autocomplete="off" maxlength="140"></label><div class="err" id="err"></div>'
   +'<div class="row"><button class="btn" data-act="close">Cancelar</button><button class="btn primary" data-act="confirmReport">Enviar</button></div>');
}
function parseBase(text){
  var out=[];
  String(text).split(/\r?\n/).forEach(function(line){
    var pm=/\b([A-Za-z]{3}\d[A-Za-z0-9]\d{2})\b/.exec(line);if(!pm)return;
    var bm=/\bbl(?:oco)?\.?\s*0*(\d{1,2})/i.exec(line);if(!bm)return;
    var am=/(?:\bap(?:to|t)?\.?\s*|\/)\s*(\d{2,4})\b/i.exec(line.slice(bm.index+bm[0].length-1));if(!am)return;
    var name=line.slice(0,bm.index).replace(pm[0],'').replace(/[-–;:,.\/]+\s*$/,'').replace(/^[\s\-–;:,.\/]+/,'').replace(/[\s\-–;:,.\/]+$/,'').trim();
    var cm=/;\s*([^;]+)$/.exec(line);
    out.push({plate:pm[1].toUpperCase(),name:name,bloco:bm[1],apto:am[1],car:''});
  });
  return out;
}
function openImport(){
  modal('<h2>Importar lista da administração</h2><p class="muted">Cole as linhas como estão no grupo, por exemplo: TMN7C49 - Maria Souza - Bl 09. Apt 004.</p>'
   +'<label class="f" for="imp">Lista<textarea id="imp" rows="7" placeholder="PLACA - Nome - Bl 00 Apt 000"></textarea></label><div class="note" id="impc">Nenhuma linha reconhecida ainda.</div><div class="err" id="err"></div>'
   +'<div class="row"><button class="btn" data-act="close">Cancelar</button><button class="btn primary" data-act="confirmImport">Importar</button></div>');
}

/* ---------- QR ---------- */
function scanQR(id){
  role=me.role==='sindico'&&role==='sindico'?role:'morador';
  if(me.role!=='sindico'){role='morador'}
  role='morador';tab='pontos';render();scrollTo(0,0);
  var p=P().find(function(x){return x.id===id});if(!p)return;
  if(mySession()){toast('Você já está carregando no ponto '+mySession().id+'.');return}
  if(p.off){toast('O ponto '+id+' está fora de serviço.');return}
  if(freeFor().indexOf(p)<0){toast('O ponto '+id+' está ocupado. Entre na fila.');return}
  openStart(id);
}
function route(){var m=/^#ponto-(\d+)$/.exec(location.hash||'');if(m&&board)scanQR(parseInt(m[1],10))}
window.addEventListener('hashchange',route);

/* ---------- ações ---------- */
var A={
  role:function(id){role=id;tab=id==='morador'?'pontos':'painel';render();if(id==='sindico')refresh()},
  tab:function(id){tab=id;if(id==='registro')rpt=null;render();scrollTo(0,0);if(id==='registro')refresh()},
  start:function(id){openStart(parseInt(id,10))},
  preset:function(id,el){$('#hh').value=el.dataset.h;$('#mm').value=el.dataset.m;updEnd()},
  confirmStart:async function(){
    var d=readDur(),sel=document.querySelector('input[name=pt]:checked');
    if(d<5){$('#err').textContent='Informe pelo menos 5 minutos.';return}
    if(d>720){$('#err').textContent='O tempo máximo é 12 horas.';return}
    if(!sel)return;
    try{await rpc('start_charge',{p_point:parseInt(sel.value,10),p_minutes:d});closeModal();await refresh();toast('Carga iniciada. Você será avisado perto do fim.')}
    catch(e){$('#err').textContent=errMsg(e)}
  },
  release:function(id){call('release_point',{p_point:parseInt(id,10)},'Ponto liberado. Obrigado!')},
  force:function(id){call('force_release',{p_point:parseInt(id,10)})},
  join:function(){call('join_queue',{},'Você entrou na fila.')},
  leave:function(){call('leave_queue')},
  kick:function(id){call('kick_queue',{p_profile:id})},
  approve:function(id){call('set_profile_status',{p_profile:id,p_status:'approved'},'Morador liberado.')},
  block:function(id){call('set_profile_status',{p_profile:id,p_status:'blocked'},'Morador bloqueado.')},
  filter:function(id){filter=id;render()},
  offOpen:function(id){openOff(parseInt(id,10)||0)},
  confirmOff:async function(){
    var sc=parseInt(document.querySelector('input[name=os]:checked').value,10),mo=document.querySelector('input[name=om]:checked').value,d=$('#od').value.trim(),tell=$('#on').checked;
    var ids=P().filter(function(p){return !p.off&&(sc===0||p.id===sc)}).map(function(p){return p.id});
    if(!ids.length){$('#err').textContent='Esse ponto já está bloqueado.';return}
    try{await rpc('set_points_off',{p_points:ids,p_reason:mo+(d?': '+d:''),p_notify:tell});closeModal();await refresh();toast(ids.length>1?'Pontos bloqueados.':'Ponto '+ids[0]+' bloqueado.')}
    catch(e){$('#err').textContent=errMsg(e)}
  },
  reactivate:function(id){call('reactivate_point',{p_point:parseInt(id,10)},'Ponto reativado.')},
  noticeOpen:function(){openNotice()},
  presetN:function(id){$('#nt').value=id},
  confirmNotice:async function(){
    var v=$('#nt').value.trim();if(!v){$('#err').textContent='Escreva a mensagem.';return}
    try{await rpc('post_notice',{p_text:v,p_auto:false});closeModal();await refresh();toast('Aviso enviado aos moradores.')}catch(e){$('#err').textContent=errMsg(e)}
  },
  noticeEnd:function(){call('end_notice',{},'Aviso encerrado.')},
  report:function(){openReport()},
  confirmReport:async function(){
    var pid=parseInt(document.querySelector('input[name=rp]:checked').value,10),tp=document.querySelector('input[name=rt]:checked').value,d=$('#rd').value.trim();
    try{await rpc('create_report',{p_point:pid,p_tipo:tp,p_desc:d});closeModal();await refresh();toast('Relato enviado à administração.')}catch(e){$('#err').textContent=errMsg(e)}
  },
  resolve:function(id){call('resolve_report',{p_id:parseInt(id,10)},'Marcado como resolvido.')},
  scan:function(id){scanQR(parseInt(id,10))},
  exportPdf:function(){window.print()},
  copy:function(id){try{navigator.clipboard.writeText(id).then(function(){toast('Número copiado: '+id)}).catch(function(){toast('Número: '+id)})}catch(e){toast('Número: '+id)}},
  importOpen:function(){openImport()},
  confirmImport:async function(){
    var rows=parseBase($('#imp').value);if(!rows.length){$('#err').textContent='Nenhuma linha reconhecida.';return}
    try{var n=await rpc('import_base',{p_rows:rows});closeModal();toast(n+' veículos na lista da administração.')}catch(e){$('#err').textContent=errMsg(e)}
  },
  enablePush:function(){enablePush()},
  sendCode:async function(){
    var email=$('#em').value.trim().toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){$('#err').textContent='Digite um e-mail válido.';return}
    var r=await sb.auth.signInWithOtp({email:email,options:{shouldCreateUser:true}});
    if(r.error){$('#err').textContent=r.error.message;return}
    loginEmail=email;loginStep=2;showLogin();
  },
  verify:async function(){
    var token=$('#cd').value.trim();
    var r=await sb.auth.verifyOtp({email:loginEmail,token:token,type:'email'});
    if(r.error){$('#err').textContent='Código inválido ou vencido. Peça outro.';return}
    loginStep=1;await boot(true);
  },
  backLogin:function(){loginStep=1;showLogin()},
  register:async function(){
    var v=function(i){return $(i).value.trim()};
    try{
      var st=await rpc('register_profile',{p_name:v('#nm'),p_bloco:v('#bl'),p_apto:v('#ap'),p_phone:v('#ph'),p_plate:v('#pl'),p_car:v('#cr')});
      await boot(true);
    }catch(e){$('#err').textContent=errMsg(e)}
  },
  recheck:function(){boot(true)},
  logout:async function(){await sb.auth.signOut();started=false;board=null;me=null;user=null;loginStep=1;if(chan){sb.removeChannel(chan);chan=null}showLogin()},
  close:function(){closeModal()}
};
document.addEventListener('click',function(e){var el=e.target.closest('[data-act]');if(!el)return;var f=A[el.dataset.act];if(f)f(el.dataset.id,el)});
document.addEventListener('input',function(e){
  var id=e.target.id;
  if(id==='hh'||id==='mm')updEnd();
  if(id==='pl'&&$('#hint')&&$('#nm'))lookupPlate();
  if(id==='imp'){var n=parseBase(e.target.value).length;$('#impc').textContent=n?n+' linhas reconhecidas.':'Nenhuma linha reconhecida ainda.'}
});

/* ---------- início ---------- */
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(function(){});
sb.auth.onAuthStateChange(function(ev){if(ev==='SIGNED_OUT'){showLogin()}});
setInterval(function(){updateLive();if(board&&Date.now()-lastRefresh>15000&&!document.hidden)refresh()},1000);
document.addEventListener('visibilitychange',function(){if(!document.hidden&&board)refresh()});
boot();
})();

const {JSDOM}=require(process.env.JSDOM_PATH||'jsdom');const fs=require('fs');
const html=fs.readFileSync('web/index.html','utf8').replace(/<script src="[^"]*"><\/script>/g,'');
const now=Date.now();
const board=(role)=>({now:new Date(now).toISOString(),notice:null,queue:[{profile_id:'u9',name:'Ana Lima',bloco:'2',apto:'31'}],
 points:[{id:1,off:false,session:{profile_id:'u1',name:'Maria Souza',bloco:'9',apto:'4',car:'BYD Dolphin',plate:'TMN7C49',started_at:new Date(now-3600e3).toISOString(),ends_at:new Date(now+3600e3).toISOString(),phone:role==='sindico'?'(71) 99999-0000':null}},
         {id:2,off:false,session:null,reservation:null}]});
function run(role){return new Promise(res=>{
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://x.github.io/carga/',pretendToBeVisual:true});
 const w=dom.window;w.scrollTo=()=>{};
 const errs=[];w.addEventListener('error',e=>errs.push(e.message));
 const q=(data)=>{const o={data,error:null,then:(f,g)=>Promise.resolve({data,error:null}).then(f,g),select:()=>q(data),order:()=>q(data),limit:()=>q(data),eq:()=>q(data),maybeSingle:()=>q(Array.isArray(data)?data[0]:data),upsert:()=>q(null)};return o};
 const me={id:'u1',name:'Maria Souza',bloco:'9',apto:'4',plate:'TMN7C49',role,status:'approved',phone:'(71) 99999-0000',car:'BYD'};
 w.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session:{user:{id:'u1',email:'m@x.com'}}}}),onAuthStateChange(){},signOut:async()=>{}},
  rpc:async(fn)=>({data:fn==='board'?board(role):fn==='monthly_report'?{total:5,hours:12.5,avg_minutes:90,late:1,hist:Array(24).fill(0).map((_,i)=>i===19?3:0),top:[{name:'Maria',count:3}],avg_wait:4,reports_open:1,reports_done:2}:[],error:null}),
  from:(t)=>q(t==='profiles'?[me]:[]),
  channel:()=>({on(){return this},subscribe(){return this}}),removeChannel(){}})};
 w.qrcode=()=>({addData(){},make(){},createSvgTag:()=>'<svg></svg>'});
 w.eval(fs.readFileSync('web/config.js','utf8').replace(/COLE_[A-Z_]+/g,'https://abc.supabase.co'));
 w.eval(fs.readFileSync('web/app.js','utf8'));
 setTimeout(()=>{
  const out={errs,title:w.document.querySelector('#ttl').textContent,html:w.document.querySelector('#view').innerHTML};
  if(role==='sindico'){w.document.querySelector('[data-act=tab][data-id=registro]').click();setTimeout(()=>{out.rep=w.document.querySelector('#view').innerHTML;res(out)},300)}else res(out);
 },300);
})}
(async()=>{
 const m=await run('morador'),s=await run('sindico');let bad=0;
 const t=(c,n)=>{console.log((c?'ok  ':'FALHA ')+n);if(!c)bad++};
 t(!m.errs.length,'sem erros (morador) '+m.errs);t(m.title==='Pontos de recarga','título morador');
 t(/Maria Souza/.test(m.html)&&/Você/.test(m.html),'sessão própria');t(!/Iniciar carga/.test(m.html),'quem já carrega não vê Iniciar carga');t(/Terminei, liberar/.test(m.html),'botão liberar');t(!/99999-0000/.test(m.html),'telefone oculto ao morador');
 t(!s.errs.length,'sem erros (síndico) '+s.errs);t(/99999-0000/.test(s.html),'telefone visível ao síndico');t(/wa\.me\/5571999990000/.test(s.html),'link wa.me');
 t(/Relatório do mês/.test(s.title)||/cargas no mês/.test(s.rep||''),'relatório mensal');t(/70%|19h|Horário de maior demanda/.test(s.rep||''),'gráfico de horários');
 console.log(bad?bad+' falhas':'tudo ok');process.exit(bad?1:0);
})();

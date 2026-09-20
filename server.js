const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

const HORSES = [
  {id:0,name:'Rosa', color:'#d85c9d', face:{circle:'01',square:'02',triangle:'03'}},
  {id:1,name:'Amarelo', color:'#f4cf12', face:{circle:'04',square:'05',triangle:'06'}},
  {id:2,name:'Azul', color:'#159fd4', face:{circle:'07',square:'08',triangle:'09'}},
  {id:3,name:'Laranja', color:'#f28b05', face:{circle:'10',square:'11',triangle:'12'}},
  {id:4,name:'Verde', color:'#37a936', face:{circle:'13',square:'14',triangle:'15'}}
];
const SYMBOLS=['circle','square','triangle'];
const BET_FILES={
  0:{1:'19',2:'20',3:'21',4:'22',5:'23'},
  1:{1:'24',2:'25',3:'26',4:'27',5:'28'},
  2:{1:'29',2:'30',3:'31',4:'32',5:'33'},
  3:{1:'34',2:'35',3:'36',4:'37',5:'38'}
};

function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function makeDeck(){
  const d=[]; let id=0;
  for(const h of HORSES) for(let n=0;n<12;n++) for(const s of SYMBOLS){ if(n%3===0) d.push({id:id++,horse:h.id,symbol:s}); }
  // Above gives 12 cards per horse, balanced 4 of each symbol.
  return shuffle(d);
}
function actionDeck(){ return shuffle(Array.from({length:15},(_,i)=>({id:i}))); }
function code(){ let c=''; const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for(let i=0;i<4;i++) c+=chars[Math.floor(Math.random()*chars.length)]; return 'PANG-'+c; }
function publicState(room){
  return {
    code:room.code,status:room.status,players:room.players.map(p=>({id:p.id,name:p.name,color:p.color,isBot:p.isBot,actions:p.actions.length,bets:p.bets,score:p.score})),
    current:room.current,rows:room.rows,discardCount:room.discard.length,deckCount:room.deck.length,
    revealed:room.revealed, winner:room.winner, lastEvent:room.lastEvent, pending:room.pending, phase:room.phase,
    turnNumber:room.turnNumber
  };
}
function send(ws,msg){ if(ws && ws.readyState===1) ws.send(JSON.stringify(msg)); }
function broadcast(room){ const st=publicState(room); for(const p of room.players) send(p.ws,{type:'state',state:st,me:p.id,hand:p.actions,bets:p.bets}); }
function log(room,text){ room.lastEvent=text; }
function roomPlayer(room,id){ return room.players.find(p=>p.id===id); }
function broadcastError(room,text){ for(const p of room.players) send(p.ws,{type:'error',message:text}); }

function createRoom(player){
  let c; do{c=code();}while(rooms.has(c));
  const room={code:c,status:'lobby',players:[],deck:[],actionDeck:actionDeck(),discard:[],rows:HORSES.map(h=>({horse:h.id,cards:[],carrots:0,chickens:0})),revealed:[],current:0,winner:null,lastEvent:'Sala criada.',pending:null,turnNumber:0};
  rooms.set(c,room); addPlayer(room,player); return room;
}
function addPlayer(room, p){
  p.id=Math.random().toString(36).slice(2,10); p.color=room.players.length; p.actions=[]; p.bets={1:null,2:null,3:null,4:null,5:null}; p.score=0; room.players.push(p); }
function startGame(room){
  if(room.players.length<2){broadcastError(room,'A partida precisa de pelo menos 2 jogadores.');return;}
  room.status='game'; room.deck=makeDeck(); room.actionDeck=actionDeck(); room.discard=[]; room.rows=HORSES.map(h=>({horse:h.id,cards:[],carrots:0,chickens:0})); room.revealed=[]; room.current=0; room.turnNumber=1; room.phase='race'; room.bonusPairTriggered=false; room.bonusTripleTriggered=false; room.betPlaced=false;
  room.players.forEach(p=>{p.actions=[room.actionDeck.pop()];p.bets={1:null,2:null,3:null,4:null};p.score=0;});
  for(let i=0;i<3;i++){const c=room.deck.pop(); room.rows[c.horse].cards.push(c);}
  log(room,'A corrida começou!'); broadcast(room); botMaybe(room);
}
function accidentCheck(rev){
  if(rev.length<3)return false;
  const s=rev.slice(0,3).map(c=>c.symbol);
  return new Set(s).size===1 || new Set(s).size===3;
}
function resolveBonuses(room, rev){
  const counts={}; rev.forEach(c=>counts[c.horse]=(counts[c.horse]||0)+1);
  const pairs=Object.values(counts).some(n=>n>=2); const triples=Object.values(counts).some(n=>n>=3);
  if(triples){ room.players[room.current].actions.push(room.actionDeck.pop(),room.actionDeck.pop()); log(room,'Bônus: 3 pangarés iguais — +2 Cartas de Ação.'); }
  else if(pairs){ room.pending={type:'pairBonus',playerId:room.players[room.current].id}; room.phase='bonus'; log(room,'Bônus: 2 pangarés iguais — você pode excluir uma carta da pista.'); }
}
function endRaceIfNeeded(room){
  const reached=room.rows.find(r=>r.cards.length>=7); if(!reached)return false;
  room.status='finished';
  const order=[...room.rows].sort((a,b)=>{
    if(b.cards.length!==a.cards.length)return b.cards.length-a.cards.length;
    if(b.carrots!==a.carrots)return b.carrots-a.carrots;
    if(a.chickens!==b.chickens)return a.chickens-b.chickens;
    return a.horse-b.horse;
  });
  order.forEach((r,i)=>r.finalPos=i+1);
  room.players.forEach(p=>{p.score=0; for(let pos=1;pos<=5;pos++){const h=p.bets[pos]; if(h===null)continue; const row=order[pos-1]; if(row && row.horse===h){const points=[0,8,4,2,1,0][pos];p.score+=points;}}});
  const max=Math.max(...room.players.map(p=>p.score)); room.winner=room.players.filter(p=>p.score===max).map(p=>p.id); log(room,'A corrida terminou!'); return true;
}
function finishTurn(room){
  room.revealed=[]; room.pending=null; room.bonusPairTriggered=false; room.bonusTripleTriggered=false; room.betPlaced=false;
  if(endRaceIfNeeded(room)){broadcast(room);return;}
  room.current=(room.current+1)%room.players.length; room.turnNumber++; log(room,`É a vez de ${room.players[room.current].name}.`); broadcast(room); botMaybe(room);
}
function reveal(room,p){
  if(room.status!=='game'||room.players[room.current].id!==p.id||room.phase!=='race'||room.pending){return;}
  if(room.revealed.length>=4){return;}
  const c=room.deck.pop(); if(!c){return;}
  room.revealed.push(c);

  // Bônus: verificar combinações de pangarés revelados.
  const counts={}; room.revealed.forEach(x=>counts[x.horse]=(counts[x.horse]||0)+1);
  const hasTriple=Object.values(counts).some(n=>n>=3);
  const hasPair=Object.values(counts).some(n=>n>=2);

  // Primeiro resolve o bônus de 3 iguais; ele não exige escolha.
  if(hasTriple && !room.bonusTripleTriggered){
    const a1=room.actionDeck.pop(), a2=room.actionDeck.pop();
    if(a1) p.actions.push(a1); if(a2) p.actions.push(a2);
    room.bonusTripleTriggered=true;
    log(room,'Bônus: 3 pangarés iguais — +2 Cartas de Ação.');
  } else if(hasPair && !room.bonusPairTriggered){
    room.pending={type:'pairBonus',playerId:p.id};
    room.phase='bonus';
    log(room,'Bônus: 2 pangarés iguais — você pode excluir uma carta da pista.');
    broadcast(room); return;
  }

  if(accidentCheck(room.revealed)){
    room.revealed=[]; room.pending=null; room.phase='action';
    const a=room.actionDeck.pop(); if(a) p.actions.push(a);
    log(room,'ACIDENTE! As cartas reveladas foram descartadas. +1 Carta de Ação.');
    broadcast(room); return;
  }

  if(room.revealed.length===4){ placeRevealed(room,p); }
  else broadcast(room);
}
function placeRevealed(room,p){ room.revealed.forEach(c=>room.rows[c.horse].cards.push(c)); const n=room.revealed.length; room.revealed=[]; room.pending=null; room.phase='action'; log(room,`${p.name} parou e avançou ${n} carta(s).`); broadcast(room); }
function stop(room,p){ if(room.status!=='game'||room.phase!=='race'||room.players[room.current].id!==p.id||room.pending)return; placeRevealed(room,p); if(room.status==='game') broadcast(room); }
function playAction(room,p,data){
  if(room.status!=='game'||room.phase!=='action'||room.players[room.current].id!==p.id||room.pending||p.actions.length===0)return;
  const idx=Math.max(0,Math.min(p.actions.length-1,Number(data.index))); p.actions.splice(idx,1);
  if(data.kind==='carrot'){room.rows[data.horse].carrots++;log(room,`${p.name} colocou uma Cenoura no pangaré ${HORSES[data.horse].name}.`);finishAction(room,p);}
  else if(data.kind==='chicken'){room.rows[data.horse].chickens++;log(room,`${p.name} colocou uma Galinha no pangaré ${HORSES[data.horse].name}.`);finishAction(room,p);}
  else if(data.kind==='moveBet'){const pos=Number(data.pos), horse=Number(data.horse); if(![1,2,3,4,5].includes(pos)||p.bets[pos]===null||!HORSES[horse]){p.actions.push({id:Date.now()});broadcastError(room,'Escolha uma aposta que você já tenha feito.');return;} p.bets[pos]=horse; log(room,`${p.name} mudou sua aposta de ${pos}º lugar para ${HORSES[horse].name}.`);finishAction(room,p);}
  else if(data.kind==='removeAny'){const horse=Number(data.horse); if(room.rows[horse].cards.length===0){p.actions.push({id:Date.now()});broadcastError(room,'Essa fila não tem carta para retirar.');return;} room.rows[horse].cards.pop(); log(room,`${p.name} removeu uma carta do pangaré ${HORSES[horse].name}.`);finishAction(room,p);}
}
function finishAction(room,p){if(endRaceIfNeeded(room)){broadcast(room);return;} room.phase='bet'; broadcast(room);}
function placeBet(room,p,pos,horse){
  if(room.status!=='game'||room.phase!=='bet'||room.players[room.current].id!==p.id||room.pending)return;
  pos=Number(pos); horse=Number(horse); if(room.betPlaced||![1,2,3,4,5].includes(pos)||!HORSES[horse])return;
  p.bets[pos]=horse; room.betPlaced=true; log(room,`${p.name} apostou ${pos}º lugar no pangaré ${HORSES[horse].name}.`); broadcast(room);
}
function skipAction(room,p){ if(room.status!=='game'||room.phase!=='action'||room.players[room.current].id!==p.id||room.pending)return; room.phase='bet'; log(room,`${p.name} passou a fase de Ação.`); broadcast(room); }
function endTurn(room,p){ if(room.status!=='game'||room.phase!=='bet'||room.players[room.current].id!==p.id||room.pending)return; finishTurn(room); }
function resolvePending(room,p,data){ if(!room.pending||room.pending.playerId!==p.id)return; if(room.pending.type==='pairBonus'){ if(data.skip){room.pending=null;room.phase='race';log(room,`${p.name} abriu mão do bônus.`);broadcast(room);return;} const horse=Number(data.horse);if(!room.rows[horse]||room.rows[horse].cards.length===0)return;room.rows[horse].cards.pop();room.pending=null;room.phase='race';log(room,`${p.name} usou o bônus para retirar uma carta da pista.`);broadcast(room); } }
function maybeBotBet(room,p){
  const open=[1,2,3,4,5].filter(pos=>p.bets[pos]===null); if(!open.length)return;
  const pos=open[Math.floor(Math.random()*open.length)];
  const ranked=[...room.rows].sort((a,b)=>b.cards.length-a.cards.length); const target=ranked[Math.floor(Math.random()*Math.min(3,ranked.length))].horse; p.bets[pos]=target;
}
function botTurn(room,p){
  if(room.status!=='game'||room.players[room.current].id!==p.id||!p.isBot)return;
  if(p.bets[1]===null) maybeBotBet(room,p);
  const tick=setInterval(()=>{
    if(room.status!=='game'||room.players[room.current].id!==p.id||!p.isBot){clearInterval(tick);return;}
    if(room.phase==='race') {
      const risk=room.revealed.length>=2 ? 0.42 : 0.74;
      if(room.revealed.length>0 && Math.random()>risk){stop(room,p);return;}
      reveal(room,p);
      return;
    }
    if(room.phase==='bonus' && room.pending){
      const nonempty=room.rows.filter(r=>r.cards.length>0); const target=nonempty.sort((a,b)=>b.cards.length-a.cards.length)[0];
      resolvePending(room,p,{horse:target.horse}); return;
    }
    if(room.phase==='action'){
      if(p.actions.length && Math.random()<0.55){
        const leader=[...room.rows].sort((a,b)=>b.cards.length-a.cards.length)[0];
        if(Math.random()<0.5) playAction(room,p,{index:0,kind:'chicken',horse:leader.horse});
        else playAction(room,p,{index:0,kind:'carrot',horse:leader.horse});
      } else skipAction(room,p);
      return;
    }
    if(room.phase==='bet'){
      if(p.bets[1]===null) maybeBotBet(room,p);
      endTurn(room,p); clearInterval(tick); return;
    }
  },650);
}
function botMaybe(room){const p=room.players[room.current];if(p&&p.isBot)setTimeout(()=>botTurn(room,p),500);}

wss.on('connection',ws=>{
  let room=null, me=null;
  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw)}catch{return;}
    if(m.type==='create'){
      room=createRoom({name:(m.name||'Jogador').slice(0,18),isBot:false,ws}); me=room.players[0]; send(ws,{type:'created',code:room.code,id:me.id}); broadcast(room); return;
    }
    if(m.type==='join'){
      room=rooms.get(String(m.code||'').toUpperCase()); if(!room){send(ws,{type:'error',message:'Sala não encontrada.'});return;} if(room.status!=='lobby'){send(ws,{type:'error',message:'A partida já começou.'});return;} if(room.players.length>=4){send(ws,{type:'error',message:'Sala cheia.'});return;}
      addPlayer(room,{name:(m.name||'Jogador').slice(0,18),isBot:false,ws}); me=room.players.at(-1); send(ws,{type:'joined',code:room.code,id:me.id}); broadcast(room); return;
    }
    if(!room||!me)return;
    if(m.type==='addBot'&&room.status==='lobby'&&room.players.length<4){addPlayer(room,{name:`Bot ${room.players.length}`,isBot:true,ws:null});broadcast(room);return;}
    if(m.type==='start'){startGame(room);return;}
    if(m.type==='reveal'){reveal(room,me);return;}
    if(m.type==='stop'){stop(room,me);return;}
    if(m.type==='bet'){placeBet(room,me,m.pos,m.horse);return;}
    if(m.type==='action'){playAction(room,me,m);return;}
    if(m.type==='skipAction'){skipAction(room,me);return;}
    if(m.type==='endTurn'){endTurn(room,me);return;}
    if(m.type==='pending'){resolvePending(room,me,m);return;}
  });
  ws.on('close',()=>{if(room&&me){me.ws=null;broadcast(room);}});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Pangaré online em http://localhost:${PORT}`));

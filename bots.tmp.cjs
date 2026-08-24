const WebSocket=require('ws');
const B='http://127.0.0.1:3000';
const j=async(p,o={})=>{const r=await fetch(B+p,{method:o.m||'GET',headers:{...(o.t?{Authorization:'Bearer '+o.t}:{}),...(o.b?{'Content-Type':'application/json'}:{})},body:o.b?JSON.stringify(o.b):undefined});const x=await r.text();try{return{s:r.status,j:JSON.parse(x)}}catch{return{s:r.status,j:x}}};
(async()=>{
  for(const label of ['bot-a','bot-b']){
    const t=(await j('/auth/guest',{m:'POST',b:{}})).j.accessToken;
    const r=await j(`/rooms/code/${process.argv[2]}/join`,{m:'POST',t,b:{}});
    if(r.s>=300){console.log(label,'참가 실패',r.s,JSON.stringify(r.j));process.exit(1)}
    const ws=new WebSocket('ws://localhost:4000'+r.j.wsPath,{origin:'http://localhost:5173'});
    let seq=0;
    ws.on('open',()=>ws.send(JSON.stringify({v:1,type:'auth',requestId:1,payload:{ticket:r.j.ticket}})));
    ws.on('message',d=>{const b=Buffer.from(d);if(b[0]!==0x7b)return;const m=JSON.parse(b.toString());
      if(m.type==='auth.ok'){console.log(label,'playerId='+m.payload.playerId);
        setInterval(()=>{const buf=Buffer.alloc(6);buf[0]=2;buf[1]=1;buf.writeUInt16LE((seq++)&0xffff,2);buf[4]=(Math.random()*16)|0;buf[5]=0;ws.send(buf)},33);}
      if(m.type==='game.started')console.log(label,'game.started');});
    ws.on('error',e=>console.log(label,'err',e.message));
    await new Promise(r=>setTimeout(r,700));
  }
  console.log('봇 2명 유지 중');
  setInterval(()=>{},1<<30);
})();

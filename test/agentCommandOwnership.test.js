const test=require('node:test');
const assert=require('node:assert/strict');
test('Agent cannot complete another node command',async()=>{
  const dbPath=require.resolve('../src/services/database'); const old=require.cache[dbPath];
  require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{getNodeById:id=>({id,name:'node-'+id,agent_token:'token-'+id}),addAuditLog(){}}};
  const agent=require('../src/services/agent-ws');
  const makeWs=()=>({readyState:1,_agentState:{authenticated:false},send(data){this.last=JSON.parse(data);},close(){this.readyState=3;}});
  const first=makeWs(),second=makeWs();
  try {
    agent.handleMessage(first,{type:'auth',nodeId:1,token:'token-1'});
    agent.handleMessage(second,{type:'auth',nodeId:2,token:'token-2'});
    let settled=false; const result=agent.sendCommand(1,{type:'ping'}).then(value=>{settled=true;return value;});
    const id=first.last.id;
    agent.handleMessage(second,{type:'cmd_result',id,success:true,stdout:'forged'});
    await Promise.resolve(); assert.equal(settled,false);
    agent.handleMessage(first,{type:'cmd_result',id,success:true,stdout:'valid'});
    assert.equal((await result).data.stdout,'valid');
  } finally {agent.shutdown();if(old) require.cache[dbPath]=old;else delete require.cache[dbPath];}
});

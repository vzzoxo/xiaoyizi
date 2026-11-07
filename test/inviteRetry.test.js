const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parse}=require('acorn');

test('Desktop and mobile invite retry buttons bind after every error render',()=>{
  const template=fs.readFileSync(require.resolve('../views/partials/admin-invites.ejs'),'utf8');
  const script=require('ejs').render(template,{nonce:'test-nonce'}).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const ast=parse(script,{ecmaVersion:'latest'}),functions=[];
  function walk(node) {
    if(!node || typeof node!=='object')return;
    if(node.type==='FunctionDeclaration'&&['esc','setInviteLoadingState','setInviteErrorState'].includes(node.id.name))functions.push(script.slice(node.start,node.end));
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
  }
  walk(ast);
  const elements=new Map(['invite-tbody','invite-cards','invite-page-info','invite-page-info-m','invite-pagination','invite-pagination-m'].map(id=>[id,{buttons:[],set innerHTML(value){this.buttons=value.includes('data-action="retry-invites"')?[{addEventListener(event,callback){assert.equal(event,'click');this.click=callback;}}]:[];}}]));
  const calls=[];
  const context=vm.createContext({document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[...elements.values()].flatMap(e=>e.buttons)},window:{loadInviteRelations:page=>calls.push(page)}});
  vm.runInContext(functions.join('\n'),context);
  for(let render=0;render<2;render++) {
    context.setInviteLoadingState();context.setInviteErrorState('Network failed');
    const buttons=[...elements.values()].flatMap(e=>e.buttons);assert.equal(buttons.length,2);
    buttons.forEach(button=>button.click());
  }
  assert.deepEqual(calls,[1,1,1,1]);
});

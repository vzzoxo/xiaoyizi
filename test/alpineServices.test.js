const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const vm=require('node:vm');
const {parse}=require('acorn');
const {restartService}=require('../src/utils/serviceCommands');
/** Run real generated shell commands against isolated service-tool fixtures. */
function tools(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyizi-services-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const log=path.join(dir,'calls');
  for(const tool of ['rc-service','rc-update','systemctl','sleep']) fs.writeFileSync(path.join(dir,tool),`#!/bin/sh\nprintf '%s %s\\n' '${tool}' "$*" >> "$SERVICE_LOG"\n[ "\${FAIL_SERVICE:-}" != '${tool}' ]\n`,{mode:0o755});
  return {dir,log,run(command,env={}) {return execFileSync('/bin/sh',['-c',command],{encoding:'utf8',env:{...process.env,PATH:dir,SERVICE_LOG:log,...env}}).trim();}};
}
test('OpenRC deployment enables, restarts and checks the service; failures are not reported as success',t=>{
  const f=tools(t);
  // Supply the guest's init-system result without depending on the CI host's /run directory.
  const cmd=restartService('xray',{enable:true,delay:2,marker:'DEPLOY_OK'}).replace('[ ! -d /run/systemd/system ]','true');
  assert.equal(f.run(cmd),'DEPLOY_OK');
  assert.match(fs.readFileSync(f.log,'utf8'),/rc-update add xray default\nrc-service xray restart\nsleep 2\nrc-service xray status/);
  assert.equal(f.run(cmd,{FAIL_SERVICE:'rc-service'}),'FAIL');
});
test('systemd deployment retains enable, restart and exit-status verification',t=>{
  const f=tools(t);fs.unlinkSync(path.join(f.dir,'rc-service'));
  assert.equal(f.run(restartService('hysteria-server',{enable:true,marker:'DEPLOY_OK'})),'DEPLOY_OK');
  assert.match(fs.readFileSync(f.log,'utf8'),/systemctl enable hysteria-server\nsystemctl restart hysteria-server\nsleep 1\nsystemctl is-active --quiet hysteria-server/);
  assert.throws(()=>restartService('xray; touch /tmp/unsafe'));
});
test('Agent status and restart commands support OpenRC without accepting arbitrary service names',async()=>{
  const source=fs.readFileSync('node-agent/agent.js','utf8');
  const declarations=parse(source,{ecmaVersion:'latest',allowHashBang:true}).body.filter(n=>n.type==='FunctionDeclaration' && ['serviceCommand','getXrayStatus','getHysteriaStatus'].includes(n.id.name)).map(n=>source.slice(n.start,n.end)).join('\n');
  for(const openrc of [true,false]) {
    const calls=[];const context=vm.createContext({fs:{existsSync:p=>p==='/sbin/rc-service' && openrc},run:async cmd=>{calls.push(cmd);return {ok:true,stdout:openrc ? ' * status: started' : 'active'};}});
    vm.runInContext(declarations,context);
    assert.equal(await context.getXrayStatus(),true);assert.equal(await context.getHysteriaStatus(),true);
    assert.equal(context.serviceCommand('xray','restart'),openrc ? 'rc-service xray restart' : 'systemctl restart xray');
    assert.equal(calls[0],openrc ? 'rc-service xray status' : 'systemctl is-active xray');
    assert.throws(()=>context.serviceCommand('xray; reboot','restart'));
  }
});
/** Execute Alpine installer branches in a temporary filesystem with inert package/service tools. */
function installerFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoyizi-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  for(const tool of ['apk','chown','rc-update','rc-service','xray','hysteria']) fs.writeFileSync(path.join(bin,tool),'#!/bin/sh\nexit 0\n',{mode:0o755});
  fs.mkdirSync(path.join(root,'etc/init.d'),{recursive:true});fs.mkdirSync(path.join(root,'etc/hysteria'),{recursive:true});
  fs.writeFileSync(path.join(root,'etc/hysteria/cert.pem'),'test-cert');fs.writeFileSync(path.join(root,'etc/hysteria/key.pem'),'test-key');
  return {root,run(file,args=[]) {
    const name=path.join(root,path.basename(file));
    const source=fs.readFileSync(file,'utf8').replace(/\/(?:usr\/local|etc|opt)\//g,match=>root+match).replace('[ ! -d /run/systemd/system ]','true');
    fs.writeFileSync(name,source);
    return execFileSync('/bin/sh',[name,...args],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH}});
  }};
}
test('Alpine Xray and Hysteria installation creates supervised OpenRC services with the panel config paths',t=>{
  const f=installerFixture(t);
  assert.match(f.run('templates/install-xray.sh'),/INSTALL_OK/);
  assert.match(fs.readFileSync(path.join(f.root,'etc/init.d/xray'),'utf8'),/supervisor="supervise-daemon"/);
  assert.match(fs.readFileSync(path.join(f.root,'etc/init.d/xray'),'utf8'),/run -config .*\/usr\/local\/etc\/xray\/config.json/);
  assert.match(f.run('templates/install-hysteria.sh'),/HY2_INSTALL_OK/);
  assert.match(fs.readFileSync(path.join(f.root,'etc/init.d/hysteria-server'),'utf8'),/server -c .*\/etc\/hysteria\/config.yaml/);
  assert.equal(fs.statSync(path.join(f.root,'etc/hysteria/key.pem')).mode & 0o777,0o600);
});
test('Standalone Alpine Agent installation creates config and an OpenRC service without invoking systemd',t=>{
  const f=installerFixture(t);fs.writeFileSync(path.join(f.root,'agent.js'),'// fixture');
  assert.match(f.run('node-agent/install.sh',['wss://panel.example.test/ws/agent','local-test-token','7']),/rc-service vless-agent status/);
  const config=JSON.parse(fs.readFileSync(path.join(f.root,'etc/vless-agent/config.json'),'utf8'));
  assert.equal(config.nodeId,7);
  assert.match(fs.readFileSync(path.join(f.root,'etc/init.d/vless-agent'),'utf8'),/supervisor="supervise-daemon"/);
});

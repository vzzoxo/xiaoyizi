const SERVICES=new Set(['xray','hysteria-server','vless-agent']);
/** Restart and verify a supported service through the host's native init system. */
function restartService(service,{enable=false,delay=1,marker='OK'}={}) {
  if(!SERVICES.has(service) || !['OK','DEPLOY_OK','AGENT_OK'].includes(marker) || ![1,2].includes(delay)) throw new Error('Invalid service command');
  const openrc=`${enable ? `rc-update add ${service} default && ` : ''}rc-service ${service} restart && sleep ${delay} && rc-service ${service} status`;
  const systemd=`${enable ? `systemctl enable ${service} && ` : ''}systemctl restart ${service} && sleep ${delay} && systemctl is-active --quiet ${service}`;
  return `if { if command -v rc-service >/dev/null 2>&1 && [ ! -d /run/systemd/system ]; then ${openrc}; else ${systemd}; fi; } >/dev/null; then echo ${marker}; else echo FAIL; fi`;
}
/** Stop managed services and remove autostart entries without selecting an arbitrary service. */
function stopServices() {
  return "if command -v rc-service >/dev/null 2>&1 && [ ! -d /run/systemd/system ]; then for s in xray hysteria-server vless-agent; do rc-service \"$s\" stop; rc-update del \"$s\" default; done; else for s in xray hysteria-server vless-agent; do systemctl stop \"$s\"; systemctl disable \"$s\"; done; fi";
}
module.exports={restartService,stopServices};

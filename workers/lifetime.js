const {AsyncLocalStorage}=require('node:async_hooks');
const scope=new AsyncLocalStorage();
function track(promise) {
  const pending=scope.getStore();
  if(pending) {pending.add(promise); promise.catch(()=>{});}
  return promise;
}
async function run(callback) {
  const pending=new Set();
  return scope.run(pending,async()=>{
    const result=await callback();
    while(pending.size) {const batch=[...pending]; pending.clear(); await Promise.allSettled(batch);}
    return result;
  });
}
module.exports={run,track};

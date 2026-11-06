const { EventEmitter } = require('node:events');
// Webhook-only Telegram adapter. Tracks every outgoing request until each
// update finishes, including calls made by legacy handlers that return void.
class TelegramBot extends EventEmitter {
  constructor(token) { super(); this.token=token; this.textHandlers=[]; this.pending=new Set(); }
  onText(regex, callback) { this.textHandlers.push({regex,callback}); }
  call(method, body) {
    const work=(async () => {
      const response=await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const json=await response.json(); if(!response.ok || !json.ok) throw new Error('Telegram API request failed'); return json.result;
    })();
    this.pending.add(work); work.then(()=>this.pending.delete(work),()=>this.pending.delete(work)); return work;
  }
  sendMessage(chat_id,text,options={}) {return this.call('sendMessage',{chat_id,text,...options});}
  answerCallbackQuery(callback_query_id,options={}) {return this.call('answerCallbackQuery',{callback_query_id,...options});}
  getMe() {return this.call('getMe',{});}
  setMyCommands(commands,options={}) {return this.call('setMyCommands',{commands,...options});}
  setChatMenuButton(options) {return this.call('setChatMenuButton',options);}
  async processUpdate(update) {
    const callbacks=[];
    if(update.message) {
      for(const cb of this.listeners('message')) callbacks.push(cb(update.message));
      for(const {regex,callback} of this.textHandlers) {const match=String(update.message.text || '').match(regex); if(match) callbacks.push(callback(update.message,match));}
    }
    if(update.callback_query) for(const cb of this.listeners('callback_query')) callbacks.push(cb(update.callback_query));
    await Promise.all(callbacks);
    while(this.pending.size) await Promise.all([...this.pending]);
  }
}
module.exports=TelegramBot;

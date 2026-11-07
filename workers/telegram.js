const { EventEmitter } = require('node:events');
// Webhook-only Telegram adapter. Tracks every outgoing request until each
// update finishes, including calls made by legacy handlers that return void.
class TelegramBot extends EventEmitter {
  /** Initialize webhook command handlers and pending Telegram API requests. */
  constructor(token) { super(); this.token=token; this.textHandlers=[]; this.pending=new Set(); }
  /** Register a regex-based Telegram message handler. */
  onText(regex, callback) { this.textHandlers.push({regex,callback}); }
  /** Send a bounded Telegram API request and track it until completion. */
  call(method, body) {
    const work=(async () => {
      const response=await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const json=await response.json(); if(!response.ok || !json.ok) throw new Error('Telegram API request failed'); return json.result;
    })();
    this.pending.add(work); work.then(()=>this.pending.delete(work),()=>this.pending.delete(work)); return work;
  }
  /** Send text and options to the selected Telegram chat. */
  sendMessage(chat_id,text,options={}) {return this.call('sendMessage',{chat_id,text,...options});}
  /** Acknowledge a Telegram inline-button callback. */
  answerCallbackQuery(callback_query_id,options={}) {return this.call('answerCallbackQuery',{callback_query_id,...options});}
  /** Fetch the bot identity for account binding links. */
  getMe() {return this.call('getMe',{});}
  /** Update Telegram command-menu entries for the requested scope. */
  setMyCommands(commands,options={}) {return this.call('setMyCommands',{commands,...options});}
  /** Configure the bot menu button. */
  setChatMenuButton(options) {return this.call('setChatMenuButton',options);}
  /** Run matching webhook handlers and await all outgoing Telegram requests. */
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

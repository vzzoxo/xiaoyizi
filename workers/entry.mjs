import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { configureStorage } from './sqlite.js';
import files from './files.cjs';
// Provides require for dependencies that conditionally load Node built-ins.
export class Panel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.telegramInFlight = new Map();
    this.cronInFlight = new Map();
    ctx.blockConcurrencyWhile(async () => {
      if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET (at least 32 characters)');
      for (const [key, value] of Object.entries(env)) if (typeof value === 'string') process.env[key] = value;
      configureStorage(ctx.storage);
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
      }
      let app;
      try { app = require('../src/app.js'); } catch(e) { console.error(e.stack); throw e; }
      this.db = require('../src/services/database.js');
      this.agent = require('../src/services/agent-ws.js');
      if (this.db.getUserCount() === 0) {
        if(!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD to initialize the administrator');
        if(env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
        const passwordHash=require('../src/utils/password.js').hashPassword(env.ADMIN_PASSWORD);
        this.db.createEmailUser({username:'admin', email:env.ADMIN_EMAIL, passwordHash, displayName:'管理员'});
      }
      this.handler = httpServerHandler(createServer(app));
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/telegram/webhook') {
      const {safeTokenEqual}=require('../src/utils/securityTokens.js');
      if(request.method !== 'POST') return new Response('Method not allowed',{status:405});
      if(!this.env.TG_WEBHOOK_SECRET || !this.env.TG_BOT_TOKEN || !safeTokenEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),this.env.TG_WEBHOOK_SECRET)) return new Response('Forbidden',{status:403});
      const reader=request.body?.getReader(); if(!reader) return new Response('Invalid body',{status:400});
      const chunks=[]; let size=0;
      while(true) {const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>1048576) {await reader.cancel(); return new Response('Payload too large',{status:413});} chunks.push(value);}
      const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks) {bytes.set(chunk,offset); offset+=chunk.length;}
      let update; try {update=JSON.parse(new TextDecoder().decode(bytes));} catch {return new Response('Invalid JSON',{status:400});}
      if(!Number.isSafeInteger(update.update_id)) return new Response('Invalid update',{status:400});
      const prior=await this.ctx.storage.get('telegram-update:'+update.update_id);
      if(prior) return new Response('ok');
      if(this.telegramInFlight.has(update.update_id)) {await this.telegramInFlight.get(update.update_id); return new Response('ok');}
      const work=Promise.resolve().then(async()=>{
        await require('./lifetime').run(()=>require('../src/services/tgbot.js').processUpdate(update));
        await this.ctx.storage.put('telegram-update:'+update.update_id,Date.now());
      });
      this.telegramInFlight.set(update.update_id,work);
      try {await work;} finally {this.telegramInFlight.delete(update.update_id);}
      return new Response('ok');
    }
    if (url.pathname === '/ws/agent') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', {status: 426});
      const pair = new WebSocketPair();
      const server = pair[1]; server.accept();
      // Reuse the authenticated existing Agent protocol and reporting logic.
      const ws = {
        readyState: 1,
        _agentState: {authenticated: false, nodeId: null, ip: request.headers.get('CF-Connecting-IP'), msgCount: 0, msgWindowStart: Date.now()},
        send: data => server.send(data),
        close: (code, reason) => { ws.readyState = 3; server.close(code, reason); },
        terminate: () => { ws.readyState = 3; server.close(4000, 'Connection closed'); },
      };
      ws._authTimer = setTimeout(() => { if (!ws._agentState.authenticated) ws.close(4001, 'Authentication timeout'); }, 10000);
      let lastSeen=Date.now();
      const heartbeat=setInterval(()=>{
        if(ws.readyState !== 1) return clearInterval(heartbeat);
        if(Date.now()-lastSeen > 90000) return ws.close(4000,'Heartbeat timeout');
        ws.send(JSON.stringify({type:'ping'}));
      },30000);
      server.addEventListener('message', event => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 1048576) return ws.close(4002, 'Invalid message');
          const state = ws._agentState;
          if (Date.now() - state.msgWindowStart > 10000) {state.msgCount = 0; state.msgWindowStart = Date.now();}
          if (++state.msgCount > 60) return ws.close(4008, 'Rate limited');
          lastSeen=Date.now();
          this.ctx.waitUntil(require('./lifetime').run(()=>{
            this.agent.handleMessage(ws, JSON.parse(event.data));
            require('../src/services/health.js').flushBufferedHealthWrites();
          }));
        } catch { ws.close(4002, 'Invalid message'); }
      });
      server.addEventListener('close', () => {clearInterval(heartbeat); ws.readyState = 3; this.agent.releaseConnection(ws);});
      return new Response(null, {status: 101, webSocket: pair[0]});
    }
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Proto', 'https');
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '127.0.0.1');
    return require('./lifetime').run(()=>this.handler.fetch(new Request(request, {headers})));
  }
  async runScheduled(scheduledTime) {
    const minute=Math.floor(scheduledTime/60000);
    if(this.cronInFlight.has(minute)) return this.cronInFlight.get(minute);
    const work=this.executeScheduled(scheduledTime);
    this.cronInFlight.set(minute,work);
    try {return await work;} finally {this.cronInFlight.delete(minute);}
  }
  async executeScheduled(scheduledTime) {
    return require('./lifetime').run(async()=>{
      require('../src/services/health.js').checkStaleAgents();
      require('../src/services/health.js').flushBufferedHealthWrites();
      this.db.getDb().prepare('DELETE FROM worker_sessions WHERE expires < ?').run(Date.now());
      const maps=this.db.getDb().prepare("SELECT name FROM sqlite_master WHERE name='worker_maps'").get();
      if(maps) this.db.getDb().prepare("DELETE FROM worker_maps WHERE namespace IN ('email-codes','forgot-codes') AND json_extract(value,'$.expiresAt') < ?").run(Date.now());
      const updates=await this.ctx.storage.list({prefix:'telegram-update:'});
      for(const [key,time] of updates) if(Date.now()-time>86400000) await this.ctx.storage.delete(key);
      const local=new Date(scheduledTime+8*3600000);
      if(local.getUTCMinutes()===0) require('../src/services/health.js').checkZeroTrafficNodes();
      if(local.getUTCMinutes()%5===0) require('../src/services/health.js').checkSuddenZeroTraffic();
      require('../src/services/health.js').flushBufferedHealthWrites();
      const expression=`${local.getUTCMinutes()} ${local.getUTCHours()} * * *`;
      if(!['0 2 * * *','0 3 * * *','0 4 * * *','30 4 * * *','40 4 * * *','50 4 * * *'].includes(expression)) return;
      const jobKey='cron:'+local.toISOString().slice(0,10)+':'+expression;
      if(await this.ctx.storage.get(jobKey)) return;
      if(expression === '0 2 * * *') require('./backups').createBackup();
      else await require('./cron.js').run(expression);
      await this.ctx.storage.put(jobKey,true);
      const oldJobs=await this.ctx.storage.list({prefix:'cron:'});
      const cutoff=new Date(scheduledTime-7*86400000).toISOString().slice(0,10);
      for(const key of oldJobs.keys()) if(key.slice(5,15)<cutoff) await this.ctx.storage.delete(key);
    });
  }
}
const singleton = env => env.PANEL.get(env.PANEL.idFromName('xiaoyizi'));
export default {
  fetch: (request, env) => {
    const url = new URL(request.url);
    if (/^\/(css|js|images|fonts)\//.test(url.pathname) || ['/favicon.ico','/favicon.svg','/robots.txt','/apple-touch-icon.png','/icon-192.png'].includes(url.pathname)) return env.ASSETS.fetch(request);
    return singleton(env).fetch(request);
  },
  scheduled: (event, env, ctx) => {
    ctx.waitUntil(singleton(env).runScheduled(event.scheduledTime));
  },
};

const router=require('express').Router();
const backups=require('./backups');
const {getDb,addAuditLog}=require('../src/services/database');
router.get('/backups',(req,res)=>{
  backups.initialize();
  res.json({ok:true,backups:getDb().prepare('SELECT name,size,created_at AS mtime,created_at AS mtime_display FROM worker_backups ORDER BY created_at DESC').all()});
});
router.post('/backups/create',(req,res)=>{
  try {const name=backups.createBackup(); addAuditLog(req.user.id,'backup_create',name,req.clientIp);res.json({ok:true,backup:name});}
  catch(e) {res.status(500).json({ok:false,error:e.message});}
});
router.get('/backups/download/:name',(req,res)=>{
  const data=backups.readBackup(req.params.name); if(!data) return res.status(404).json({error:'备份不存在'});
  res.attachment(req.params.name).type('json').send(data);
});
router.post('/backups/restore',(req,res)=>{
  try {const safety=backups.restoreBackup(req.body.name); req.session.destroy(()=>{}); res.json({ok:true,message:`恢复成功，已保存恢复前快照 ${safety}。请重新登录。`});}
  catch(e) {res.status(400).json({ok:false,error:e.message});}
});
module.exports=router;

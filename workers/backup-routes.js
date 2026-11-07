const router=require('express').Router();
const backups=require('./backups');
const {getDb,getUserById,addAuditLog}=require('../src/services/database');
const logger=require('../src/services/logger');
router.get('/backups',(req,res)=>{
  backups.initialize();
  res.json({ok:true,backups:getDb().prepare('SELECT name,size,created_at AS mtime,created_at AS mtime_display FROM worker_backups ORDER BY created_at DESC').all()});
});
router.post('/backups/create',(req,res)=>{
  try {
    const name=backups.createBackup();
    addAuditLog(req.user.id,'backup_create',name,req.clientIp);
    res.json({ok:true,backup:name});
  } catch(err) {
    if(err instanceof backups.BackupError) return res.status(500).json({ok:false,error:err.message});
    logger.error({err},'Worker 备份创建失败');
    res.status(500).json({ok:false,error:'创建备份失败，请稍后重试'});
  }
});
router.get('/backups/download/:name',(req,res)=>{
  const data=backups.readBackup(req.params.name); if(!data) return res.status(404).json({error:'备份不存在'});
  res.attachment(req.params.name).type('json').send(data);
});
router.post('/backups/restore',(req,res)=>{
  if(!req.body || typeof req.body.name!=='string' || !req.body.name.trim()) return res.status(400).json({ok:false,error:'无效备份名称'});
  try {
    const safety=backups.restoreBackup(req.body.name);
    // The restoring administrator may not exist in the older snapshot.
    const actor=getUserById(req.user.id);
    addAuditLog(actor ? actor.id : null,'backup_restore',`操作者 #${req.user.id} 恢复 ${req.body.name}；恢复前快照 ${safety}`,req.clientIp);
    req.session.destroy(()=>{});
    res.json({ok:true,message:`恢复成功，已保存恢复前快照 ${safety}。请重新登录。`});
  } catch(err) {
    if(err instanceof backups.BackupError) return res.status(400).json({ok:false,error:err.message});
    logger.error({err},'Worker 备份恢复失败');
    res.status(500).json({ok:false,error:'恢复备份失败，请稍后重试'});
  }
});
module.exports=router;

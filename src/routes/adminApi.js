const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// 挂载子路由
router.use('/', require('./admin/adminNodes'));
router.use('/', require('./admin/adminUsers'));
router.use('/', require('./admin/adminInvites'));
router.use('/', require('./admin/adminUlzix'));
router.use('/', require('./admin/adminAgents'));
router.use('/', require('./admin/adminSettings'));
router.use('/', require('./admin/adminTraffic'));
router.use('/', process.env.WORKERS_RUNTIME ? require('../../workers/backup-routes') : require('./admin/adminBackup'));

module.exports = router;

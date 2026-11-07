// 用户组定义：trust_level 0-3 映射
const USER_GROUPS = [
  { level: 0, name: '普通用户', color: '#9ca3af', badge: '' },
  { level: 1, name: 'VIP',     color: '#34d399', badge: '' },
  { level: 2, name: 'SVIP',    color: '#a78bfa', badge: '' },
  { level: 3, name: 'SSVIP',   color: '#fbbf24', badge: '' },
];

function getGroup(level) {
  return USER_GROUPS[Math.min(Math.max(level || 0, 0), USER_GROUPS.length - 1)];
}

function getGroupLabel(level) {
  const g = getGroup(level);
  return g.badge ? `${g.badge} ${g.name}` : g.name;
}

module.exports = { USER_GROUPS, getGroup, getGroupLabel };

// 默认值：uuid_days 0=不重置, sub_days 0=不重置
const GROUP_RESET_DEFAULTS = [
  { uuid_days: 1, sub_days: 7 },   // 普通用户
  { uuid_days: 1, sub_days: 15 },  // VIP
  { uuid_days: 1, sub_days: 0 },   // SVIP (sub 0=不重置)
  { uuid_days: 0, sub_days: 0 },   // SSVIP (都不重置)
];

function getGroupResetConfig(db) {
  return [0,1,2,3].map(i => {
    const uRaw = parseInt(db.getSetting(`group_${i}_uuid_days`));
    const sRaw = parseInt(db.getSetting(`group_${i}_sub_days`));
    return {
      level: i,
      uuid_days: Number.isFinite(uRaw) ? uRaw : GROUP_RESET_DEFAULTS[i].uuid_days,
      sub_days: Number.isFinite(sRaw) ? sRaw : GROUP_RESET_DEFAULTS[i].sub_days,
    };
  });
}

module.exports.getGroupResetConfig = getGroupResetConfig;

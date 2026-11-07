const CITY_CN = {
  'singapore': '新加坡', 'tokyo': '东京', 'osaka': '大阪', 'chiyoda': '千代田', 'chiyoda city': '千代田',
  'seoul': '首尔', 'hong kong': '香港', 'hongkong': '香港',
  'taipei': '台北', 'mumbai': '孟买', 'sydney': '悉尼',
  'london': '伦敦', 'frankfurt': '法兰克福', 'paris': '巴黎',
  'amsterdam': '阿姆斯特丹', 'virginia': '弗吉尼亚', 'ohio': '俄亥俄',
  'oregon': '俄勒冈', 'california': '加利福尼亚', 'los angeles': '洛杉矶', 'portland': '波特兰', 'minkler': '明克勒', 'ashburn': '阿什本', 'san jose': '圣何塞', 'são paulo': '圣保罗',
  'toronto': '多伦多', 'jakarta': '雅加达', 'bangkok': '曼谷',
  'kuala lumpur': '吉隆坡', 'manila': '马尼拉',
  'dubai': '迪拜', 'stockholm': '斯德哥尔摩', 'dublin': '都柏林',
  'milan': '米兰', 'zurich': '苏黎世', 'warsaw': '华沙',
  'cape town': '开普敦', 'bahrain': '巴林',
};

function getCityCN(city) {
  const key = (city || '').toLowerCase();
  for (const [k, v] of Object.entries(CITY_CN)) {
    if (key.includes(k)) return v;
  }
  return city || '未知';
}

module.exports = { CITY_CN, getCityCN };

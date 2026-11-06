const jobs = [];
function schedule(expression, callback) { jobs.push({ expression, callback }); return { stop() {} }; }
async function run(expression) {
  for (const job of jobs) if (job.expression === expression) await job.callback();
}
module.exports = { schedule, run };

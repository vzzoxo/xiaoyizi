const jobs = [];
/** Register an application cron callback for the Workers trigger dispatcher. */
function schedule(expression, callback) { jobs.push({ expression, callback }); return { stop() {} }; }
/** Await each registered callback matching the selected local-time cron expression. */
async function run(expression) {
  for (const job of jobs) if (job.expression === expression) await job.callback();
}
module.exports = { schedule, run };

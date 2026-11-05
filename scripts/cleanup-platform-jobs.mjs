// 清理遗留的「平台网页端创建」定时任务（source=PLATFORM）。
// 用户决策：这些旧任务不再需要，停掉并清理（破坏性，不可恢复）。
// 配套：scheduler 已加 source='AGENT' 过滤，PLATFORM 任务即使残留也不会再被调度执行。
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const db = new DatabaseSync(join(process.cwd(), "prisma", "dev.db"));

const before = db.prepare("SELECT COUNT(*) AS n FROM ScheduledJob WHERE source='PLATFORM'").get().n;
const runsBefore = db
  .prepare("SELECT COUNT(*) AS n FROM ScheduledJobRun r JOIN ScheduledJob j ON r.jobId=j.id WHERE j.source='PLATFORM'")
  .get().n;

db.exec("DELETE FROM ScheduledJob WHERE source='PLATFORM'");

const after = db.prepare("SELECT COUNT(*) AS n FROM ScheduledJob").get().n;
const agentLeft = db.prepare("SELECT COUNT(*) AS n FROM ScheduledJob WHERE source='AGENT'").get().n;

console.log(`删除 PLATFORM 任务: ${before} 条（级联运行记录 ${runsBefore} 条）`);
console.log(`剩余 ScheduledJob 总数: ${after}，其中 AGENT: ${agentLeft}`);

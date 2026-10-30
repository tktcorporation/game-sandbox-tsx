/**
 * A worker process of RINGFALL's campaign table (forked by scripts/ringfall-campaign.ts and
 * scripts/ringfall-months.ts): plays one skill's month and sends it back.
 */
import { playCampaign } from "./ringfall-campaign";

process.on("message", (job: { skill: string; days: number; seed?: number }) => {
  process.send!(playCampaign(job.skill, job.days, job.seed));
});
process.on("disconnect", () => process.exit(0));

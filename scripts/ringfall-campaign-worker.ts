/**
 * A worker process of RINGFALL's campaign table (forked by scripts/ringfall-campaign.ts):
 * plays one skill's month and sends it back.
 */
import { playCampaign } from "./ringfall-campaign";

process.on("message", (job: { skill: string; days: number }) => {
  process.send!(playCampaign(job.skill, job.days));
});
process.on("disconnect", () => process.exit(0));

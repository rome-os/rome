import { aDayLater, loadHearing, recallCheck } from "../lib/hearing.mjs";
import { ruleResult } from "../lib/scenario.mjs";

export default {
  rule: "A2",
  title: "Hears without a mention",
  phase: 2,
  async run(ctx) {
    const { factIds, hours } = await aDayLater(ctx);
    const facts = loadHearing().a2Facts;
    return ruleResult([
      await recallCheck(
        ctx,
        facts,
        factIds,
        `recalls facts said without a mention, ${hours} h later`,
      ),
    ]);
  },
};

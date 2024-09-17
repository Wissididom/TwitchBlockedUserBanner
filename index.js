import "dotenv/config";

import { handleDcfLogin, getUserBlockList, banUser } from "./twitchApi.js";

await handleDcfLogin(async () => {
  let blocks = await getUserBlockList(process.env.BROADCASTER_ID);
  console.log(`Total Blocks: ${blocks.total} (Max: 500)`);
  for (let block of blocks.blocks) {
    //banUser(broadcasterId, moderatorId, userId, reason)
    await banUser(
      process.env.BROADCASTER_ID,
      process.env.BROADCASTER_ID,
      block.user_id,
      "Ban blocked user",
    );
    break;
  }
});

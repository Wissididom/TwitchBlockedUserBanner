import { banUser, getUserBlockList, handleDcfLogin } from "./twitchApi.js";

await handleDcfLogin(async () => {
  const blocks = await getUserBlockList(Deno.env.get("BROADCASTER_ID"));
  console.log(`Total Blocks: ${blocks.total} (Max: 500)`);
  for (const block of blocks.blocks) {
    //banUser(broadcasterId, moderatorId, userId, reason)
    await banUser(
      Deno.env.get("BROADCASTER_ID"),
      Deno.env.get("BROADCASTER_ID"),
      block.user_id,
      "Ban blocked user",
    );
    break;
  }
});

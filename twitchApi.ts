// deno-lint-ignore-file no-explicit-any
import { fileExists } from "./utils.ts";

let tokens: {
  access_token?: string | null;
  refresh_token?: string | null;
  device_code?: string | null;
  user_code?: string | null;
  verification_uri?: string | null;
  user_id?: string | null;
} = {
  access_token: null,
  refresh_token: null,
  device_code: null,
  user_code: null,
  verification_uri: null,
  user_id: null,
};

function getStatusResponse(res: Response, json: any) {
  switch (res.status) {
    case 200:
      return `OK: ${json.message}`;
    case 400:
      return `Bad Request: ${json.message}`;
    case 401:
      return `Unauthorized: ${json.message}`;
    case 403:
      return `Forbidden: ${json.message}`;
    case 409:
      return `Conflict: ${json.message}`;
    case 429:
      return `Too Many Requests: ${json.message}`;
    case 500:
      return `Internal Server Error: ${json.message}`;
    default:
      return `${json.error} (${res.status}): ${json.message}`;
  }
}

const SCOPES = [
  "user:read:blocked_users",
  "moderator:manage:banned_users",
].join(" ");

async function handleDcfLogin(authenticatedCallback: () => any) {
  if (await fileExists("./.tokens.json")) {
    tokens = JSON.parse(
      await Deno.readTextFile("./.tokens.json"),
    );
    const validated = await validate();
    if (validated) {
      console.log("Validated tokens and started bot");
      await authenticatedCallback();
      return;
    }
  }
  const dcf = await fetch(
    `https://id.twitch.tv/oauth2/device?client_id=${
      Deno.env.get("TWITCH_CLIENT_ID")
    }&scopes=${encodeURIComponent(SCOPES)}`,
    {
      method: "POST",
    },
  );
  if (dcf.status >= 200 && dcf.status < 300) {
    // Successfully got DCF data
    const dcfJson = await dcf.json();
    tokens.device_code = dcfJson.device_code;
    tokens.user_code = dcfJson.user_code;
    tokens.verification_uri = dcfJson.verification_uri;
    console.log(
      `Open ${tokens.verification_uri} in a browser and enter ${tokens.user_code} there!`,
    );
  }
  const dcfInterval = setInterval(async () => {
    const tokenPair = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${
        Deno.env.get("TWITCH_CLIENT_ID")
      }&scopes=${
        encodeURIComponent(SCOPES)
      }&device_code=${tokens.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
      {
        method: "POST",
      },
    );
    if (tokenPair.status == 400) return; // Probably authorization pending
    if (tokenPair.status >= 200 && tokenPair.status < 300) {
      // Successfully got token pair
      const tokenJson = await tokenPair.json();
      tokens.access_token = tokenJson.access_token;
      tokens.refresh_token = tokenJson.refresh_token;
      const user = await getUser();
      tokens.user_id = user.id;
      await Deno.writeTextFile("./.tokens.json", JSON.stringify(tokens));
      clearInterval(dcfInterval);
      console.log(
        `Got Device Code Flow Tokens for ${user.display_name} (${user.login}) and started bot`,
      );
      await authenticatedCallback();
      setInterval(
        async () => {
          await validate();
        },
        60 * 60 * 1000, /*Run every hour*/
      );
    }
  }, 1000);
}

async function getUser() {
  return (
    await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-ID": Deno.env.get("TWITCH_CLIENT_ID") ?? "N/A",
        Authorization: `Bearer ${tokens.access_token}`,
      },
    }).then((res) => res.json())
  ).data[0];
}

async function refresh() {
  console.log("Refreshing tokens...");
  const refreshResult = await fetch(
    `https://id.twitch.tv/oauth2/token?grant_type=refresh_token&refresh_token=${
      encodeURIComponent(
        tokens.refresh_token ?? "N/A",
      )
    }&client_id=${Deno.env.get("TWITCH_CLIENT_ID")}&client_secret=${
      Deno.env.get("TWITCH_CLIENT_SECRET")
    }`,
    {
      method: "POST",
      headers: {
        "Client-ID": Deno.env.get("TWITCH_CLIENT_ID") ?? "N/A",
        Authorization: `Bearer ${tokens.access_token}`,
      },
    },
  );
  const refreshJson = await refreshResult.json();
  if (refreshResult.status >= 200 && refreshResult.status < 300) {
    // Successfully refreshed
    tokens.access_token = refreshJson.access_token;
    tokens.refresh_token = refreshJson.refresh_token;
    const user = await getUser();
    tokens.user_id = user.id;
    await Deno.writeTextFile("./.tokens.json", JSON.stringify(tokens));
    console.log("Successfully refreshed tokens!");
    return true;
  } else {
    // Refreshing failed
    console.log(`Failed refreshing tokens: ${JSON.stringify(refreshJson)}`);
    return false;
  }
}

async function validate() {
  tokens = JSON.parse(
    await Deno.readTextFile(".tokens.json"),
  );
  return await fetch("https://id.twitch.tv/oauth2/validate", {
    method: "GET",
    headers: {
      "Client-ID": Deno.env.get("TWITCH_CLIENT_ID") ?? "N/A",
      Authorization: `Bearer ${tokens.access_token}`,
    },
  }).then(async (res) => {
    if (res.status) {
      if (res.status == 401) {
        return await refresh();
      } else if (res.status >= 200 && res.status < 300) {
        console.log("Successfully validated tokens!");
        return true;
      } else {
        console.error(
          `Unhandled validation error: ${JSON.stringify(await res.json())}`,
        );
        return false;
      }
    } else {
      console.error(
        `Unhandled network error! res.status is undefined or null! ${res}`,
      );
      return false;
    }
  });
}

async function getUserBlockList(
  broadcasterId?: string,
  maxEntries: number = 500,
) {
  const result: {
    total: number;
    blocks: any[];
  } = {
    total: 0,
    blocks: [],
  };
  if (!broadcasterId) return result;
  let paginationCursor = null;
  while (result.total < maxEntries) {
    const tempUserBlockList = await internalGetUserBlockList(
      broadcasterId,
      paginationCursor,
    );
    // Don't continue when there is no pagination cursor returned by Twitch
    if (!tempUserBlockList?.paginationCursor) break;
    paginationCursor = tempUserBlockList.paginationCursor;
    result.blocks = [...result.blocks, ...tempUserBlockList.blocks];
    result.total = result.blocks.length;
  }
  return result;
}

async function internalGetUserBlockList(
  broadcasterId: string,
  paginationCursor: string | null = null,
) {
  let apiUrl;
  if (paginationCursor) {
    apiUrl =
      `https://api.twitch.tv/helix/users/blocks?broadcaster_id=${broadcasterId}&first=100&after=${paginationCursor}`;
  } else {
    apiUrl =
      `https://api.twitch.tv/helix/users/blocks?broadcaster_id=${broadcasterId}&first=100`;
  }
  const res = await fetch(apiUrl, {
    method: "GET",
    headers: {
      "Client-ID": Deno.env.get("TWITCH_CLIENT_ID") ?? "N/A",
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    },
  });
  const json = await res.json();
  if (res.status == 401) {
    console.log("Status 401");
    const refreshed = await refresh();
    if (!refreshed) throw new Error("Token refresh failed");
    return await internalGetUserBlockList(broadcasterId, paginationCursor);
  }
  if (!res.ok) {
    console.log(`!res.ok: ${res.status}`);
    throw new Error(getStatusResponse(res, json));
  }
  if (json.error) {
    throw new Error(`Error: ${json.error}; Error-Message: ${json.message}`);
  } else {
    if (json.data) {
      return {
        paginationCursor: json?.pagination?.cursor
          ? json.pagination.cursor
          : null,
        blocks: json.data,
      };
    }
    return null;
  }
}

async function banUser(
  broadcasterId?: string,
  moderatorId?: string,
  userId?: string,
  reason?: string,
) {
  if (!broadcasterId || !moderatorId || !userId) {
    throw new Error(
      "At least broadcasterId, moderatorId and userId must be given for banning a user!",
    );
  }
  const res = await fetch(
    `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
    {
      method: "POST",
      headers: {
        "Client-ID": Deno.env.get("TWITCH_CLIENT_ID") ?? "N/A",
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          user_id: userId,
          // duration: 0,
          reason: "Ban blocked user",
        },
      }),
    },
  );
  const json = await res.json();
  if (res.status == 401) {
    const refreshed = await refresh();
    if (refreshed) {
      return await banUser(broadcasterId, moderatorId, userId, reason);
    }
  }
  if (!res.ok) {
    throw new Error(getStatusResponse(res, json));
  }
  if (json.error) {
    throw new Error(`Error: ${json.error}; Error-Message: ${json.message}`);
  } else {
    if (json.data.length < 1) {
      throw new Error(
        "twitch didn't return ban info. I assume, the ban was silently dropped.",
      );
    }
    return json.data[0];
  }
}

export { banUser, getUser, getUserBlockList, handleDcfLogin, refresh };

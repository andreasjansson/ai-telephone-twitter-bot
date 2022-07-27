import OAuth from "oauth-1.0a";
import CryptoJS from "crypto-js";
import Replicate from "replicate-js";

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request))
})

const replicate = new Replicate({ token: REPLICATE_API_TOKEN });

const firstPrompt = "two robots playing a game of telephone";

/**
 * Used for Cloudflare worker cron trigger.
 */
addEventListener('scheduled', event => {
  event.waitUntil(nextTweet());
});

/**
 * Used for local development.
 */
async function handleRequest(request) {
  if (new URL(request.url).pathname != "/") {
    return new Response("", { status: 404 });
  }

  await nextTweet();

  return new Response("done!", {
    headers: { "content-type": "text/plain" },
  })
}

async function nextTweet() {
  const userID = await getMyUserID();
  const latestTweet = await getLatestTweet(userID);

  if (latestTweet) {
    console.log(latestTweet);
    if (latestTweet.imageURL) {
      const text = await captionImage(latestTweet.imageURL);
      await tweetText(text, latestTweet.id);
    } else {
      const imageURL = await generateImage(latestTweet.text);
      await tweetImage(imageURL, latestTweet.id);
    }
  } else {
    await tweetText(firstPrompt);
  }
}

async function generateImage(text) {
  const minDalle = await replicate.models.get("kuprel/min-dalle");
  const swinIR = await replicate.models.get("jingyunliang/swinir");
  console.log("Generating image with min-dalle");
  const minDalleOutput = await minDalle.predict({ text: text, grid_size: 1 });
  const image = minDalleOutput.pop();
  console.log("Upscaling image with swin-ir");
  const swinIROutput = await swinIR.predict({ image: image });
  const upscaled = swinIROutput.pop();
  return upscaled["file"];
}

async function captionImage(imageURL) {
  const clipCaptionReward = await replicate.models.get("j-min/clip-caption-reward");
  console.log("Captioning image with clip-caption-reward");
  const captionOutput = await clipCaptionReward.predict({ image: imageURL });
  return captionOutput;
}

async function getLatestTweet(userID) {
  const url = new URL(`https://api.twitter.com/2/users/${userID}/tweets`)
  url.searchParams.append("max_results", 5);
  url.searchParams.append("expansions", "attachments.media_keys");
  url.searchParams.append("media.fields", "url");
  const resp = await fetch(url.href, {
    headers: { ...oauthHeadersForURL(url.href, "GET") }
  });
  const json = await resp.json();
  const tweets = json.data;
  if (!tweets) {
    return null;
  }
  const tweet = tweets[0];
  const mediaKey = tweet.attachments?.media_keys?.[0];

  if (json.includes?.media && mediaKey) {
    for (let i = 0; i < json.includes.media.length; i++) {
      const media = json.includes.media[i];
      if (media.media_key == mediaKey) {
        tweet.imageURL = media.url;
        break;
      }
    }
  }

  return tweet;
}

async function getMyUserID() {
  const url = new URL("https://api.twitter.com/2/users/me");
  url.searchParams.append("tweet.fields", "author_id");
  const resp = await fetch(url.href, {
    headers: { ...oauthHeadersForURL(url.href, "GET") }
  });
  const json = await resp.json();
  return json.data.id;
}

async function tweetText(text, quoteTweetID) {
  const url = "https://api.twitter.com/2/tweets";
  const body = { text: text };
  if (quoteTweetID) {
    body.quote_tweet_id = quoteTweetID;
  }
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...oauthHeadersForURL(url, "POST"),
    },
    body: JSON.stringify(body)
  });
}

async function tweetImage(imageURL, quoteTweetID) {
  const mediaID = await uploadMedia(imageURL);
  const url = "https://api.twitter.com/2/tweets";
  const body = { media: { media_ids: [mediaID] } };
  if (quoteTweetID) {
    body.quote_tweet_id = quoteTweetID;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...oauthHeadersForURL(url, "POST"),
    },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
}

async function uploadMedia(imageURL) {
  const imageBlob = await downloadImageBlob(imageURL);
  const formData = new FormData();
  formData.append("media", imageBlob);

  const url = "https://upload.twitter.com/1.1/media/upload.json?media_category=tweet_image";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...oauthHeadersForURL(url, "POST"),
    },
    body: formData
  });
  const json = await resp.json();
  return json.media_id_string;
}

async function downloadImageBlob(imageURL) {
  const resp = await fetch(imageURL);
  return await resp.blob();
}

function oauthHeadersForURL(url, method) {
  const oauth = OAuth({
    consumer: {
      key: TWITTER_CONSUMER_KEY,
      secret: TWITTER_CONSUMER_SECRET,
    },
    signature_method: "HMAC-SHA1",
    hash_function: hashFunctionSHA1
  });
  const token = {
    key: TWITTER_ACCESS_TOKEN,
    secret: TWITTER_ACCESS_TOKEN_SECRET
  }
  return oauth.toHeader(oauth.authorize({ url: url, method: method }, token));
}

function hashFunctionSHA1(baseString, key) {
  return CryptoJS.HmacSHA1(baseString, key).toString(CryptoJS.enc.Base64);
}

import OAuth from "oauth-1.0a";
import CryptoJS from "crypto-js";
import Replicate from "replicate-js";

const replicate = new Replicate({ token: REPLICATE_API_TOKEN });

const firstPrompt = "two robots playing a game of telephone";

// Used for Cloudflare worker cron trigger
addEventListener('scheduled', event => {
  event.waitUntil(nextTweet());
});

// Used for local development, triggered by visiting http://localhost:8787
// when running the server with `wrangler dev --local`
addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request))
})

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

/**
 * Generate a new tweet.
 *
 * If the last tweet was an image, it generates a caption. If the last
 * tweet was text, it generates an image. If there was no previous
 * tweet, it tweets "two robots playing a game of telephone".
 */
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

/**
 * Generate an image from text using the Replicate API.
 *
 * First the prompt is fed to https://replicate.com/kuprel/min-dalle,
 * then the output is upscaled by feeding it to
 * https://replicate.com/jingyunliang/swinir.
 *
 * The upscaled image URL is returned.
 */
async function generateImage(text) {
  const stableDiffusion = await replicate.models.get("stability-ai/stable-diffusion");
  console.log("Generating image");
  const stableDiffusionOutput = await stableDiffusion.predict({
    prompt: text,
    width: 512,
    height: 512,
    num_inference_steps: 50,
    num_outputs: 1
  });
  return stableDiffusionOutput[0];
}

/**
 * Generate a caption from an image using the Replicate API.
 *
 * The image is captioned with https://replicate.com/j-min/clip-caption-reward
 */
async function captionImage(imageURL) {
  const img2prompt = await replicate.models.get("methexis-inc/img2prompt");
  console.log("Captioning image");
  const img2promptOutput = await img2prompt.predict({ image: imageURL });
  return img2promptOutput;
}

/**
 * Get the latest tweet for a Twitter user ID.
 *
 * The tweet is returned in the format
 * {
 *   id: '1552736006104825856',
 *   text: 'https://t.co/UvYZP3he5k https://t.co/CqZaQJWXoz',
 *   attachments: { media_keys: [ '3_1552736002682355713' ] },
 *   imageURL: 'https://pbs.twimg.com/media/FYxtKu3XgAEftqg.jpg'
 * }
 * If there is no image, attachments and imageURL are not included.
 */
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

  // add imageURL with a URL to the attached image if there is one
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

/**
 * Return the Twitter user ID that belongs to the user who's
 * keys we're using.
 */
async function getMyUserID() {
  const url = new URL("https://api.twitter.com/2/users/me");
  url.searchParams.append("tweet.fields", "author_id");
  const resp = await fetch(url.href, {
    headers: { ...oauthHeadersForURL(url.href, "GET") }
  });
  const json = await resp.json();
  return json.data.id;
}

/**
 * Tweet a string of text, optionally quote tweeting a previous tweet.
 */
async function tweetText(text, quoteTweetID) {
  text = text.trim();
  if (text.length > 280) {
    text = text.substring(0, 280);
    text = text.substring(0, text.lastIndexOf(","));
  }
  console.log(`Tweeting ${text}`);
  const url = "https://api.twitter.com/2/tweets";
  const body = { text: text };
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
  if (resp.status != 200) {
    const body = await resp.text();
    console.log(body);
  }
}


/**
 * Tweet an image, optionally quote tweeting a previous tweet.
 *
 * The image is first uploaded as a piece of Twitter media.
 */
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

/**
 * Upload an image from a URL to Twitter's media storage.
 *
 * The image is first downloaded as raw bytes, then uploaded
 * using the Twitter media API.
 *
 * Returns the uploaded media ID.
 */
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

/**
 * Download an image from a URL as a Blob of raw bytes.
 */
async function downloadImageBlob(imageURL) {
  const resp = await fetch(imageURL);
  return await resp.blob();
}

/**
 * Make authorization headers for Twitter API calls.
 *
 * Returns an object like
 * {
 *   Authorization: "OAuth oauth_consumer_key=[...]"
 * }
 */
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

/**
 * Hash function required by the OAuth constructor.
 */
function hashFunctionSHA1(baseString, key) {
  return CryptoJS.HmacSHA1(baseString, key).toString(CryptoJS.enc.Base64);
}

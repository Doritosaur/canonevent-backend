import { AwsClient } from "aws4fetch";

const accountId = Deno.env.get("R2_ACCOUNT_ID") ?? "";
const bucket = Deno.env.get("R2_BUCKET") ?? "";

const aws = new AwsClient({
  accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID") ?? "",
  secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "",
  service: "s3",
  region: "auto",
});

// Uploads happen right away; playback links must outlast a listener who pauses and resumes.
const UPLOAD_TTL_SECONDS = 600;
const PLAYBACK_TTL_SECONDS = 3600;

function objectUrl(key: string): URL {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encoded}`);
}

async function presign(method: "GET" | "PUT", key: string, ttlSeconds: number, contentType?: string) {
  const url = objectUrl(key);
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  const headers = new Headers();
  // Signing the content type means the client must upload with exactly this type.
  if (contentType) headers.set("Content-Type", contentType);
  const signed = await aws.sign(new Request(url, { method, headers }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

export const presignPut = (key: string, contentType: string) => presign("PUT", key, UPLOAD_TTL_SECONDS, contentType);
export const presignGet = (key: string) => presign("GET", key, PLAYBACK_TTL_SECONDS);

export async function objectExists(key: string): Promise<boolean> {
  const res = await aws.fetch(objectUrl(key), { method: "HEAD" });
  return res.ok;
}

export async function deleteObject(key: string): Promise<void> {
  const res = await aws.fetch(objectUrl(key), { method: "DELETE" });
  // 404 is fine: the object is already gone.
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 delete failed: ${res.status}`);
  }
}
